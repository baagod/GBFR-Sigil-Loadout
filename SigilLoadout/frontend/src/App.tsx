import {useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState} from "react"
import {Button} from "@/components/ui/button"
import {ButtonGroup} from "@/components/ui/button-group"
import {Checkbox} from "@/components/ui/checkbox"
import {Tabs, TabsList, TabsPanel, TabsTrigger} from "@/components/ui/tabs"
import {LoadSigils, LoadConfig, SaveLoadout, MinimiseApp, LoadExclusives, GemNames, CharaNames} from "../bindings/sigilloadout/loadoutservice"
import {messages, type Messages} from "./messages"
import {LANGS, LANG_LABEL, initialLang, type Lang} from "./lang"
import {
    buildLoadoutPayload,
    buildSigilIndex,
    configToSlots,
    itemRowsOf,
    pad12,
    parseExclusiveTable,
    parseSigilRows,
    sanitizeExclusiveState,
    skillTableOf,
    withExclusiveToggle,
    type Exclusive,
    type ExclusiveState,
    type Sigil,
    type Slot,
    type Skill
} from "./model"
import {SlotRow, HEADER_ROW} from "./SlotEditor"
import {ExclusivePanel} from "./ExclusivePanel"
import {SigilEditorPanel} from "./SigilEditorPanel"

type TabKey = "general" | "exclusive" | "sigilEditor"

/** 外壳唯一的一条失败通道：谁失败都只是把它写进这里，屏幕上只可能显示一条。 */
type Failure = { kind: "sigil" | "config" | "exclusive" | "save" | "tables"; error?: unknown }

function failureText(failure: Failure, t: Messages): string {
    switch (failure.kind) {
        case "sigil":
            return t.sigilFail(failure.error)
        case "config":
            return t.configFail(failure.error)
        case "exclusive":
            return t.exclFail(failure.error)
        case "save":
            return t.saveFail(failure.error)
        case "tables":
            return t.tablesNotReady
    }
}

// 配装那两页共用的滚动盒子：整个面板自己滚，所以每页各留一份滚动位置。
// 因子编辑不套它——那一页自带内边距与滚动。
const LOADOUT_PANEL = "min-h-0 flex-1 overflow-y-auto px-4 [scrollbar-gutter:stable]"

// 每语言的显示名表在 Go 侧只在启动时读一次（main.go 的 loadAssets），之后不再变，所以缓存住：
// 换语言命中缓存就同步落地，标签与外层文字同一帧换掉——否则要先显示旧名字、等 IPC 回来再跳一次。
const nameCache = new Map<Lang, { names: Record<string, string>; charas: Record<string, string> }>()

