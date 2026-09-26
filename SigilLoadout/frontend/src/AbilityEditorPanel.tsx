/*
    能力编辑页：一条能力一栏，**一行就是第一档**——这一页只改第一档，游戏里 Lv2/Lv3 保持原值
    （见 ability.ts 的 withFirstValue）。

    这一页刻意只做中文——它读的资产（assets/abilities.json）只有中文，所以文案直接写在组件里，
    不走 messages.ts 的多语言（那一份是给四个页签共用的外壳与因子页准备的）。

    编辑列表与因子编辑页是同一套规矩：按 Key 索引（一个参数行一个 Key，mod 也按 Key 找
    limit_bonus_param 的行）、每次改动把整份列表交给后端防抖落盘（见 abilityservice.go）、读取不写回。

    屏幕上的那一行是**第一档**：左边一格里是各参数行的效果模板（{0} 写成框号 {1}/{2}/{3}），右边并排
    着它们各自的数值框——描述里的第 n 个号就是从左数第 n 个框。一条能力挂几个参数行，一行里就有几个
    框（1..3）：属性类强化有三个参数行（伤害上限 = 普攻/能力/奥义），因此读成一行，而不是叠三行描述
    与三个框。
*/
import { Fragment, memo, useEffect, useRef, useState } from "react";
import { Call, Events } from "@wailsio/runtime";
import { ChevronDown, ChevronRight } from "lucide-react";

import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
    asEdit,
    dedupeCharacters,
    dedupeEdits,
    levelLabel,
    slotsAt,
    valueAt,
    withFirstValue,
    type Ability,
    type AbilityCharacter,
    type AbilityEdit,
    type AbilityParam,
    type AbilityTable,
} from "./ability";
import { slotEdit, stepValue } from "./skills";
import { useWheelStep } from "./useWheelStep";

const SERVICE = "main.AbilityService";
/*
    与 editservice.go 的 saveFailedEvent 是同一个事件（两个服务共用一个写入失败通道）：防抖写入
    发生在请求它的那次调用返回之后，那里的失败没有可返回的答复，只能以这个事件的形式到达。
*/
const SAVE_FAILED = "GBFR.SigilLoadout.SaveFailed";

/*
    表头（已移除）与每一行共用这张列宽表：宽度只在这一处声明。描述那一列吃掉剩下的宽度——它最长，
    而其余两列的内容都是定长的（名字、三个数值槽）。

    勾选框那一列随"有值即启用"一起删掉了（见 ability.ts 的 withFirstValue）：留着空列只会把能力名推右。
    一条能力就是一行，三列各填一格：能力名、描述、那三个槽。

    数值那一列按**固定的三个槽**留宽（3 × 56px 的框 + 3 × 6px 的 `|` 分隔 = 186px）：一个槽对应一个
    参数行，一条强化最多三个。
*/
const COLUMNS = "grid grid-cols-[130px_minmax(160px,1fr)_200px] items-center gap-2";

/**
 * 一个数值框：描述里的 {n} 指的就是它。
 *
 * 半成品文本、提交规则与步进与因子编辑页的十个槽逐字相同（见 skills.ts 的 slotEdit 与 stepValue）
 * ——这里只是借它们解析一个框。
 */
