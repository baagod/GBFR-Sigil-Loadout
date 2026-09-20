import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { ButtonGroup } from "@/components/ui/button-group"
import { Checkbox } from "@/components/ui/checkbox"
import { Tabs, TabsList, TabsPanel, TabsTrigger } from "@/components/ui/tabs"
import { LoadSigils, LoadConfig, SaveLoadout, MinimiseApp, GetHotkey, LoadExclusives, GemNames, CharaNames } from "../bindings/loadouttool/loadoutservice"
import { messages, type Messages } from "./messages"
import { LANGS, LANG_LABEL, initialLang, type Lang } from "./lang"
import { DEFAULT_HIDE_KEY, buildLoadoutPayload, buildSigilIndex, configToSlots, itemRowsOf, pad12, parseExclusiveTable, parseSigilRows, sanitizeExclusiveState, traitTableOf, withExclusiveToggle, type Exclusive, type ExclusiveState, type Sigil, type Slot, type Trait } from "./model"
import { SlotRow, HEADER_ROW } from "./SlotEditor"
import { ExclusivePanel } from "./ExclusivePanel"
import { SigilEditPanel } from "./SigilEditPanel"

type TabKey = "general" | "exclusive" | "sigilEdit"

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
// 因子编辑不套它——那一页自带内边距与滚动，套上就是两层滚动。
const LOADOUT_PANEL = "min-h-0 flex-1 overflow-y-auto px-4 [scrollbar-gutter:stable]"

