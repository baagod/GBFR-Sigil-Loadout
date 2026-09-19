/*
  行本身：一个因子的行、它各个等级的行，以及一个等级持有的十个数值框。

  它们住在这里而不是 App 里，因为它们是列表标记的主体，而且都不需要知道列表如何过滤、
  如何排序、如何保存——它们要的东西以 props 的形式到达：行数据、指针是否在这一行上、
  这个因子是否展开，以及装着 App 那几个回调的 context。
*/
import { Fragment, useRef, useState, type MouseEvent, type PointerEvent } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { Messages } from "./messages";
import {
  addressOf,
  pad,
  parentState,
  SLOTS,
  slotEdit,
  stepValue,
  valuesAt,
  withSlot,
  type SigilTrait,
  type TraitInfo,
} from "./traits";
import { useWheelStep } from "./useWheelStep";

/** 一个因子的行和它的各个等级，由列表这样构建出来。 */
export type Row = {
  key: string;
  label: string;
  /** 游戏对这个因子本身的一句话，父行读的就是它。 */
  summary: string;
  info?: TraitInfo;
  byLevel: Map<number, SigilTrait>;
  enabled: boolean;
  levels: number[];
};

/**
 * 一行需要从 App 拿到的东西：文案、因子的说明文本，以及一行可以请求的编辑——
 * 包括 tooltip 依赖的两个指针处理函数。作为一个对象传下去，
 * 上面的标记就不必背着十来个 props 走来走去。
 */
export type RowContext = {
  t: Messages;
  notationOf: (key: string, level: number) => string;
  rest: (id: string, e: PointerEvent<HTMLElement>) => void;
  leave: (id: string) => void;
  toggleLevel: (key: string, level: number) => void;
  toggleTrait: (key: string, nextChecked: boolean) => void;
  toggleOpen: (key: string) => void;
  updateLevel: (key: string, level: number, patch: Partial<SigilTrait>) => void;
  isControl: (e: MouseEvent<HTMLElement>) => boolean;
};

