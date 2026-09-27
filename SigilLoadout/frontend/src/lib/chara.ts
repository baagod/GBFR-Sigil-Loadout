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
 *  {PL 码: 名字} 同摆法）。 */
export type CharaTable = Record<string, CharaEntry>