export default function App() {
  const [traits, setTraits] = useState<Trait[]>([])
  const [sigils, setSigils] = useState<Sigil[]>([])
  const [slots, setSlots] = useState<Slot[]>([])
  const [failure, setFailure] = useState<Failure | null>(null)
  const [tab, setTab] = useState<TabKey>("general")
  const [exclusiveTable, setExclusiveTable] = useState<Exclusive[]>([])
  const [exclusiveState, setExclusiveState] = useState<ExclusiveState | undefined>(undefined)
  // 当前语言的显示名（gem.lang.json：{hash: 名字}）。名字按语言变，所以它只是标签，
  // 不是身份——身份是 hash。
  const [names, setNames] = useState<Record<string, string>>({})
  // 角色名（chara.lang.json：{PL 码: 名字}），专职专属因子页的行标签。
  const [charaNames, setCharaNames] = useState<Record<string, string>>({})
  const [hideKey, setHideKey] = useState(DEFAULT_HIDE_KEY)
  const [lang, setLang] = useState<Lang>(initialLang) // persisted in loadout.json
  // 整个可视工具一份文案（messages.ts）；换成别的语言只是换一个索引。
  const t = messages[lang]

  // 因子表的一切派生关系构造一次（可脱离 React 测试）。
  const index = useMemo(() => buildSigilIndex(sigils, traits, names), [sigils, traits, names])

  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // 落盘要读"当前"状态，而定时器是在某一次渲染里排的，所以状态从 ref 取而不是让
  // 闭包捕获。
  const latest = useRef({ slots, index, lang, exclusiveState })
  latest.current = { slots, index, lang, exclusiveState }

  /*
    自动保存只由**编辑**触发，不由状态变化触发。

    以前它挂在 [slots, lang, exclusiveState] 上，于是"首次加载不写盘"只能靠一个一次性
    旗标去赌"哪一次状态更新先把它消费掉"——加载过程中任何一次额外的 setState 都会让
    启动变成一次写盘（旧版本那次 exclusive 迁移就是这么把用户配置改坏的）。现在没有
    旗标：加载不调用任何编辑处理器，所以它根本排不出保存。
  */
  // 落盘：状态全部从 latest.current 读，所以这个回调没有任何响应式依赖，也不会读到旧值。
  const saveNow = useCallback(async () => {
    const current = latest.current
    if (current.index.mainKeys.length === 0 || current.index.traitHashes.length === 0) {
      setFailure({ kind: "tables" })
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
      // 只清掉"保存失败"这一条：加载期别的失败跟这次保存没有关系。
      setFailure((prev) => (prev?.kind === "save" ? null : prev))
    } catch (e) {
      setFailure({ kind: "save", error: e })
    }
  }, [])

  const scheduleSave = useCallback(() => {
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => void saveNow(), 300)
  }, [saveNow])

  useEffect(() => {
    void (async () => {
      // 三份独立读取一起发出；只有 LoadConfig 要先拿到因子表（它要把存档里的
      // gem 翻译成组键、并按 cap 夹等级）。
      const exclusives = LoadExclusives()
      exclusives.catch(() => {}) // 稍后才 await 它；先挂上处理，免得出现未处理拒绝
      const hotkey = GetHotkey().catch(() => DEFAULT_HIDE_KEY)

      let sigilTable: Sigil[] = []
      let traitTable: Trait[] = []
      try {
        const rows = parseSigilRows(await LoadSigils())
        traitTable = traitTableOf(rows)
        sigilTable = itemRowsOf(rows)
        setTraits(traitTable)
        setSigils(sigilTable)
      } catch (e) {
        setFailure({ kind: "sigil", error: e })
      }

      try {
        applyConfig(JSON.parse(await LoadConfig()), sigilTable, traitTable)
      } catch (e) {
        setFailure({ kind: "config", error: e })
        // 读不出来也要铺满行：空表和"读失败"是两件事，而屏幕上 0 行看起来像后者
        // 什么都没发生。
        setSlots(pad12([]))
      }

      try {
        setExclusiveTable(parseExclusiveTable(JSON.parse(await exclusives)))
      } catch (e) {
        setFailure({ kind: "exclusive", error: e })
      }

      setHideKey(await hotkey)
    })()
    // 只在挂载时跑一次：它读的是启动那一刻的磁盘状态，重跑没有意义。这里也刻意不
    // 读 t——文案在渲染时由 failureText 取，所以没有语言依赖会把这一跑重新触发。
  }, [])

  // 文档语言跟着界面语言走：index.html 里写死的那一个只够第一次渲染，读屏软件看的是这个属性。
  useEffect(() => {
    document.documentElement.lang = lang
  }, [lang])

  // 显示名按语言取（内嵌的 gem.lang.json / chara.lang.json）。换语言就重取一次，
  // 取不到名字的条目由 TraitPicker 回落成 hash——看得见但不好看，总比显示一个别的
  // 语言的名字强。
  useEffect(() => {
    let cancelled = false
    Promise.all([GemNames(lang), CharaNames(lang)])
      .then(([gems, charas]) => {
        if (cancelled) return
        setNames(gems ?? {})
        setCharaNames(charas ?? {})
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
      setSlots((prev) => prev.map((slot, i) => (i === row ? { ...slot, ...patch } : slot)))
      scheduleSave()
    },
    [scheduleSave]
  )

  /**
   * Load a saved config into the editor state.
   *
   * 键就是文件里的键：编辑器不再把 exclusive 翻译成别的形状。旧版本那一步迁移只读
   * legacy.t1/t2/war，于是"角色 hash 作键 + 当前形状"的条目会被整条改写成全开
   * （false 静默变 true），随后自动保存把它写回磁盘——用户的开关状态就这么没了。
   */
  const applyConfig = (parsed: unknown, sigilTable: Sigil[], traitTable: Trait[]) => {
    const cfg = (parsed ?? {}) as {
      lang?: unknown
      slots?: unknown
      exclusive?: unknown
    }
    if (LANGS.includes(cfg.lang as Lang)) setLang(cfg.lang as Lang)
    setSlots(pad12(configToSlots(cfg, sigilTable, traitTable)))
    setExclusiveState(sanitizeExclusiveState(cfg.exclusive))
  }

  // Header check box: select all / clear all (official Table pattern).
  // slots is always padded to MAX_SLOTS, so the length check is unnecessary.
  const allEnabled = slots.every((s) => s.enabled)
  const toggleAll = () => {
    setSlots((prev) => prev.map((slot) => ({ ...slot, enabled: !allEnabled })))
    scheduleSave()
  }

  // Exclusive toggle update. 落到文件里的键是**角色 hash**（身份），不是 PL 码：PL 码只是
  // 显示用的标签，而古兰/姬塔共享 PL0000——所以一次点击要写到共享这个 PL 码的每个角色上，
  // 面板才继续是一行。规则（只写 `false`、打开就删键）在 model.ts 的 withExclusiveToggle 里，
  // 那里能单独测。
  const updateExclusive = (player: string, traitHash: string, value: boolean) => {
    const charaHashes = exclusiveTable.filter((e) => e.player === player).map((e) => e.hash)
    setExclusiveState((prev) => withExclusiveToggle(prev, charaHashes, traitHash, value))
    scheduleSave()
  }

  // The hide key is the SAME key as the mod's menu hotkey (default F1,
  // configurable; the mod publishes it in tool-hotkey.txt). Pressed here it
  // minimises the window; pressed in the game it brings the tool back. The
  // hide is deferred until AFTER the key-up so the press is fully consumed
  // here and never leaks to the game window. Escape also hides the window,
  // EXCEPT when an overlay (combobox list / dialog) has the focus: there it
  // belongs to the overlay and only closes it. The overlay check runs on
  // keydown (Base UI unmounts the popup during keydown, so keyup can no
  // longer see it) and is remembered for the keyup decision.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let overlayEscOnKeyDown = false
    const hideKeyPressed = (e: KeyboardEvent) => e.keyCode === hideKey
    const isInOverlay = (e: KeyboardEvent) =>
      !!(e.target as HTMLElement | null)?.closest?.(
        // Esc 归谁：打开的浮层，以及因子编辑页里的数值框——那一页把 Esc 定义成
        // "放开这个框"（见 TraitRow），不该同时把整个窗口藏到托盘去。
        '[data-slot="combobox-content"], [role="dialog"], [role="alertdialog"], .trait-rows input'
      )
    const onKeyDown = (e: KeyboardEvent) => {
      if (!hideKeyPressed(e) && e.key !== "Escape") return
      if (e.key === "Escape") {
        // Assign both ways: a lost keyup must not swallow the next Esc.
        overlayEscOnKeyDown = isInOverlay(e)
        if (overlayEscOnKeyDown) return
      }
      clearTimeout(timer)
      e.preventDefault()
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (!hideKeyPressed(e) && e.key !== "Escape") return
      if (e.key === "Escape") {
        if (overlayEscOnKeyDown) {
          overlayEscOnKeyDown = false
          return
        }
      }
      clearTimeout(timer)
      timer = setTimeout(() => void MinimiseApp(), 150)
    }
    // Capture phase: Base UI unmounts the popup while React processes the
    // keydown, so a bubble-phase listener would see a detached target and
    // wrongly hide the window. In the capture phase the popup is still live.
    document.addEventListener("keydown", onKeyDown, true)
    document.addEventListener("keyup", onKeyUp, true)
    return () => {
      document.removeEventListener("keydown", onKeyDown, true)
      document.removeEventListener("keyup", onKeyUp, true)
      clearTimeout(timer)
    }
  }, [hideKey])

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
            <TabsTrigger value="sigilEdit">{t.tabSigilEdit}</TabsTrigger>
          </TabsList>
          {/*
            一个连成一体的组（ButtonGroup 削直内侧圆角、去掉内部边框）。
            size 用 stock 的 icon-sm（正方形单元格，四格等宽）；
            行内 translate 抵掉 stock 按钮按下时的位移（行内样式优先于 class，不必 !important）；
            lang 让每个标签按自己的语言选字体，否则字体会跟着文档语言换，切语言时粗细就变了。
          */}
          <ButtonGroup aria-label={t.langSwitch}>
            {LANGS.map((option) => (
              <Button
                key={option}
                size="icon-sm"
                // 关掉 stock 的按下位移，以及选中格 150ms 的淡出淡入（行内样式优先于 class）。
                style={{ translate: "none", transition: "none" }}
                variant={option === lang ? "default" : "outline"}
                // default 变体不带边框色（组的外框会断一截），补上 outline 同款。
                className={option === lang ? "border-input" : undefined}
                lang={option}
                onClick={() => {
                  setLang(option) // 语言也存在 loadout.json 里，所以这也是一次编辑
                  scheduleSave()
                }}
              >
                {LANG_LABEL[option]}
              </Button>
            ))}
          </ButtonGroup>
        </div>
        </div>
        {/*
          状态条是外壳级的通知，不属于任何一个 Tab：它必须留在这一层，
          否则切到因子编辑页时那两页的"没保存成功"会被静默吞掉。全部失败都走
          这一条通道，所以屏幕上不可能出现两条互相矛盾的提示。
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
          配装那两页各自是滚动盒子（见 LOADOUT_PANEL），所以这里没有共用容器、
          也没有"不在这一页就整块不渲染"的分支：未激活的面板本来就不渲染。
        */}
        <TabsPanel value="general" className={LOADOUT_PANEL}>
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
        <TabsPanel value="exclusive" className={LOADOUT_PANEL}>
          <ExclusivePanel
            table={exclusiveTable}
            state={exclusiveState}
            names={names}
            charaNames={charaNames}
            onChange={updateExclusive}
          />
        </TabsPanel>
        {/*
          keepMounted：这一页的编辑状态活在组件里，而后端落盘要等 500ms 防抖
          （见 editservice.go）。切走就卸载的话，在防抖窗口内切回来会读到还没写下的
          旧文件——屏幕上刚敲的数字消失，随后那份旧列表还会把磁盘上的新值覆盖掉。
        */}
        <TabsPanel value="sigilEdit" keepMounted className="min-h-0 flex-1 overflow-auto">
          <SigilEditPanel lang={lang} />
        </TabsPanel>
      </Tabs>
    </div>
  )
}
