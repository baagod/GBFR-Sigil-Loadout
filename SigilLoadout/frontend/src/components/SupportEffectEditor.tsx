/*
    「附加效果」（`supportEffectList_`）的编辑弹窗。

    一格的值是 `[数量, 哈希, 值×6, …]`（见 lib/buffs.ts）。弹窗把它摊成**一行一个 buff**：
    左边勾选这条效果挂不挂，右边 6 个输入框填值，每个框的顶部标出这一槽是什么意思
    —— 注释随 buff 变（同一个 slot 在一个 buff 里是 duration、在另一个里是 range），
    所以标签只能跟着行走，做不了固定表头。

    值的形态：
      · 打开时**原样显示**（源数据里有 `0.5` 这种小数，不能预先归一）；
      · 用户一敲键盘就按整数过滤（`/[^\d-]/g`，见 setValue）—— 这是用户口径，不是数据约束。

    ⚠️ 勾选与值分开存：**编辑输入框不会自动勾上这一行** —— 勾选是明确的动作，没勾的效果不写回。
    ‼️ 没有保存/取消按钮：改动先留在弹窗里，**关窗（× / Esc / 点遮罩）时才写回那一格**；没改就不写。
*/
import { useMemo, useState } from "react";
import { buffName, formatSupportEffects, parseSupportEffects, type BuffInfo } from "@/lib/buffs";
import type { Lang } from "@/lib/lang";
import type { Messages } from "@/lib/messages";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Search } from "lucide-react";

/** 每组固定 6 个值（`1 + 7n` 那个 7 里的 6）。 */
const SLOTS = 6;

type Row = {
    /** 这条 buff 挂不挂。 */
    checked: boolean;
    /** 恒 6 个，原样字符串。 */
    values: string[];
};

/** 没勾的行的初始值：全 0（保存时"未填补 0"同一条口径）。 */
const emptyValues = (): string[] => Array.from({ length: SLOTS }, () => "0");

/**
 * 原始字符串 → 每行状态（按哈希索引；未知哈希也在 `list` 里，见 `rowsOf`）。
 * 解析失败（`null`）按"没有任何效果"打开，不抛错也不显示脏数据。
 *
 * 同一个哈希出现两次时只认第一次：这个弹窗的模型是"一行一个 buff"，一格里重复挂同一个 buff
 * 没有对应的行可以表达 —— 写回时那次重复会消失（数据里没出现过，见 lib/buffs.ts 的严进）。
 */
