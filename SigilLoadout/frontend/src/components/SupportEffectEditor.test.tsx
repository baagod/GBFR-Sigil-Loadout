// @vitest-environment happy-dom
/*
    「附加效果」弹窗：勾选、原值灰显占位、关窗才写回、已勾选置顶、搜索过滤。

    只钉这个弹窗自己的契约（输入框不预填、空输入回落原值、未勾不写），不重复测 lib/buffs 的解析。
*/
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

// vi.mock 会被提升到文件最前：工厂里不能引用外面的变量（React 19 的 act 环境警告）。
vi.mock("../../bindings/sigilloadout/service/actionsservice", () => ({
    LoadBuffs: vi.fn(),
}));

import { SupportEffectEditor } from "@/components/SupportEffectEditor";
import { parseSupportEffects, type BuffInfo } from "@/lib/buffs";
import { messages } from "@/lib/messages";

const t = messages.zh;

afterEach(cleanup);

const buffs: BuffInfo[] = [
    { hash: "4039598841", labels: ["duration", "range", "", "", "", ""], values: ["0", "0", "0", "0", "0", "0"], byChar: {}, names: { zh: "霸体", en: "Stout Heart" } },
    { hash: "1039632913", labels: ["", "", "", "", "1", "1"], values: ["2", "45", "0", "0", "1", "1"], byChar: { PL1400: ["7", "8", "0", "0", "1", "1"] }, names: { zh: "双发子弹", en: "Various" } },
];

/** `original` 不传 = 与 value 相同（最常见的"没改过"）。 */
const renderEditor = (value: string, original: string = value, charCode = "PL0000") => {
    const onSave = vi.fn();
    const onClose = vi.fn();
    render(<SupportEffectEditor value={value} original={original} charCode={charCode} buffs={buffs} lang="zh" t={t} onSave={onSave} onClose={onClose} />);
    return { onSave, onClose };
};

const checkbox = (name: string) => screen.getByLabelText(name) as HTMLButtonElement;
const valueInput = (name: string) => screen.getByLabelText(name) as HTMLInputElement;
const rowNames = () =>
    Array.from(screen.getByTestId("support-effect-rows").children).map((row) => row.querySelector(".text-sm")?.textContent ?? "");
// 弹窗没有右上角 ×（提交与取消都在标题栏），关窗 = 点「取消」。
const close = () => fireEvent.click(screen.getByRole("button", { name: t.cancel }));
const saved = (onSave: ReturnType<typeof vi.fn>) => parseSupportEffects(onSave.mock.calls.at(-1)?.[0] as string);

const RAW = JSON.stringify(["1", "4039598841", "15", "0", "0", "0", "1", "1"]);