/**
 * 十个紧凑的数值输入框，按所属等级命名，屏幕阅读器才能把上千个框区分开。
 *
 * 每个槽的占位符是游戏在该槽上的自有数值，所以空框读起来就是"这个没碰过，游戏的
 * 数值留着"；而一个框是否为空由记录本身决定：槽在有人输入之前一直是 null，
 * 从不靠把数字和默认值比较来判断。默认值是 20 的槽里输入一个 20，仍然是用户的 20。
 *
 * 一次敲键意味着什么、正在输入时框里显示什么，由 traits.ts（slotEdit）决定——
 * 包括为什么输入过的数字会一直显示自己那串文本，直到离开这个框。
 * 改这里之前先读那条规则。
 */
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
  // 编辑中的框正在显示的文本，前提是它与已提交数字渲染出来的样子不同："-" 和 "0."
  // 是通往一个数字的中间状态，输入过的数字也保留自己那串文本（0.004 在输入途中
  // 不能渲染成 0）。在 blur 时丢弃，那时框会回到渲染数字的样子。
  const [halfTyped, setHalfTyped] = useState<Record<number, string>>({});

  const vanillaOf = (i: number) => defaults?.[i] ?? 0;

  /*
    滚轮让聚焦的框步进，而列表不能跟着一起滚——监听器为什么必须是原生的、
    passive: false 的，以及最新数值从哪来，见 useWheelStep。

    是哪个框，按位置判断：这一行里正好只有这些槽，没有别的东西，所以不必为此把索引带进 DOM。
  */
  const host = useRef<HTMLDivElement>(null);
  useWheelStep(
    host,
    (target) => document.activeElement === target,
    (target, delta) => {
      const element = host.current;
      if (!element) return;
      const index = Array.prototype.indexOf.call(
        element.querySelectorAll("input"),
        target,
      );
      if (index < 0) return;
      // 没碰过的槽从游戏自己的数值步进，那正是框里显示的东西。
      const from = values[index] ?? defaults?.[index] ?? 0;
      setHalfTyped(({ [index]: _dropped, ...rest }) => rest);
      onChange(withSlot(values, index, stepValue(from, delta)));
    },
  );

  return (
    // 行里唯一有弹性的部分：名字和等级用不完的都归数值，它们平分这点空间。
    //
    // 外层不加 cursor-text：每个框自带，I 形光标因此正好标出接受输入的那些框，
    // 而每个框都能输入——还没有编辑的等级把游戏的数值显示为占位符，第一次敲键就
    // 开始一条编辑（没打开的编辑会被保存但不生效，见 updateLevel）。
    //
    // 自己不加右内边距：最后一个框在行的末端结束，十个框平分整行。展开箭头那一列
    // 不构成加它的理由——箭头只存在于父行上，而父行不带任何数值。
    <div ref={host} className="flex min-w-0 flex-1 items-center">
      {Array.from({ length: SLOTS }, (_, i) => (
        <Fragment key={i}>
          {/* 每个槽都有，第一个也不例外：它把数值和等级隔开，方式和数值彼此之间的隔开一样。 */}
          <span className="shrink-0 text-muted-foreground/40" aria-hidden>
            |
          </span>
          <Input
            type="text"
            inputMode="decimal"
            aria-label={`${label} Lv${level} ${valueLabel} ${i + 1}`}
            placeholder={String(vanillaOf(i))}
            // 空就是"游戏的数值留着"：槽在有人输入之前是 null，所以这个框不需要和
            // 默认值比较就知道这一点——而手写进 gemedits.json 的数字，会按它本来的值显示。
            value={halfTyped[i] ?? (values[i] === null ? "" : String(values[i]))}
            onChange={(e) => {
              // 一次敲键意味着什么——丢弃、半输入状态，还是一个要提交的数字——
              // 由 traits.ts 决定，那里可以用测试逐个按键驱动它。
              const edit = slotEdit(e.target.value, i, values);
              if (edit.kind === "drop") return;
              if (edit.kind === "half") {
                setHalfTyped((prev) => ({ ...prev, [i]: edit.text }));
                return;
              }
              // 数字已提交，但框会保留输入的那串文本直到离开它：一个数字的前缀往往
              // 本身也是数字（0.0、0.00），所以用已提交的数字渲染这个框，会吃掉后面
              // 输入的内容——0.004 曾变成 4。blur 会重新渲染数字。
              setHalfTyped(({ [i]: _dropped, ...rest }) =>
                edit.keeps ? { ...rest, [i]: edit.keeps } : rest,
              );
              onChange(edit.values);
            }}
            onBlur={() => setHalfTyped(({ [i]: _dropped, ...rest }) => rest)}
            /*
              按 1 步进，这本是 number 输入框免费提供的能力：这些框必须能容纳 "-" 和
              "0." 才输得进去，而 number 输入框报不出这些内容。步进会替换掉半输入的
              内容，因为从那一刻起这个框要的就是数字。
            */
            onKeyDown={(e) => {
              // Escape 让人放开这个框：列表是用指针读的，所以离开一个槽就是 blur，
              // 仅此而已。半输入的内容随之退回，因为 onBlur 本来就是这么做的。
              if (e.key === "Escape") {
                e.currentTarget.blur();
                return;
              }
              if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
              // 否则方向键会把光标移到框的末尾，而在一个可滚动的列表上，它还会顺手把列表也滚了。
              e.preventDefault();
              // 没碰过的槽从游戏自己的数值步进，那正是它显示的东西。
              const from = values[i] ?? vanillaOf(i);
              setHalfTyped(({ [i]: _dropped, ...rest }) => rest);
              onChange(withSlot(values, i, stepValue(from, e.key === "ArrowUp" ? 1 : -1)));
            }}
            /*
              裸文本，不是输入域：没有边框、没有底色、没有焦点环。整行读起来就是一行
              用 | 隔开的数字，剩下唯一的装饰是正在编辑的槽上一层很淡的底色，让光标有个落脚处。

              框就是行高：行自己没有内边距，所以标出聚焦槽的那层底色从上到下盖满整行，
              点在这条带子上的任何地方都落进框里。因子的行和它各等级的行因此一样高
              （多等级那一行是 h-11，也是同一个原因）。

              行上每个框都能输入，无论该等级是否打开：还没有编辑的等级把游戏的数值
              显示为占位符，第一次敲键或步进就开始这条编辑（见 updateLevel）。所以
              没有需要绕开的禁用态——只有占位符，而已编辑等级里没碰过的槽显示的也是它。
            */
            className="h-11! min-w-0 flex-1 border-0 bg-transparent px-0 text-center text-xs md:text-xs tabular-nums shadow-none focus:bg-muted/50 focus-visible:ring-0 dark:bg-transparent"
          />
        </Fragment>
      ))}
    </div>
  );
}

