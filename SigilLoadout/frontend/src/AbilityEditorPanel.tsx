/*
    能力强化编辑页：一个能力一栏、一个数值。

    这一页刻意只做中文——它读的资产（assets/abilities.json）只有中文，所以文案直接写在组件里，
    不走 messages.ts 的多语言（那一份是给四个页签共用的外壳与因子页准备的）。

    编辑列表与因子编辑页是同一套规矩：按 Key 索引（mod 也按 Key 找 limit_bonus_param 的行）、每次
    改动把整份列表交给后端防抖落盘（见 abilityservice.go）、读取不写回。
*/
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Call, Events } from "@wailsio/runtime";
import { ChevronDown } from "lucide-react";

import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
    Combobox,
    ComboboxContent,
    ComboboxEmpty,
    ComboboxInput,
    ComboboxItem,
    ComboboxList,
    ComboboxTrigger,
    ComboboxValue,
} from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import {
    asEdit,
    dedupeCharacters,
    dedupeEdits,
    defaultOf,
    effectText,
    type Ability,
    type AbilityCharacter,
    type AbilityEdit,
    type AbilityTable,
} from "./ability";
import { slotEdit, stepValue } from "./skills";
import { useWheelStep } from "./useWheelStep";

const SERVICE = "main.AbilityService";
/*
    与 editservice.go 的 saveFailedEvent 是同一个事件（两个服务共用一个写入失败通道）：防抖写入
    发生在请求它的那次调用返回之后，那里的失败没有可返回的答复，只能以这个事件的形式到达。
*/
const SAVE_FAILED = "GBFR.SigilLoadout.SaveFailed";

/*
    表头与每一行共用这张列宽表，列才对得上：宽度只在这一处声明。效果那一列吃掉剩下的宽度——它最长，
    而其余几列的内容都是定长的。
*/
const COLUMNS =
    "grid grid-cols-[170px_88px_170px_minmax(160px,1fr)_84px_44px] items-center gap-2";

/**
 * 一栏。数值框的半成品文本、提交规则与步进与因子编辑页的十个槽逐字相同（见 skills.ts 的 slotEdit
 * 与 stepValue），只是这里一栏只有一个框。
 */
function AbilityRow({
    ability,
    record,
    onValue,
    onToggle,
}: {
    ability: Ability;
    /** 这一栏的编辑；没编辑过就是 undefined。 */
    record: AbilityEdit | undefined;
    /** 一个数值算完了，null = 清空（这一栏回到没编辑过）。 */
    onValue: (value: number | null) => void;
    onToggle: () => void;
}) {
    /*
        编辑中的框正在显示的文本，前提是它与已提交数字渲染出来的样子不同："-" 与 "0." 是通往一个数字
        路上的状态（受控输入框没有别的办法显示它们），而一个数字的前缀往往本身也是数字——0.004 用已
        提交的数字渲染会变成 4。
    */
    const [typed, setTyped] = useState<string | null>(null);

    const committed = record?.value;
    // 没人输入过时框是空的、占位符是游戏自己的数值：空 = 没碰过，与因子编辑页的十个槽同一条规矩。
    // 而效果那一行总要有个数可填，所以它拿游戏自己的数值当起点。
    const shown = committed ?? defaultOf(ability);

    function step(delta: 1 | -1) {
        setTyped(null);
        onValue(stepValue(committed ?? defaultOf(ability), delta));
    }

    /*
        滚轮让聚焦的框步进，而列表不能跟着滚——监听器为什么必须是原生的、passive: false 的，见
        useWheelStep。这一页一行只有一个框，所以不必像因子行那样按位置认是哪一个。
    */
    const host = useRef<HTMLDivElement>(null);
    useWheelStep(
        host,
        (target) => document.activeElement === target,
        (_target, delta) => step(delta),
    );

    return (
        <div ref={host} className={`${COLUMNS} h-11 border-b text-sm last:border-b-0`}>
            <span className="truncate">{ability.name}</span>
            <span className="truncate text-muted-foreground">{ability.category}</span>
            <span className="truncate text-muted-foreground">{ability.node}</span>
            {/* 节点描述下面那一行。它跟着数值框走——就是游戏里填了这个数会长成什么样子；这一栏是否
                正在游戏里生效由右边那个开关说。少数节点游戏自己没有这行文案。 */}
            <span className="truncate">
                {ability.effect === "" ? (
                    <span className="text-muted-foreground">—</span>
                ) : (
                    effectText(ability, shown)
                )}
            </span>
            <Input
                type="text"
                inputMode="decimal"
                aria-label={`${ability.name} 数值`}
                placeholder={String(defaultOf(ability))}
                value={typed ?? (committed === undefined ? "" : String(committed))}
                onChange={(e) => {
                    const edit = slotEdit(e.target.value, 0, [committed ?? null]);
                    if (edit.kind === "drop") return;
                    if (edit.kind === "half") {
                        setTyped(edit.text);
                        return;
                    }
                    // 数字已提交，但框会保留用户敲的那串文本直到离开它（见 typed 的声明）；
                    // 清空得到的是 null，也就是"这一栏回到没编辑过"。
                    setTyped(edit.keeps ?? null);
                    onValue(edit.values[0]);
                }}
                onBlur={() => setTyped(null)}
                onKeyDown={(e) => {
                    // Escape 让人放开这个框；方向键步进（否则它会把光标移到末尾，列表还会跟着滚）。
                    if (e.key === "Escape") {
                        e.currentTarget.blur();
                        return;
                    }
                    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
                    e.preventDefault();
                    step(e.key === "ArrowUp" ? 1 : -1);
                }}
                className="h-8 text-center tabular-nums"
            />
            <Checkbox
                checked={record?.enabled ?? false}
                // 没有编辑的栏里没有可启用的东西：开关不给按，数值框才是入口（见 toggle 的注释）。
                disabled={!record}
                aria-label={`启用 ${ability.name}`}
                onCheckedChange={onToggle}
            />
        </div>
    );
}