describe("附加效果弹窗", () => {
    it("输入框不预填：原值以灰字占位符显示", () => {
        renderEditor(RAW);

        expect(screen.getByText(t.supportEffectTitle)).toBeTruthy();
        expect(screen.getByPlaceholderText(t.supportEffectSearch)).toBeTruthy();
        expect(screen.getByText("duration")).toBeTruthy();

        const input = valueInput("霸体 4039598841 1");
        expect(input.value).toBe("");
        expect(input.placeholder).toBe("15");
        expect(valueInput("霸体 4039598841 2").placeholder).toBe("0");
        expect(checkbox("霸体").getAttribute("aria-checked")).toBe("true");
        // 原本就有的 buff 灰显；不在原值里的默认白字。
        expect(screen.getAllByText("霸体").some((el) => el.className.includes("text-muted-foreground"))).toBe(true);
        expect(screen.getAllByText("双发子弹").every((el) => !el.className.includes("text-muted-foreground"))).toBe(true);
    });

    it("打开不改动：关窗只回调 onClose，不写回", () => {
        const { onSave, onClose } = renderEditor(RAW);

        close();
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(onSave).not.toHaveBeenCalled();
    });

    /* 原值的排列顺序与资产顺序不同，也只是"没改"：写回按资产顺序排，不能因此留一条草稿。 */
    it("打开不改动：原值顺序与资产不同也不写回", () => {
        const reversed = JSON.stringify(["2", "1039632913", "2", "45", "0", "0", "1", "1", "4039598841", "15", "0", "0", "0", "1", "1"]);
        const { onSave } = renderEditor(reversed);

        close();
        expect(onSave).not.toHaveBeenCalled();
    });

    it("改动不会立刻写回；关窗时写一次，空槽回落到原值", () => {
        const { onSave } = renderEditor(RAW);

        fireEvent.change(valueInput("霸体 4039598841 1"), { target: { value: "1.8" } });
        expect(valueInput("霸体 4039598841 1").value).toBe("18");
        expect(onSave).not.toHaveBeenCalled();

        close();
        expect(onSave).toHaveBeenCalledTimes(1);
        expect(saved(onSave)).toEqual([{ hash: "4039598841", values: ["18", "0", "0", "0", "1", "1"] }]);
    });

    it("清空输入框 = 用原值：原样数据不会产生改动", () => {
        const { onSave } = renderEditor(RAW);

        fireEvent.change(valueInput("霸体 4039598841 1"), { target: { value: "20" } });
        fireEvent.change(valueInput("霸体 4039598841 1"), { target: { value: "" } });
        close();
        expect(onSave).not.toHaveBeenCalled();
    });

    it("改输入框不会自动勾选；没勾的行不写回", () => {
        const { onSave } = renderEditor(RAW);

        fireEvent.change(valueInput("霸体 4039598841 1"), { target: { value: "18" } });
        fireEvent.change(valueInput("双发子弹 1039632913 1"), { target: { value: "7" } });
        expect(checkbox("双发子弹").getAttribute("aria-checked")).toBe("false");

        close();
        expect(saved(onSave)).toEqual([{ hash: "4039598841", values: ["18", "0", "0", "0", "1", "1"] }]);
    });

    it("输成默认值等于没改：输入框回到空、关窗不写回", () => {
        const raw = JSON.stringify(["1", "1039632913", "7", "8", "0", "0", "1", "1"]);
        const { onSave } = renderEditor(raw, raw, "PL1400");

        const input = valueInput("双发子弹 1039632913 1");
        expect(input.value).toBe("");
        fireEvent.change(input, { target: { value: "7" } });
        expect(input.value).toBe("");
        close();
        expect(onSave).not.toHaveBeenCalled();
    });

    it("新勾一条（原值里没有）：占位符用 buff 默认参数，写回也是默认值", () => {
        const { onSave } = renderEditor('["0"]');

        expect(valueInput("双发子弹 1039632913 1").placeholder).toBe("2");
        fireEvent.click(checkbox("双发子弹"));
        close();
        expect(saved(onSave)).toEqual([{ hash: "1039632913", values: ["2", "45", "0", "0", "1", "1"] }]);
    });

    it("排序：勾选的置顶，两组内部都是 原 buff → 新加", () => {
        // 原值里只有「双发子弹」；当前值一个都没勾 —— 未选组仍应先列原 buff。
        renderEditor('["0"]', JSON.stringify(["1", "1039632913", "2", "45", "0", "0", "1", "1"]));

        expect(rowNames()).toEqual(["双发子弹", "霸体"]);
    });

    it("默认参数优先取当前角色的那一组（同一 buff 不同角色值不同）", () => {
        renderEditor('["0"]', '["0"]', "PL1400");

        expect(valueInput("双发子弹 1039632913 1").placeholder).toBe("7");
        expect(valueInput("双发子弹 1039632913 2").placeholder).toBe("8");
    });

    it("已勾选的 buff 置顶，取消勾选后回到原位", () => {
        const { onSave } = renderEditor(JSON.stringify(["1", "1039632913", "2", "45", "0", "0", "1", "1"]));

        expect(rowNames()).toEqual(["双发子弹", "霸体"]);

        fireEvent.click(checkbox("双发子弹")); // 取消勾选（它仍是原 buff，未选组里排最前）
        expect(rowNames()).toEqual(["双发子弹", "霸体"]);

        fireEvent.click(checkbox("霸体"));
        expect(rowNames()).toEqual(["霸体", "双发子弹"]);

        close();
        expect(saved(onSave)).toEqual([{ hash: "4039598841", values: ["0", "0", "0", "0", "0", "0"] }]);
    });

    it("搜索框右侧 × 清空搜索", () => {
        renderEditor('["0"]');

        fireEvent.change(screen.getByPlaceholderText(t.supportEffectSearch), { target: { value: "1039" } });
        expect(rowNames()).toEqual(["双发子弹"]);

        fireEvent.click(screen.getByRole("button", { name: t.clearSearch }));
        expect(rowNames()).toEqual(["霸体", "双发子弹"]);
    });

    it("标题栏输入框按哈希或名字过滤", () => {
        renderEditor('["0"]');

        const search = screen.getByPlaceholderText(t.supportEffectSearch);
        fireEvent.change(search, { target: { value: "1039" } });
        expect(rowNames()).toEqual(["双发子弹"]);

        fireEvent.change(search, { target: { value: "霸体" } });
        expect(rowNames()).toEqual(["霸体"]);
    });

    it("这一格里的未知哈希也留一行（否则写回时会丢）", () => {
        const raw = JSON.stringify(["1", "999", "7", "0", "0", "0", "1", "1"]);
        const { onSave } = renderEditor(raw);

        expect(rowNames()).toEqual(["999", "霸体", "双发子弹"]);
        expect(valueInput("999 999 1").placeholder).toBe("7");
        fireEvent.change(valueInput("999 999 2"), { target: { value: "8" } });

        close();
        expect(saved(onSave)).toEqual([{ hash: "999", values: ["7", "8", "0", "0", "1", "1"] }]);
    });
});
