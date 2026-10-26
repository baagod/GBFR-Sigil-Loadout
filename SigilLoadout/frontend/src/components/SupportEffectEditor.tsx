/*
    「附加效果」（`supportEffectList_`）的编辑弹窗。

    一格的值是 `[数量, 哈希, 值×6, …]`（见 lib/buffs.ts）。弹窗把它摊成**一行一个 buff**：
    左边勾选这条效果挂不挂，右边 6 个输入框填值，每个框的顶部标出这一槽是什么意思
    —— 注释随 buff 变（同一个 slot 在一个 buff 里是 duration、在另一个里是 range），
    所以标签只能跟着行走，做不了固定表头。

    值的形态：
      · 打开时**原样显示**（源数据里有 `0.5` 这种小数，不能预先归一）；
      · 用户一敲键盘就按数值文本解析（`slotEdit`，整数/小数都收，见 setValue）；
      · 是否真的改了按**数值**与默认值比较（0 与 0.0 是同一个值），相等就在关窗时当作没改。

    ⚠️ 勾选与值分开存：**编辑输入框不会自动勾上这一行** —— 勾选是明确的动作，没勾的效果不写回。
    ‼️ 没有保存按钮：改动先留在弹窗里，**关窗（取消 / Esc / 点遮罩）时才写回那一格**；没改就不写。
*/
import { useMemo, useRef, useState } from "react";
import { buffName, formatSupportEffects, parseSupportEffects, type BuffInfo } from "@/lib/buffs";
import type { Lang } from "@/lib/lang";
import type { Messages } from "@/lib/messages";
import { slotEdit } from "@/lib/numericText";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Search, X } from "lucide-react";

/** 每组固定 6 个值（`1 + 7n` 那个 7 里的 6）。 */
const SLOTS = 6;

type Row = {
    /** 这条 buff 挂不挂。 */
    checked: boolean;
    /** 恒 6 个：**空串 = 用原值**（输入框只显示原值当占位符，没动过就留空）。 */
    values: string[];
};

/** 没勾/没动过的行：6 个空串 = 全用原值（原值也没有就是 0）。 */
const emptyValues = (): string[] => Array.from({ length: SLOTS }, () => "");
/** 资产里没有的未知哈希没有默认参数，占位值统一取 0。 */
const zeroValues = (): string[] => Array.from({ length: SLOTS }, () => "0");

/**
 * 原始字符串 → 每行状态（按哈希索引；未知哈希也在 `list` 里，见 `rowsOf`）。
 * 解析失败（`null`）按"没有任何效果"打开，不抛错也不显示脏数据。
 *
 * ‼️ 输入框**不预填当前值**：与「这一槽的默认值」（原值，没有则当前角色/全表默认）相同的槽留空，
 * 把默认值交给占位符显示 —— 玩家没动过的格子看起来就是"空的"（灰字是默认值），动过才留下实字。
 *
 * 同一个哈希出现两次时只认第一次：这个弹窗的模型是"一行一个 buff"，一格里重复挂同一个 buff
 * 没有对应的行可以表达 —— 写回时那次重复会消失（数据里没出现过，见 lib/buffs.ts 的严进）。
 */
type Baseline = (hash: string, slot: number) => string

/**
 * 两个槽的文本在**数值上**是否相同：0、0.0、00 是同一个值，用于判断"有没有改"。
 * 不是数字的文本按不同处理；serialize 会把这类值回落成默认值。
 */
function sameNumber(a: string, b: string): boolean {
    const left = Number(a.trim());
    const right = Number(b.trim());
    return a.trim() !== "" && b.trim() !== "" && Number.isFinite(left) && Number.isFinite(right) && left === right;
}

function initialRows(
    list: readonly BuffInfo[],
    raw: string,
    baseline: Baseline,
): Map<string, Row> {
    const effects = parseSupportEffects(raw) ?? [];
    const byHash = new Map(effects.map((effect) => [effect.hash, effect.values]));
    const rows = new Map<string, Row>();
    for (const info of list) {
        const values = byHash.get(info.hash);
        rows.set(info.hash, {
            checked: values !== undefined,
            values: values
                ? values.map((value, slot) => (sameNumber(value, baseline(info.hash, slot)) ? "" : value))
                : emptyValues(),
        });
    }
    return rows;
}

/**
 * 弹窗里的全部行 = 资产里的 buff + **这一格里出现的未知哈希**（资产没收录的）。
 *
 * 未知哈希只显示哈希、没有注释，但必须留一行：不然写回时它会被丢掉 —— 打开弹窗看一眼，
 * 一个原本合法（只是没注释）的效果就没了。顺序：已知的按资产顺序，未知的按第一次出现的顺序。
 */
