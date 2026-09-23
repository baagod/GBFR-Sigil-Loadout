import { memo, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { Call, Events } from "@wailsio/runtime";
import { X } from "lucide-react";

import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
    InputGroup,
    InputGroupAddon,
    InputGroupButton,
    InputGroupInput,
} from "@/components/ui/input-group";
import { TooltipProvider } from "@/components/ui/tooltip";
import { messages } from "./messages";
import type { Lang } from "./lang";
import { SkillRow, type RowContext } from "./SkillRow";
import { useRowTooltip } from "./useRowTooltip";
import {
    addressOf,
    asEdits,
    dedupe,
    explainAt,
    levelsOf,
    matches,
    pad,
    slotLabel,
    type SigilSkill,
    type SkillText,
    type SkillInfo,
} from "./skills";

const SERVICE = "main.EditService";
/*
    与 editservice.go 的 saveFailedEvent 保持一致：防抖写入发生在请求它的那次调用返回之后，
    那里的失败没有可返回的答复，只能以这个事件的形式到达。
*/
const SAVE_FAILED = "GBFR.SigilLoadout.SaveFailed";

/** 稍早之前的那个值：否则搜索框每敲一个键都要过滤一遍 200 行的列表。 */
function useDebounced<T>(value: T, delay = 150): T {
    const [settled, setSettled] = useState(value);
    useEffect(() => {
        const timer = setTimeout(() => setSettled(value), delay);
        return () => clearTimeout(timer);
    }, [value, delay]);
    return settled;
}

/*
    “因子编辑”这一页：行、说明、搜索、语言都在。它是个 Tab，不自己钉住整个窗口。

    根节点按这一页排出来的宽度（888 DIP）设了下限，外面那一层面板负责横向滚动，所以窗口更窄
    时列是被滚动条推到视野外，而不是被裁掉。
*/
// 每语言的文本表同样在 Go 侧只读一次，缓存住：命中就同步落地，换语言不再等一次 IPC。
const textCache = new Map<Lang, Record<string, SkillText>>();