function SlotBox({
    name,
    slot,
    param,
    record,
    onValue,
}: {
    /** 能力名：只在读屏里指认这个框用，屏幕上它就在这一行的左端。 */
    name: string;
    /** 第几个框，从 1 起：描述里的 {n} 是同一个号。 */
    slot: number;
    param: AbilityParam;
    /** 这个参数行的记录；没编辑过就是 undefined。 */
    record: AbilityEdit | undefined;
    /** 这一格算完了一个数：null = 清空（整条记录被删掉，这一行回到没编辑过的样子）。 */
    onValue: (value: number | null) => void;
}) {
    /*
        编辑中的框正在显示的文本，前提是它与已提交数字渲染出来的样子不同："-" 与 "0." 是通往一个数字
        路上的状态（受控输入框没有别的办法显示它们），而一个数字的前缀往往本身也是数字——0.004 用已
        提交的数字渲染会变成 4。
    */
    const [typed, setTyped] = useState<string | null>(null);

    // 这一格有没有用户填过的数：手写过的记录缺第一格（values 是空的）与"没编辑过"一样，显示占位符。
    // 读的永远是记录的第一格——这一页只写、只显示第一档（见 ability.ts 的 valueAt）。
    const committed = record?.values[0];
    // 框里的占位符读的是 Lv1 的数（见 ability.ts 的 valueAt）。
    const shown = valueAt(param, record);

    function step(delta: 1 | -1) {
        setTyped(null);
        onValue(stepValue(shown, delta));
    }

    /*
        滚轮让聚焦的框步进，而列表不能跟着滚——监听器为什么必须是原生的、passive: false 的，见
        useWheelStep。一格只有一个框，所以不必像因子行那样按位置认是哪一个。
    */
    const host = useRef<HTMLDivElement>(null);
    useWheelStep(
        host,
        (target) => document.activeElement === target,
        (_target, delta) => step(delta),
    );

    return (
        <div ref={host} className="min-w-0 flex-1">
            <Input
                type="text"
                inputMode="decimal"
                aria-label={`${name} Lv1 数值 ${slot}`}
                placeholder={String(shown)}
                value={typed ?? (committed === undefined ? "" : String(committed))}
                onChange={(e) => {
                    /*
                        只借 slotEdit 的解析规则（"-" 与 "0." 这类半成品文本、前导零、清空成 null）：起点
                        给 [null] 是因为结果只取 [0]，而"只写第一档"那条规矩在 withFirstValue 里（见
                        ability.ts），不该在这里再写一遍。
                    */
                    const edit = slotEdit(e.target.value, 0, [null]);
                    if (edit.kind === "drop") return;
                    if (edit.kind === "half") {
                        setTyped(edit.text);
                        return;
                    }
                    // 数字已提交，但框保留用户敲的那串文本直到离开它（见 typed 的声明）；清空得到 null。
                    setTyped(edit.keeps ?? null);
                    onValue(edit.values[0]);
                }}
                onBlur={() => setTyped(null)}
                onKeyDown={(e) => {
                    // Escape 让人放开这个框；方向键步进（否则它会把光标移到末尾，列表还会跟着滚）。
                    if (e.key === "Escape") {
                        e.currentTarget.blur();
                        return;
                    }
                    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
                    e.preventDefault();
                    step(e.key === "ArrowUp" ? 1 : -1);
                }}
                /*
                    无边框：框就是行高，读的是数字本身；"这一格能改"由 hover 与 focus 的淡底色回答——
                    指针或焦点落在框上时它才现出来，所以框在静止时像裸文本，却又不是。

                    那两条 dark: 不是重复：框自己的深色底色被 dark:bg-transparent 顶掉之后，深色下
                    focus:bg-muted/50 与它同特异性、又按编译顺序排在后面（见 style.css 里因子页那条同样
                    的取舍），带 dark: 前缀重写一遍才真的盖得住。
                */
                className="h-11! min-w-0 flex-1 border-0 bg-transparent px-0 text-center text-xs md:text-xs tabular-nums shadow-none focus:bg-muted/50 focus-visible:ring-0 dark:bg-transparent"
            />
        </div>
    );
}

/**
 * 一条能力：**就是一行**——能力名、描述、那三个数值槽（合并前是能力行下面再挂一行 Lv1 行）。
 *
 * 这一页只改第一档（见 ability.ts 的 withFirstValue）：Lv2/Lv3 不写也不显示，游戏里保持原值，所以
 * 屏幕上不再有 Lv 字样，能力行自己就是那一档。
 *
 * 描述是各参数行的效果模板连成的一格（见 ability.ts 的 levelLabel），{n} 指着右边第 n 个槽。槽数固定
 * 三（参数的个数上界），缺的那些是空槽——画一个不会有反应的 0，而不是把它们藏起来：一条能力长什么样
 * 在每一条上都该是同一件事（与因子编辑页十个槽并排同理）。
 */
