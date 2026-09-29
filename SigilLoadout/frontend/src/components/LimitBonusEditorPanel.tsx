/*
    能力强化页：一条能力一栏，**一行就是第一档**——这一页只改第一档，游戏里 Lv2/Lv3 保持原值
    （见 limitbonus.ts 的 withFirstValue）。

    资产是三份：语言无关的骨架（有哪个角色、哪些能力、默认值多少）、每语言一份按 id 索引的文案、以及
    角色属性（哪一行是哪个属性、属性各自的颜色）。骨架与属性各取一次，**文案跟着界面语言重取**（与因子
    编辑页的 SkillMap 同一条路）。角色名不在这三份里：它由 App 按当前语言取好（charaNames，见
    chara.lang.json 与 loadoutservice.go 的 CharaNames）传下来，专属因子页用的也是它。

    页面自有文案（页签名、空态、两个错误对话框的标题）走 messages.ts；能力名与效果模板来自资产，缺哪条
    就显示哪个 id——不拿中文兜底。

    编辑列表与因子编辑页是同一套规矩：按 Key 索引（一个参数行一个 Key，mod 也按 Key 找
    limit_bonus_param 的行）、每次改动把整份列表交给后端防抖落盘（见 limitbonusservice.go）、读取不写回。

    屏幕上的那一行是**第一档**：左边一格里是当前语言的效果模板（{0} 写成框号 {1}，见 limitbonus.ts 的
    effectLabel），右边是这一栏的数值框（一个参数行一个框），
    描述里的 {1} 就是从左数第一个框。每条能力都是这个版式：能力强化只挂一个参数行，另两个框是空的。
*/
import { memo, useEffect, useState } from "react";


import {
    LoadLimitBonus,
    LoadLimitBonusCharacters,
    LoadLimitBonusEdits,
    SaveLimitBonusEdits,
} from "../../bindings/sigilloadout/service/limitbonusservice";
import { DisclosureChevron } from "@/components/DisclosureChevron";
import { SlotInput } from "@/components/SlotInput";
import {
    asEdit,
    dedupeByName,
    spaceCJKAndLatin,
    dedupeCharacters,
    effectLabel,
    valueAt,
    withFirstValue,
    type Ability,
    type LimitBonusCharacter,
    type LimitBonusEdit,
    type LimitBonusTable,
    type LimitBonusText,
} from "@/lib/limitbonus";
import type { CharaTable } from "@/lib/chara";
import type { Lang } from "@/lib/lang";
import { messages } from "@/lib/messages";
import { dedupeBy } from "@/lib/skills";
import { PanelFailureDialog } from "@/components/PanelFailureDialog";
import { usePanelFailure } from "@/hooks/usePanelFailure";
import { useLangTable } from "@/hooks/useLangTable";

/*
    表头（已移除）与每一行共用这张列宽表：宽度只在这一处声明。描述那一列吃掉剩下的宽度——它最长，
    而其余两列的内容都是定长的（名字、三个数值槽）。

    勾选框那一列随"有值即启用"一起删掉了（见 limitbonus.ts 的 withFirstValue）：留着空列只会把能力名推右。
    一条能力就是一行，三列各填一格：能力名、描述、那三个槽。

    数值那一列**固定 64px**（框占满这一列，里面还有 6px 的 `|` 分隔），其余宽度全给描述列
    （见渲染处），能力强化只有一个参数行。
*/

const COLUMNS = "grid grid-cols-[288px_minmax(160px,1fr)_64px] items-center gap-2";

/*
    数值框的样式：框就是行高（h-11），读的是数字本身，所以静止与聚焦都像裸文本。

    无边框、无聚焦底色（原先那条 focus:bg-muted/50 在深色下被 dark:bg-transparent 压掉、
    只有浅色下可见，两页一起删掉了，见 style.css 里"数值框"那段）。

    dark:bg-transparent 不是重复（WebStorm 会提示删掉，别删）：基础 Input 自带 .dark:bg-input/30，
    两者同特异性，只能靠排在编译产物更后面取胜。

    框内行为（半成品文本、解析规则、滚轮/方向键/Esc）全在共享的 SlotInput 里，不在这里重写。
*/
const SLOT_BOX =
    "h-11! min-w-0 flex-1 border-0 bg-transparent px-0 text-center text-xs md:text-xs tabular-nums shadow-none focus-visible:ring-0 dark:bg-transparent"


/**
 * 一条能力：一行——名字、描述、一个数值框。只改第一档，Lv2/Lv3 不写也不显示（见 limitbonus.ts 的 withFirstValue）。
 * 描述是各参数行的效果模板用空格接起来（框只有一个，框号一律 {1}，见 effectLabel）。
 */
