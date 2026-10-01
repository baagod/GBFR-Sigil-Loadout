/*
    它们住在这里而不是 App 里，因为它们是列表标记的主体，而且都不需要知道列表如何过滤、
    排序、保存——要的东西以 props 到达：行数据、指针是否在这一行上、是否展开，以及
    App 那几个回调组成的 context。
*/
import { Fragment, type MouseEvent, type PointerEvent, type ReactElement } from "react";

import { Checkbox } from "@/components/ui/checkbox";
import { SlotInput } from "@/components/SlotInput";
import { DisclosureChevron } from "@/components/DisclosureChevron";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import type { Messages } from "@/lib/messages";
import {
    addressOf,
    pad,
    parentState,
    SLOTS,
    valuesAt,
    withSlot,
    type SigilSkill,
    type SkillInfo,
} from "@/lib/skills";

type Row = {
    key: string;
    label: string;
    /** 游戏对这个因子本身的一句话；父行读的就是它。 */
    summary: string;
    info?: SkillInfo;
    byLevel: Map<number, SigilSkill>;
    enabled: boolean;
    levels: number[];
};

/** 一行需要从列表拿到的一切：打包成一个对象传下去，上面的标记就不必背着十来个 props 走来走去。 */
export type RowContext = {
    t: Messages;
    notationOf: (key: string, level: number) => string;
    rest: (id: string, e: PointerEvent<HTMLElement>) => void;
    leave: (id: string) => void;
    toggleLevel: (key: string, level: number) => void;
    toggleSkill: (key: string, nextChecked: boolean) => void;
    toggleOpen: (key: string) => void;
    updateLevel: (key: string, level: number, patch: Partial<SigilSkill>) => void;
    isControl: (e: MouseEvent<HTMLElement>) => boolean;
};

/**
 * 十个紧凑的数值输入框，按所属等级命名，屏幕阅读器才能把上千个框区分开。
 *
 * 每个槽的占位符是游戏在该槽上的自有数值，所以空框读起来就是"这个没碰过，游戏的数值留着"；
 * 而一个框是否为空由记录本身决定：槽在有人输入之前一直是 null，从不靠把数字和默认值比较来
 * 判断。默认值是 20 的槽里输入一个 20，仍然是用户的 20。
 *
 * 一次敲键意味着什么、正在输入时框里显示什么，由 skills.ts（slotEdit）决定。
 */
/*
    数值框的样子：底样式（裸文本、无边框底色、tabular-nums）在 SlotInput，三页共用；这里只给这一页的
    高度与弹性——框就是行高（父行与各等级行都是 h-11），行没有内边距，所以整行都是框；行里唯一有弹性
    的就是这些框，十个平分整行。
*/
const VALUE_SLOT = "h-11! flex-1";

function ValueSlots({
    values,
    defaults,
    label,
    level,
    valueLabel,
    onChange,
}: {
    values: (number | null)[];
    defaults?: number[];
    label: string;
    level: number;
    /** 这个槽在读屏里叫什么（"数值"/"value"/"数値"/"값"），随界面语言走。 */
    valueLabel: string;
    onChange: (values: (number | null)[]) => void;
}) {
    // 游戏在这一槽上的自有数值（没写过 defaults 就是 0）。
    const vanillaOf = (i: number) => defaults?.[i] ?? 0;

    // 半输入文本、步进、滚轮、方向键、Esc 全都搬进了 SlotInput（三页共用的那一个框）。
    // 这里只剩"每个槽拿什么值、提交回哪去"。
    return (
        // 行里唯一有弹性的部分：名字和等级用不完的都归数值，它们平分这点空间。
        <div className="flex min-w-0 flex-1 items-center">
            {Array.from({ length: SLOTS }, (_, i) => (
                <Fragment key={i}>
                    {/* 每个槽都有，第一个也不例外：它把数值和等级隔开，方式和数值彼此之间一样。 */}
                    <span className="shrink-0 text-muted-foreground/40" aria-hidden>
                        |
                    </span>
                    <SlotInput
                        label={`${label} Lv${level} ${valueLabel} ${i + 1}`}
                        original={vanillaOf(i)}
                        value={values[i] ?? null}
                        onCommit={(value) => onChange(withSlot(values, i, value))}
                        className={VALUE_SLOT}
                    />
                </Fragment>
            ))}
        </div>
    );
}