function SigilEditorPanelBase({ lang }: { lang: Lang }) {
    // 编辑态按**地址**（因子哈希 + 等级）索引：一个地址一条，这个不变量由容器本身保证，
    // 所以没有路径需要手工去重或整体重建列表。
    const [edits, setEdits] = useState<Map<string, SigilSkill>>(new Map());
    // 所选语言对每个因子的说法：名字、概要，以及共享同一段说明的那些连续等级——
    // 大多数只有一段，少数中途换措辞（见 explainAt）。
    const [texts, setTexts] = useState<Record<string, SkillText>>({});
    const [skills, setSkills] = useState<Record<string, SkillInfo>>({});
    // 初始列表读过没有。没读过就**绝不写盘**：此时 edits 是空的，交出去的残缺列表会被后端整体替换
    // （同 editservice.go 的那条注释），用户的其余编辑就没了。
    const [editListRead, setEditListRead] = useState(false);
    const [error, setError] = useState<{ title: string; detail: string } | null>(null);
    const [errorOpen, setErrorOpen] = useState(false);
    // 哪些因子是展开的。数值只落在一个等级上的因子没有可展开的东西，所以只有跨多个等级的
    // 因子会进到这里。
    const [open, setOpen] = useState<Set<string>>(new Set());
    // 列表上的 tooltip 指向哪一行：整套"指针下那一行"的状态与重放都在 useRowTooltip 里，
    // 它是列表这一层唯一的共同状态——行只拿 hoveredRow 跟自己的 id 比一比。
    const {
        hoveredRow,
        listBox,
        keepScroll,
        onPointerMove,
        onPointerLeave,
        onRowPointerEnter,
        onRowPointerLeave,
        closeTooltip,
    } = useRowTooltip<HTMLDivElement>();
    const [query, setQuery] = useState("");
    const search = useDebounced(query);
    // 搜索框本身，好让它的清除按钮能把光标交还给它。
    const searchBox = useRef<HTMLInputElement>(null);

    const t = messages[lang];

    /*
        显示一次失败既记下它，也打开对话框。关闭只是关闭：消息留在 state 里好让退场动画仍有
        东西可画——关掉时清空会让对话框在整个淡出过程中一片空白。
    */
    function showError(next: { title: string; detail: string }) {
        setError(next);
        setErrorOpen(true);
    }

    /*
        因子的名字和说明来自游戏针对所选语言的自有文本。编辑列表与语言无关，这里刻意不动它。
    */
    useEffect(() => {
        const hit = textCache.get(lang);
        if (hit) {
            setTexts(hit);
            return;
        }
        let cancelled = false;
        // 整个语言一次调用，名字、概要、说明都从这一份里读，切换语言不会让它们各自描述不同的表。
        Call.ByName(`${SERVICE}.SkillMap`, lang)
            .then((map) => {
                if (cancelled) return;
                const entry = (map ?? {}) as Record<string, SkillText>;
                textCache.set(lang, entry);
                setTexts(entry);
            })
            .catch((err) => {
                if (cancelled) return;
                showError({ title: t.readFailed, detail: String(err) });
            });
        return () => {
            cancelled = true;
        };
    }, [lang]);

    async function loadAll() {
        const [list, skillTable] = await Promise.all([
            Call.ByName(`${SERVICE}.LoadEdits`) as Promise<SigilSkill[]>,
            Call.ByName(`${SERVICE}.SkillTable`) as Promise<Record<string, SkillInfo>>,
        ]);
        // 不是十六进制的 key 也是用户的一行：留着、用它自己的 hash 当名字，而不是过滤掉——
        // 在这里丢掉它，下一次写入就会把它从 sigiledits.json 里删掉，而一个谁都看不见的编辑
        // 比一个名字只是 hash 的更糟。
        // 文件里有什么就照原样拿什么：同一地址可以有两条编辑，key 也可能是小写。清理是"读取"
        // 这一步的事，原始列表被留着，用来判断文件是否已经说出了可视工具即将显示的内容。
        const raw = (list ?? [])
            .filter((e) => String(e.key ?? "").trim() !== "")
            .map((e) => ({
                ...e,
                // 可视工具提供的每张表都以大写 hash 为键，手写进 sigiledits.json 的 key 可能是小写。
                // 在这里归一化，下面每一次查找才能直接用 key。
                //
                // String() 不是多余的：手改过的文件里 key 可能是数字，那时 toUpperCase 会抛，
                // 整份列表退化成一句笼统的"读取失败"，而不是只坏掉那一行。
                key: String(e.key ?? "").toUpperCase(),
                // 十个槽，数字或 null：短了一截或者一个值都没有的文件用 null 补齐——null 就是游戏
                // 自己的数值，什么都不写入。同理，values 不是数组时要当作空，否则 pad 会把字符串按
                // 字符铺进参槽，看起来就像"用户在这些槽里填过值"。
                values: pad(
                    Array.isArray(e.values)
                        ? e.values.map((v) => (typeof v === "number" && Number.isFinite(v) ? v : null))
                        : [],
                ),
            }));

        // 一个地址一条编辑，且只留编辑（见 asEdits）。**只读，不写回**：归一化只是为了在屏幕上
        // 理顺这份列表，用户文件在下一次真正的编辑之前不该被动过——在读取时发现差异就回写等于
        // "打开一次就等于改过一次"，与 App.tsx 那条"启动不写盘"是同一条规则。
        const loaded = dedupe(asEdits(raw, skillTable ?? {}));
        setEdits(new Map(loaded.map((record) => [addressOf(record.key, record.level), record])));
        setSkills(skillTable ?? {});
        setEditListRead(true);
    }

    useEffect(() => {
        loadAll().catch((err) => showError({ title: t.readFailed, detail: String(err) }));
    }, []);

    /*
        防抖之后才失败的写入由后端推送过来（见 SAVE_FAILED）。它和立即失败共用同一个对话框，
        因为在用户看来它们是同一件事：编辑没有落到磁盘上。语言变化时重新订阅好让标题跟着切换；
        On 交回的函数就是 React 在退出时运行的取消订阅。
    */
    useEffect(
        () =>
            Events.On(SAVE_FAILED, (event) => {
                showError({ title: t.writeFailed, detail: String(event.data) });
            }),
        [lang],
    );

    /*
        游戏有的每个因子，而不只是编辑过的那些：一行就是一个因子，它的勾选框是该因子被编辑的
        等级。找到某个因子是搜索框的活，所以这份列表是总目录，而不是一份新增清单。
    */
    const rows = useMemo(() => {
        const records = [...edits.values()];
        // 两个层级上都是打开的内容排最前：有启用等级的因子排在其余因子之上，因子内部启用的
        // 等级排在它的其他行之上——打开的内容就是游戏正在生效的东西，必须最先被找到。
        // 状态已按地址去重，这里按因子哈希再分一层，供 rows 与各行使用。
        const byKey = new Map<string, SigilSkill[]>();
        for (const record of records) {
            const held = byKey.get(record.key);
            if (held) held.push(record);
            else byKey.set(record.key, [record]);
        }

        const keys = [...Object.keys(texts)];
        // 表里没有的 hash（手写的 sigiledits.json、别的版本留下的编辑）保留而不是丢掉：
        // 列表显示不出来的编辑，就是谁都不知道正在生效的编辑。它和其他因子一起排序。
        for (const key of byKey.keys()) {
            if (!(key in texts)) keys.push(key);
        }

        const needle = search.trim().toLowerCase();

        return keys
            .map((key) => {
                const info: SkillInfo | undefined = skills[key];
                const records = byKey.get(key) ?? [];
                const byLevel = new Map(records.map((record) => [record.level, record]));
                const label = texts[key]?.name ?? key;

                return {
                    key,
                    label,
                    // 父行读概要：它代表整个因子，而概要是游戏对这个因子本身的一句话。
                    summary: texts[key]?.summary ?? "",
                    info,
                    byLevel,
                    enabled: records.some((record) => record.enabled),
                    // 因子显示哪些等级、按什么顺序，是 skills.ts 的事。
                    levels: levelsOf(info, records),
                };
            })
            // 搜索按名字，或按表和 sigiledits.json 给因子编键的 hash——手动把某一行调出来靠后者。
            .filter((row) => matches(row.label, row.key, needle))
            .sort(
                (a, b) =>
                    Number(b.enabled) - Number(a.enabled) ||
                    a.label.localeCompare(b.label, lang === "zh" ? "zh-Hans-CN" : lang),
            );
    }, [edits, texts, skills, search, lang]);

    /**
     * 一个等级的勾选框所开启的编辑：没有任何输入，每个槽都是游戏自己的数值。
     *
     * `enabled` 是调用方"开启一条编辑"的意思：勾选一个等级会把它打开，往里面输入则不会
     * （见 updateLevel）。
     */
    function newRecord(key: string, level: number, enabled: boolean): SigilSkill {
        return {
            enabled,
            key: key,
            level: level,
            // 没碰过的槽是 null，会把游戏自己的数值留在原处——勾选一个等级却什么都不改就等于什么都不写。
            values: pad([]),
        };
    }

    /*
        一个等级的勾选框。该地址还没有编辑时，勾选它就是创建一条；取消勾选会关掉这条编辑并保留
        它的数值——带用户输入数值的关闭记录仍会被保存（见 isEdit），只是不生效。取消一条没有
        任何用户输入的记录等于没有编辑，commit 会把它丢掉。
    */
    function toggleLevel(key: string, level: number) {
        keepScroll();
        const address = addressOf(key, level);
        const existing = edits.get(address);
        if (!existing) {
            commit(new Map(edits).set(address, newRecord(key, level, true)));
            return;
        }
        commit(new Map(edits).set(address, { ...existing, enabled: !existing.enabled }));
    }

    /*
        表头勾选框代表整个因子：把该因子显示的所有等级一并打开，也一并关闭。第一次点击还会让
        这些等级诞生——没人编辑过的因子还没有任何行，而勾选表头就是关于它们全体的一句话。
    */
    function toggleSkill(key: string, nextChecked: boolean) {
        keepScroll();
        const next = new Map(edits);
        for (const [address, record] of next) {
            if (record.key === key) next.set(address, { ...record, enabled: nextChecked });
        }
        if (nextChecked) {
            const mine = [...next.values()].filter((record) => record.key === key);
            for (const level of levelsOf(skills[key], mine)) {
                const address = addressOf(key, level);
                if (!next.has(address)) next.set(address, newRecord(key, level, true));
            }
        }
        commit(next);
    }

    /*
        一个数值框。往还没有编辑的等级里输入，会像勾选它的勾选框一样开始一条编辑——但不会把它
        打开：这些数值是用户的、会被保存，而勾选框才是把它们送进游戏的动作。输入过却从未生效的
        编辑，是列表明确显示出来的状态（它的勾选框是空的），不是意外。

        只有第一次敲键保持滚动：创建记录可能让光标所在的那一行重排，之后每次敲键都只是在原地改数值。
    */
    function updateLevel(key: string, level: number, patch: Partial<SigilSkill>) {
        const address = addressOf(key, level);
        const existing = edits.get(address);
        if (!existing) {
            keepScroll();
            commit(new Map(edits).set(address, { ...newRecord(key, level, false), ...patch }));
            return;
        }
        /*
            只打补丁，绝不在这里碰 enabled——它是用户勾选出来的。

            清空最后一个数值之后这条记录还算不算编辑，由 skills.ts 的 isEdit（"勾选了，或者带着
            数字"）说了算，而 commit 的每条路径都经过 asEdits。在这里再写一遍那条规则就等于只按
            后半句判断：勾选着的记录会因为输入框被清空而丢掉勾选，于是也掉出置顶区——用户明确按下
            的那一下被一次输入框操作撤销了。
        */
        commit(new Map(edits).set(address, { ...existing, ...patch }));
    }

    function toggleOpen(key: string) {
        setOpen((prev) => {
            const next = new Set(prev);
            if (!next.delete(key)) next.add(key);
            return next;
        });
    }

    /*
        整行是它内部控件的快捷方式：点在**控件上**才让控件自己处理，点在行的其余任何位置
        （文字、箭头、空白）都算点在行上。

        判据用元素本身，不用 data-slot：行里的控件就是十个数值框与那个勾选框，而它们是 <input>
        与 <span role="checkbox">（Base UI 的 Checkbox 不渲染成 button，所以这里不能只写
        button）。拿 data-slot 当"这是控件"的代理就得处理"最近的 data-slot 元素在不在这一行里"
        ——列表外面也有 data-slot（面板整个包在 TabsPanel 里），代理于是把每一行都判成控件、
        整行再也点不开。语义判据没有这个歧义。
    */
    const isControl = (e: MouseEvent<HTMLElement>) =>
        !!(e.target as HTMLElement).closest("input, button, [role='checkbox']");

    /*
        每一次编辑都经过这里：屏幕上的列表就是全部状态，也是运行中的游戏最终拿到的东西。不是
        编辑的在途中就被丢掉（asEdits）——勾选一个等级再取消不会留下任何东西，而清空一条编辑的
        所有框会把整条编辑带走。

        前端对"何时写入"刻意保持无知：每次变化把整份列表交出去，不等答复；后端的尾随防抖把一串
        敲键变成一次 sigiledits.json 写入和一次在线应用，只有完全无法被接受的列表才会作为值得
        打断用户的失败回来。
    */
    function commit(next: Map<string, SigilSkill>) {
        // 列表还没读回来就不写，理由见上面 editListRead 的声明。
        if (!editListRead) return;
        // 状态本身就是按地址去重的容器，不必再跑一遍 dedupe。归一化仍走 asEdits，好让"同一条
        // 记录连着两次提交"得到逐字节相同的结果。
        const kept = asEdits([...next.values()], skills);
        setEdits(new Map(kept.map((record) => [addressOf(record.key, record.level), record])));
        Call.ByName(`${SERVICE}.SaveEdits`, kept).catch((err) =>
            showError({ title: messages[lang].writeFailed, detail: String(err) }),
        );
    }

    /*
        一行显示的说明：覆盖它所在等级的那段措辞（见 explainAt），其中每个 {N} 改写成它对应的
        槽号（见 slotLabel）。

        游戏的占位符从 0 开始（{0} 是第一个数值）；行里显示的是数字，所以 tooltip 把第一个写成
        {1}，让读者顺着数下去。把数值替换进去是错的：数字已经在屏幕上了，不明显的是哪个数字对应
        哪一部分。
    */
    function slotNotation(key: string, level: number): string {
        return slotLabel(explainAt(texts[key]?.explain, level));
    }

    /*
        一行需要从这里拿的一切装在一个对象里，行本身住在 SkillRow.tsx——它们不该知道列表如何
        过滤、排序、保存。
    */
    const rowCtx: RowContext = {
        t,
        notationOf: slotNotation,
        rest: onRowPointerEnter,
        leave: onRowPointerLeave,
        toggleLevel,
        toggleSkill,
        toggleOpen,
        updateLevel,
        isControl,
    };

    return (
        <div className="flex h-full min-h-0 min-w-[888px] flex-col px-5 pt-4 pb-6">
            {/*
                列表上方的一条横带：如何从中找到因子，以及语言切换——它一直待在那个角落。
                下面的一切都归行所有。
            */}
            <div className="flex shrink-0 items-center gap-2 border-b pb-4">
                {/*
                    没有标题：搜索框已经说明了这条横带是干什么的，而一个编辑计数会把两件不同的事
                    ——开着的有哪些、记录一共有几条——混进一个分数里。下面的列表就是整个总目录，
                    浏览它就是搜索它；输入经过防抖（useDebounced）才到列表，这是两百行列表不会每次
                    敲键都重建的原因。
                */}
                <div className="min-w-0 flex-1">
                    <InputGroup>
                        <InputGroupInput
                            ref={searchBox}
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            placeholder={t.searchSigil}
                            aria-label={t.searchSigil}
                        />
                        {/*
                            一个清除按钮，只在有东西可清时出现，而且光标要回到框里：刚被点击的就是这个按钮，
                            它马上就会消失，没有这一步下一次敲键就不知去向。
                        */}
                        {query !== "" && (
                            <InputGroupAddon align="inline-end">
                                <InputGroupButton
                                    size="icon-xs"
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
                </div>

                {/*
                    语言开关不在这里：整个可视工具只有外壳右上角那一组。这一页原来带着自己的三个按钮，
                    合并成"因子编辑" Tab 之后，同一窗口里放两套互不同步的语言状态只会让人困惑，
                    那一组连同它自己的 localStorage 一起删掉了，语言由 App 传进来。
                */}
            </div>

            {/*
                行在离滚动条 16px 处停下，而且无论列表是否溢出，滚动条宽度都被预留。过滤到只剩一行会让
                滚动条消失，不预留这条沟槽的话每行都加宽一个滚动条宽度，清空搜索时又弹回去——实测行边缘
                在 772 -> 787 px 之间移动。

                表格上下的 24px 在滚动盒之外（是 margin，不是 padding）：padding 会成为可滚动区域的一部分，
                滚动条就会从 padding 的边缘开始而不是从第一行开始。这里只有上面那一份——外壳 padding 的
                底部设成同样的 24px——所以滚动条离横带和离窗口边缘是一样的距离。

                这里用 class 而不是 data-slot：行的点击处理把任何带 data-slot 的祖先当成控件（勾选框或
                数值框上的点击就是靠这个保住自己的点击的），所以这个容器上挂 data-slot 会吞掉所有点在行上
                的点击，因子就打不开了。
            */}
            <div
                ref={listBox}
                className="skill-rows mt-6 min-h-0 flex-1 overflow-y-auto pr-4 [scrollbar-gutter:stable]"
                onPointerMove={onPointerMove}
                onPointerLeave={onPointerLeave}
                onScroll={closeTooltip}
            >
                {/*
                    整个列表共用一个 provider：哪个 tooltip 打开由这里决定（见 useRowTooltip），所以
                    base-ui 自己的打开/关闭时序根本不起作用——provider 剩下的用处是每行共用的其余设置。
                */}
                <TooltipProvider>
                    {rows.map((row) => (
                        <SkillRow
                            key={row.key}
                            row={row}
                            hoveredId={hoveredRow}
                            isOpen={open.has(row.key)}
                            ctx={rowCtx}
                        />
                    ))}
                </TooltipProvider>

                {rows.length === 0 && (
                    <p className="py-6 text-center text-sm text-muted-foreground">
                        {t.noMatch}
                    </p>
                )}
            </div>

            {/*
                写入失败值得打断用户——编辑没有落到磁盘上，而原因通常要用户自己处理
                （sigiledits.json 被别的程序锁住、文件夹不可写）。两种失败都落到这里：立即失败，
                以及后端推送的防抖失败。关闭只是关闭：消息留到下一条失败把它替换掉，淡出时仍有东西可画。
            */}
            <AlertDialog
                open={errorOpen}
                onOpenChange={setErrorOpen}
            >
                {/* 不用 size="sm"：那会把页脚切成两列网格，而这个对话框只有一个按钮，应该居中。 */}
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>{error?.title}</AlertDialogTitle>
                        <AlertDialogDescription className="wrap-anywhere">
                            {error?.detail}
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    {/* 现成的页脚和按钮：sm 断点以下纵向排列，按钮自己撑开，我们不设自己的宽度。 */}
                    <AlertDialogFooter>
                        <AlertDialogAction onClick={() => setErrorOpen(false)}>{t.ok}</AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </div>
    );
}

/* keepMounted 的一页：memo 住才不会被 App 的重渲染连带（切 Tab 也算）；hover 状态在
     useRowTooltip 里，不受影响。 */
export const SigilEditorPanel = memo(SigilEditorPanelBase);