function AbilityRow({
    ability,
    name,
    effects,
    edits,
    onValue,
}: {
    ability: Ability;
    /** 当前语言里的名字；表里没有就显示 Key——不拿别的语言兜底。 */
    name: string;
    /** 效果模板（按参数行的 Key 查）。 */
    effects: Record<string, string>;
    /** 按参数行 Key 索引的全部编辑。 */
    edits: Map<string, LimitBonusEdit>;
    /** 一个框算完了：null = 清空（这一栏名下各参数行各自写回原值）。 */
    onValue: (ability: Ability, value: number | null) => void;
}) {
    // 各参数行的模板用空格接起来（游戏自己就这么写："被回复量+{0}% 回复量+{0}%"）；框只有一个，框号一律 {1}。
    const label = ability.params
        .map((param) => effectLabel(param, effects))
        .join(" ");

    return (
        <div className={`${COLUMNS} h-11 border-b pl-8 last:border-b-0`}>
            {/* 能力名用默认前景色：层级交给字号与缩进，不靠颜色。 */}
            {/*
                名字这一格是定位容器：圆点用 absolute 摆在缩进槽里（-left-4.5、8px 的点 → 与名字正好 10px），
                所以能力名与属性名左对齐；只有能力 / 专属类（bonusType ≠ 0）有点，属性节点没有。
            */}
                <div className="relative min-w-0">
                    {ability.bonusType !== 0 && (
                        <span
                            aria-hidden
                            className="absolute top-1/2 -left-4.5 size-2 -translate-y-1/2 rounded-full bg-[#2b7fff]"
                        />
                    )}
                    {/*
                        名字里的间隔号不再上样式：生成器已经把各语言的写法统一成 U+30FB（・），
                        它在 Noto Sans SC 里本来就是全宽、居中的字形（之前放大 1.15 倍 + mx-1 是为了
                        救中文原文的 U+00B7 —— 那个在微软雅黑下只有 24% 宽）。见 gen/game/display。
                    */}
                    <span className="truncate text-sm">{spaceCJKAndLatin(name)}</span>
                </div>
            {/* 描述是模板本身（不填数值）：数字在右边的框里，说不清的正是哪一段对应哪一个。少数参数行游戏没写文案，画占位符。 */}
            <span className="min-w-0 truncate text-sm text-[#a0a0a0]">
                {label === "" ? "—" : label}
            </span>
            {/* 数值靠右：这一列比"框 + 分隔"宽，靠左时每行的数字离右边缘远近不一。 */}
            <div className="flex items-center justify-end">
                {/*
                    一个节点一个框：节点要么挂 1 条参数行，要么挂 3 条（"全部上限"类），而那 3 条默认值永远
                    相同——游戏就是同一个数同时加到三项上。所以填一个值 = 写给这个节点的全部参数行（见 setValue）。
                */}
                <span className="shrink-0 text-muted-foreground/40" aria-hidden>
                    |
                </span>
                <SlotInput
                    label={`${name} Lv1 数值`}
                    original={valueAt(ability.params[0], edits.get(ability.params[0].key))}
                    value={edits.get(ability.params[0].key)?.values[0] ?? null}
                    onCommit={(value) => onValue(ability, value)}
                    className={SLOT_BOX}
                />
            </div>
        </div>
    );
}

/*
    骨架里角色条目只有 id，颜色在 chara.json 里：界面拿 id 去角色表**一次**取值就拿到颜色（没有第二步
    查找，见下面渲染处传下去的 color）。资产里没这一条时它是 undefined，那一行的名字就继承默认前景色。
*/

/**
 * 一个角色：一行名字，展开后是它的能力，**默认收起**。
 *
 * 29 个角色全摊开没法看，而这一页的第一件事是挑角色、不是挑能力；展开态由它自己拿着——列表不按
 * 展开态过滤或排序，行卸载时自然回到收起。
 */