/**
 * 行与它的说明气泡。等级行与父行共用这一套脚手架：
 *
 * - tooltip 是否打开由列表根据指针单独决定（见 useRowTooltip）；留给 base-ui 的是定位，以及它
 *   需要的两个开关——弹层压在正悬停那一行上方，所以它不能接收指针（否则上面那行永远悬停不到），
 *   指针在弹层自己的盒子里时它也不能继续打开。
 * - 在行的上方并居中：每一行都按同样的方式读，而且指针下面的列表永远不会被盖住。比现成的气泡
 *   更宽，并保留游戏原文里的换行——有些说明是三行参数，单行气泡会把它们截掉。
 * - 只保留侧向位置的轴（trackCursorAxis="x"），打开/关闭动画都关掉：气泡是在行之间换位置，
 *   不是被动画带进带出。
 * - 只在打开时挂载：base-ui 关闭时会先让弹层走完退场动画，整块不挂载 = 当帧就没了。
 *
 * 触发器由调用点作为 children 传入（base-ui 的 Trigger 靠 context 找 Root，不靠子节点位置）。
 */
function RowTooltip({
    open,
    disabled,
    text,
    children,
}: {
    open: boolean;
    disabled: boolean;
    text: string;
    children: ReactElement;
}) {
    return (
        <Tooltip open={open} disabled={disabled} disableHoverablePopup trackCursorAxis="x">
            {children}
            {open && (
                <TooltipContent
                    side="top"
                    align="center"
                    className="max-w-md items-start whitespace-pre-line data-open:animate-none data-closed:animate-none"
                >
                    {text}
                </TooltipContent>
            )}
        </Tooltip>
    );
}

function LevelRow({
    row,
    level,
    nested,
    hovered,
    ctx,
}: {
    row: Row;
    level: number;
    nested: boolean;
    hovered: boolean;
    ctx: RowContext;
}) {
    // 它自己等级的措辞，而不是整个因子的（分级读法见 explainAt）。
    const notation = ctx.notationOf(row.key, level);
    const record = row.byLevel.get(level);
    const id = addressOf(row.key, level);

    return (
        <RowTooltip open={hovered} disabled={!notation} text={notation}>
            {/*
                触发器是整行，勾选框也在内：说明在行上任何地方都值得一问，而切换等级时指针本来就在
                勾选框上。

                用 div，而不是触发器默认渲染的 button：这一行里有数值框和勾选框，交互内容不能住在
                button 里面。
            */}
            <TooltipTrigger
                data-row={id}
                onPointerEnter={(e) => ctx.rest(id, e)}
                onPointerLeave={() => ctx.leave(id)}
                render={
                    <div
                        className={`flex items-center gap-2 border-b last:border-b-0 ${
                            nested ? "pl-9" : ""
                        }`}
                    />
                }
            >
                <Checkbox
                    checked={record?.enabled ?? false}
                    // 左侧留 2px：行的第一个子元素就是这个勾选框，而焦点环向外生长，没有这一点容器的
                    // 边缘会把环裁掉。
                    className="ml-0.5"
                    aria-label={ctx.t.enable(`${row.label} Lv${level}`)}
                    onCheckedChange={() => ctx.toggleLevel(row.key, level)}
                />

                {!nested && (
                    <span
                        /*
                            固定宽度而不是弹性宽度：名字和等级必须待在一起，吸收更宽窗口的应该是数值框。
                            217px 覆盖四种语言里最长的名字（"スーパーアルティメットJust回避"），只剩几个像素
                            余量；再长的截断，完整名字由 tooltip 承载。
                        */
                        className="w-[217px] shrink-0 truncate text-sm"
                    >
                        {row.label}
                    </span>
                )}
                <span className="w-12 shrink-0 text-sm leading-7 text-muted-foreground tabular-nums select-none">
                    Lv {level}
                </span>

                <ValueSlots
                    // 没有编辑的等级没有自己的数值：每个槽都是游戏自己的，这正是占位符显示的内容。
                    values={record ? record.values : pad([])}
                    defaults={valuesAt(row.info, level)}
                    label={row.label}
                    level={level}
                    valueLabel={ctx.t.valueLabel}
                    onChange={(values) => ctx.updateLevel(row.key, level, { values: values })}
                />
            </TooltipTrigger>
        </RowTooltip>
    );
}

