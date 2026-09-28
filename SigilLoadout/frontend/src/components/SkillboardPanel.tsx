/*
    专精技能页（第一版）：只做「专精类型」（图 1），只做炎帝，只有中文。

    一个**专精类型**占一个标题（如「真谛：红莲之刃」），它下面挂着这个类型自己的 1~3 阶技能——每阶
    一行，行首用 ♦ / ♦♦ / ♦♦♦ 表示，行上是这一阶的十个数值槽。

    版式照**因子编辑**：数值槽靠右、占满剩余宽度，槽之间用 | 分隔；说明文字放进**悬停**，悬停挂在
    **整行**上（照 SkillRow 的写法：触发器渲染成 div，因为行里有输入框，交互内容不能住在 button 里）。

    数值框里只显示**用户填过的数**：没编辑过的那一槽是空框，游戏原值当占位符（与角色强化页同一套）。
    悬停里的说明则填"这一槽现在等于多少"（填过用填的，没填过用游戏原值），{i} 指第 i+1 个槽。

    编辑记法与因子编辑页相同：values[i] = null 表示"那一槽不动"。
*/
import { Fragment, memo, useEffect, useState } from "react";

import {
    LoadSkillboard,
    LoadSkillboardCharacters,
    LoadSkillboardEdits,
    SaveSkillboardEdits,
} from "../../bindings/sigilloadout/service/skillboardservice";
import { Input } from "@/components/ui/input";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { cn } from "cn";
import type { Lang } from "@/lib/lang";
import type { CharaTable } from "@/lib/chara";

// 一个节点：key = 改哪一行（挂的参数行），rowKey = 看哪段字（自己那一行），两件事。
// diamonds = 游戏在这一行前面画几个 ♦（生成器已从原文的 <d> 数出来）。
type Row = { key: string; rowKey: string; diamonds: number; values: number[] };
// 该专精类型包含的一个阶（1 阶 / 2 阶 / 3 阶 / EX），label 就是"1阶"这类标签。
type Skill = { key: string; label: string; rows: Row[] };
// 一个专精类型：rows 是类型自己的三条说明（界面上画 ♦ / ♦♦ / ♦♦♦），skills 是它包含的四个阶。
type Type = { typeIndex: number; nameKey: string; rows: Row[]; skills: Skill[] };
type Character = { id: string; types: Type[] };
type Skeleton = { characters: Character[] };
type Text = { names: Record<string, string>; lines: Record<string, string> };

// 类型自己的三条说明画 ♦ / ♦♦ / ♦♦♦，阶里的条目一律一个 ♦（照游戏的画法）。
const diamonds = (tier: number) => "♦".repeat(tier + 1)

// 游戏给每一阶留的等级槽数（与生成器的 Value1..Value10 对齐）。
const SLOTS = 10

// 数值框的样式取因子编辑页那一套（SkillRow 与角色强化页用的是同一个类）。
const SLOT =
    "min-w-0 flex-1 border-0 bg-transparent px-0 text-center text-xs md:text-xs tabular-nums shadow-none focus-visible:ring-0 dark:bg-transparent"

// ♦ 的颜色：所有行一致（专精特化技能那几条也不变）。
const DIAMOND_COLOR = "#cbd5e1"

// 专精特化技能（专精类型自己那几条）的**文字**颜色：跟游戏里那几条的浅米白一致，
// 把这一组和阶里的条目区分开。♦ 不着这个色——它保持 DIAMOND_COLOR。
const TYPE_SKILL_COLOR = "#eeeebe"

/*
    专精页里所有行的上下留白：只有这一个来源（py-1.5 = 上下各 6px），不加 min-height。

    行高构成：
      单行说明 = 一行文字（leading-5 = 20px） + 12px = 32px
      数值行   = 输入框（见 SLOT_HEIGHT 的说明） + 12px = 32px  ← 与单行说明**严格同高**
      多行说明 = 每多一行加 20px（自己长高，留白不变）

    为什么不用 min-h 凑高度：单行内容只有 20px，若把行高钉在 40px，多出来的 20px 会摊成上下各约
    10px 的空隙，再叠上 padding 就成了 12~13px；而多行时按 padding 走（6px）。两种行看着就不一样
    —— 这正是"一行和多行间距不一致"的来源。
*/
const ROW_PAD_Y = "py-1.5"
const ROW_BOX = `${ROW_PAD_Y}`