function rowsOf(buffs: readonly BuffInfo[], raw: string): BuffInfo[] {
    const known = new Set(buffs.map((info) => info.hash));
    const effects = parseSupportEffects(raw) ?? [];
    const unknown: string[] = [];
    for (const effect of effects) {
        if (!known.has(effect.hash) && !unknown.includes(effect.hash)) unknown.push(effect.hash);
    }
    return [...buffs, ...unknown.map((hash) => ({ hash, labels: [], names: {} }))];
}

/**
 * 行状态 → 这一格的 JSON。数量由勾中的行数算。
 * 空输入框回落顺序：该动作的原值 → 默认占位值（见 `baselineOf`，未知哈希是 0）；
 * 非数字文本（含历史遗留的 "-"）也回落默认值；其余按数值与默认值比较（0 与 0.0 不算改）。
 */
function serialize(
    list: readonly BuffInfo[],
    rows: ReadonlyMap<string, Row>,
    baseline: Baseline,
): string {
    const effects: { hash: string; values: string[] }[] = [];
    for (const info of list) {
        const row = rows.get(info.hash);
        if (!row?.checked) continue;
        effects.push({
            hash: info.hash,
            values: row.values.map((raw, slot) => {
                const trimmed = raw.trim();
                const base = baseline(info.hash, slot);
                if (trimmed === "") return base;
                if (trimmed === "-") return base;
                const numeric = Number(trimmed);
                if (!Number.isFinite(numeric)) return base;
                return sameNumber(String(numeric), base) ? base : String(numeric);
            }),
        });
    }
    // 一条都没勾时写回 `["0"]`（数量 0）而不是 `[]`：源数据里"没有效果"的写法就是数量 0。
    return effects.length === 0 ? JSON.stringify(["0"]) : formatSupportEffects(effects);
}

/**
 * 一个值格：上一行是这一槽的注释（12px、单行、超出省略），下一行是数字输入。
 *
 * ‼️ 不用 InputGroup 的 block-start 标签模式：那套自带「输入框 pb-3 / 标签 pt-2」和 h-9 的固定高度，
 * 想按像素收紧就得一路 `!` 覆盖，反而把高度算糊涂（踩过：同排格子高矮不一）。这里就是两行：
 * 标签 12px + 输入 13px，高度由内容撑开；不写死格子高度（同排格子自然等高）。
 */
function ValueCell({label, value, draft, placeholder, ariaLabel, onChange, onBlur}: {
    label: string;
    value: string;
    /** 正在输入、还没成为数字的文本（如 "-"、"0."）：只在焦点里显示，失焦就丢掉。 */
    draft?: string;
    /** 空输入时显示的灰字：这一槽的原值（新加的 buff / 原值没有该槽就是 "0"）。 */
    placeholder: string;
    ariaLabel: string;
    onChange: (text: string) => void;
    onBlur: () => void;
}) {
    return (
        /*
            标签行 12px、输入行 13px，中间 7px、上下各 7px；高度由内容算，不写死 h-11：
            写死之后中间那道缝会被 justify-center 分走，上下缝和中间缝就不一样了。
        */
        <label className="flex w-full cursor-text flex-col justify-center gap-[7px] px-2 pt-[7px] pb-[7px]">
            <span className="h-3 truncate text-[12px] leading-3 text-muted-foreground">{label}</span>
            <input
                value={draft ?? value}
                placeholder={placeholder}
                onChange={(event) => onChange(event.target.value)}
                onBlur={onBlur}
                inputMode="decimal"
                aria-label={ariaLabel}
                className="h-[13px] w-full bg-transparent p-0 text-[13px] leading-[13px] outline-none"
            />
        </label>
    );
}