function CharacterGroup({
    character,
    name,
    color,
    effects,
    abilityNames,
    edits,
    onValue,
}: {
    character: LimitBonusCharacter;
    /** 这个角色在当前语言里的名字；表里没有就显示 PL 码——不拿别的语言兜底。 */
    name: string;
    /** 这个角色的颜色（chara.json 里那一栏）；资产里没这个角色时是 undefined（名字继承默认前景色）。 */
    color: string | undefined;
    /** 当前语言的效果模板：一路传给它的能力行。 */
    effects: Record<string, string>;
    /** 当前语言的能力名。 */
    abilityNames: Record<string, string>;
    /** 按参数行 Key 索引的全部编辑：一路传给它的能力行。 */
    edits: Map<string, LimitBonusEdit>;
    onValue: (ability: Ability, value: number | null) => void;
}) {
    const [open, setOpen] = useState(false);

    return (
        /*
            角色行 44px：`h-11` 与边框**同一层**，Tailwind 默认 border-box，边框从 44px 里扣 1px
            （内容区 43px）。这与因子编辑页的角色行、以及本页能力行的写法一致。

            别写成"外层 div 挂 border-b + 内层 h-11"——那样是 44 + 1 = 45px，比其它页高 1px
            （这条踩过：三页的角色行因此对不齐，行数也数得出来差一截）。
            行高基准：**除通用配装与专精技能的内容行外，一律 44px**。

            Fragment 是因为角色行与展开的能力要并列返回（原先靠那层 border-b 的包装凑成一个根）。
        */
        <>
            <div className="flex h-11 items-center gap-2 border-b" onClick={() => setOpen((prev) => !prev)}>
                {/*
                    属性色直接上在名字上（不再单画一条竖线——那会花）：颜色由游戏六属性决定，而它已经
                    按角色算好写在 chara.json 里，取一个 PL 码就拿到了；缺那一条时名字继承默认前景色。
                */}
                <span
                    className="truncate text-sm font-medium"
                    style={{ color: color }}
                >
                    {name}
                </span>
                <span className="flex-1" />
                {/*
                    展开箭头在行末，与能力行、因子编辑页一致：一个普通图标、自己没有点击，展开是整行的
                    活——会响应点击的图标会成为同一件事的第二个、更安静的控制。
                */}
                <DisclosureChevron open={open} />
            </div>
            {open &&
                dedupeByName(character.bonuses, abilityNames).map((ability) => (
                    <AbilityRow
                        key={ability.key}
                        ability={ability}
                        name={abilityNames[ability.key] ?? ability.key}
                        effects={effects}
                        edits={edits}
                        onValue={onValue}
                    />
                ))}
        </>
    );
}

// 每语言的文案表在 Go 侧只读一次，缓存住：命中就同步落地，换语言不再等一次 IPC（同 SigilEditorPanel 的
// textCache）。
const textCache = new Map<Lang, LimitBonusText>();

/*
    文案还没到手（第一帧、或者这一门语言的资产读不出来）时用的空表：两张表都空，于是能力名显示
    AB_PL1400_06、描述画一个占位符——"缺 key 就是缺"照实显示，而不是拿另一种语言垫上。角色名读的是
    App 传下来的 charaNames，与这份表无关。
*/
const EMPTY_TEXT: LimitBonusText = {
    bonuses: {},
    effects: {},
};

