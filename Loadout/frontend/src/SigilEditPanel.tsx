import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent,
} from "react";
import { Call, Events } from "@wailsio/runtime";
import { X } from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { TooltipProvider } from "@/components/ui/tooltip";
import { messages } from "./messages";
import type { Lang } from "./lang";
import { SkillRow, type RowContext } from "./SkillRow";
import {
  asEdits,
  dedupe,
  explainAt,
  levelsOf,
  matches,
  pad,
  slotLabel,
  type SigilSkill,
  type SkillText,
  type SkillInfo,
} from "./skills";

const SERVICE = "main.EditService";
/*
  与 editservice.go 里的 saveFailedEvent 保持一致。防抖写入发生在请求它的那次调用
  返回之后，所以那里的失败没有可以返回的答复，只能以这个事件的形式到达。
*/
const SAVE_FAILED = "GBFR.SigilEdit.SaveFailed";

/** 可视工具准备写入的列表是否就是它读到的那个：同样的编辑，同样的数值。 */
const sameRecords = (a: SigilSkill[], b: SigilSkill[]) =>
  a.length === b.length &&
  a.every((record, i) =>
    record.values.every((value, slot) => value === b[i].values[slot]),
  );

/** 稍早之前的那个值：否则搜索框每敲一个键都要过滤一遍 200 行的列表。 */
function useDebounced<T>(value: T, delay = 150): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return settled;
}

