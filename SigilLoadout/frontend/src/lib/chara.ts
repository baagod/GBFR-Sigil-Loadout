/*
    这份形状不属于任何一页：能力强化页按属性给角色名上色、专属因子页同样，所以放在这里，谁都不必为了
    一个资产形状去 import 另一页的逻辑。
*/

/**
 * assets/chara.json 里的一个角色：**颜色就记在它自己身上**（生成期按属性算好写进来的），所以界面拿
 * PL 码取到这一条就能直接上色，没有第二步查找。
 *
 * element 是生成期写下的冗余，只为让这份资产自解释；界面不读它。
 */
export type CharaEntry = { hash: string; element: string; color: string }

/** assets/chara.json：语言无关的角色表，**顶层直接以 PL 码为键**（与 chara.lang.json 里每门语言那份
 *  {PL 码: 名字} 同摆法）。
 *
 * ‼️ **键序就是游戏的角色顺序**（生成器按 `chara.UIOrder` 写的，见 gen 的 limitbonus）—— 后端读它来排
 * 「角色动作」页的角色列表（见 `service/assets.go` 的 `charaCodes`、`service/tables.go` 的
 * `sortByCharaOrder`），所以这份资产不能落成"按键排序"的 map。 */
export type CharaTable = Record<string, CharaEntry>

/**
 * 玩家角色码的形状（`pl1000`）：后端的角色名单 = **容器里有动作表的那些**（`ListCharacters`），而其中
 * 混着 6 个不是玩家角色的码（np / em 段与占位 `plffff`）——「角色动作」页的下拉只要玩家。那 6 个由
 * `chara.test.ts` 钉着；游戏自己的权威标记 `chara.IsNPC` 不在随包资产里，形状是这里能拿到的最近似的判据。
 */
export const PLAYER_CODE = /^pl\d{4}$/i