// 数值框：高度必须自己定死。Input 的默认类是 h-9（36px）+ py-1 + text-base/md:text-sm，三件事一起
// 把框撑到 41px；只写 h-8 时 flex 的 stretch 还会把它拉成整行高。所以除了高度还要 self-center，
// 再把 py 与字号收掉——32px 的行里要留得下 20px 的框（与说明文字那一行等高）。
const SLOT_HEIGHT = "h-5! self-center border-0 py-0 text-xs md:text-xs"

// 说明文字里的分隔符：照「角色强化」处理 "攻击DOWN抗性" 那一套（见 lib/limitbonus.ts 的
// spaceCJKAndLatin），在 CJK 与 [xxx] 的边界补一个空格，写进文本本身而不是靠 CSS 留白。
// 两个要求一起满足：行内的分隔符与相邻汉字分开、不再挤；行首/行尾不带空白——
// 因为开头左边、结尾右边根本没有 CJK 邻居可配对。
// 必须**整体**处理 [xxx]：分两遍先配 CJK→[、再配 ]→CJK 的话，第二遍会把 [征 这种"外侧已到位"
// 的邻居也算进去，得到 "[ 征战之剑 ]"（内侧凭空多空格）。
// CJK 区间与 spaceCJKAndLatin 保持一致，这里不跨模块引一个字符串常量。
const CJK_RANGES = "\\u2e80-\\u9fff\\u3000-\\u303f\\uff00-\\uffef\\uac00-\\ud7af"
const CJK = new RegExp(`[${CJK_RANGES}]`)
const CJK_OR_GROUP = new RegExp(`[${CJK_RANGES}]|\\[[^\\]]*\\]`, "g")
const GROUP_THEN_CJK = new RegExp(`(\\])([${CJK_RANGES}])`, "g")

export const spaceBrackets = (text: string): string =>
    text
        // 在 [xxx] 左侧补：只有它左边紧邻的**前一个字符**是 CJK 时才补（行首没有前一个字符，天然不补）。
        .replace(CJK_OR_GROUP, (token, offset: number) =>
            token.startsWith("[") && offset > 0 && CJK.test(text[offset - 1]) ? ` ${token}` : token)
        // 在 [xxx] 右侧补：只有它右边紧邻的**后一个字符**是 CJK 时才补（行尾同理天然不补）。
        .replace(GROUP_THEN_CJK, "$1 $2")

/*
    间隔号不再在渲染时替换：生成器已经把各语言的写法统一成 U+30FB（见 gen/game/display），
    资产里的数据本身就是「・」。这里只要保证整段说明包在**一个** span 里——提示框弹层是
    inline-flex，平级返回多个节点会被拆成多个 flex 子项、文字排成好几列（踩过的坑）。
*/
const renderMarks = (text: string) => <span className="inline">{text}</span>

// 一个数值框：照角色强化页的 SlotBox——敲进去的那串文本在离开框之前一直显示（所以能删空、能清空），
// 空框时显示游戏原值当占位符；离开框之后回到"以记录为准"的样子。
// 数值框：照角色强化页的 SlotBox，但高度压到与说明行一致（见 SLOT_IN_ROW）——专精页一行里说明和
// 十个框要齐平，用整页的 h-11 会把数值行撑得比说明行高。
function Slot({ original, value, onInput, className }: {
    original: number
    value: number | null
    onInput: (raw: string) => void
    className?: string
}) {
    const [typed, setTyped] = useState<string | null>(null)
    return (
        <Input
            className={cn(SLOT, className)}
            inputMode="decimal"
            placeholder={String(original)}
            value={typed ?? (value === null ? "" : String(value))}
            onChange={event => {
                setTyped(event.target.value)
                onInput(event.target.value)
            }}
            onBlur={() => setTyped(null)}
        />
    )
}