/**
 * 一个因子：数值只落在一个等级上时是一行，否则是它自己的行加上每个等级一行——已编辑的等级
 * 在前、升序，没动过的排在后面。它的勾选框此时代表所有等级：全开时勾选，部分开时半选，全关时为空。
 */
export function SkillRow({
    row,
    hoveredId,
    isOpen,
    ctx,
}: {
    row: Row;
    hoveredId: string | null;
    isOpen: boolean;
    ctx: RowContext;
}) {
    if (row.levels.length === 1) {
        return (
            <LevelRow
                row={row}
                level={row.levels[0]}
                nested={false}
                hovered={hoveredId === addressOf(row.key, row.levels[0])}
                ctx={ctx}
            />
        );
    }

    /*
        父行代表整个因子，自己没有等级，所以它读因子的概要：游戏对整个因子的那句话，而不是某个
        等级的措辞。它下面的各等级行仍保留各自等级的说明。
    */
    // 父行说的是"这一整行显示的等级"，不是"碰巧存在几条记录"——规则本身在 skills.ts 里，
    // 半选态才因此可能出现（11 个等级只开 1 个 = 半选）。单等级那条早返回用不到它，所以放在这里。
    const state = parentState(row.levels, row.byLevel);

    return (
        <>
            <RowTooltip
                open={hoveredId === row.key}
                disabled={!row.summary}
                text={row.summary}
            >
                <TooltipTrigger
                    data-row={row.key}
                    onPointerEnter={(e) => ctx.rest(row.key, e)}
                    onPointerLeave={() => ctx.leave(row.key)}
                    /*
                        触发器是整行，勾选框在内；整行也是打开因子的地方：点在除控件以外的任何位置都会
                        切换它（箭头只是一个图标，不是第二个控件）。
                    */
                    render={
                        <div
                            onClick={(e) => {
                                if (ctx.isControl(e)) return;
                                ctx.toggleOpen(row.key);
                            }}
                            className="flex h-11 items-center gap-2 border-b"
                        />
                    }
                >
                    <span className="relative ml-0.5 inline-flex shrink-0">
                        <Checkbox
                            checked={state === "all"}
                            indeterminate={state === "some"}
                            aria-label={ctx.t.enable(row.label)}
                            onCheckedChange={() => ctx.toggleSkill(row.key, state !== "all")}
                        />
                        {state === "some" && (
                            /*
                                这一行自己画的横杠，因为几何就是它的全部意义：一条水平线必须落在某一像素行的
                                中心，否则会糊到两行上。Lucide 的 minus 把线放在 24 单位盒子的 y=12，换算到
                                指示器绘制的 14px 里正好是 y=7.0——一个像素边界，挨着对勾显示时发虚。这里是
                                同一条线（lucide 的 x 5..19、24 单位中描边 2.3）放进 14 单位的盒子，y=7.5 是
                                第 7 行的中点，渲染出来是实心的。
                            */
                            <svg
                                aria-hidden
                                viewBox="0 0 14 14"
                                className="pointer-events-none absolute inset-0 m-auto size-3.5 text-primary-foreground"
                            >
                                <line
                                    x1="2.92"
                                    y1="7.5"
                                    x2="11.08"
                                    y2="7.5"
                                    stroke="currentColor"
                                    strokeWidth="1.34"
                                    strokeLinecap="round"
                                />
                            </svg>
                        )}
                    </span>

                    <span className="w-[217px] shrink-0 truncate text-sm">{row.label}</span>

                    <span className="flex-1" />

                    {/*
                        展开指示，就是一个普通图标：自己没有点击，也没有自己的背景。打开因子是整行的活
                        ——当意思是指 "这个因子" 时指针就在行上——而一个会响应点击的图标就成了同一件事的
                        第二个、更安静的控制。做成 ghost 按钮时它还会在指针下涂一层底色，读起来像一个有事
                        可做的按钮。
                    */}
                    <DisclosureChevron open={isOpen} />
                </TooltipTrigger>
            </RowTooltip>

            {isOpen &&
                row.levels.map((level) => (
                    <LevelRow
                        key={addressOf(row.key, level)}
                        row={row}
                        level={level}
                        nested
                        hovered={hoveredId === addressOf(row.key, level)}
                        ctx={ctx}
                    />
                ))}
        </>
    );
}
