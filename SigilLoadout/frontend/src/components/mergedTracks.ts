import type {TrackInfo, TrackTable} from "../../bindings/sigilloadout/service/models"
import type {KeyedTrackRow, KeyedTrackTable} from "./TrackGrid"

/** 一条子轨在 `tables` 状态里的键：「子轨号 + kind」，如 `0flags` —— 从数据派生，别在别处写魔数。 */
export function trackKey(info: {sub: string; kind: string}): string {
    return info.sub + info.kind
}

/** 轨表：同一 kind 的多条子轨并成一张（表头只留一个，状态里直接用 `kind` 当键）。 */
export type MergedTable = {list: TrackInfo[]; table: KeyedTrackTable}

/** 轨表的行 id = `子轨键::该子轨的行键`。 */
export function splitMergedRowId(id: string): [string, string] | null {
    const at = id.indexOf("::")
    return at === -1 ? null : [id.slice(0, at), id.slice(at + 2)]
}

/**
 * 把同一动画的各条子轨按 `kind` 并成一张表：行键带子轨前缀，子轨首行只写子轨号 `00`（子轨内接着写 `2`、`3`，首行不用再标 1）。
 *
 * ‼️ 纯函数、每次返回新对象：调用方必须 `useMemo` —— 基座把 `rows` 的引用当"数据换没换"，
 * 每次渲染新建数组会让它每一帧重跑一趟列宽测量。
 */
export function mergeTrackTables(
    infos: readonly TrackInfo[],
    tables: Record<string, KeyedTrackTable>,
    baseline: {tables: Record<string, TrackTable>} | null,
): Map<string, MergedTable> {
    const byKind = new Map<string, MergedTable>()
    for (const kind of [...new Set(infos.map((info) => info.kind))]) {
        const list = infos.filter((info) => info.kind === kind)
        // 装载是全有全无（任一轨读失败整层报错），所以每张子轨表都在；只有 Go 的 nil 切片会序列化成 null。
        const columns: string[] = []
        for (const info of list) {
            for (const column of tables[trackKey(info)].columns ?? []) {
                if (!columns.includes(column)) columns.push(column)
            }
        }
        const first = tables[trackKey(list[0])]
        const rows: KeyedTrackRow[] = list.flatMap((info) => {
            const track = trackKey(info)
            const group = info.sub.padStart(2, "0")
            return (tables[track].rows ?? []).map((row, index) => ({
                ...row,
                key: `${track}::${row.key}`,
                track,
                groupKey: track,
                indexLabel: index === 0 ? group : String(index + 1),
                origValues:
                    row.orig != null && row.orig >= 0 ? baseline?.tables[track]?.rows[row.orig]?.values : undefined,
            }))
        })
        byKind.set(kind, {list, table: {...first, columns, rows}})
    }
    return byKind
}
