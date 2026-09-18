import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { ButtonGroup } from "@/components/ui/button-group"
import { Checkbox } from "@/components/ui/checkbox"
import { Tabs, TabsList, TabsPanel, TabsTrigger } from "@/components/ui/tabs"
import { LoadSigils, LoadConfig, SaveLoadout, MinimiseApp, GetHotkey, LoadExclusives, GemNames, CharaNames } from "../bindings/loadouttool/loadoutservice"
import { copy } from "./copy"
import { LANGS, LANG_LABEL, initialLang, type Lang } from "./i18n"
import { DEFAULT_HIDE_KEY, DEFAULT_LEVEL, configToSlots, pad12, parseExclusiveTable, sanitizeExclusiveState, type Exclusive, type ExclusiveState, type SavedItem, type Sigil, type Slot, type Trait } from "./model"
import { SlotRow, HEADER_ROW } from "./SlotEditor"
import { ExclusivePanel } from "./ExclusivePanel"
import { SigilEditPanel } from "./SigilEditPanel"

type TabKey = "general" | "exclusive" | "sigilEdit"

// 配装那两页共用的滚动盒子：整个面板自己滚，所以每页各留一份滚动位置。
// 因子编辑不套它——那一页自带内边距与滚动，套上就是两层滚动。
const LOADOUT_PANEL = "min-h-0 flex-1 overflow-y-auto px-4 [scrollbar-gutter:stable]"

