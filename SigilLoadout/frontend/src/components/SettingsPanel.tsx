import {useEffect, useState} from "react"

import {DetectGameDirAuto, GameDirInfo, PickGameExe} from "../../bindings/sigilloadout/service/gameservice"
import {Button} from "@/components/ui/button"
import {Input} from "@/components/ui/input"
import type {Messages} from "@/lib/messages"

export function SettingsPanel({t}: { t: Messages }) {
    const [dir, setDir] = useState("")
    const [auto, setAuto] = useState(false)
    const [note, setNote] = useState("")

    useEffect(() => {
        void (async () => {
            const detected = await DetectGameDirAuto().catch(() => "")
            if (detected) {
                setDir(detected)
                setAuto(true)
                return
            }
            const saved = await GameDirInfo().catch(() => "")
            setDir(saved)
        })()
    }, [])

    const detect = async () => {
        try {
            const d = await DetectGameDirAuto()
            if (!d) {
                setNote(t.gameDirNotFound)
                return
            }
            setDir(d)
            setAuto(true)
            setNote(t.gameDirDetected)
        } catch (e) {
            setNote(String(e))
        }
    }

    const pick = async () => {
        try {
            const d = await PickGameExe()
            if (d) {
                setDir(d)
                setAuto(false)
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
                    <Input
                        id="game-dir"
                        value={dir}
                        readOnly
                        onClick={pick}
                        placeholder={t.gameDirPick}
                        className={auto ? "cursor-pointer opacity-60" : "cursor-pointer"}
                    />
                    <Button variant="outline" onClick={detect}>{t.gameDirAuto}</Button>
                </div>
                {note && <p className="text-sm text-muted-foreground">{note}</p>}
            </div>
        </div>
    )
}