function AbilityRow({
    ability,
    edits,
    onValue,
}: {
    ability: Ability;
    /** 按参数行 Key 索引的全部编辑：这一行自己去取它那几个参数行的。 */
    edits: Map<string, AbilityEdit>;
    /** 某一格算完了一个数：null = 清空（整条记录被删掉，这一行回到没编辑过的样子）。 */
    onValue: (param: AbilityParam, value: number | null) => void;
}) {
    // 这一行的三个槽，按资产里的顺序：从左到右就是描述里的 {1}、{2}、{3}。
    const slots = slotsAt(ability);
    const label = levelLabel(slots);

    return (
        <div className={`${COLUMNS} h-11 border-b pl-8 last:border-b-0`}>
            {/* 能力名用默认前景色：层级交给字号（14 vs 角色名的 16）与 32px 缩进，不靠颜色。 */}
            <span className="truncate text-sm">{ability.name}</span>
            {/*
                描述显示的是模板本身，不是把数值填进去：数字已经在右边的槽里了，说不清的正是哪个槽对
                应效果的哪一部分。颜色比能力名淡（#a0a0a0），一行就是一行高。少数参数行游戏自己没有
                这行文案，那时画一个占位符。
            */}
            <span className="min-w-0 truncate text-sm text-[#a0a0a0]">
                {label === "" ? "—" : label}
            </span>
            <div className="flex items-center">
                {slots.map(({ param, slot }) => (
                    <Fragment key={slot}>
                        {/*
                            每个槽前面一个 |，第一个也不例外：它把数值与描述隔开，方式与数值彼此之间
                            一样（与因子编辑页的 ValueSlots 逐字相同）。
                        */}
                        <span className="shrink-0 text-muted-foreground/40" aria-hidden>
                            |
                        </span>
                        {param === null ? (
                            // 空槽：这条能力没有这个参数行（limit_bonus 的 ParamId2/3 为空），没有可写
                            // 的行，所以显示游戏那边的 0 且不可编辑。
                            <span className="min-w-0 flex-1 text-center text-xs text-[#a0a0a0] tabular-nums select-none">
                                0
                            </span>
                        ) : (
                            <SlotBox
                                name={ability.name}
                                slot={slot}
                                param={param}
                                record={edits.get(param.key)}
                                onValue={(value) => onValue(param, value)}
                            />
                        )}
                    </Fragment>
                ))}
            </div>
        </div>
    );
}

/**
 * 一个角色：一行名字，展开后是它的能力，**默认收起**。
 *
 * 29 个角色全摊开没法看，而这一页的第一件事是挑角色、不是挑能力；展开态由它自己拿着——列表不按
 * 展开态过滤或排序，行卸载时自然回到收起。
 */
