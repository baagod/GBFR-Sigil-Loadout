import type {ReactNode} from "react"

/** 左栏清单的行距：条目本身 32px（文字 20 + 上下各 6px 内边距），行与行之间 6px。 */
export const sideListRows = "flex flex-col gap-1.5"

const ITEM =
    "flex w-full cursor-default items-center gap-2 rounded-sm py-1.5 pr-2 pl-2 text-left text-sm outline-hidden select-text "

/**
 * 左栏清单的一行：**div + role="button"**，不是 `<button>` —— Chromium 里 `<button>` 内的文字
 * 用鼠标拖选选不中，而这里要的是"能拖选、复制名字"；键盘可达性用 tabIndex + Enter/Space 补。
 */
export function SideListItem({selected, onSelect, dataIndex, children}: {
    selected: boolean
    onSelect: () => void
    dataIndex?: number
    children: ReactNode
}) {
    return (
        <div
            role="button"
            tabIndex={0}
            data-index={dataIndex}
            onClick={onSelect}
            onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault()
                    onSelect()
                }
            }}
            className={ITEM + (selected ? "bg-accent text-accent-foreground" : "hover:bg-accent/50")}
        >
            {children}
        </div>
    )
}