export function SupportEffectEditor({
    value,
    original,
    charCode,
    buffs,
    lang,
    t,
    onSave,
    onClose,
}: {
    /** 这一格**当前**的字符串（`[数量, 哈希, 值×6, …]`）。 */
    value: string;
    /** 这一格的**原值**：输入框占位符与"没填就用原值"都取自它。 */
    original: string;
    /** 当前角色码（`pl1400` 这种）：buff 的默认参数按角色取。 */
    charCode: string;
    /** 全部 buff（已按哈希升序；界面不再排）。 */
    buffs: BuffInfo[];
    lang: Lang;
    t: Messages;
    /** 关窗时才交出去（只写一次；没改就不调）。 */
    onSave: (raw: string) => void;
    /** 关掉弹窗（取消 / Esc / 点遮罩）—— 关窗即保存。 */
    onClose: () => void;
}) {
    const searchBox = useRef<HTMLInputElement>(null);
    /** 资产里的 buff + 这一格里的未知哈希（见 rowsOf：不补这一行，写回时未知效果会丢）。 */
    const list = useMemo(() => rowsOf(buffs, value), [buffs, value]);
    /** 哈希 → 原值那 6 个槽（输入框占位符 + 空输入的回落值）。 */
    const originalValues = useMemo(
        () => new Map((parseSupportEffects(original) ?? []).map((effect) => [effect.hash, effect.values])),
        [original],
    );
    /**
     * 哈希 → buff 的**默认参数**：同一个 buff 不同角色给的值不一样（防御(自身) 在 PL1400 是 40/30、
     * 在 PL0900 是 50/60），所以先取当前角色那一组，没有再用全表第一组。
     */
    const defaultsOf = useMemo(
        () => (hash: string): string[] => {
            const info = buffs.find((buff) => buff.hash === hash);
            // 资产里的 buff 都有默认值；资产没收录的未知哈希没有，占位值取 0。
            return info?.byChar[charCode.toUpperCase()] ?? info?.values ?? zeroValues();
        },
        [buffs, charCode],
    );
    /** 一槽的基准值：原值 → 默认占位值。打开/写回/输入比较/占位符四处共用这一条。 */
    const baselineOf = (hash: string, slot: number): string => originalValues.get(hash)?.[slot] ?? defaultsOf(hash)[slot];
    const [rows, setRows] = useState<Map<string, Row>>(() => initialRows(list, value, baselineOf));
    /**
     * 正在输入、还没成为数字的文本（"-"、"0."）：键是 `哈希#槽`。它只负责"焦点里显示什么"，
     * 失焦就删掉；模型（rows.values）里永远只存已经成立的值。
     */
    const [drafts, setDrafts] = useState<Map<string, string>>(new Map());
    const [query, setQuery] = useState("");
    /**
     * 打开时那份行状态序列化一次：关窗时按**同一个函数**再算一遍，两份一样就是"没改"
     * —— 不用去比原字符串，原值的排列顺序与空格都不算改动（写回总是按资产顺序排）。
     */
    const openedRaw = useRef<string | null>(null);
    if (openedRaw.current === null) openedRaw.current = serialize(list, rows, baselineOf);

    /** 关窗时才落盘：**没改就不写**（避免"点开看一眼"也在动作表里留一条草稿）。 */
    const close = () => {
        const raw = serialize(list, rows, baselineOf);
        if (raw !== openedRaw.current) onSave(raw);
        onClose();
    };

    const setChecked = (hash: string, checked: boolean) => {
        const row = rows.get(hash);
        if (!row) return;
        const next = new Map(rows);
        next.set(hash, { ...row, checked });
        setRows(next);
    };

    /**
     * 改值只改值，**不代勾选**（勾选是一个明确的动作；改了值但没勾 = 这条不挂）。
     *
     * 输入原样收下，包括与默认值相同的数：输入时拦截会让“默认值 5 → 想打 55”永远打不出来。
     * 半成品（"-"、"0."）只进 `drafts`，不进模型；失焦时草稿清掉，回到模型里的上一个值。
     */
    const setValue = (hash: string, slot: number, text: string) => {
        const row = rows.get(hash);
        if (!row) return;
        const edit = slotEdit(text);
        if (edit.kind === "drop") return;
        const key = `${hash}#${slot}`;
        if (edit.kind === "half") {
            setDrafts((prev) => new Map(prev).set(key, edit.text));
            return;
        }
        const model = edit.value === null ? "" : String(edit.value);
        const shown = edit.value === null ? "" : (edit.keeps ?? String(edit.value));
        const nextRows = new Map(rows);
        nextRows.set(hash, { checked: row.checked, values: row.values.map((old, s) => (s === slot ? model : old)) });
        setRows(nextRows);
        setDrafts((prev) => new Map(prev).set(key, shown));
    };

    const clearDraft = (hash: string, slot: number) => {
        const key = `${hash}#${slot}`;
        setDrafts((prev) => {
            if (!prev.has(key)) return prev;
            const next = new Map(prev);
            next.delete(key);
            return next;
        });
    };

    /**
     * 标题栏那个输入框：按哈希子串或名字子串过滤（不区分大小写）。
     * 排序：**已勾选置顶**；两组内部都是 **原值里有的 → 新加的**；同级按资产顺序（列表原序，稳定排序）。
     */
    const visible = useMemo(() => {
        const needle = query.trim().toLowerCase();
        const matched = needle
            ? list.filter((info) => info.hash.includes(needle) || buffName(info, lang).toLowerCase().includes(needle))
            : list;
        const rank = (info: BuffInfo) => (rows.get(info.hash)?.checked ? 2 : 0) + (originalValues.has(info.hash) ? 1 : 0);
        return [...matched].sort((a, b) => rank(b) - rank(a));
    }, [list, query, lang, rows, originalValues]);

    return (
        <Dialog open onOpenChange={(next) => (next ? undefined : close())}>
            {/* 宽度：左名字列 + 6 个值格，官方的 448 装不下 6 列。 */}
            <DialogContent showCloseButton={false} className="flex h-[min(1080px,calc(100vh-64px))] w-[min(1080px,calc(100vw-40px))] flex-col gap-4 p-5 sm:max-w-none">
                <DialogHeader className="border-b pb-4">
                    <div className="flex items-center">
                        <DialogTitle className="mr-8 shrink-0 text-base font-medium">{t.supportEffectTitle}</DialogTitle>
                        <InputGroup className="mr-4 flex-1">
                            <InputGroupAddon align="inline-start">
                                <Search className="text-muted-foreground" />
                            </InputGroupAddon>
                            <InputGroupInput
                                ref={searchBox}
                                value={query}
                                onChange={(event) => setQuery(event.target.value)}
                                placeholder={t.supportEffectSearch}
                                aria-label={t.supportEffectSearch}
                            />
                            {query !== "" && (
                                <InputGroupAddon align="inline-end">
                                    <InputGroupButton
                                        aria-label={t.clearSearch}
                                        onClick={() => {
                                            setQuery("");
                                            searchBox.current?.focus();
                                        }}
                                    >
                                        <X />
                                    </InputGroupButton>
                                </InputGroupAddon>
                            )}
                        </InputGroup>
                        <Button variant="outline" onClick={close}>{t.cancel}</Button>
                    </div>
                </DialogHeader>

                <div className="min-h-0 flex-1 overflow-y-auto pr-4" data-testid="support-effect-rows">
                    {visible.map((info) => {
                        const row = rows.get(info.hash);
                        if (!row) return null;
                        const name = buffName(info, lang);
                        const displayName = name || info.hash;
                        return (
                            <div key={info.hash} className="flex items-center border-b pl-2">
                                <Checkbox
                                    checked={row.checked}
                                    onCheckedChange={(next) => setChecked(info.hash, next === true)}
                                    aria-label={displayName}
                                />
                                {/* 名字列：随弹窗宽度按 28% 拉伸，夹在 144~280px 之间。
                                    280 是「DMG Increase Based on SBA Gauge (Vane)」在 14px 下的实测宽度（273）。
                                    名字列到第一个输入框 32px（列表容器本身没有 gap，这里自己给）。 */}
                                <div className="ml-3 w-[28%] max-w-[280px] min-w-36 shrink-0">
                                    {/* 英文名比中文长：放不下就折行（最多两行），不截断。 */}
                                    {/* 这个动作**原本就有**的 buff 灰显；其余（新加的、本格之外的）默认白字。 */}
                                    <div
                                        data-buff-name={displayName}
                                        data-original={originalValues.has(info.hash) ? "true" : "false"}
                                        className={`line-clamp-2 text-sm leading-tight break-words ${
                                            originalValues.has(info.hash) ? "text-muted-foreground" : ""
                                        }`}
                                    >
                                        {displayName}
                                    </div>
                                    <div className="truncate font-mono text-[12px] text-muted-foreground">{info.hash}</div>
                                </div>
                                <div className="ml-8 grid flex-1 grid-cols-6 gap-2">
                                    {Array.from({ length: SLOTS }, (_, slot) => (
                                        <ValueCell
                                            key={slot}
                                            label={info.labels[slot] ?? ""}
                                            value={row.values[slot]}
                                            draft={drafts.get(`${info.hash}#${slot}`)}
                                            placeholder={baselineOf(info.hash, slot)}
                                            ariaLabel={`${displayName} ${info.hash} ${slot + 1}`}
                                            onChange={(text) => setValue(info.hash, slot, text)}
                                            onBlur={() => clearDraft(info.hash, slot)}
                                        />
                                    ))}
                                </div>
                            </div>
                        );
                    })}
                </div>
            </DialogContent>
        </Dialog>
    );
}