function LimitBonusEditorPanelBase({ lang, charaTable, charaNames }: {
    /** 当前界面语言：资产文案按它取，页面自有文案也按它取（见 messages.ts）。 */
    lang: Lang;
    /** PL 码 → 角色属性（chara.json 的整张表）：由 App 在挂载时取一次，语言无关；取色就从这里一步到位。 */
    charaTable: CharaTable;
    /** PL 码 → 角色名（chara.lang.json）：由 App 按当前语言取好传下来，角色名的唯一来源。 */
    charaNames: Record<string, string>;
}) {
    // 骨架里的角色（语言无关）：挂载时取一次，之后不再变。
    const [characters, setCharacters] = useState<LimitBonusCharacter[]>([]);
    const [edits, setEdits] = useState<Map<string, LimitBonusEdit>>(new Map());
    // 初始列表读过没有。没读过就**绝不写盘**：此时 edits 是空的，交出去的这份空列表会被后端整体替换
    // 掉（同 SigilEditorPanel 的那条规则），用户其余的编辑就没了。
    const [editListRead, setEditListRead] = useState(false);

    const t = messages[lang];
    const { failure, open: failureOpen, setOpen: setFailureOpen, showError } = usePanelFailure(
        t.writeFailed,
    );

    /*
        当前语言的文案：能力名与效果模板都在这一份里（角色名走 App 的 charaNames，不在这里取）。换语言
        就重取（与因子编辑页的 SkillMap 同一条路），缓存住的话命中就同步落地，标签与外层文字同一帧换掉。
    */
    const text = useLangTable<LimitBonusText>(
        lang,
        textCache,
        (code) => LoadLimitBonus(code) as Promise<LimitBonusText | null>,
        EMPTY_TEXT,
        (err) => showError({ title: t.readFailed, detail: String(err) }),
    );

    /*
        骨架与编辑列表只读一次：它们都是语言无关的，换语言不该把屏幕上还没写下去的编辑重读一遍（同
        SigilEditorPanel 里"编辑列表与语言无关，这里刻意不动它"）。
    */
    useEffect(() => {
        void (async () => {
            const [table, list] = await Promise.all([
                LoadLimitBonusCharacters() as Promise<LimitBonusTable | null>,
                LoadLimitBonusEdits() as Promise<LimitBonusEdit[]>,
            ]);
            setCharacters(dedupeCharacters(table?.characters ?? []));
            // 只读、不写回：归一化只是为了在屏幕上理顺这份列表，用户文件在下一次真正的编辑之前不该被动过
            // ——"打开一次就等于改过一次"与 App.tsx 那条"启动不写盘"是同一件事。
            // 一个 Key 一条记录（见 skills.ts 的 dedupeBy），地址就是记录自己的 Key。
            setEdits(
                new Map(
                    dedupeBy(
                        (list ?? [])
                            .map(asEdit)
                            .filter((edit): edit is LimitBonusEdit => edit !== null),
                        (edit) => edit.key,
                    ).map((edit) => [edit.key, edit]),
                ),
            );
            setEditListRead(true);
        })().catch((err) => showError({ title: t.readFailed, detail: String(err) }));
        // 只在挂载时跑一次：它读的是启动那一刻的磁盘状态。这里刻意不读 t——文案在渲染时取，所以没有
        // 语言依赖会把这一跑重新触发。
    }, []);

    /*
        每一次改动都经过这里：屏幕上的列表就是全部状态，也是运行中的游戏最终拿到的东西。前端对"何时
        写入"刻意保持无知——每次变化把整份列表交出去，不等答复；后端的尾随防抖把一串敲键变成一次
        limit_bonus.json 写入与一次游戏内的应用。
    */
    function commit(next: Map<string, LimitBonusEdit>) {
        // 列表还没读回来就不写；不写盘的理由见 editListRead 的声明。
        if (!editListRead) return;
        setEdits(next);
        SaveLimitBonusEdits([...next.values()]).catch(err =>
            showError({ title: t.writeFailed, detail: String(err) }),
        );
    }

    /*
        一个数值框。往还没有编辑的参数行里输入会开始一条记录，**有值就是启用**——这一页没有启用开关，
        所以这里也从不写 enabled: false（见 limitbonus.ts 的 withFirstValue）。

        清空 = **把这一行的 Lv1 原值写回去**（不是"删掉记录"）：游戏不会自己忘掉上一次写入的值，删了
        记录它就会停在旧值上、而界面显示的是默认值——两边对不上（实测的 bug）。
    */
    function setValue(ability: Ability, value: number | null) {
        const next = new Map(edits);
        for (const param of ability.params) {
            next.set(param.key, withFirstValue(param, value ?? param.default));
        }
        commit(next);
    }

    // min-w-[640px] 是本页排出来的宽度（列宽表的下限加上页面内边距与滚动条沟槽）：外面那一层面板负责
    // 横向滚动，所以窗口更窄时列是被滚动条推到视野外，而不是被裁掉（同因子编辑页）。
    return (
        <div className="flex h-full min-h-0 min-w-160 flex-col page-padding">
            {/*
                ability-rows 是给外壳那记 Esc 用的（见 App.tsx）：焦点在数值框里时，Esc 是"放开这个框"
                （见 SlotBox），不该同时把整个窗口藏到托盘去——与因子编辑页的 .skill-rows 同一条规矩。
                这一页没有用得上它的样式，所以它在这里只是个钩子。
            */}
            <div className="ability-rows min-h-0 flex-1 overflow-y-auto pr-4 scrollbar-gutter-stable">
                {characters.map((character) => (
                    <CharacterGroup
                        key={character.id}
                        character={character}
                        name={charaNames[character.id] ?? character.id}
                        color={charaTable[character.id]?.color}
                        effects={text.effects}
                        abilityNames={text.bonuses}
                        edits={edits}
                        onValue={setValue}
                    />
                ))}
                {characters.length === 0 && (
                    <p className="py-6 text-center text-sm text-muted-foreground">{t.noBonuses}</p>
                )}
            </div>

            {/*写入失败值得打断用户——编辑没有落到磁盘上，而原因通常要用户自己处理
               (limit_bonus.json 被别的程序锁住、文件夹不可写)。
               两种失败都落到这里：立即失败，以及后端推送的防抖失败。*/}
            <PanelFailureDialog
                failure={failure}
                open={failureOpen}
                onOpenChange={setFailureOpen}
                okLabel={t.ok}
            />
        </div>
    );
}

/* keepMounted 的一页：memo 住才不会被 App 的重渲染连带（切 Tab 也算）。 */
export const LimitBonusEditorPanel = memo(LimitBonusEditorPanelBase);