function initialRows(list: readonly BuffInfo[], raw: string): Map<string, Row> {
    const effects = parseSupportEffects(raw) ?? [];
    const byHash = new Map(effects.map((effect) => [effect.hash, effect.values]));
    const rows = new Map<string, Row>();
    for (const info of list) {
        const values = byHash.get(info.hash);
        rows.set(info.hash, { checked: values !== undefined, values: values ? [...values] : emptyValues() });
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

/** 行状态 → 这一格的 JSON。数量由勾中的行数算；单独一个 "-" 不是数字，按 0 写。 */
function serialize(list: readonly BuffInfo[], rows: ReadonlyMap<string, Row>): string {
    const effects: { hash: string; values: string[] }[] = [];
    for (const info of list) {
        const row = rows.get(info.hash);
        if (!row?.checked) continue;
        effects.push({
            hash: info.hash,
            values: row.values.map((raw) => {
                const trimmed = raw.trim();
                return trimmed === "" || trimmed === "-" ? "0" : trimmed;
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
 * 标签 16px + 输入 20px + 上下留白，固定 44px，所有格子完全等高。
 */
function ValueCell({label, value, ariaLabel, onChange}: {
    label: string;
    value: string;
    ariaLabel: string;
    onChange: (text: string) => void;
}) {
    return (
        /*
            上下与中间的留白都走 8px（`py-2` + `gap-2`），高度由内容算：8 + 16(标签) + 8 + 20(输入) + 8 = 60px。
            不再写死 h-11：写死之后中间那道缝会被 justify-center 分走，上下缝和中间缝就不一样了。
        */
        <div className="flex w-full flex-col justify-center gap-2 rounded-md border border-input bg-input/20 px-2 py-2">
            <span className="h-3 truncate text-[12px] leading-3 text-muted-foreground">{label}</span>
            <input
                value={value}
                onChange={(event) => onChange(event.target.value)}
                inputMode="numeric"
                aria-label={ariaLabel}
                className="h-[14px] w-full bg-transparent p-0 text-sm leading-[14px] outline-none"
            />
        </div>
    );
}

export function SupportEffectEditor({
    value,
    buffs,
    lang,
    t,
    onSave,
    onClose,
}: {
    /** 这一格的原始字符串（`[数量, 哈希, 值×6, …]`）。 */
    value: string;
    /** 全部 buff（已按哈希升序；界面不再排）。 */
    buffs: BuffInfo[];
    lang: Lang;
    t: Messages;
    /** 关窗时才交出去（只写一次；没改就不调）。 */
    onSave: (raw: string) => void;
    /** 关掉弹窗（× / Esc / 点遮罩）—— 关窗即保存。 */
    onClose: () => void;
}) {
    /** 资产里的 buff + 这一格里的未知哈希（见 rowsOf：不补这一行，写回时未知效果会丢）。 */
    const list = useMemo(() => rowsOf(buffs, value), [buffs, value]);
    const [rows, setRows] = useState<Map<string, Row>>(() => initialRows(list, value));
    const [query, setQuery] = useState("");

    /**
     * 关窗时才落盘：把当前行状态序列化，和打开时那份比——**没改就不写**（避免"点开看一眼"也
     * 在动作表里留一条草稿）。比较按解析后的值比，原字符串的空格/格式不算改动。
     */
    const close = () => {
        const raw = serialize(list, rows);
        if (JSON.stringify(parseSupportEffects(raw)) !== JSON.stringify(parseSupportEffects(value))) {
            onSave(raw);
        }
        onClose();
    };

    const setChecked = (hash: string, checked: boolean) => {
        const row = rows.get(hash);
        if (!row) return;
        const next = new Map(rows);
        next.set(hash, { ...row, checked });
        setRows(next);
    };

    /** 改值只改值，**不代勾选**（勾选是一个明确的动作；改了值但没勾 = 这条不挂）。键入只留整数写法。 */
    const setValue = (hash: string, slot: number, text: string) => {
        const row = rows.get(hash);
        if (!row) return;
        const digits = text.replace(/[^\d-]/g, "");
        const next = new Map(rows);
        next.set(hash, { checked: row.checked, values: row.values.map((old, s) => (s === slot ? digits : old)) });
        setRows(next);
    };

    /**
     * 标题栏那个输入框：按哈希子串或名字子串过滤（不区分大小写）。
     * **已勾选的置顶**（两组内部各自保持原顺序）：勾上的那几条就是这次在编辑的东西，不该翻半天找。
     */
    const visible = useMemo(() => {
        const needle = query.trim().toLowerCase();
        const matched = needle
            ? list.filter((info) => info.hash.includes(needle) || buffName(info, lang).toLowerCase().includes(needle))
            : list;
        const checked: BuffInfo[] = [];
        const rest: BuffInfo[] = [];
        for (const info of matched) {
            if (rows.get(info.hash)?.checked) checked.push(info);
            else rest.push(info);
        }
        return [...checked, ...rest];
    }, [list, query, lang, rows]);

    return (
        <Dialog open onOpenChange={(next) => (next ? undefined : close())}>
            {/* 宽度：左名字列 + 6 个值格，官方的 448 装不下 6 列。 */}
            <DialogContent className="flex h-[min(800px,calc(100vh-2rem))] w-[min(1080px,calc(100vw-2rem))] flex-col gap-4 sm:max-w-none">
                <DialogHeader className="gap-3 border-b pb-4">
                    {/* 第一行只放标题与 ×：× 由 DialogContent 绝对定位在右上角，这里留出 pr-8 避开它。 */}
                    <DialogTitle className="text-base font-medium">{t.supportEffectTitle}</DialogTitle>
                    {/* 第二行：搜索占满整行、带放大镜。搜索是这层最常用的动作，单独一行比挤在标题旁边好认。 */}
                    <div className="relative">
                        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                        <Input
                            value={query}
                            onChange={(event) => setQuery(event.target.value)}
                            placeholder={t.supportEffectSearch}
                            aria-label={t.supportEffectSearch}
                            className="w-full pl-8"
                        />
                    </div>
                </DialogHeader>

                <div className="min-h-0 flex-1 overflow-y-auto pr-2" data-testid="support-effect-rows">
                    {visible.map((info) => {
                        const row = rows.get(info.hash);
                        if (!row) return null;
                        const name = buffName(info, lang);
                        const displayName = name || info.hash;
                        return (
                            <div key={info.hash} className="flex items-center border-b py-1.5 pl-2 last:border-b-0">
                                <Checkbox
                                    checked={row.checked}
                                    onCheckedChange={(next) => setChecked(info.hash, next === true)}
                                    aria-label={displayName}
                                />
                                {/* 名字列到第一个输入框 32px（列表容器本身没有 gap，这里自己给）。 */}
                                <div className="ml-3 w-36 min-w-0 shrink-0">
                                    {/* 英文名比中文长：放不下就折行（最多两行），不截断。 */}
                                    <div className="line-clamp-2 text-sm leading-tight break-words">{displayName}</div>
                                    <div className="truncate font-mono text-[12px] text-muted-foreground">{info.hash}</div>
                                </div>
                                <div className="ml-8 grid flex-1 grid-cols-6 gap-2">
                                    {Array.from({ length: SLOTS }, (_, slot) => (
                                        <ValueCell
                                            key={slot}
                                            label={info.labels[slot] ?? ""}
                                            value={row.values[slot]}
                                            ariaLabel={`${displayName} ${info.hash} ${slot + 1}`}
                                            onChange={(text) => setValue(info.hash, slot, text)}
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
