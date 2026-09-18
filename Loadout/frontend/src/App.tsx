import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Tabs, TabsList, TabsPanel, TabsTrigger } from "@/components/ui/tabs"
import { LoadSigils, LoadConfig, SaveLoadout, MinimiseApp, GetHotkey, LoadExclusives } from "../bindings/loadouttool/loadoutservice"
import { copy } from "./copy"
import { LANGS, LANG_LABEL, initialLang, type Lang } from "./i18n"
import { DEFAULT_HIDE_KEY, DEFAULT_LEVEL, configToSlots, pad12, sanitizeExclusiveState, type Exclusive, type ExclusiveState, type SavedItem, type Sigil, type Slot, type Trait } from "./model"
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
  const [resetOpen, setResetOpen] = useState(false)
  const [hideKey, setHideKey] = useState(DEFAULT_HIDE_KEY)
  const [lang, setLang] = useState<Lang>(initialLang) // persisted in loadout.json
  const resetCancelRef = useRef<HTMLButtonElement | null>(null)
  // 配装那两页只有中英两套文案，所以日语下它们显示英文——这比在同一个窗口里
  // 放两个互不同步的语言开关要好（那一页的文案本身三种都齐，见 i18n.ts）。
  const copyLang = lang === "ja" ? "en" : lang
  const t = copy[copyLang]
  // 一个开关管三个 Tab：中 → EN → JA → 中。
  const nextLang = LANGS[(LANGS.indexOf(lang) + 1) % LANGS.length]
  const toggleLang = () => setLang(nextLang)
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
            zh: s.zh ?? "",
            en: s.name || s.zh || "",
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
            name: s.name ?? s.zh ?? s.hash ?? "",
            zh: s.zh ?? "",
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
        const table = (JSON.parse(exclusiveJson).exclusives ?? []) as Exclusive[]
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
            merged[row.t1] = legacy.t1 !== false
            merged[row.t2] = legacy.t2 !== false
            merged[row.war] = legacy.war !== false
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

  const traitByName = useMemo(() => new Map(traits.map((tr) => [tr.hash, tr])), [traits])
  const sigilByHash = useMemo(() => new Map(sigils.map((s) => [s.hash, s])), [sigils])

  // Variants grouped by display name: one entry per name (unique picker item).
  const groupedByName = useMemo(() => {
    const byName = new Map<string, Sigil[]>()
    for (const s of sigils) {
      const g = byName.get(s.name)
      if (g) g.push(s)
      else byName.set(s.name, [s])
    }
    return byName
  }, [sigils])

  // General mains: only item rows (hash != skill1) with no character
  // exclusivity (player == "") qualify. Rows that cannot take part in a
  // combination (onlyone / non-item) stay selectable — their secondary list is
  // hinted as fully illegal instead.
  const sigilGroups = useMemo(
    () =>
      [...groupedByName.entries()]
        .filter(([, variants]) => variants.some((v) => v.player === ""))
        .map(([name, variants]) => ({
          name,
          zh: variants[0]?.zh ?? name,
        })),
    [groupedByName]
  )

  const traitHashes = useMemo(() => traits.map((tr) => tr.hash), [traits])

  // Pool families: the pool version (lot != []) and its pool, read by hashFor
  // at save time (which variant hash a family resolves to).
  const poolByMain = useMemo(() => {
    const byName = new Map<string, { poolHash: string; lot: Set<string> }>()
    for (const [name, variants] of groupedByName) {
      const pool = variants.find((v) => v.lot && v.lot.length > 0)
      if (!pool) continue
      byName.set(name, { poolHash: pool.hash, lot: new Set(pool.lot) })
    }
    return byName
  }, [groupedByName])

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
      const variants = (groupedByName.get(name) ?? []).filter(
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
  }, [groupedByName, ordinaryTraits])

  // Family item hash at save time: no secondary -> pool version (lot != []
  // variant, else first); secondary in the pool's lot -> pool version;
  // secondary equal to a variant's fixed second (sec) -> that fixed version;
  // anything else (illegal) still generates with the pool version (styles
  // only). lot match wins over sec match (currently no trait is in both).
  const hashFor = (name: string, secHash = ""): string => {
    const variants = groupedByName.get(name)
    if (!variants || variants.length === 0) return ""
    const pool = poolByMain.get(name)
    if (pool && (secHash === "" || pool.lot.has(secHash))) return pool.poolHash
    const fixed = secHash !== "" ? variants.find((v) => v.skill2 === secHash) : undefined
    return fixed?.hash ?? pool?.poolHash ?? variants[0].hash
  }

  // Stable callbacks + memoized arrays keep SlotRow memoization effective:
  // editing one row no longer re-renders all 12.
  const maxOfMain = useCallback((name: string) => {
    const variants = groupedByName.get(name)
    const tr = variants && variants.length > 0 ? traitByName.get(variants[0].skill1) : undefined
    return tr?.cap ?? DEFAULT_LEVEL
  }, [groupedByName, traitByName])
  const maxOfSec = useCallback(
    (h: string) => traitByName.get(h)?.cap ?? DEFAULT_LEVEL,
    [traitByName]
  )

  // Picker item values: main = unique display names; secondary = trait hashes
  // (labels provided by hashLabels).
  const sigilNames = useMemo(() => sigilGroups.map((g) => g.name), [sigilGroups])
  const sigilNameSet = useMemo(() => new Set(sigilNames), [sigilNames])
  const hashLabels = useMemo(
    () =>
      Object.fromEntries([
        ...traits.map((tr) => [tr.hash, lang === "zh" ? tr.zh : tr.en] as const),
        ...sigilGroups.map((g) => [g.name, lang === "zh" ? g.zh : g.name] as const),
      ]),
    [traits, sigilGroups, lang]
  )
  const updateSlot = useCallback((index: number, patch: Partial<Slot>) => {
    setSlots((prev) => prev.map((slot, i) => (i === index ? { ...slot, ...patch } : slot)))
  }, [])

  // Reload the player config (falls back to the preset template). Used at mount
  // and after a reset so the UI mirrors the fresh state without restarting the
  // app. The tables are parameters: at mount time the sigils/traits state is
  // still empty, so reading it here would resolve zero display names.
  const reloadConfig = async (
    sigilTable: Sigil[] = sigils,
    traitTable: Trait[] = traits
  ) => {
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
        zh: sigilByHash.get(hash)?.zh ?? "",
        en: sigilByHash.get(hash)?.name ?? "",
      }
      const items: SavedItem[] = [main]
      if (s.secHash !== "") {
        items.push({
          hash: s.secHash,
          level: s.secLevel,
          zh: traitByName.get(s.secHash)?.zh ?? "",
          en: traitByName.get(s.secHash)?.en ?? "",
        })
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
        : { [row.t1]: true, [row.t2]: true, [row.war]: true }
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
          <div className="flex items-center">
            <AlertDialog open={resetOpen} onOpenChange={setResetOpen}>
              <AlertDialogTrigger
                render={
                  <Button variant="ghost" size="sm" aria-label={t.reset}>
                    {t.reset}
                  </Button>
                }
              />
              <AlertDialogContent size="sm" initialFocus={resetCancelRef}>
                <AlertDialogHeader>
                  <AlertDialogTitle>{t.reset}?</AlertDialogTitle>
                  <AlertDialogDescription>{t.resetDesc}</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel ref={resetCancelRef}>{t.cancel}</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() => {
                      // Cancel a pending debounced save: it would otherwise
                      // write the pre-reset state right after this write.
                      clearTimeout(saveTimer.current)
                      // Reset = empty configuration; lang survives (it is a
                      // tool-side setting, not part of the mod config).
                      void SaveLoadout(JSON.stringify({ lang, slots: [] }, null, 2))
                        .then(() => reloadConfig())
                        .catch((e) => setStatus(t.saveFail(e)))
                        .finally(() => setResetOpen(false))
                    }}
                  >
                    {t.reset}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
            <Button
              variant="ghost"
              size="sm"
              className="ml-1"
              onClick={toggleLang}
              aria-label={t.langSwitch}
            >
              {LANG_LABEL[nextLang]}
            </Button>
          </div>
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
            sigilNames={sigilNames}
            sigilNameSet={sigilNameSet}
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
            sigilByHash={sigilByHash}
            lang={copyLang}
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


