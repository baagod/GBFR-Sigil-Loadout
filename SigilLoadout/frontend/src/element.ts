/*
    角色属性（游戏自己的六属性）→ 色条颜色。**整份映射只有这一处**：以后调色改这里就够了。

    属性本身来自游戏数据（chara.Element，生成器把它翻成名字写进 assets/abilities.json，见
    gen/game/abilities/abilities.go 的 elementNames）。颜色不写进资产：一份资产不该同时带着"是什么"
    与"画成什么色"两件事。

    键用语义名，因为资产里写的就是名字；整数写法也认（老资产、或有人把生成器改回去写原始整数时，
    0..5 同样落到这张表上，下标就是游戏枚举：0 火 1 水 2 土 3 风 4 光 5 暗）。
*/

/** 六属性各自的颜色：取自游戏自己的属性色相，压暗到这一页的灰阶基调里。 */
const ELEMENT_COLORS: Record<string, string> = {
    fire: "#e05c4a", // 火
    water: "#4a8fd4", // 水
    wind: "#4fae6b", // 风
    earth: "#c89a52", // 土
    light: "#e6c66a", // 光
    dark: "#9a72c9", // 暗
}

/** 整数写法用的名字表：下标即游戏枚举的值。 */
const ELEMENT_NAMES = ["fire", "water", "earth", "wind", "light", "dark"]

/** 属性缺失或认不出来时的中性灰。 */
const NEUTRAL = "#6b6b6b"

/**
 * 一条角色色条的颜色。
 *
 * 认不出来（空串、越界的数、资产里根本没有 element 这一项）给中性灰而不是空值：色条是"这一行是哪个
 * 角色"的补充信息，缺了它也不该让那一行长歪或者报错——六个属性认得出时才是有意义的那一条。
 */
export function elementColor(element: string | number | null | undefined): string {
    const name = typeof element === "number" ? ELEMENT_NAMES[element] : element
    return (name ? ELEMENT_COLORS[name] : undefined) || NEUTRAL
}