function CharacterGroup({
    character,
    edits,
    onValue,
}: {
    character: AbilityCharacter;
    /** 按参数行 Key 索引的全部编辑：一路传给它的能力行。 */
    edits: Map<string, AbilityEdit>;
    onValue: (param: AbilityParam, value: number | null) => void;
}) {
    const [open, setOpen] = useState(false);

    return (
        /*
            组回到**有下边框的默认样式**（border-b，最后一行不画）：分组靠这条线，不靠底色。
            悬停那一层色（#262626）仍给出"这一行能点"。展开的能力住在这个容器里。
        */
        <div className="border-b last:border-b-0">
            <div className="flex h-11 items-center gap-2 pr-4" onClick={() => setOpen((prev) => !prev)}>
                {/* 角色名用默认前景色 */}
                <span className="truncate text-sm font-[550]">{character.name}</span>
                <span className="flex-1" />
                {/*
                    展开箭头在行末，与能力行、因子编辑页一致：一个普通图标、自己没有点击，展开是整行的
                    活——会响应点击的图标会成为同一件事的第二个、更安静的控制。
                */}
                <span
                    aria-hidden
                    className="grid size-7 shrink-0 place-content-center text-muted-foreground"
                >
                    {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                </span>
            </div>
            {open &&
                character.abilities.map((ability) => (
                    <AbilityRow
                        key={ability.abilityId}
                        ability={ability}
                        edits={edits}
                        onValue={onValue}
                    />
                ))}
        </div>
    );
}

function AbilityEditorPanelBase() {
    const [characters, setCharacters] = useState<AbilityCharacter[]>([]);
    const [edits, setEdits] = useState<Map<string, AbilityEdit>>(new Map());
    // 初始列表读过没有。没读过就**绝不写盘**：此时 edits 是空的，交出去的这份空列表会被后端整体替换
    // 掉（同 SigilEditorPanel 的那条规则），用户其余的编辑就没了。
    const [editListRead, setEditListRead] = useState(false);
    const [error, setError] = useState<{ title: string; detail: string } | null>(null);
    const [errorOpen, setErrorOpen] = useState(false);

    // 显示一次失败既记下它，也打开对话框。关闭只是关闭：消息留在 state 里好让退场动画仍有东西可画。
    function showError(next: { title: string; detail: string }) {
        setError(next);
        setErrorOpen(true);
    }

    useEffect(() => {
        void (async () => {
            const [table, list] = await Promise.all([
                Call.ByName(`${SERVICE}.LoadAbilities`) as Promise<AbilityTable | null>,
                Call.ByName(`${SERVICE}.LoadAbilityEdits`) as Promise<AbilityEdit[]>,
            ]);
            const all = dedupeCharacters(table?.characters ?? []);
            setCharacters(all);
            // 只读、不写回：归一化只是为了在屏幕上理顺这份列表，用户文件在下一次真正的编辑之前不该被动过
            // ——"打开一次就等于改过一次"与 App.tsx 那条"启动不写盘"是同一件事。
            setEdits(
                new Map(
                    dedupeEdits(
                        (list ?? [])
                            .map(asEdit)
                            .filter((edit): edit is AbilityEdit => edit !== null),
                    ).map((edit) => [edit.key, edit]),
                ),
            );
            setEditListRead(true);
        })().catch((err) => showError({ title: "读取失败", detail: String(err) }));
        // 只在挂载时跑一次：它读的是启动那一刻的磁盘状态。这一页只有中文，没有语言依赖会把这一跑重新触发。
    }, []);

    /*
        防抖之后才失败的写入由后端推送过来（见 SAVE_FAILED）。它和立即失败共用同一个对话框，因为在
        用户看来它们是同一件事：编辑没有落到磁盘上。On 交回的函数就是 React 在退出时运行的取消订阅。
    */
    useEffect(
        () =>
            Events.On(SAVE_FAILED, (event) => {
                showError({ title: "写入失败", detail: String(event.data) });
            }),
        [],
    );

    /*
        每一次改动都经过这里：屏幕上的列表就是全部状态，也是运行中的游戏最终拿到的东西。前端对"何时
        写入"刻意保持无知——每次变化把整份列表交出去，不等答复；后端的尾随防抖把一串敲键变成一次
        abilityedits.json 写入与一次游戏内的应用。
    */
    function commit(next: Map<string, AbilityEdit>) {
        // 列表还没读回来就不写；不写盘的理由见 editListRead 的声明。
        if (!editListRead) return;
        setEdits(next);
        Call.ByName(`${SERVICE}.SaveAbilityEdits`, [...next.values()]).catch((err) =>
            showError({ title: "写入失败", detail: String(err) }),
        );
    }

    /*
        一个数值框。往还没有编辑的参数行里输入会开始一条记录，**有值就是启用**——这一页没有启用开关，
        所以这里也从不写 enabled: false（见 ability.ts 的 withFirstValue）。

        "只写第一档"在 withFirstValue 里，这里只管两件事：有值时把那一格放回列表；**清空时把整条记录
        删掉**——删掉之后这一行回到完全没编辑过的样子，游戏那边一个字节都没被碰过（不是"还原成默认
        值"：那会留下一条记录）。没有记录时清空是空操作，连一次落盘都不必发生。
    */
    function setValue(param: AbilityParam, value: number | null) {
        const patched = withFirstValue(param, value);
        // 清空一个没编辑过的参数行：Map 里本来就没有它，没有东西可删。
        if (patched === null && !edits.has(param.key)) return;

        const next = new Map(edits);
        if (patched === null) next.delete(param.key);
        else next.set(param.key, patched);
        commit(next);
    }

    // min-w-[640px] 是本页排出来的宽度（列宽表的下限加上页面内边距与滚动条沟槽）：外面那一层面板负责
    // 横向滚动，所以窗口更窄时列是被滚动条推到视野外，而不是被裁掉（同因子编辑页）。
    return (
        <div className="flex h-full min-h-0 min-w-[640px] flex-col page-padding">
            {/*
                ability-rows 是给外壳那记 Esc 用的（见 App.tsx）：焦点在数值框里时，Esc 是"放开这个框"
                （见 SlotBox），不该同时把整个窗口藏到托盘去——与因子编辑页的 .skill-rows 同一条规矩。
                这一页没有用得上它的样式，所以它在这里只是个钩子。
            */}
            <div className="ability-rows min-h-0 flex-1 overflow-y-auto pr-4 [scrollbar-gutter:stable]">
                {characters.map((character) => (
                    <CharacterGroup
                        key={character.id}
                        character={character}
                        edits={edits}
                        onValue={setValue}
                    />
                ))}
                {characters.length === 0 && (
                    <p className="py-6 text-center text-sm text-muted-foreground">没有可强化的条目</p>
                )}
            </div>

            {/*写入失败值得打断用户——编辑没有落到磁盘上，而原因通常要用户自己处理
               (abilityedits.json 被别的程序锁住、文件夹不可写)。
               两种失败都落到这里：立即失败，以及后端推送的防抖失败。*/}
            <AlertDialog open={errorOpen} onOpenChange={setErrorOpen}>
                {/* 不用 size="sm"：那会把页脚切成两列网格，而这个对话框只有一个按钮，应该居中。 */}
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>{error?.title}</AlertDialogTitle>
                        <AlertDialogDescription className="wrap-anywhere">
                            {error?.detail}
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogAction onClick={() => setErrorOpen(false)}>确定</AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </div>
    );
}

/* keepMounted 的一页：memo 住才不会被 App 的重渲染连带（切 Tab 也算）。 */
export const AbilityEditorPanel = memo(AbilityEditorPanelBase);