/**
 * 因子的一个等级：它的勾选框（勾选它就是在该等级开始一条编辑）、它的等级号、
 * 它的十个槽，以及该因子自己的 tooltip——说明覆盖整行，
 * 行上任何地方都是合理的询问位置。
 */
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
  // 它自己等级的措辞，而不是整个因子的：某个抗性在 29 级前读作"受到的伤害-{1}%"，
  // 30 级读作"…免疫"，这一行就是其中之一（见 explainAt）。
  const notation = ctx.notationOf(row.key, level);
  const record = row.byLevel.get(level);
  const id = addressOf(row.key, level);

  return (
    <Tooltip
      open={hovered}
      disabled={!notation}
      disableHoverablePopup
      trackCursorAxis="x"
    >
      {/*
        触发器是整行，勾选框也在内：因子的说明在行上任何地方都值得一问，而切换等级时指针本来就在勾选框上。

        tooltip 是否打开由 App 根据指针单独决定——见那里的说明。留给 base-ui 的是
        定位，以及它需要的两个开关：弹层压在正悬停那一行上方的那一行上，所以它不能
        接收指针（否则上面那行永远悬停不到），指针在弹层自己的盒子里时它也不能继续打开。

        用 div，而不是触发器默认渲染的 button：这一行里有数值框和勾选框，而交互内容不能住在 button 里面。
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
          // 左侧留 2px 空间：行的第一个子元素就是这个勾选框，而焦点环向外生长，没有这一点，容器的边缘会把环裁掉。
          className="ml-0.5"
          aria-label={ctx.t.enable(`${row.label} Lv${level}`)}
          onCheckedChange={() => ctx.toggleLevel(row.key, level)}
        />

        {!nested && (
          <span
            /*
              固定宽度而不是弹性宽度：名字和等级必须待在一起，吸收更宽窗口的应该是
              数值框。217px 覆盖四种语言里最长的名字
              （"スーパーアルティメットJust回避"），只剩几个像素的余量；
              再长的就截断，完整名字由 tooltip 承载。
            */
            className="w-[217px] shrink-0 truncate text-sm"
          >
            {row.label}
          </span>
        )}

        {/* 这一行编辑的等级，以文本形式：它是该行写入的地址的一部分，不是一个独立
            字段。单等级因子在它唯一的那一行上说同样的话。 */}
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
      {/*
        因子的说明，在行的上方并居中：每一行都按同样的方式读，而且指针下面的列表
        永远不会被盖住。比现成的气泡更宽，并保留游戏原文里的换行——有些说明是三行参数，
        单行气泡会把它们截掉。打开和关闭动画都关掉了：气泡是在行之间换位置，而不是被动画带进带出。
      */}
      <TooltipContent
        side="top"
        align="center"
        className="max-w-md items-start whitespace-pre-line data-open:animate-none data-closed:animate-none"
      >
        {notation}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * 一个因子：数值只落在一个等级上时是一行，否则是它自己的行加上每个等级一行——
 * 已编辑的等级在前、升序，没动过的排在后面。它的勾选框此时代表所有等级：
 * 全开时勾选，部分开时半选，全关时为空。
 */
export function TraitRow({
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
  // 父行说的是 "这一整行显示的等级"，不是 "碰巧存在几条记录" —— 规则本身在 traits.ts 里，
  // 半选态才因此可能出现（11 个等级只开 1 个 = 半选）。
  const state = parentState(row.levels, row.byLevel);

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
    父行代表整个因子，自己没有等级，所以它读因子的概要：游戏对整个因子的那句话，
    而不是某个等级的措辞。它下面的各等级行仍然保留各自所指等级的说明。
  */

  return (
    <>
      <Tooltip
        open={hoveredId === row.key}
        disabled={!row.summary}
        disableHoverablePopup
        trackCursorAxis="x"
      >
        <TooltipTrigger
          data-row={row.key}
          onPointerEnter={(e) => ctx.rest(row.key, e)}
          onPointerLeave={() => ctx.leave(row.key)}
          /*
            触发器是整行，勾选框在内；整行也是打开因子的地方：点在除控件以外的任何
            位置都会切换它（箭头只是一个图标，不是第二个控件）。
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
              onCheckedChange={() => ctx.toggleTrait(row.key, state !== "all")}
            />
            {state === "some" && (
              /*
                这一行自己画的横杠，因为几何就是它的全部意义：一条水平线必须落在某一
                像素行的中心，否则会糊到两行上。Lucide 的 minus 把线放在 24 单位盒子的
                y=12，换算到指示器绘制的 14px 里正好是 y=7.0——一个像素边界，
                结果它挨着对勾显示时发虚。这里是同一条线（lucide 的 x 5..19、
                24 单位中描边 2.3）放进 14 单位的盒子，y=7.5 是第 7 行的中点，所以渲染出来是实心的。
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
            展开指示，就是一个普通图标：自己没有点击，也没有自己的背景。打开因子是
            整行的活——当意思是指 "这个因子" 时，指针就在行上——而一个会响应点击的
            图标就成了同一件事的第二个、更安静的控制。做成 ghost 按钮时它还会在指针下
            涂一层底色，读起来像一个有事可做的按钮。
          */}
          <span
            aria-hidden
            className="grid size-7 shrink-0 place-content-center text-muted-foreground"
          >
            {isOpen ? (
              <ChevronDown className="size-4" />
            ) : (
              <ChevronRight className="size-4" />
            )}
          </span>
        </TooltipTrigger>
        <TooltipContent
          side="top"
          align="center"
          className="max-w-md items-start whitespace-pre-line data-open:animate-none data-closed:animate-none"
        >
          {row.summary}
        </TooltipContent>
      </Tooltip>

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
