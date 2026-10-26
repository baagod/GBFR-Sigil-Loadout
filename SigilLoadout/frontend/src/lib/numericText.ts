/*
    数值输入框的文本解析规则（因子编辑 / 专精 / 能力强化 / 附加效果共用）。

    输入域上界：小数点前最多 6 位、后最多 6 位，最大 999999.999999。永远超不过它的数也不可能
    变成 Infinity——否则粘进来的 400 位数会被提交成 Infinity，JSON 拒绝写这种值，之后每次保存
    都失败。前导零也进不了：00 提交后是 0、框里却渲染不回 00，读者会以为第二个 0 被吃掉了。
*/
export const HALF_TYPED = /^-?(0|[1-9]\d{0,5})?(\.\d{0,6})?$/;

/** 输完之后什么才算数字：-3、30、0.6、.5。 */
export const NUMBER = /^-?((0|[1-9]\d{0,5})(\.\d{1,6})?|\.\d{1,6})$/;

export type SlotEdit =
    | { kind: "drop" }
    | { kind: "half"; text: string }
    | { kind: "commit"; value: number | null; keeps?: string };

/**
 * 一个槽里的一次按键会做什么。
 *
 * 输入框有焦点时把半成品文本留在屏幕上（"-" 是通往负数路上的状态）；永远成不了数字的东西直接
 * 丢弃，输入框保持原样。结果作为数据返回而不是直接应用，这样规则就是一个函数，测试能一个键
 * 一个键地驱动它。
 *
 * 输入框只吐出这一格的新值，不吐整个数组：换进哪个数组由调用方自己做，各页面持有值的方式不同。
 */
export function slotEdit(text: string): SlotEdit {
    /*
        往已经显示 0 的框里输入数字，意思就是那个数字：0 是输入框自己的。所以判断之前先去掉
        整数部分的前导零——"04" 是 4，"007" 是 7，"00" 是 0——而小数点需要的那个零留下，
        因为 0.5 不是 .5。
    */
    const tidied = text.replace(/^(-?)0+(?=\d)/, "$1");

    if (!HALF_TYPED.test(tidied)) return { kind: "drop" };
    if (tidied === "") {
        // 清空：该槽回到游戏自己的数值，输入框从这儿起把它显示成占位符——null 就是它。
        return { kind: "commit", value: null };
    }
    /*
        "0." 已经是 0：先按数字提交，但屏幕上仍留着 "0."，否则接着敲 5 会被接到已经规整过的
        "0" 后面，0.5 变成 5。
    */
    if (/^-?0\.$/.test(tidied)) return { kind: "commit", value: Number(tidied), keeps: tidied };
    if (!NUMBER.test(tidied)) return { kind: "half", text: tidied };

    /*
        是数字：立刻提交，但输入框在失焦前一直显示用户敲的内容（见 `keeps`）。提交是给游戏看的，
        必须逐次按键发生；但文本必须留给用户，因为一个数字的前缀往往本身就是数字——0.0 是 0，
        0.00 是 0——用提交后的数字渲染输入框会丢掉后面输入的内容：0.004 变成 4，5.05 变成 50。
        失焦时输入框重新渲染数字，这才让 06 读回成 6。
    */
    return { kind: "commit", value: Number(tidied), keeps: tidied };
}

/**
 * 输入框能放的最大值，也就是上面两个模式编码的上界：小数点前 6 位、后 6 位。
 *
 * 专门写出来是因为步进也必须遵守它。步进是值变化的第三条路（排在输入与手改文件之后），
 * 没有这个钳制时，停在 999999 的框按一下方向键会得到 1000000：七位数，它自己的模式随后
 * 拒绝，于是框里显示着一个按什么键都不会被接受的数字。
 */
export const MAX_VALUE = 999999;

/** 方向键与滚轮的一步，夹在输入框能放的范围内。 */
export const stepValue = (value: number, direction: 1 | -1) => {
    const next = Math.round((value + direction) * 100) / 100;
    return Math.abs(next) <= MAX_VALUE ? next : value;
};