// 说明里的 {i} 换成第 i+1 个槽当前等于多少（填过用填的，没填过用游戏原值）。
// 下标是**一位或两位**（文案里出现过 {10}、{20}）；超出十个槽的那些原样留着。
// 顺带脱掉 <d> —— 游戏富文本里的内联图标标记，界面上没有对应图标，留着会显示成一串尖括号。
function lineText(template: string, values: (number | null)[]): string {
    return template
        .replace(/<d>/g, "")
        .replace(/\{(\d+)\}/g, (whole, digits) => {
            const value = values[Number(digits)]
            return value === null || value === undefined ? whole : String(value)
        })
}

// 行首那几个 <d>（= 游戏画几个 ♦）已经由生成器数成 Row.Diamonds，这里不再解析。
// 「专精效果中」「专精生效时」这两个条件前缀也已经在生成器里剥掉，界面拿到的是正文。

function SkillboardPanelBase({ lang, charaNames, charaTable }: {
    lang: Lang;
    charaNames: Record<string, string>;
    charaTable: CharaTable;
}) {
    const [skeleton, setSkeleton] = useState<Skeleton | null>(null)
    const [text, setText] = useState<Text | null>(null)
    const [edits, setEdits] = useState<Map<string, (number | null)[]>>(new Map())

    /*
        展开态用 Accordion，但**受控**：值来自组件自己的 state，并给 Root/Panel 都带上 keepMounted。

        受控是让行为不依赖 Accordion 内部 store；keepMounted 保证收起时面板的 DOM 不被卸载。

        **但这两条都不是"切页回来又展开"的根因**。真正的根因在 ui/accordion.tsx 的 AccordionContent：
        shadcn 生成的那行用了 `animate-accordion-down/up`，而 Tailwind v4 早已不内置这两个关键帧
        （style.css 里没有、构建产物 CSS 里也没有），于是收起/展开一直是硬切，被 display:none 藏过
        之后再显示回来就要重新量一次高度——那才是抖。改成官方文档的 transition-[height] 写法即可。
    */
    const [expanded, setExpanded] = useState<Set<string>>(new Set())
    const toggleExpanded = (key: string) =>
        setExpanded(prev => {
            const next = new Set(prev)
            if (next.has(key)) next.delete(key)
            else next.add(key)
            return next
        })

    // Accordion 的 onValueChange 只给"现在打开着哪些"，自己跟上一层比出**动的是哪一个**。
    const toggledKey = (prevOpen: string[], nextOpen: string[]) =>
        nextOpen.find(v => !prevOpen.includes(v)) ?? prevOpen.find(v => !nextOpen.includes(v)) ?? null

    // 角色整块的收起态：默认全展开，所以记的是"收起来的那些"。
    const [collapsedCharacters, setCollapsedCharacters] = useState<Set<string>>(new Set())
    const toggleCharacter = (id: string) =>
        setCollapsedCharacters(prev => {
            const next = new Set(prev)
            if (next.has(id)) next.delete(id)
            else next.add(id)
            return next
        })

    /*
        这一页自己就是滚动的那个盒子（h-full min-h-0 flex-col，同另外三页）。

        曾经在这里加过一段"用 ResizeObserver 把 scrollTop 放回去"的补救代码，用来绕过切页时滚动
        被夹到 0 的现象。撤掉了：那是 Accordion 高度硬切（见 ui/accordion.tsx 的说明）造成的连带
        现象，根因修好之后浏览器自己的滚动锚定就够了，不需要多一层。
    */

    // 挂载时读一次：骨架、当前语言的文案、编辑列表。三者到齐之前不画（更不写盘）。
    useEffect(() => {
        let alive = true
        Promise.all([
            LoadSkillboardCharacters() as Promise<Skeleton | null>,
            LoadSkillboard(lang) as Promise<Text | null>,
            LoadSkillboardEdits() as Promise<{ key: string; values: (number | null)[] }[] | null>,
        ]).then(([loaded, loadedText, loadedEdits]) => {
            if (!alive) return
            setSkeleton(loaded)
            setText(loadedText)
            const map = new Map<string, (number | null)[]>()
            for (const edit of loadedEdits ?? []) map.set(edit.key, edit.values)
            setEdits(map)
        })
        return () => { alive = false }
    }, [lang])

    // 编辑里那一槽的值：null = 用户没填过（框里就是空的，原值只当占位符）。
    //
    // 记录里的值**等于游戏原值**也算"没填过"：清空一槽时按规矩要把原值写回游戏（否则游戏停在旧值
    // 上），那会留下一条"值就是原值"的记录——它不该让界面一启动就显示成编辑状态，更不该被将来某份
    // 残留的编辑文件点着。所以判据是"和原值不一样"，不是"记录在不在"。
    function editAt(row: Row, slot: number): number | null {
        const value = edits.get(row.key)?.[slot] ?? null
        if (value === null || value === row.values[slot]) return null
        return value
    }

    // 这一行的十个槽"现在等于多少"：填过用填的，没填过用游戏原值。悬停里的说明按它填。
    function effective(row: Row): (number | null)[] {
        return Array.from({ length: SLOTS }, (_, slot) => editAt(row, slot) ?? row.values[slot] ?? null)
    }

    function setSlot(row: Row, slot: number, raw: string) {
        // 空串 = 清空这一槽：写回游戏原值（游戏不会自己忘掉上一次写入的值，与角色强化页同一条规矩）。
        const value = raw.trim() === "" ? row.values[slot] : Number(raw)
        if (value === null || Number.isNaN(value)) return
        const next = new Map(edits)
        // 交出去的永远是**完整的十个值**（没动过的格子交游戏原值）：原生按连续前缀写，中间挖空写不了。
        // 界面判"这一格填过没有"靠的是"值 ≠ 原值"（见 editAt），所以整行交满不影响显示。
        const values = [...effective(row)]
        values[slot] = value
        next.set(row.key, values)
        setEdits(next)
        SaveSkillboardEdits([...next].map(([key, v]) => ({ key, values: v }))).catch(() => {})
    }

    if (!skeleton || !text) return <div className="p-6 text-sm text-muted-foreground">Loading…</div>

    // 十个数值框：展开后才铺出来。框自己是 h-8（输入框有 padding，min-height 撑起来的是另一种高度），
    // 所以传字面量而不是 ROW_BOX；行容器仍吃 ROW_BOX，上下留白与说明行一致。
    const valuesOf = (row: Row) => (
        <div className={`flex items-center ${ROW_BOX}`}>
            {Array.from({ length: SLOTS }, (_, slot) => {
                const edited = editAt(row, slot)
                return (
                    <Fragment key={slot}>
                        {slot > 0 && (
                            <span className="shrink-0 text-muted-foreground/40" aria-hidden>
                                |
                            </span>
                        )}
                        <Slot
                            className={SLOT_HEIGHT}
                            original={row.values[slot] ?? 0}
                            value={edited}
                            onInput={raw => setSlot(row, slot, raw)}
                        />
                    </Fragment>
                )
            })}
        </div>
    )

    // 说明行：左边「阶标签 + 几个 ♦」，右边是游戏原文（全显、按原文换行）。
    // items-center：♦ 是行内最高的那件东西，说明换行成两三行时它得**垂直居中**，不能贴顶。
    // 字色：阶里的条目用默认前景色；**专精特化技能**那三条（类型自己那几条）文字用米白 #eeeebe，
    // 一眼能看出"这几条属于上面那个类型"。♦ 不跟着变——它一律是 #cbd5e1，与阶里的条目同色。
    // tier 只在阶里的条目上给（"1 阶"/…/"EX"），专精类型那三条没有阶，那一格留空占位。
    const descriptionRow = (row: Row, diamondText: string, tier: string, amber = false) => {
        const description = spaceBrackets(lineText(text.lines[row.rowKey], effective(row)))
        const color = amber ? TYPE_SKILL_COLOR : undefined
        return (
            <div className={`flex items-center gap-3 ${ROW_BOX}`}>
                <span className="w-8 shrink-0 text-xs text-muted-foreground">{tier}</span>
                {/*
                    select-text 不能省：这一格宽 64px 而 ♦ 只占左边约 9px，用户点在 ♦ 上按住拖动时，
                    `user-select: auto` 的 span 当不了选择起点（实测：点在 ♦ 上拖不出任何选区），
                    显式声明 text 才行。跟右边的说明文字保持同一规则。
                */}
                <span
                    className="w-16 shrink-0 select-text text-lg leading-none"
                    style={{ color: DIAMOND_COLOR }}
                >
                    {diamondText}
                </span>
                {/* select-text：说明是可以选中复制的文字（默认继承不到用户选择就别扭）。
                    字号 14（text-sm）、行高 24px（leading-6）：游戏原文一行里有说明、效果量、条件好几段，
                    行高松一点才不"密密麻麻"；行高是固定值，不跟着字号变。 */}
                <span
                    className="min-w-0 flex-1 select-text whitespace-pre-line text-sm leading-6 text-foreground"
                    style={{ color }}
                >
                    {renderMarks(description)}
                </span>
            </div>
        )
    }

    // 一个阶里的条目：说明全显，点整行展开它的十个数值框（Accordion；收起时面板不卸载）。
    // 每行都画下划线，**除了每一组的最后一行**（last:border-b-0）：它后面紧跟下一个类型的名字，
    // 再多一条线就成了"两行平行线"，最后一组也因为下面是页面底边同样不需要。分隔改由类型块
    // 之间的间距承担。
    const effectRow = (row: Row, tier: string, path: string) => (
        <AccordionItem key={row.key} value={path} className="border-b last:border-b-0">
            <AccordionTrigger className="w-full items-center gap-0 rounded-none border-0 py-0 hover:no-underline focus-visible:ring-0">
                {descriptionRow(row, "♦".repeat(row.diamonds), tier)}
            </AccordionTrigger>
            <AccordionContent className="pb-0" keepMounted>
                {/* 缩进 = 上面那三格（阶标签 w-8 + 间距 + ♦ w-16 + 间距）= 32+12+64+12 = 120px，
                    十个框与说明文字左端对齐。Tailwind 的间距刻度到 24 就没有 30，所以用内联值。 */}
                <div style={{ paddingLeft: 120 }}>{valuesOf(row)}</div>
            </AccordionContent>
        </AccordionItem>
    )

    return (
        /*
            这一页自己就是滚动的那个盒子（h-full min-h-0 flex-col，同另外三页）：**不能**让外层
            TabsPanel 去滚。
        */
        <div className="flex h-full min-h-0 flex-col page-padding">
            <div className="min-h-0 flex-1 overflow-y-auto pr-4 scrollbar-gutter-stable">
                <div className="min-w-[720px]">
                    {skeleton.characters.map(character => {
                        const characterOpen = !collapsedCharacters.has(character.id)
                        return (
                            <div key={character.id} className="mb-6 last:mb-0">
                                <Accordion
                                    keepMounted
                                    value={characterOpen ? [character.id] : []}
                                    onValueChange={next => {
                                        const changed = toggledKey(characterOpen ? [character.id] : [], next)
                                        if (changed) toggleCharacter(changed)
                                    }}
                                >
                                    {/*
                                        角色行照「角色强化」页的写法：名字贴左（用角色属性色）、行高 h-11、
                                        下边框收口，箭头在最右（AccordionTrigger 自带那对 chevron 就是
                                        ml-auto）。不再用 mb-8 那种大间距——两张表要能对齐着看。
                                    */}
                                    <AccordionItem value={character.id} className="border-b-0">
                                        <AccordionTrigger className="h-11 items-center gap-2 py-0 text-sm font-medium hover:no-underline focus-visible:ring-0">
                                            <span
                                                className="truncate"
                                                style={{ color: charaTable[character.id]?.color }}
                                            >
                                                {charaNames[character.id] ?? character.id}
                                            </span>
                                        </AccordionTrigger>
                                        {/*
                                            角色块这一层**不画收口线**。

                                            块内最后一行必定自带 border-b（每个阶的最后一行都画），所以
                                            再来一条块的收口线，就会和它挨在同一条线上 —— 两条 1px 叠成
                                            看着"加粗"的一条（只有整页最后一行会这样，中间的收尾线都正常）。
                                        */}
                                        <AccordionContent className="pb-0" keepMounted>
                                            {character.types.map(type => {
                                                // 类型自己那三条（♦/♦♦/♦♦♦）也是可编辑的数值行，和阶里的条目一样
                                                // 点开就能改；身份用 type/… 前缀，不跟阶里的条目撞。
                                                const typeRows = type.rows.map((row, i) => ({
                                                    row,
                                                    path: `${character.id}/${type.typeIndex}/type/${i}`,
                                                }))
                                                // 这一类型下每一条的 value（= 展开态的身份）+ 它所属的阶标签。
                                                const rows = type.skills.flatMap(skill =>
                                                    skill.rows.map((row, i) => ({
                                                        row,
                                                        tier: skill.label,
                                                        path: `${character.id}/${type.typeIndex}/${skill.key}/${i}`,
                                                    })),
                                                )
                                                const openTypeRows = typeRows
                                                    .filter(entry => expanded.has(entry.path))
                                                    .map(entry => entry.path)
                                                const openRows = rows
                                                    .filter(entry => expanded.has(entry.path))
                                                    .map(entry => entry.path)
                                                return (
                                                    <div key={type.typeIndex} className="-mt-2 mb-6 last:mb-0">
                                                        {/*
                                                            专精类型：名字 + 一条下划线 + 它自己的三条说明（白字，点开有数值槽）。

                                                            这条线不只是分组：没有它的时候，名字到第一行之间的间距**没有共同基准**
                                                            ——下面是单行时眼睛拿"一行字"去比，是多行时拿"一整块字"去比，
                                                            明明数值一样（都是 pb 4px + 行 padding 6px），看着却像单行更紧。
                                                            加一条线之后两边都从这条线起算，观感就一致了。
                                                            用 py-2：名字上下各留 8px，线正好夹在这 8px 之下。
                                                            而 -mt-2 把整块上移 8px 抵掉那 8px 上内边距 —— 否则角色到名字
                                                            的间距会跟着变大。这样三处互不牵连：角色↔名字回到原来的观感、
                                                            名字下仍 8px、名字到第一行仍 8px。
                                                        */}
                                                        <div className="border-b py-2 text-base font-medium text-foreground">
                                                            {text.names[type.nameKey]}
                                                        </div>
                                                        <Accordion
                                                            multiple
                                                            keepMounted
                                                            value={openTypeRows}
                                                            onValueChange={next => {
                                                                const changed = toggledKey(openTypeRows, next)
                                                                if (changed) toggleExpanded(changed)
                                                            }}
                                                        >
                                                            {typeRows.map((entry, i) => (
                                                                <AccordionItem
                                                                    key={entry.row.key}
                                                                    value={entry.path}
                                                                    className="border-b"
                                                                >
                                                                    <AccordionTrigger className="w-full items-center gap-0 rounded-none border-0 py-0 hover:no-underline focus-visible:ring-0">
                                                                        {descriptionRow(entry.row, diamonds(i), "", true)}
                                                                    </AccordionTrigger>
                                                                    <AccordionContent keepMounted>
                                                                        {/* 缩进 = 阶标签 w-8 + 间距 + ♦ w-16 + 间距 = 120px。 */}
                                                                        <div style={{ paddingLeft: 120 }}>
                                                                            {valuesOf(entry.row)}
                                                                        </div>
                                                                    </AccordionContent>
                                                                </AccordionItem>
                                                            ))}
                                                        </Accordion>
                                                        {/* 四个阶的条目：每条各自可展开十个数值框。 */}
                                                        <Accordion
                                                            multiple
                                                            keepMounted
                                                            value={openRows}
                                                            onValueChange={next => {
                                                                const changed = toggledKey(openRows, next)
                                                                if (changed) toggleExpanded(changed)
                                                            }}
                                                        >
                                                            {rows.map(entry =>
                                                                effectRow(entry.row, entry.tier, entry.path),
                                                            )}
                                                        </Accordion>
                                                    </div>
                                                )
                                            })}
                                        </AccordionContent>
                                    </AccordionItem>
                                </Accordion>
                            </div>
                        )
                    })}
                </div>
            </div>
        </div>
    )
}

export const SkillboardPanel = memo(SkillboardPanelBase)