/*
  “因子编辑”这一页。原先是一个独立窗口（SigilEdit.exe）的整页内容，
  现在原样搬成一个 Tab：行、说明、搜索、语言都在，只是不再自己钉住整个窗口。

  根节点按这一页排出来的宽度（888 DIP）设了下限，外面那一层面板负责横向滚动，
  所以窗口缩到比这更窄时，列是被滚动条推到视野外，而不是被裁掉。
*/
export function SigilEditPanel({ lang }: { lang: Lang }) {
  const [edits, setEdits] = useState<SigilSkill[]>([]);
  // 所选语言对每个因子的说法：名字、概要，以及共享同一段说明的那些连续等级——
  // 大多数只有一段，少数会在中途换措辞（见 explainAt）。
  const [texts, setTexts] = useState<Record<string, SkillText>>({});
  const [skills, setSkills] = useState<Record<string, SkillInfo>>({});
  const [error, setError] = useState<{ title: string; detail: string } | null>(null);
  const [errorOpen, setErrorOpen] = useState(false);
  // 哪些因子是展开的。数值只落在一个等级上的因子没有可展开的东西，
  // 所以只有跨多个等级的因子会进到这里。
  const [open, setOpen] = useState<Set<string>>(new Set());
  /*
    指针停留在的那一行，tooltip 是否显示全看它：指针在行里，说明就显示；只有离开这一行才会收起。

    以前 Base UI 自己的关闭理由（在触发器内部按下、焦点从数值框移到行上）会在
    指针还在行里时就把说明收走，所以打开状态改成由这里控制，只有指针能改变它，
    包括一次勾选：它是行在动而不是指针在动，随后由 resolveHoveredRow 跟进。
  */
  const [tipRow, setTipRow] = useState<string | null>(null);
  const listBox = useRef<HTMLDivElement>(null);
  /*
    跨过一次勾选重渲染保留的滚动偏移，没有待处理的勾选时为 null。

    一次勾选会重排列表——打开的内容排到最前——而浏览器会跟着刚被点击、仍持有焦点的
    那个勾选框走：它把该行滚回视野，这正是让勾选感觉列表跳了一下的原因。偏移在下面
    的 layout effect 里放回去，和把 tooltip 重新指向此刻指针下那一行（原本悬停的行已经
    移开，另一行滑到了它的位置）是同一次 pass，于是两者都落在指针所在的位置。
  */
  const heldScroll = useRef<number | null>(null);
  /*
    指针最后一次移动的位置。一次勾选会在指针没动的情况下移动行，
    而在行内移动也不会触发 enter，所以勾选之后，浏览器的 hover
    和我们自己的 enter/leave 都说不出当前悬停的是哪一行。
  */
  const lastMove = useRef<{ x: number; y: number } | null>(null);

  useLayoutEffect(() => {
    if (heldScroll.current === null) return;
    if (listBox.current) listBox.current.scrollTop = heldScroll.current;
    heldScroll.current = null;
    resolveHoveredRow();
  });
  const [query, setQuery] = useState("");
  const search = useDebounced(query);
  // 搜索框本身，好让它的清除按钮能把光标交还给它。
  const searchBox = useRef<HTMLInputElement>(null);

  const t = messages[lang];

  /*
    显示一次失败既记下它，也打开对话框。关闭只是关闭：消息留在 state 里，
    好让退场动画仍有东西可画——以前在关闭时清空，会让对话框在整个淡出过程中一片空白。
  */
  function showError(next: { title: string; detail: string }) {
    setError(next);
    setErrorOpen(true);
  }

  /*
    因子的名字和说明来自游戏针对所选语言的自有文本，
    所以语言一变就重新取一次。编辑列表与语言无关，这里刻意不去动它。
  */
  useEffect(() => {
    /*
      整个语言一次调用：每个因子的名字、概要和说明。列表三者都直接从这里读，
      所以切换语言不会让它们各自描述不同的表。
    */
    Call.ByName(`${SERVICE}.SkillMap`, lang)
      .then((map) => {
        setTexts((map ?? {}) as Record<string, SkillText>);
      })
      .catch((err) => showError({ title: t.readFailed, detail: String(err) }));
  }, [lang]);

  async function loadAll() {
    const [list, skillTable] = await Promise.all([
      Call.ByName(`${SERVICE}.LoadEdits`) as Promise<SigilSkill[]>,
      Call.ByName(`${SERVICE}.SkillTable`) as Promise<Record<string, SkillInfo>>,
    ]);
    // 根本不是十六进制的 key 也不是模组能应用的编辑，但它仍然是用户的一行：它被保留，
    // 用自己的 hash 当名字，而不是被过滤掉——在这里丢掉它，下一次写入就会把它从gemedits.json 中删除，
    // 而一个谁都看不见的编辑，比一个名字只是 hash 的更糟。
    // 文件里有什么就照原样拿什么：同一个地址可以同时有两条编辑，key 也可能是小写。
    // 清理是"读取"这一步做的事，所以原始列表被留着，用来判断文件是否已经说出了可视工具即将显示的内容。
    const raw = (list ?? [])
      .filter((e) => String(e.key ?? "").trim() !== "")
      .map((e) => ({
        ...e,
        // 可视工具所提供的每张表都以大写 hash 为键，而手写进 gemedits.json 的 key 可能是小写。
        // 在这里归一化，下面的每一次查找才能直接用 key 本身，
        // 而不是靠过去那半打各自把它转成大写的调用点。
        //
        // String() 不是多余的：手改过的文件里 key 可能是数字，那时直接 toUpperCase
        // 会抛，整份列表会退化成一句笼统的"读取失败"，而不是只坏掉那一行。
        key: String(e.key ?? "").toUpperCase(),
        // 十个槽，数字或 null：短了一截或者一个值都没有的文件用 null 补齐 ——
        // null 就是游戏自己的数值，什么都不写入。同理，values 不是数组时要当作空，
        // 否则 pad 会把字符串按字符铺进参槽，看起来就像"用户在这些槽里填过值"。
        values: pad(
          Array.isArray(e.values)
            ? e.values.map((v) => (typeof v === "number" && Number.isFinite(v) ? v : null))
            : [],
        ),
      }));

    // 一个地址一条编辑，且只留编辑（见 asEdits）。结果与文件不同时立刻写回：
    // 旧文件在第一次打开时就被理顺，而不是等到下一次敲键。
    const records = dedupe(asEdits(raw, skillTable ?? {}));
    setEdits(records);
    setSkills(skillTable ?? {});
    if (!sameRecords(records, raw)) {
      Call.ByName(`${SERVICE}.SaveEdits`, records).catch((err) =>
        showError({ title: messages[lang].writeFailed, detail: String(err) }),
      );
    }
  }

  useEffect(() => {
    loadAll().catch((err) => showError({ title: t.readFailed, detail: String(err) }));
  }, []);

  /*
    防抖之后才失败的写入，由后端推送过来——见 SAVE_FAILED。它和立即失败共用同一个
    对话框，因为在用户看来它们是同一件事：编辑没有落到磁盘上。语言变化时重新订阅，
    好让标题跟着切换走；On 交回的函数就是 React 在退出时运行的取消订阅。
  */
  useEffect(
    () =>
      Events.On(SAVE_FAILED, (event) => {
        showError({ title: t.writeFailed, detail: String(event.data) });
      }),
    [lang],
  );

  /*
    游戏有的每个因子，而不仅是编辑过的那些：一行就是一个因子，它的勾选框是该因子
    被编辑的等级。找到某个因子是搜索框的活，所以这份列表是总目录，而不是一份新增清单。
  */
  const rows = useMemo(() => {
    const byKey = new Map<string, SigilSkill[]>();
    for (const record of edits) {
      const held = byKey.get(record.key);
      if (held) held.push(record);
      else byKey.set(record.key, [record]);
    }

    /*
      两个层级上都是打开的内容排最前：有启用等级的因子排在其余因子之上，
      因子内部启用的等级排在它的其他行之上。
      打开的内容就是游戏正在生效的东西，所以它必须最先被找到。
    */
    const keys = [...Object.keys(texts)];
    // 表里没有的 hash——手写的 gemedits.json、别的版本留下的编辑——保留而不是丢掉，
    // 因为列表显示不出来的编辑，就是谁都不知道正在生效的编辑。它和其他因子一起排序。
    for (const key of byKey.keys()) {
      if (!(key in texts)) keys.push(key);
    }

    const needle = search.trim().toLowerCase();

    return keys
      .map((key) => {
        const info: SkillInfo | undefined = skills[key];
        const records = byKey.get(key) ?? [];
        const byLevel = new Map(records.map((record) => [record.level, record]));
        const label = texts[key]?.name ?? key;

        return {
          key,
          label,
          // 父行读的是概要：它代表整个因子，而概要是游戏对这个因子本身的一句话，
          // 不是针对其中某个等级的。
          summary: texts[key]?.summary ?? "",
          info,
          byLevel,
          enabled: records.some((record) => record.enabled),
          // 因子显示哪些等级、按什么顺序，是 skills.ts 的事。
          levels: levelsOf(info, records),
        };
      })
      // 搜索按名字，或按表和 gemedits.json 给因子编键的 hash——手动把某一行调出来靠的就是后者。
      .filter((row) => matches(row.label, row.key, needle))
      .sort(
        (a, b) =>
          Number(b.enabled) - Number(a.enabled) ||
          a.label.localeCompare(b.label, lang === "zh" ? "zh-Hans-CN" : lang),
      );
  }, [edits, texts, skills, search, lang]);

  /**
   * 一个等级的勾选框所开启的编辑：没有任何输入，所以每个槽都是游戏自己的数值。
   *
   * `enabled` 是调用方"开启一条编辑"的意思：勾选一个等级会把它打开，往里面输入则
   * 不会（见 updateLevel）。
   */
  function newRecord(key: string, level: number, enabled: boolean): SigilSkill {
    return {
      enabled,
      key: key,
      level: level,
      // 完全没有数值：没碰过的槽是 null，会把游戏自己的数值留在原处——
      // 所以勾选一个等级却什么都不改，就等于什么都不写。
      values: pad([]),
    };
  }

  /*
    一个等级的勾选框。该地址还没有编辑时，勾选它就是创建一条，内容来自游戏在那个
    等级上的自有行；取消勾选会把这条编辑关掉并保留它的数值——带用户输入数值的关闭
    记录仍然会被保存（见 isEdit），只是不生效。取消一条没有任何用户输入的记录等于
    没有编辑，commit 会把它丢掉。
  */
  function toggleLevel(key: string, level: number) {
    beginTick();
    const at = edits.findIndex((e) => e.key === key && e.level === level);
    if (at < 0) {
      commit([...edits, newRecord(key, level, true)]);
      return;
    }
    commit(edits.map((e, i) => (i === at ? { ...e, enabled: !e.enabled } : e)));
  }

  /*
    表头勾选框代表整个因子：它把该因子显示的所有等级一并打开，也一并关闭。第一次
    点击还会让这些等级诞生——没人编辑过的因子还没有任何行，而勾选表头就是关于它们全体的一句话。
  */
  function toggleSkill(key: string, nextChecked: boolean) {
    beginTick();
    const mine = edits.filter((e) => e.key === key);
    if (!nextChecked) {
      commit(edits.map((e) => (e.key === key ? { ...e, enabled: false } : e)));
      return;
    }

    const have = new Set(mine.map((e) => e.level));
    const added = levelsOf(skills[key], mine)
      .filter((level) => !have.has(level))
      .map((level) => newRecord(key, level, true));
    commit([...edits.map((e) => (e.key === key ? { ...e, enabled: true } : e)), ...added]);
  }

  /**
    勾选在重渲染之前做的事：为随后的 layout effect 记下滚动偏移（heldScroll），
    后者把视口放回原处，并把 tooltip 指向此刻指针下的那一行。
  */
  function beginTick() {
    heldScroll.current = listBox.current?.scrollTop ?? null;
  }

  /*
    指针在哪一行，是问文档而不是问 hover 事件：一次勾选之后，行在没动的指针下面
    移动了，而在行内移动也不会触发 enter，所以 hover 事件说不出当前悬停的是哪一行。
    这个函数由勾选之后的 layout effect 调用，所以这里找到的就是此刻指针下的那一行 ——
    无论它是被勾选的那行，还是滑进来占了它位置的那行 —— tooltip 跟着它走就是了。
  */
  function resolveHoveredRow() {
    const at = lastMove.current;
    if (!at) return;
    const row = document.elementFromPoint(at.x, at.y)?.closest("[data-row]");
    const id = row?.getAttribute("data-row") ?? null;
    /*
      这里只补一个 move，而 restInRow 会把整个进入过程重放一遍：造成这次勾选的点击
      让 Base UI 关掉了它的弹层，而 move 才是它的 hover 接受的入场——先来一个 leave
      只会又把它关上，何况对于没挪窝的那一行，我们的 open prop 并没有变。
    */
    row?.dispatchEvent(
      new window.MouseEvent("mousemove", { bubbles: true, clientX: at.x, clientY: at.y }),
    );
    setTipRow(id);
  }

  /*
    指针进入和离开行；它所在的那一行是决定 tooltip 是否显示的唯一因素（见 tipRow）。
    能改变它的只有指针从一行移到另一行——或者一次勾选，那是行在动，由 resolveHoveredRow 处理。
  */
  function restInRow(id: string, e: PointerEvent<HTMLElement>) {
    /*
      Base UI 只在打开它的那个事件是 mouseenter 或 mousemove 时才让 tooltip 跟随光标
      （useClientPoint 检查的正是这一点），而一次点击之后，它根本不允许 hover 打开，
      直到指针离开这一行再回来。聚焦一个数值框、切换窗口、回来再扫进这一行，记录里写的仍然是 focus，
      它自己的 hover 也仍然被挡住——于是这次访问的第一个 tooltip 锚在行的中央，只有第二个才落在光标上。

      所以进入的过程在行上被完整重放：leave 清掉那个闩，enter 是它接受的入场，
      move 带上指针的位置。resolveHoveredRow 需要的比这少，因为那里的弹层已经在行上打开了。
    */
    const at = { bubbles: true, clientX: e.clientX, clientY: e.clientY };
    const row = e.currentTarget;
    row.dispatchEvent(new window.MouseEvent("mouseleave", at));
    row.dispatchEvent(new window.MouseEvent("mouseenter", at));
    row.dispatchEvent(new window.MouseEvent("mousemove", at));
    setTipRow(id);
  }

  function leaveRow(id: string) {
    setTipRow((cur) => (cur === id ? null : cur));
  }

  /*
    一个数值框。往还没有编辑的等级里输入，会像勾选它的勾选框一样开始一条编辑 ——
    但不会把它打开：这些数值是用户的、会被保存，而勾选框才是把它们送进游戏的动作。
    输入过却从未生效的编辑，是列表明确显示出来的状态（它的勾选框是空的），不是意外。

    只有第一次敲键会保持滚动：创建记录可能让光标所在的那一行重排。之后每一次敲键都只是在原地改数值。
  */
  function updateLevel(key: string, level: number, patch: Partial<SigilSkill>) {
    const at = edits.findIndex((e) => e.key === key && e.level === level);
    if (at < 0) {
      beginTick();
      commit([...edits, { ...newRecord(key, level, false), ...patch }]);
      return;
    }
    /*
      只打补丁，绝不在这里碰 enabled——它是用户勾选出来的。

      清空最后一个数值之后这条记录还算不算编辑，由 skills.ts 的 isEdit（"勾选了，或者带着
      数字"）说了算，而 commit 的每条路径都经过 asEdits。在这里再写一遍那条规则，就等于只
      按后半句判断：勾选着的记录会因为输入框被清空而丢掉勾选，于是也掉出置顶区——用户明确
      按下的那一下被一次输入框操作撤销了。
    */
    commit(edits.map((e, i) => (i === at ? { ...e, ...patch } : e)));
  }

  function toggleOpen(key: string) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }

  /*
    整行是它内部勾选框的快捷方式。用户真正瞄准的东西——数值框、勾选框、箭头 ——
    都是 shadcn 控件并带 data-slot，所以各自保留自己的点击；
    触发器自身的 slot 不是控件，因此点在行上的点击仍然落到这里。
  */
  const isControl = (e: MouseEvent<HTMLElement>) =>
    !!(e.target as HTMLElement).closest(
      '[data-slot]:not([data-slot="tooltip-trigger"])',
    );

  /*
    每一次编辑都经过这里：屏幕上的列表就是全部状态，也是运行中的游戏最终拿到的东西。
    不是编辑的在途中就被丢掉（asEdits）——所以勾选一个等级再取消，不会留下任何东西，
    而清空一条编辑的所有框，会把整条编辑带走。

    前端对"何时写入"刻意保持无知。它在每次变化时把整份列表交出去，不等答复；
    后端的尾随防抖把一串敲键变成一次 gemedits.json 写入和一次在线应用，
    只有完全无法被接受的列表才会作为值得打断用户的失败回来。
  */
  function commit(next: SigilSkill[]) {
    const kept = asEdits(next, skills);
    setEdits(kept);
    Call.ByName(`${SERVICE}.SaveEdits`, kept).catch((err) =>
      showError({ title: messages[lang].writeFailed, detail: String(err) }),
    );
  }

  /*
    一行显示的说明：覆盖它所在等级的那段措辞（见 explainAt），其中每个 {N} 被改写成它对应的槽号（见 slotLabel）。

    游戏的占位符从 0 开始（{0} 是第一个数值）；行里显示的是数字，所以 tooltip 把第一个写成 {1}，
    让读者顺着数下去。把数值替换进去是错的：数字已经在屏幕上了，不明显的是哪一个数字对应哪一部分。
  */
  function slotNotation(key: string, level: number): string {
    return slotLabel(explainAt(texts[key]?.explain, level));
  }

  /*
    一行需要从这里拿的一切，装在一个对象里：文案、说明文本、tooltip 依赖的两个指针处理函数，
    以及一行可以请求的编辑。行本身住在 SkillRow.tsx —— 它们不该知道的是列表如何过滤、如何排序、如何保存。
  */
  const rowCtx: RowContext = {
    t,
    notationOf: slotNotation,
    rest: restInRow,
    leave: leaveRow,
    toggleLevel,
    toggleSkill,
    toggleOpen,
    updateLevel,
    isControl,
  };

  return (
    <div className="flex h-full min-h-0 min-w-[888px] flex-col p-5 pb-6">
      {/*
        列表上方的一条横带：如何从中找到因子，以及语言切换——它一直待在那个角落。它下面的一切都归行所有。
      */}
      <div className="flex shrink-0 items-center gap-2 border-b pb-4">
        {/*
          没有标题：搜索框已经说明了这条横带是干什么的，而一个编辑计数会把两件不同的
          事——开着的有哪些、记录一共有几条——混进一个分数里。下面的列表就是整个总目录，
          浏览它就是搜索它；输入的内容经过防抖（useDebounced）才到列表，
          这是让两百行的列表不会每次敲键都重建的原因。
        */}
        <div className="min-w-0 flex-1">
          <InputGroup>
            <InputGroupInput
              ref={searchBox}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t.searchSigil}
              aria-label={t.searchSigil}
            />
            {/*
              一个清除按钮，只在有东西可清时出现，而且光标要回到框里：
              刚被点击的就是这个按钮，它马上就会消失，没有这一步下一次敲键就不知去向。
            */}
            {query !== "" && (
              <InputGroupAddon align="inline-end">
                <InputGroupButton
                  size="icon-xs"
                  aria-label={t.clearSearch}
                  onClick={() => {
                    setQuery("");
                    searchBox.current?.focus();
                  }}
                >
                  <X />
                </InputGroupButton>
              </InputGroupAddon>
            )}
          </InputGroup>
        </div>

        {/*
          语言开关不在这里：整个可视工具只有外壳右上角那一组（中 / EN / JA / KO 四个按钮，
          当前那个高亮）。
          这一页原来带着自己的三个按钮，合并成"因子编辑" Tab 之后，同一个窗口里放
          两套互不同步的语言状态只会让人困惑，所以那一组连同它自己的 localStorage
          一起删掉了，语言由 App 传进来。
        */}
      </div>

      {/*
        行在离滚动条 16px 处停下，而且无论列表是否溢出，滚动条宽度都被预留。
        过滤到只剩一行会让滚动条消失，不预留这条沟槽的话，每行都会加宽一个滚动条的宽度，
        清空搜索时又弹回去——实测行边缘在 772 -> 787 px 之间移动。
      */}
      {/*
        这里用的是 class 而不是 data-slot：
        行的点击处理把任何带 data-slot 的祖先当成控件（勾选框或数值框上的点击就是靠这个保住自己的点击的），
        所以这个容器上挂 data-slot 会吞掉所有点在行上的点击，因子就打不开了。
      */}
      {/*
        表格上下的 24px 在滚动盒之外（是 margin，不是 padding）：padding 会成为可滚动区域的一部分，
        滚动条就会从 padding 的边缘开始，而不是从第一行开始。
        这里只有上面那一份——外壳 padding 的底部设成同样的 24px——所以滚动条离横带和离窗口边缘是一样的距离。
      */}
      <div
        ref={listBox}
        className="skill-rows mt-6 min-h-0 flex-1 overflow-y-auto pr-4 [scrollbar-gutter:stable]"
        onPointerMove={(e) => {
          lastMove.current = { x: e.clientX, y: e.clientY };
        }}
      >
        {/*
          整个列表共用一个 provider：哪个 tooltip 打开由这里决定（见 tipRow），
          所以 base-ui 自己的打开/关闭时序根本不起作用——provider 剩下的用处是 tooltip 其余那一套设置，每一行都共用。
        */}
        <TooltipProvider>
          {rows.map((row) => (
            /*
              指针下的那一行决定哪个 tooltip 显示，
              所以每一行都会拿到那个 id 并与自己的比较——指针而不是 hover 事件为什么说了算，见 tipRow。
            */
            <SkillRow
              key={row.key}
              row={row}
              hoveredId={tipRow}
              isOpen={open.has(row.key)}
              ctx={rowCtx}
            />
          ))}
        </TooltipProvider>

        {rows.length === 0 && (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {t.noMatch}
          </p>
        )}
      </div>

      {/*
        写入失败值得打断用户——编辑没有落到磁盘上，
        而原因通常是用户必须处理的事（gemedits.json 被别的程序锁住、文件夹不可写）。
        两种失败都落到这里：立即失败，以及后端推送的防抖失败。
        关闭只是关闭：消息一直留到下一条失败把它替换掉，这样淡出时仍然有东西可画。
      */}
      <AlertDialog
        open={errorOpen}
        onOpenChange={setErrorOpen}
      >
        {/* 不用 size="sm"：那会把页脚切成两列网格，而这个对话框只有一个按钮，应该居中。 */}
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{error?.title}</AlertDialogTitle>
            <AlertDialogDescription className="wrap-anywhere">
              {error?.detail}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {/* 现成的页脚和现成的按钮：在 sm 断点以下是纵向排列，按钮会自己撑开。我们不设自己的宽度。 */}
          <AlertDialogFooter>
            <AlertDialogAction onClick={() => setErrorOpen(false)}>{t.ok}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