export default function App() {
    const [skills, setSkills] = useState<Skill[]>([])
    const [sigils, setSigils] = useState<Sigil[]>([])
    const [slots, setSlots] = useState<Slot[]>([])
    // 配置读回来了没有。没读回来就**绝不写盘**：读取失败时槽位被铺成空数组（见加载那段的
    // setSlots(pad12([]))），此刻交出去的载荷会把磁盘上那份完整的配置整体替换掉。
    const [loadoutRead, setLoadoutRead] = useState(false)
    const [failure, setFailure] = useState<Failure | null>(null)
    const [tab, setTab] = useState<TabKey>("general")
    const [exclusiveTable, setExclusiveTable] = useState<Exclusive[]>([])
    const [exclusiveState, setExclusiveState] = useState<ExclusiveState | undefined>(undefined)
    // 当前语言的显示名（sigils.lang.json：{hash: 名字}）。名字按语言变，只是标签，身份是 hash。
    const [names, setNames] = useState<Record<string, string>>({})
    // 角色名（chara.lang.json：{PL 码: 名字}），专职专属因子页的行标签。
    const [charaNames, setCharaNames] = useState<Record<string, string>>({})
    const [lang, setLang] = useState<Lang>(initialLang) // 存在 loadout.json 里
    // 整个可视工具一份文案（messages.ts）；换成别的语言只是换一个索引。
    const t = messages[lang]

    // 因子表的一切派生关系构造一次（可脱离 React 测试）。
    const index = useMemo(() => buildSigilIndex(sigils, skills, names), [sigils, skills, names])

    // 落盘要读"当前"状态，而这个回调刻意不带响应式依赖（闭包里的值会过期），所以从 ref 取。
    const latest = useRef({slots, index, lang, exclusiveState})
    // 渲染期写 ref 是 React 明令禁止的（会把一次从未提交的渲染里的值发布出去），挪进 layout effect。
    useLayoutEffect(() => {
        latest.current = {slots, index, lang, exclusiveState}
    }, [slots, index, lang, exclusiveState])

    /*
        自动保存只由**编辑**触发，不由状态变化触发。

        挂在 [slots, lang, exclusiveState] 上的版本只能靠一个一次性旗标去赌"哪次状态更新先把它
        消费掉"，加载中任何一次额外的 setState 都会让启动变成一次写盘（旧版本那次 exclusive
        迁移就是这么把用户配置改坏的）。现在没有旗标：加载不调用任何编辑处理器，排不出保存。
    */
    // 落盘：状态全部从 latest.current 读，所以这个回调没有响应式依赖，也不会读到旧值。
    //
    // 防抖住在 Go 侧（LoadoutService）：这里每改一下就交一份，后端替换待写并重启定时器，退出时由
    // OnShutdown 的 flushNow 兜住。
    const saveNow = useCallback(async () => {
        if (!loadoutRead) return
        const current = latest.current
        if (current.index.mainKeys.length === 0 || current.index.skillHashes.length === 0) {
            setFailure({kind: "tables"})
            return
        }
        try {
            const payload = buildLoadoutPayload(
                current.slots,
                current.index,
                current.lang,
                current.exclusiveState
            )
            await SaveLoadout(JSON.stringify(payload, null, 2))
            setFailure((prev) => (prev?.kind === "save" ? null : prev))
        } catch (e) {
            setFailure({kind: "save", error: e})
        }
    }, [loadoutRead])

    // 编辑必须先把新值放进 latest.current 再保存：处理器里 setState 要等它返回后才提交，那时读到的还是
    // 上一次的状态，落盘就永远慢一次（最后一次勾选就是这么丢的）。
    const edit = useCallback(
        (patch: { slots?: Slot[]; exclusiveState?: ExclusiveState; lang?: Lang }) => {
            latest.current = {...latest.current, ...patch}
            if (patch.slots) setSlots(patch.slots)
            if (patch.exclusiveState) setExclusiveState(patch.exclusiveState)
            if (patch.lang) setLang(patch.lang)
            void saveNow()
        },
        [saveNow]
    )

    useEffect(() => {
        void (async () => {
            // 三份读取一起发出；只有 LoadConfig 要先拿到因子表（它要把存档里的 gem 翻译成组键、
            // 并按 cap 夹等级）。
            const exclusives = LoadExclusives()
            exclusives.catch(() => {}) // 稍后才 await 它；先挂上处理，免得出现未处理拒绝

            let sigilTable: Sigil[] = []
            let skillTable: Skill[] = []
            try {
                const rows = parseSigilRows(await LoadSigils())
                skillTable = skillTableOf(rows)
                sigilTable = itemRowsOf(rows)
                setSkills(skillTable)
                setSigils(sigilTable)
            } catch (e) {
                setFailure({kind: "sigil", error: e})
            }

            try {
                applyConfig(JSON.parse(await LoadConfig()), sigilTable, skillTable)
                setLoadoutRead(true)
            } catch (e) {
                setFailure({kind: "config", error: e})
                // 读不出来也要铺满行：屏幕上 0 行看起来像什么都没发生。
                setSlots(pad12([]))
            }

            try {
                setExclusiveTable(parseExclusiveTable(JSON.parse(await exclusives)))
            } catch (e) {
                setFailure({kind: "exclusive", error: e})
            }
        })()
        // 只在挂载时跑一次：它读的是启动那一刻的磁盘状态。这里也刻意不读 t——文案在渲染时由
        // failureText 取，所以没有语言依赖会把这一跑重新触发。
    }, [])

    // 文档语言跟着界面语言走：index.html 里写死的那一个只够第一次渲染，读屏软件看的是这个属性。
    useEffect(() => {
        document.documentElement.lang = lang
    }, [lang])

    // 显示名按语言取（随包的 sigils.lang.json / chara.lang.json）。取不到名字的条目由
    // SkillPicker 回落成 hash——看得见但不好看，总比显示一个别的语言的名字强。
    useEffect(() => {
        const hit = nameCache.get(lang)
        if (hit) {
            setNames(hit.names)
            setCharaNames(hit.charas)
            return
        }
        let cancelled = false
        Promise.all([GemNames(lang), CharaNames(lang)])
            .then(([gems, charas]) => {
                if (cancelled) return
                const entry = {names: gems ?? {}, charas: charas ?? {}}
                nameCache.set(lang, entry)
                setNames(entry.names)
                setCharaNames(entry.charas)
            })
            .catch(() => {
                if (cancelled) return
                setNames({})
                setCharaNames({})
            })
        return () => {
            cancelled = true
        }
    }, [lang])

    const updateSlot = useCallback(
        (row: number, patch: Partial<Slot>) => {
            edit({slots: latest.current.slots.map((slot, i) => (i === row ? {...slot, ...patch} : slot))})
        },
        [edit]
    )

    /**
     * 把存档读进编辑器状态。键就是文件里的键，编辑器不再把 exclusive 翻译成别的形状：
     * 旧版本那一步迁移只读 legacy.t1/t2/war，于是"角色 hash 作键 + 当前形状"的条目会被整条
     * 改写成全开（false 静默变 true），随后自动保存写回磁盘——用户的开关状态就这么没了。
     */
    const applyConfig = (parsed: unknown, sigilTable: Sigil[], skillTable: Skill[]) => {
        const cfg = (parsed ?? {}) as {
            lang?: unknown
            slots?: unknown
            exclusive?: unknown
        }
        if (LANGS.includes(cfg.lang as Lang)) setLang(cfg.lang as Lang)
        setSlots(pad12(configToSlots(cfg, sigilTable, skillTable)))
        setExclusiveState(sanitizeExclusiveState(cfg.exclusive))
    }

    // 表头勾选框：全选 / 全不选（官方 Table 的写法）。
    const allEnabled = slots.every((s) => s.enabled)
    const toggleAll = () => {
        edit({slots: latest.current.slots.map((slot) => ({...slot, enabled: !allEnabled}))})
    }

    // 落到文件里的键是**角色 hash**（身份），不是 PL 码：古兰/姬塔共享 PL0000，所以一次点击
    // 要写到共享这个 PL 码的每个角色上，面板才继续是一行。规则（只写 `false`、打开就删键）
    // 在 model.ts 的 withExclusiveToggle 里，那里能单独测。
    const updateExclusive = (player: string, skillHash: string, value: boolean) => {
        const charaHashes = exclusiveTable.filter((e) => e.player === player).map((e) => e.hash)
        edit({exclusiveState: withExclusiveToggle(latest.current.exclusiveState, charaHashes, skillHash, value)})
    }

    // Esc 隐藏到托盘，**除非**焦点在浮层（下拉列表/对话框）里：那里它归浮层，只关浮层。浮层判断在
    // keydown 做（Base UI 会在 keydown 期间卸载弹层，keyup 就看不到它了），结果留给 keyup 用。
    // 推迟到 keyup 才藏：keydown 就藏掉的话，这一记 keyup 会落到游戏窗口上。
    // 菜单热键不在这里处理：它是 mod 的全局注册，按一下就是开关这个窗口（见 windowstate.go 的 wmToggle）。
    useEffect(() => {
        let timer: ReturnType<typeof setTimeout> | undefined
        let overlayEscOnKeyDown = false
        const isInOverlay = (e: KeyboardEvent) =>
            !!(e.target as HTMLElement | null)?.closest?.(
                // Esc 归谁：打开的浮层，以及因子编辑页里的数值框——那一页把 Esc 定义成"放开这个框"
                // （见 SkillRow），不该同时把整个窗口藏到托盘去。
                '[data-slot="combobox-content"], [role="dialog"], [role="alertdialog"], .skill-rows input'
            )
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key !== "Escape") return
            // 两条路都赋值：丢一次 keyup 不能把下一次 Esc 也吞掉。
            overlayEscOnKeyDown = isInOverlay(e)
            if (overlayEscOnKeyDown) return
            clearTimeout(timer)
            e.preventDefault()
        }
        const onKeyUp = (e: KeyboardEvent) => {
            if (e.key !== "Escape") return
            if (overlayEscOnKeyDown) {
                overlayEscOnKeyDown = false
                return
            }
            clearTimeout(timer)
            timer = setTimeout(() => void MinimiseApp(), 150)
        }
        // 捕获阶段：Base UI 在 React 处理 keydown 时卸载弹层，冒泡阶段的监听器会看到一个已经
        // 摘下来的 target，从而错判成"不在浮层"，把窗口藏掉。捕获阶段弹层还活着。
        document.addEventListener("keydown", onKeyDown, true)
        document.addEventListener("keyup", onKeyUp, true)
        return () => {
            document.removeEventListener("keydown", onKeyDown, true)
            document.removeEventListener("keyup", onKeyUp, true)
            clearTimeout(timer)
        }
    }, [])

    /*
        窗口失活时 :focus / :focus-visible 会被判掉，而 DOM 焦点还在框里：切到游戏改完再回来接着
        输靠的就是它。所以失活那一刻给仍持有焦点的元素挂上 data-focus-hold，由 style.css 补齐那套
        指示，视觉就不随窗口的激活状态变。
    */
    useEffect(() => {
        const hold = () => {
            const active = document.activeElement
            if (active instanceof HTMLElement) active.setAttribute("data-focus-hold", "")
        }
        const release = () =>
            document.querySelector("[data-focus-hold]")?.removeAttribute("data-focus-hold")
        window.addEventListener("blur", hold)
        window.addEventListener("focus", release)
        return () => {
            window.removeEventListener("blur", hold)
            window.removeEventListener("focus", release)
            release()
        }
    }, [])

    return (
        <div className="fixed inset-0 flex flex-col">
            <Tabs
                value={tab}
                onValueChange={(v) => setTab(v as TabKey)}
                className="flex min-h-0 flex-1 flex-col gap-0"
            >
                <div className="flex h-[60px] shrink-0 flex-col justify-center border-b bg-background px-4">
                    <div className="flex items-center justify-between gap-3">
                        <TabsList>
                            <TabsTrigger value="general">{t.tabGeneral}</TabsTrigger>
                            <TabsTrigger value="exclusive">{t.tabExclusive}</TabsTrigger>
                            <TabsTrigger value="sigilEditor">{t.tabSigilEditor}</TabsTrigger>
                        </TabsList>
                        {/*
                        一个连成一体的组（ButtonGroup 削直内侧圆角、去掉内部边框）。size 用 stock 的
                        icon-sm（正方形、四格等宽）；行内 translate 抵掉按下位移、transition 关掉选中格
                        150ms 的淡出淡入（行内样式优先于 class）；lang 让每个标签按自己的语言选字体，
                        否则字体会跟着文档语言换，切语言时粗细就变了。
                    */}
                        <ButtonGroup aria-label={t.langSwitch}>
                            {LANGS.map((option) => (
                                <Button
                                    key={option}
                                    size="icon-sm"
                                    style={{translate: "none", transition: "none"}}
                                    variant={option === lang ? "default" : "outline"}
                                    // default 变体不带边框色（组的外框会断一截），补上 outline 同款。
                                    className={option === lang ? "border-input" : undefined}
                                    lang={option}
                                    onClick={() => {
                                        // 语言也存在 loadout.json 里，所以这也是一次编辑
                                        edit({lang: option})
                                    }}
                                >
                                    {LANG_LABEL[option]}
                                </Button>
                            ))}
                        </ButtonGroup>
                    </div>
                </div>
                {/*
                    状态条是外壳级的通知，不属于任何一个 Tab：留在这一层，切到因子编辑页时那两页的
                    "没保存成功"才不会被静默吞掉。全部失败都走这一条通道，屏幕上不可能出现两条矛盾提示。
                */}
                {failure && (
                    <div
                        aria-live="polite"
                        className="mx-4 mt-2 rounded-md bg-muted/50 px-3 py-1.5 text-sm text-muted-foreground"
                    >
                        {failureText(failure, t)}
                    </div>
                )}
                {/*
                    配装那两页各自是滚动盒子（见 LOADOUT_PANEL），也没有"不在这一页就整块不渲染"的分支。
                    两页都 keepMounted：否则每次切页都要卸载/重挂 10 行 SlotRow（每行两个 Base UI 下拉）——
                    切页于是只剩显示/隐藏，代价是三页启动时都挂上（专属页 29 行，可忽略）。
                */}
                {/* 上下 16px 只归这一页：专属因子那页沿用 LOADOUT_PANEL 原本的间距。 */}
                <TabsPanel value="general" keepMounted className={`${LOADOUT_PANEL} py-4`}>
                    <div className={HEADER_ROW}>
                        <div className="pl-0.5 pr-3">
                            {/* 配置读回来之前不画"全选"：空数组的 every() 是 true，会先勾上再改，看着像闪一下。 */}
                            {slots.length > 0 && (
                                <Checkbox checked={allEnabled} onCheckedChange={toggleAll} aria-label={t.selectAll} />
                            )}
                        </div>
                        <div>#</div>
                        <div className="pr-2 pl-[11px]">{t.headerPrimary}</div>
                        <div className="pl-[21px]">{t.headerSecondary}</div>
                    </div>

                    {slots.map((slot, row) => (
                        <SlotRow key={row} row={row} slot={slot} sigils={index} t={t} updateSlot={updateSlot} />
                    ))}
                </TabsPanel>
                <TabsPanel value="exclusive" keepMounted className={LOADOUT_PANEL}>
                    <ExclusivePanel
                        table={exclusiveTable}
                        state={exclusiveState}
                        names={names}
                        charaNames={charaNames}
                        onChange={updateExclusive}
                    />
                </TabsPanel>
                {/*
                    keepMounted：这一页的编辑状态活在组件里，而后端落盘要等 500ms 防抖（见
                    editservice.go）。切走就卸载的话，在防抖窗口内切回来会读到还没写下的旧文件——
                    屏幕上刚敲的数字消失，随后那份旧列表还会把磁盘上的新值覆盖掉。
                */}
                <TabsPanel value="sigilEditor" keepMounted className="min-h-0 flex-1 overflow-auto">
                    <SigilEditorPanel lang={lang} />
                </TabsPanel>
            </Tabs>
        </div>
    )
}
