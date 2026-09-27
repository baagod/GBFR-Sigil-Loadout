/*
    角色那一行的颜色。**颜色不在这个文件里**：它只有一处，就是生成器出的 assets/chara.json
    （见 gen/game/limitbonus/limitbonus.go 的 elementColors），那里按 element 把颜色算好、记在每个角色
    上，界面拿 PL 码取到角色再一路传到渲染。所以这一份只留下"拿到的东西不像颜色时怎么办"。

    没有"属性名 → 颜色"的查找了：那只六色调色表已经删掉，取色不再需要第二步（见 chara.json 的形状）。
*/

/** 颜色缺失、或者拿到的东西不是一个颜色值时的中性灰。 */
const NEUTRAL = "#6b6b6b"

/**
 * 一条角色色条的颜色。
 *
 * 传进来的就是资产里这个角色那一栏 color（Go 侧已经按 element 算好，属性认不出来时它自己就是中性灰）。
 * 这里只兜一种情形：资产没到手、或者那一栏不是个正经的 hex——色条是"这一行是哪个角色"的补充信息，
 * 缺了它也不该让那一行长歪或者报错。
 */
export function elementColor(color: string | null | undefined): string {
    return typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color) ? color : NEUTRAL
}