function AbilityEditorPanelBase() {
    const [characters, setCharacters] = useState<AbilityCharacter[]>([]);
    const [edits, setEdits] = useState<Map<string, AbilityEdit>>(new Map());
    // 初始列表读过没有。没读过就**绝不写盘**：此时 edits 是空的，交出去的这份空列表会被后端整体替换
    // 掉（同 SigilEditorPanel 的那条规则），用户其余的编辑就没了。
    const [editListRead, setEditListRead] = useState(false);
    const [selected, setSelected] = useState("");
    const [error, setError] = useState<{ title: string; detail: string } | null>(null);
    const [errorOpen, setErrorOpen] = useState(false);

    // 显示一次失败既记下它，也打开对话框。关闭只是关闭：消息留在 state 里好让退场动画仍有东西可画。
    function showError(next: { title: string; detail: string }) {
        setError(next);
        setErrorOpen(true);
    }

    useEffect(() => {
        void (async () => {
            const [table, list] = await Promise.all([
                Call.ByName(`${SERVICE}.LoadAbilities`) as Promise<AbilityTable | null>,
                Call.ByName(`${SERVICE}.LoadAbilityEdits`) as Promise<AbilityEdit[]>,
            ]);
            const characters = dedupeCharacters(table?.characters ?? []);
            setCharacters(characters);
            setSelected(characters[0]?.id ?? "");
            // 只读、不写回：归一化只是为了在屏幕上理顺这份列表，用户文件在下一次真正的编辑之前不该被动过
            // ——"打开一次就等于改过一次"与 App.tsx 那条"启动不写盘"是同一件事。
            setEdits(
                new Map(
                    dedupeEdits(
                        (list ?? [])
                            .map(asEdit)
                            .filter((edit): edit is AbilityEdit => edit !== null),
                    ).map((edit) => [edit.key, edit]),
                ),
            );
            setEditListRead(true);
        })().catch((err) => showError({ title: "读取失败", detail: String(err) }));
        // 只在挂载时跑一次：它读的是启动那一刻的磁盘状态。这一页只有中文，没有语言依赖会把这一跑重新触发。
    }, []);

    /*
        防抖之后才失败的写入由后端推送过来（见 SAVE_FAILED）。它和立即失败共用同一个对话框，因为在
        用户看来它们是同一件事：编辑没有落到磁盘上。On 交回的函数就是 React 在退出时运行的取消订阅。
    */
    useEffect(
        () =>
            Events.On(SAVE_FAILED, (event) => {
                showError({ title: "写入失败", detail: String(event.data) });
            }),
        [],
    );

    const items = useMemo(
        () => characters.map((character) => ({ value: character.id, label: character.name })),
        [characters],
    );
    const current = items.find((item) => item.value === selected) ?? items[0];
    const rows = useMemo(
        () => characters.find((character) => character.id === current?.value)?.abilities ?? [],
        [characters, current?.value],
    );

    /*
        每一次改动都经过这里：屏幕上的列表就是全部状态，也是运行中的游戏最终拿到的东西。前端对"何时
        写入"刻意保持无知——每次变化把整份列表交出去，不等答复；后端的尾随防抖把一串敲键变成一次
        abilityedits.json 写入与一次游戏内的应用。
    */
    function commit(next: Map<string, AbilityEdit>) {
        // 列表还没读回来就不写；不写盘的理由见 editListRead 的声明。
        if (!editListRead) return;
        setEdits(next);
        Call.ByName(`${SERVICE}.SaveAbilityEdits`, [...next.values()]).catch((err) =>
            showError({ title: "写入失败", detail: String(err) }),
        );
    }

    /*
        一个数值框。往还没有编辑的栏里输入会开始一条编辑，而且**是启用的**：这一版一栏一个数值，填
        数值就是要它生效，开关只是事后把它关掉的手段。已经有记录时只改数值、绝不在这里碰 enabled
        ——那是用户按下的开关（同 SkillRow 的"只打补丁"）。

        清空则把整条编辑删掉：契约里一条记录必须带数值，没有数值的记录在这里无处可存；这一栏于是回到
        没编辑过，屏幕上显示游戏自己的数值。
    */
    function setValue(ability: Ability, value: number | null) {
        const existing = edits.get(ability.key);
        const next = new Map(edits);
        if (value === null) {
            next.delete(ability.key);
        } else {
            next.set(ability.key, {
                enabled: existing?.enabled ?? true,
                key: ability.key,
                levels: existing?.levels ?? ability.levels,
                value: value,
            });
        }
        commit(next);
    }

    /*
        启用开关：只是事后把一条编辑关掉/再打开的手段。关掉时保留数值、只是不生效（mod 跳过未启用的
        条目），所以关着的那一栏仍显示用户填过的那个数。

        **开关不自己造数值**：没有数值的栏里它是不给按的（见渲染处的 disabled）。这一版一栏一个数值，
        打开一个空栏就等于替用户填一个数，而"填哪个数"只有用户知道。要让它生效就在数值框里输入，
        要撤销整栏就把数值框清空。
    */
    function toggle(ability: Ability) {
        const existing = edits.get(ability.key);
        if (!existing) return;
        const next = new Map(edits);
        next.set(ability.key, { ...existing, enabled: !existing.enabled });
        commit(next);
    }

    // min-w-[888px] 是本页排出来的宽度：外面那一层面板负责横向滚动，所以窗口更窄时列是被滚动条推到
    // 视野外，而不是被裁掉（同因子编辑页）。
    return (
        <div className="flex h-full min-h-0 min-w-[888px] flex-col page-padding">
            <div className="flex shrink-0 items-center gap-2 border-b pb-4">
                <Combobox
                    items={items}
                    value={current}
                    autoHighlight
                    onValueChange={(item) => {
                        if (item) setSelected(item.value);
                    }}
                >
                    <ComboboxTrigger
                        render={
                            <Button
                                variant="outline"
                                className="h-8 w-[220px] justify-between font-normal"
                            >
                                <ComboboxValue />
                                <ChevronDown className="size-4 text-muted-foreground" />
                            </Button>
                        }
                    />
                    <ComboboxContent>
                        <ComboboxInput showTrigger={false} placeholder="搜索角色" />
                        <ComboboxEmpty>无匹配角色</ComboboxEmpty>
                        <ComboboxList className="max-h-[264px]">
                            {(item) => (
                                <ComboboxItem key={item.value} value={item}>
                                    {item.label}
                                </ComboboxItem>
                            )}
                        </ComboboxList>
                    </ComboboxContent>
                </Combobox>
            </div>

            {/*
                表头待在滚动盒**外面**，否则下滚时它跟着走。它自己也是一个滚动容器（overflow-y-hidden），
                右边那条滚动条沟槽才与下面的列表留出同一个宽度——否则表头每列都比它下面那一行窄 16px。
            */}
            <div className="mt-6 shrink-0 overflow-y-hidden pr-4 [scrollbar-gutter:stable]">
                <div className={`${COLUMNS} pb-1 text-xs text-muted-foreground`}>
                    <span>能力</span>
                    <span>类别</span>
                    <span>节点</span>
                    <span>效果</span>
                    <span className="text-center">数值</span>
                    <span>启用</span>
                </div>
            </div>

            {/*
                ability-rows 是给外壳那记 Esc 用的（见 App.tsx）：焦点在数值框里时，Esc 是"放开这个框"
                （见 AbilityRow），不该同时把整个窗口藏到托盘去——与因子编辑页的 .skill-rows 同一条规矩。
                这一页没有用得上它的样式，所以它在这里只是个钩子。
            */}
            <div className="ability-rows min-h-0 flex-1 overflow-y-auto pr-4 [scrollbar-gutter:stable]">
                {rows.map((ability) => (
                    <AbilityRow
                        // 表格的顺序就是资产的顺序：开关与输入都不会让行跳位置，指针下那一栏永远不动。
                        key={ability.key}
                        ability={ability}
                        record={edits.get(ability.key)}
                        onValue={(value) => setValue(ability, value)}
                        onToggle={() => toggle(ability)}
                    />
                ))}
                {rows.length === 0 && (
                    <p className="py-6 text-center text-sm text-muted-foreground">没有可编辑的能力</p>
                )}
            </div>

            {/*写入失败值得打断用户——编辑没有落到磁盘上，而原因通常要用户自己处理
               (abilityedits.json 被别的程序锁住、文件夹不可写)。
               两种失败都落到这里：立即失败，以及后端推送的防抖失败。*/}
            <AlertDialog open={errorOpen} onOpenChange={setErrorOpen}>
                {/* 不用 size="sm"：那会把页脚切成两列网格，而这个对话框只有一个按钮，应该居中。 */}
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>{error?.title}</AlertDialogTitle>
                        <AlertDialogDescription className="wrap-anywhere">
                            {error?.detail}
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogAction onClick={() => setErrorOpen(false)}>确定</AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </div>
    );
}

/* keepMounted 的一页：memo 住才不会被 App 的重渲染连带（切 Tab 也算）。 */
export const AbilityEditorPanel = memo(AbilityEditorPanelBase);
