import { useLayoutEffect, useRef, useState, type PointerEvent } from "react"

/*
  列表上的 tooltip 指向谁，由**指针下的那一行**决定，而不是由 hover 事件决定。

  原因是行会在指针底下移动：一次勾选会把打开的内容排到最前，于是行动了、指针没动，而在同一行
  内移动不会触发 enter。hover 事件说不出此刻指针下是哪一行，所以这里用 elementFromPoint 问文档，
  再把答案交给各行自己去比。

  base-ui 的 tooltip 还有一层脾气：只有打开它的那次事件是 mouseenter/mousemove 时它才让弹层
  跟着光标（useClientPoint 检查的正是这一点），而一次点击之后它根本不允许 hover 打开，直到
  指针离开这一行再回来。所以"指针进入"与"勾选之后重新指向"都要把进入过程在行上重放一遍
  （见 replayHover）。

  这份状态住在列表那一层，因为"哪一行被指向"是整份列表的答案，而行只需要拿它跟自己的 id 比一比。
*/
export function useRowTooltip<T extends HTMLElement>() {
  const [hoveredRow, setHoveredRow] = useState<string | null>(null)
  // 指针最后一次移动的位置：勾选会在指针没动的情况下移动行，重解"指针下是哪一行"只能靠记下的坐标。
  const lastPointer = useRef<{ x: number; y: number } | null>(null)
  /*
    跨过一次勾选重渲染保留的滚动偏移，没有待处理的勾选时为 null。

    一次勾选会重排列表，而浏览器会跟着刚被点击、仍持有焦点的那个勾选框走：它把该行滚回视野，
    这就是勾选感觉列表跳了一下的原因。偏移在下面的 layout effect 里放回去，和把 tooltip 重新
    指向此刻指针下那一行是同一次 pass。
  */
  const heldScroll = useRef<number | null>(null)
  const listBox = useRef<T>(null)

  /** 一次勾选之前调一次：记下滚动偏移，供下面那次 layout effect 放回去。 */
  function keepScroll() {
    heldScroll.current = listBox.current?.scrollTop ?? null
  }

  /*
    把"进入这一行"在行上重放一遍。moveOnly 为 true 时只补一个 move——那种情形弹层已经在行上
    打开了（见 resolveRowUnderPointer），先来一个 leave 只会又把它关上。
  */
  function replayHover(row: HTMLElement, moveOnly: boolean) {
    const at = lastPointer.current
    if (!at) return
    const init = { bubbles: true, clientX: at.x, clientY: at.y }
    if (!moveOnly) row.dispatchEvent(new window.MouseEvent("mouseleave", init))
    row.dispatchEvent(new window.MouseEvent("mouseenter", init))
    row.dispatchEvent(new window.MouseEvent("mousemove", init))
  }

  /*
    指针此刻在哪一行，是问文档而不是问 hover 事件（原因见文件头）。调用点：勾选之后的 layout
    effect，以及滚动关掉说明之后指针的第一次移动。
  */
  function resolveRowUnderPointer() {
    const at = lastPointer.current
    if (!at) return
    const row = document.elementFromPoint(at.x, at.y)?.closest<HTMLElement>("[data-row]")
    setHoveredRow(row?.getAttribute("data-row") ?? null)
    // 那里的弹层已经在行上打开，所以只补一个 move（见 replayHover）。
    if (row) replayHover(row, true)
  }

  /* 一次勾选之后：放回滚动偏移，并把 tooltip 重新指向此刻指针下的那一行。 */
  useLayoutEffect(() => {
    if (heldScroll.current === null) return
    if (listBox.current) listBox.current.scrollTop = heldScroll.current
    heldScroll.current = null
    resolveRowUnderPointer()
  })

  /*
    指针在列表里移动：记下位置；说明已被滚动关掉时替指针重解一次——那种情形指针常停在原行上，
    不会再触发 enter。
  */
  function onPointerMove(e: PointerEvent<T>) {
    lastPointer.current = { x: e.clientX, y: e.clientY }
    if (hoveredRow === null) resolveRowUnderPointer()
  }

  /** 指针离开列表：位置不再有意义，留着它下一次重解会解出一个指针根本不在的行。 */
  function onPointerLeave() {
    lastPointer.current = null
    setHoveredRow(null)
  }

  /*
    指针进入一行：记下位置并重放整个进入过程（原因见 replayHover）。能改变 hoveredRow 的只有
    指针从一行移到另一行，或者一次勾选——那是行在动，由上面那个 layout effect 处理。
  */
  function onRowPointerEnter(id: string, e: PointerEvent<HTMLElement>) {
    lastPointer.current = { x: e.clientX, y: e.clientY }
    replayHover(e.currentTarget, false)
    setHoveredRow(id)
  }

  /** 指针离开一行：只有它仍是当前那行时才清掉（重排会让另一行接管）。 */
  function onRowPointerLeave(id: string) {
    setHoveredRow((cur) => (cur === id ? null : cur))
  }

  /** 滚动就当场关掉说明：弹层按"打开那一刻"的坐标画，滚动只挪内容、不挪它。 */
  function closeTooltip() {
    setHoveredRow(null)
  }

  return {
    hoveredRow,
    listBox,
    keepScroll,
    onPointerMove,
    onPointerLeave,
    onRowPointerEnter,
    onRowPointerLeave,
    closeTooltip,
  }
}