export default function App() {
  const [traits, setTraits] = useState<Trait[]>([])
  const [sigils, setSigils] = useState<Sigil[]>([])
  const [slots, setSlots] = useState<Slot[]>([])
  const [status, setStatus] = useState("")
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
  // 一个开关管全部页面：配装那两页读 copy.ts，因子编辑页读 i18n.ts。
  const t = copy[lang]
  // First render + first load must not write loadout.json: the preset stays
  // active until the user actually edits something.
  const skipSave = useRef(true)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // Set when loadout.json could not be read: autosave must never overwrite a
  // configuration the editor never managed to load.
  const configLoadError = useRef<unknown>(null)

  useEffect(() => {
    ;(async () => {
      // Merged single table: item rows (hash != skill1) + non-item skill rows.
      let sigilsLoaded: Sigil[] = []
      let traitsLoaded: Trait[] = []
      // Independent reads start together; LoadConfig needs the sigil table.
      const exclusivesPromise = LoadExclusives()
      exclusivesPromise.catch(() => {}) // handled below; avoid an unhandled rejection
      const hotkeyPromise = GetHotkey().catch(() => DEFAULT_HIDE_KEY)
      try {
        const sigilJson = await LoadSigils()
        const rows = (JSON.parse(sigilJson).sigils as Partial<Sigil>[]) ?? []
        // Trait list = one row per trait hash (first row wins: the item named
        // after the trait); EN label uses the item EN name when present.
        const traitById = new Map<string, Trait>()
        for (const s of rows) {
          if (!s.skill1 || traitById.has(s.skill1)) continue
          if (s.player) continue // exclusive-slot sigils: traits never offered
          traitById.set(s.skill1, {
            hash: s.skill1,
            // 显示名来自命名它那一行的物品名，所以取名字时用那一行的 hash。
            gem: s.hash ?? "",
            cap: s.cap ?? DEFAULT_LEVEL,
          })
        }
        traitsLoaded = [...traitById.values()]
        setTraits(traitsLoaded)
        // Item rows only (hash != skill1): non-item skill rows stay in the
        // trait list above but never appear as pickable sigils.
        sigilsLoaded = rows
          .filter((s) => s.hash !== s.skill1)
          .map((s) => ({
            hash: s.hash ?? "",
            skill1: s.skill1 ?? "",
            player: s.player ?? "",
            onlyone: s.onlyone ?? "",
            mix: s.mix ?? "",
            lot: s.lot?.length ? s.lot : undefined,
            skill2: s.skill2 || undefined,
          }))
        setSigils(sigilsLoaded)
      } catch (e) {
        setStatus(t.sigilFail(e))
      }

      await reloadConfig(sigilsLoaded, traitsLoaded)
      try {
        const exclusiveJson = await exclusivesPromise
        const table = parseExclusiveTable(JSON.parse(exclusiveJson))
        setExclusiveTable(table)
        // Migrate legacy exclusive entries (character-hash keys + t1/t2/war)
        // to the player-keyed shape; otherwise they render as all-enabled and
        // the first toggle would silently re-enable the disabled factors.
        setExclusiveState((prev) => {
          if (!prev) return prev
          const byHash = new Map(table.map((e) => [e.hash, e]))
          const out: ExclusiveState = {}
          let migrated = false
          for (const [key, entry] of Object.entries(prev)) {
            const row = byHash.get(key)
            if (!row) {
              out[key] = entry
              continue
            }
            const merged = { ...(out[row.player] ?? {}) }
            const legacy = entry as Record<string, unknown>
            const [t1, t2, war] = row.gems.map(([, skill]) => skill)
            merged[t1] = legacy.t1 !== false
            merged[t2] = legacy.t2 !== false
            merged[war] = legacy.war !== false
            out[row.player] = merged
            migrated = true
          }
          return migrated ? out : prev
        })
      } catch (e) {
        setStatus(t.exclFail(e))
      }
      setHideKey(await hotkeyPromise)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 显示名按语言取（内嵌的 gem.lang.json / chara.lang.json）。换语言就重取一次，
  // 取不到名字的条目由 hashLabels 回落成 hash——看得见但不好看，总比显示一个别的
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

  const traitByName = useMemo(() => new Map(traits.map((tr) => [tr.hash, tr])), [traits])

  // 主因子的分组：同一词条的变体归一组，组键就是那条词条的 hash。以前按显示名分，
  // 而名字现在按语言变、不能再当键；同一个名字的那些本来也共享一条词条。
  const groupedByKey = useMemo(() => {
    const byKey = new Map<string, Sigil[]>()
    for (const s of sigils) {
      const key = s.skill1 || s.hash
      const g = byKey.get(key)
      if (g) g.push(s)
      else byKey.set(key, [s])
    }
    return byKey
  }, [sigils])

  // General mains: only item rows (hash != skill1) with no character
  // exclusivity (player == "") qualify. Rows that cannot take part in a
  // combination (onlyone / non-item) stay selectable — their secondary list is
  // hinted as fully illegal instead.
  const sigilGroups = useMemo(
    () =>
      [...groupedByKey.entries()]
        .filter(([, variants]) => variants.some((v) => v.player === ""))
        .map(([key, variants]) => ({
          key,
          // 显示名按 hash 取，所以这一组要带上代表行的 hash。
          gem: variants[0]?.hash ?? "",
        })),
    [groupedByKey]
  )

  const traitHashes = useMemo(() => traits.map((tr) => tr.hash), [traits])

  // Pool families: the pool version (lot != []) and its pool, read by hashFor
  // at save time (which variant hash a family resolves to).
  const poolByMain = useMemo(() => {
    const byName = new Map<string, { poolHash: string; lot: Set<string> }>()
    for (const [name, variants] of groupedByKey) {
      const pool = variants.find((v) => v.lot && v.lot.length > 0)
      if (!pool) continue
      byName.set(name, { poolHash: pool.hash, lot: new Set(pool.lot) })
    }
    return byName
  }, [groupedByKey])

  // Traits that can act as a secondary: provided by at least one ordinary
  // (mix=0, combinable) item row.
  const ordinaryTraits = useMemo(() => {
    const set = new Set<string>()
    for (const s of sigils) {
      if (s.onlyone !== "1" && s.hash !== s.skill1 && s.mix === "0") set.add(s.skill1)
    }
    return set
  }, [sigils])

  // Combination rules (hint only: nothing is blocked, no input is changed):
  //   1. rows that cannot take part — special (onlyone) or non-item
  //      (hash == skill1);
  //   2. a mix=1 row only pairs with its own lot pool or its fixed second;
  //   3. every other (ordinary, mix=0) row pairs freely.
  // Both roles are checked, so a secondary must itself be an ordinary trait.
  const legalByMain = useMemo(() => {
    const none: Set<string> = new Set()
    return (name: string) => {
      const variants = (groupedByKey.get(name) ?? []).filter(
        (s) => s.onlyone !== "1" && s.hash !== s.skill1
      )
      if (variants.length === 0) return none
      if (variants.some((v) => v.mix === "0")) return ordinaryTraits
      const legal = new Set<string>()
      for (const v of variants) {
        if (v.mix !== "1") continue
        if (v.skill2 && ordinaryTraits.has(v.skill2)) legal.add(v.skill2)
        for (const h of v.lot ?? []) if (ordinaryTraits.has(h)) legal.add(h)
      }
      return legal
    }
  }, [groupedByKey, ordinaryTraits])

  // Family item hash at save time: no secondary -> pool version (lot != []
  // variant, else first); secondary in the pool's lot -> pool version;
  // secondary equal to a variant's fixed second (sec) -> that fixed version;
  // anything else (illegal) still generates with the pool version (styles
  // only). lot match wins over sec match (currently no trait is in both).
  const hashFor = (name: string, secHash = ""): string => {
    const variants = groupedByKey.get(name)
    if (!variants || variants.length === 0) return ""
    const pool = poolByMain.get(name)
    if (pool && (secHash === "" || pool.lot.has(secHash))) return pool.poolHash
    const fixed = secHash !== "" ? variants.find((v) => v.skill2 === secHash) : undefined
    return fixed?.hash ?? pool?.poolHash ?? variants[0].hash
  }

  // Stable callbacks + memoized arrays keep SlotRow memoization effective:
  // editing one row no longer re-renders all 12.
  const maxOfMain = useCallback((name: string) => {
    const variants = groupedByKey.get(name)
    const tr = variants && variants.length > 0 ? traitByName.get(variants[0].skill1) : undefined
    return tr?.cap ?? DEFAULT_LEVEL
  }, [groupedByKey, traitByName])
  const maxOfSec = useCallback(
    (h: string) => traitByName.get(h)?.cap ?? DEFAULT_LEVEL,
    [traitByName]
  )

  // Picker item values: main = the group key (the trait hash its variants share),
  // secondary = trait hashes. Labels come from hashLabels.
  //
  // 主因子以前拿显示名当值，那是它在表里的身份；名字现在按语言变，值必须换成与语言
  // 无关的东西，而存档里记的本来就是 hash。
  const mainKeys = useMemo(() => sigilGroups.map((g) => g.key), [sigilGroups])
  const mainKeySet = useMemo(() => new Set(mainKeys), [mainKeys])
  const hashLabels = useMemo(
    () =>
      Object.fromEntries([
        ...traits.map((tr) => [tr.hash, names[tr.gem] ?? tr.hash] as const),
        ...sigilGroups.map((g) => [g.key, names[g.gem] ?? g.key] as const),
      ]),
    [traits, sigilGroups, names]
  )
  const updateSlot = useCallback((index: number, patch: Partial<Slot>) => {
    setSlots((prev) => prev.map((slot, i) => (i === index ? { ...slot, ...patch } : slot)))
  }, [])

  // Reload the player config (falls back to the preset template), so the UI
  // mirrors what is on disk without restarting the app. The tables are
  // parameters rather than read from state: the only caller is the mount load,
  // which has just fetched them while the state still holds the empty first
  // render.
  const reloadConfig = async (sigilTable: Sigil[], traitTable: Trait[]) => {
    try {
      const configJson = await LoadConfig()
      applyConfig(JSON.parse(configJson), sigilTable, traitTable)
      configLoadError.current = null
    } catch (e) {
      configLoadError.current = e
      setStatus(t.configFail(e))
    }
  }

  /** Load a saved config into the editor state (first render skips saving). */
  const applyConfig = (parsed: unknown, sigilTable: Sigil[], traitTable: Trait[]) => {
    const cfg = (parsed ?? {}) as {
      lang?: unknown
      slots?: unknown
      exclusive?: unknown
    }
    skipSave.current = true
    if (LANGS.includes(cfg.lang as Lang)) setLang(cfg.lang as Lang)
    setSlots(pad12(configToSlots(cfg, sigilTable, traitTable)))
    setExclusiveState(sanitizeExclusiveState(cfg.exclusive))
  }

  // Header check box: select all / clear all (official Table pattern).
  // slots is always padded to MAX_SLOTS, so the length check is unnecessary.
  const allEnabled = slots.every((s) => s.enabled)
  const toggleAll = () => {
    setSlots((prev) => prev.map((slot) => ({ ...slot, enabled: !allEnabled })))
  }

  const save = async () => {
    if (sigils.length === 0 || traits.length === 0) {
      setStatus(t.tablesNotReady)
      return
    }
    if (configLoadError.current !== null) {
      // Never overwrite a configuration the editor could not read.
      setStatus(t.configFail(configLoadError.current))
      return
    }
    const cfg: { items: SavedItem[]; enabled: boolean }[] = []
    for (const s of slots) {
      if (s.mainHash === "") continue
      const hash = hashFor(s.mainHash, s.secHash)
      // A gem the current sigil table cannot resolve would be written as an
      // empty id and make the mod reject the whole file: skip the row (it
      // already renders as empty in the editor).
      if (hash === "") continue
      const main = {
        gem: hash, // loadout.json protocol: item id stays "gem" (mod reads it)
        level: s.mainLevel,
      }
      const items: SavedItem[] = [main]
      if (s.secHash !== "") {
        items.push({ hash: s.secHash, level: s.secLevel })
      }
      cfg.push({ items, enabled: s.enabled })
    }
    try {
      const exclusive =
        exclusiveState && Object.keys(exclusiveState).length > 0
          ? exclusiveState
          : undefined
      await SaveLoadout(JSON.stringify({ lang, slots: cfg, exclusive }, null, 2))
      setStatus("")
    } catch (e) {
      setStatus(t.saveFail(e))
    }
  }

  // Exclusive toggle update (per character, per trait hash; a character's
  // first toggle writes all three factors so the file always shows the state).
  const updateExclusive = (
    player: string,
    row: Exclusive,
    traitHash: string,
    value: boolean
  ) => {
    setExclusiveState((prev) => {
      const current: ExclusiveState = prev ? { ...prev } : {}
      const entry = current[player]
        ? { ...current[player] }
        : Object.fromEntries(row.gems.map(([, skill]) => [skill, true]))
      entry[traitHash] = value
      current[player] = entry
      return current
    })
  }

  // Auto-save on edits (300 ms debounce; first load skips writing once).
  useEffect(() => {
    if (skipSave.current) {
      skipSave.current = false
      return
    }
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => void save(), 300)
    return () => clearTimeout(saveTimer.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slots, lang, exclusiveState])

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
            四种语言各一个按钮、当前那个高亮：比一个要按几下才转回来的循环按钮好认，
            而语言只有四种，放得下。
          */}
          <ButtonGroup aria-label={t.langSwitch}>
            {LANGS.map((option) => (
              <Button
                key={option}
                variant={option === lang ? "secondary" : "ghost"}
                size="sm"
                aria-pressed={option === lang}
                onClick={() => setLang(option)}
              >
                {LANG_LABEL[option]}
              </Button>
            ))}
          </ButtonGroup>
        </div>
        </div>
        {/*
          状态条是外壳级的通知，不属于任何一个 Tab：它必须留在这一层，
          否则切到因子编辑页时那两页的"没保存成功"会被静默吞掉。
        */}
        {status && (
          <div
            aria-live="polite"
            className="mx-4 mt-2 rounded-md bg-muted/50 px-3 py-1.5 text-sm text-muted-foreground"
          >
            {status}
          </div>
        )}
        {/*
          配装那两页各自是滚动盒子（见 LOADOUT_PANEL），所以这里没有共用容器、
          也没有"不在这一页就整块不渲染"的分支：未激活的面板本来就不渲染。
        */}
        <TabsPanel value="general" className={LOADOUT_PANEL}>
        <div className={HEADER_ROW}>
          <div>
            <Checkbox checked={allEnabled} onCheckedChange={toggleAll} aria-label={t.selectAll} />
          </div>
          <div>#</div>
          <div className="pr-2 pl-[11px]">{t.headerPrimary}</div>
          <div className="pl-[21px]">{t.headerSecondary}</div>
        </div>

        {slots.map((slot, index) => (
          <SlotRow
            key={index}
            index={index}
            slot={slot}
            mainKeys={mainKeys}
            mainKeySet={mainKeySet}
            traitHashes={traitHashes}
            labels={hashLabels}
            legalOfMain={legalByMain}
            t={t}
            maxOfMain={maxOfMain}
            maxOfSec={maxOfSec}
            updateSlot={updateSlot}
          />
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


