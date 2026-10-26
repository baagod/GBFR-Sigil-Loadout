import {useEffect, useState} from "react"
import {ListFsm, LoadFsm} from "../../bindings/sigilloadout/service/actionsservice"
import type {ActionField} from "../../bindings/sigilloadout/service/models"
import {InfoBadge} from "@/components/InfoBadge"
import type {Messages} from "@/lib/messages"

/*
    「FSM」：左栏是本角色的 FSM 清单（自己目录 + 参数表 fsmParam_ 引用的共享层），右栏是选中那份的
    key.path = 值。与「全员参数」同一套左右分栏、同一套表格线（只读，这里没有编辑）。

    清单跟着角色走：换角色后 `charCode` 变，整份重读；选中项按名字保留（还在清单里就不跳走）。
    共享层（带 `目录/` 前缀的，如 pl_base/snd_auto_type_2）排在最前面。
*/
export function FsmPanel({charCode, t}: {charCode: string; t: Messages}) {
    const [names, setNames] = useState<string[]>([])
    const [selected, setSelected] = useState("")
    const [fields, setFields] = useState<ActionField[]>([])
    const [failure, setFailure] = useState("")

    useEffect(() => {
        let alive = true
        void (async () => {
            try {
                const list = orderSharedFirst((await ListFsm()) ?? [])
                if (!alive) return
                setNames(list)
                setFailure("")
                setSelected((cur) => (list.includes(cur) ? cur : (list[0] ?? "")))
            } catch (e) {
                if (alive) setFailure(String(e))
            }
        })()
        return () => {
            alive = false
        }
    }, [charCode])

    useEffect(() => {
        if (selected === "") {
            setFields([])
            return
        }
        let alive = true
        void (async () => {
            try {
                const rows = (await LoadFsm(selected)) ?? []
                if (!alive) return
                setFields(rows)
                setFailure("")
            } catch (e) {
                if (alive) setFailure(String(e))
            }
        })()
        return () => {
            alive = false
        }
    }, [selected])

    return (
        <div className="flex min-h-0 min-w-0 flex-1 gap-4">
            {/* 左栏：条目长相照 combobox（同 GlobalParamList）。名字不翻译 —— 它就是游戏里的文件名。 */}
            <div className="min-h-0 w-max shrink-0 overflow-y-auto overflow-x-hidden border-r pr-3">
                {failure && <p className="p-2 text-xs text-destructive">{failure}</p>}
                <div className="flex flex-col gap-1.5">
                    {names.map((name) => {
                        const shared = name.includes("/")
                        const label = shared ? name.slice(name.indexOf("/") + 1) : name
                        return (
                            <div
                                key={name}
                                role="button"
                                tabIndex={0}
                                onClick={() => setSelected(name)}
                                onKeyDown={(e) => {
                                    if (e.key === "Enter" || e.key === " ") {
                                        e.preventDefault()
                                        setSelected(name)
                                    }
                                }}
                                className={
                                    "flex w-full cursor-default items-center gap-2 rounded-sm py-1.5 pr-2 pl-2 text-left text-sm outline-hidden select-text " +
                                    (selected === name ? "bg-accent text-accent-foreground" : "hover:bg-accent/50")
                                }
                            >
                                <span>{label}</span>
                                {shared && <InfoBadge>{t.sharedLayer}</InfoBadge>}
                            </div>
                        )
                    })}
                </div>
            </div>
            {/* 右栏：只读的 key.path = 值。与 GlobalParamPanel 同一套表格线（最后一行不要下边框）。 */}
            <div className="min-h-0 min-w-0 flex-1 overflow-auto pr-2 scrollbar-gutter-stable">
                <table className="w-full table-border border-separate border-spacing-0 text-xs [&_tr:last-child>*]:border-b-0">
                    <tbody>
                        {fields.map((field) => (
                            <tr key={field.key}>
                                <td className="border-b px-2 py-1 whitespace-nowrap">{field.key}</td>
                                <td className="w-full border-b px-2 py-1 break-all">{field.original}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    )
}

// 共享层（名字里带 "/"）排前面；两边各自保持后端给的字典序。
function orderSharedFirst(names: string[]): string[] {
    return [...names.filter((name) => name.includes("/")), ...names.filter((name) => !name.includes("/"))]
}
