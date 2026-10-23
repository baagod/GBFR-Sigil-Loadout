// @vitest-environment happy-dom
/*
    「附加效果」弹窗：勾选、值原样显示、键入过滤、改动即时写回、已勾选置顶、搜索过滤。

    只钉这个弹窗自己的契约（解析失败当空、未勾不写、空串补 0），不重复测 lib/buffs 的解析 ——
    那部分在 lib/buffs.test.ts。
*/
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

// vi.mock 会被提升到文件最前：工厂里不能引用外面的变量（React 19 的 act 环境警告）。
// 组件本身不调 LoadBuffs，但 lib/buffs 会 import 它，所以必须挡掉 Wails 运行时。
vi.mock("../../bindings/sigilloadout/service/actionsservice", () => ({
    LoadBuffs: vi.fn(),
}));

import { SupportEffectEditor } from "@/components/SupportEffectEditor";
import { parseSupportEffects, type BuffInfo } from "@/lib/buffs";
import { messages } from "@/lib/messages";

const t = messages.zh;

// 弹层渲染在 portal 里，不卸载就会漏到下一个用例（仓库里其它弹层测试同样 afterEach(cleanup)）。
afterEach(cleanup);

const buffs: BuffInfo[] = [
    {
        hash: "4039598841",
        labels: ["duration", "range", "", "", "", ""],
        names: { zh: "霸体", en: "Stout Heart" },
    },
    {
        hash: "1039632913",
        labels: ["", "", "", "", "1", "1"],
        names: { zh: "双发子弹", en: "Various" },
    },
];

const renderEditor = (raw: string) => {
    const onChange = vi.fn();
    const onClose = vi.fn();
    render(<SupportEffectEditor value={raw} buffs={buffs} lang="zh" t={t} onChange={onChange} onClose={onClose} />);
    return { onChange, onClose };
};

const checkbox = (name: string) => screen.getByLabelText(name) as HTMLButtonElement;
const valueInput = (name: string) => screen.getByLabelText(name) as HTMLInputElement;
/** 列表里每一行：按 DOM 顺序取名字（已勾选的应当排在前面）。 */
const rowNames = () =>
    Array.from(screen.getByTestId("support-effect-rows").children).map((row) => row.querySelector(".text-sm")?.textContent ?? "");
const lastWritten = (onChange: ReturnType<typeof vi.fn>) =>
    parseSupportEffects(onChange.mock.calls.at(-1)?.[0] as string);

describe("附加效果弹窗", () => {
    it("标题、搜索框、每一槽的注释、原始值（含小数）都照原样显示", () => {
        renderEditor(JSON.stringify(["2", "4039598841", "0.5", "0", "0", "0", "1", "1", "1039632913", "2", "45", "0", "0", "1", "1"]));

        expect(screen.getByText(t.supportEffectTitle)).toBeTruthy();
        expect(screen.getByPlaceholderText(t.supportEffectSearch)).toBeTruthy();
        // 标签随行：霸体那行第一槽是 duration；没有注释的槽**什么都不显示**（连占位符都没有）。
        expect(screen.getByText("duration")).toBeTruthy();
        expect(screen.queryAllByText("-").length).toBe(0);
        // 小数**打开时原样显示**（不在初始化时归一）。
        expect(valueInput("霸体 4039598841 1").value).toBe("0.5");
        expect(valueInput("双发子弹 1039632913 1").value).toBe("2");
        expect(checkbox("霸体").getAttribute("aria-checked")).toBe("true");
        // 弹窗里没有保存/取消按钮：改动即时写回。
        expect(screen.queryByText(t.cancel)).toBeNull();
    });

    it("打开时不写回；解析失败（[]）按没有效果打开", () => {
        const { onChange } = renderEditor("[]");

        expect(checkbox("霸体").getAttribute("aria-checked")).toBe("false");
        expect(onChange).not.toHaveBeenCalled();
    });

    it("键入的值按整数过滤，改动立刻写回（只含勾中的行）", () => {
        const { onChange } = renderEditor(JSON.stringify(["1", "4039598841", "15", "0", "0", "0", "1", "1"]));

        const input = valueInput("霸体 4039598841 1");
        // 用户键入 "1.5"：小数点被过滤掉（小数只保留在初始化那一份）。
        fireEvent.change(input, { target: { value: "1.5" } });
        expect(input.value).toBe("15");

        expect(onChange).toHaveBeenCalledTimes(1);
        expect(lastWritten(onChange)).toEqual([{ hash: "4039598841", values: ["15", "0", "0", "0", "1", "1"] }]);
    });

    it("点一下勾选就挂上（默认值全 0），空串补 0", () => {
        const { onChange } = renderEditor("");

        fireEvent.click(checkbox("双发子弹"));
        fireEvent.change(valueInput("双发子弹 1039632913 5"), { target: { value: "" } });

        expect(lastWritten(onChange)).toEqual([{ hash: "1039632913", values: ["0", "0", "0", "0", "0", "0"] }]);
    });

    it("已勾选的 buff 置顶，取消勾选后回到原位", () => {
        const { onChange } = renderEditor(JSON.stringify(["1", "1039632913", "2", "45", "0", "0", "1", "1"]));

        expect(rowNames()).toEqual(["双发子弹", "霸体"]);

        fireEvent.click(checkbox("双发子弹")); // 取消勾选
        expect(rowNames()).toEqual(["霸体", "双发子弹"]);

        fireEvent.click(checkbox("霸体")); // 勾上另一个
        expect(rowNames()).toEqual(["霸体", "双发子弹"]);
        expect(lastWritten(onChange)).toEqual([{ hash: "4039598841", values: ["0", "0", "0", "0", "0", "0"] }]);
    });

    it("标题栏输入框按哈希或名字过滤", () => {
        renderEditor("");

        const search = screen.getByPlaceholderText(t.supportEffectSearch);
        fireEvent.change(search, { target: { value: "1039" } });
        expect(rowNames()).toEqual(["双发子弹"]);

        fireEvent.change(search, { target: { value: "霸体" } });
        expect(rowNames()).toEqual(["霸体"]);
    });

    it("右上角 × 关闭只回调 onClose", () => {
        const { onChange, onClose } = renderEditor(JSON.stringify(["0"]));

        fireEvent.click(screen.getByRole("button", { name: "Close" }));
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(onChange).not.toHaveBeenCalled();
    });

    it("这一格里的未知哈希也留一行（否则写回时会丢）", () => {
        const { onChange } = renderEditor(JSON.stringify(["1", "999", "7", "0", "0", "0", "1", "1"]));

        // 未知哈希是勾上的 → 和最前面那组一起置顶。
        expect(rowNames()).toEqual(["999", "霸体", "双发子弹"]);
        fireEvent.change(valueInput("999 999 2"), { target: { value: "8" } });
        expect(lastWritten(onChange)).toEqual([{ hash: "999", values: ["7", "8", "0", "0", "1", "1"] }]);
    });
});
