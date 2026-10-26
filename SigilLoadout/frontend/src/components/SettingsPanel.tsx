import {useEffect, useState} from "react"

import {DetectGameDirAuto, GameDirInfo, PickGameExe, SetGameDir} from "../../bindings/sigilloadout/service/gameservice"
import {Button} from "@/components/ui/button"
import {Input} from "@/components/ui/input"
import type {Messages} from "@/lib/messages"

export function SettingsPanel({t}: { t: Messages }) {
    const [dir, setDir] = useState("")
    const [note, setNote] = useState("")

    // 显示的是**当前生效**的目录（手动配置优先，否则自动检测），不是"刚检测到但没保存"的那个。
    useEffect(() => {
        let alive = true
        void (async () => {
            const effective = await GameDirInfo().catch(() => "")
            if (alive) setDir(effective)
        })()
        return () => {
            alive = false
        }
    }, [])

    const detect = async () => {
        try {
            const detected = await DetectGameDirAuto()
            if (!detected) {
                setNote(t.gameDirNotFound)
                return
            }
            // 检测出来就存进配置：只显示不保存的话，这一页写着一个目录、实际用的还是另一个。
            await SetGameDir(detected)
            setDir(await GameDirInfo())
            setNote(t.gameDirDetected)
        } catch (e) {
            setNote(String(e))
        }
    }

    const pick = async () => {
        try {
            const picked = await PickGameExe()
            if (picked) {
                setDir(await GameDirInfo().catch(() => picked))
                setNote("")
            }
        } catch (e) {
            setNote(String(e))
        }
    }

    return (
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-6">
            <div className="flex max-w-3xl flex-col gap-2">
                <label className="text-sm font-medium" htmlFor="game-dir">{t.gameDir}</label>
                <div className="flex gap-2">
                    {/* 路径本身可拖选/复制；点击整行路径选取 exe（「选择」按钮已移除），Enter 也能触发。 */}
                    <Input
                        id="game-dir"
                        value={dir}
                        readOnly
                        placeholder={t.gameDirPick}
                        className="cursor-pointer"
                        onClick={pick}
                        onKeyDown={(event) => {
                            if (event.key !== "Enter") return
                            event.preventDefault()
                            void pick()
                        }}
                    />
                    <Button variant="outline" onClick={detect}>{t.gameDirAuto}</Button>
                </div>
                {note && <p className="text-sm text-muted-foreground">{note}</p>}
            </div>
        </div>
    )
}
