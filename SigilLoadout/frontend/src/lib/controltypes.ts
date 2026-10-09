/*
    `controlTypeHash_` 的**全部取值** —— 动作表里这一格只能从这 53 个值里挑。

    来源：`docs/action/ControlType全表.md`（自动扫描 36 个 `*_action.msg`、1429 条记录得出）。
    这个文件是那份表的**机械搬运**（一个值都没手改过），改表时两边一起改；每项的**含义**在那边
    （含"推断"与实测状态），这里**不抄** —— 界面上列表只显示值本身，抄一遍只会多一处会过期的文案。

    ⚠️ **这一列必须填十进制**：游戏拿它做整数比对，写十六进制（`4582EE4A`）解析不出整数 →
    技能直接放不出来。所以每项都带上十六进制（只作辨认，**别填**）与 `uses`
    （全游戏多少条动作用它，用来一眼看出常用 / 罕见）。
*/

export type ControlType = {
    /** **填进这一格的值**：十进制字符串（数据里 1429 条全是这个写法，没有例外）。 */
    decimal: string
    /** 同一个哈希的十六进制写法（**只是备注，别填**）。 */
    hex: string
    /** 全游戏用它的动作条数。 */
    uses: number
}

export const CONTROL_TYPES: readonly ControlType[] = [
    {decimal: "4087152117", hex: "F39CFDF5", uses: 724},
    {decimal: "1253898414", hex: "4ABCF8AE", uses: 128},
    {decimal: "3157634433", hex: "BC35AD81", uses: 122},
    {decimal: "1927393365", hex: "72E1B055", uses: 75},
    {decimal: "3601664416", hex: "D6AD09A0", uses: 43},
    {decimal: "1155529037", hex: "44DFF94D", uses: 35},
    {decimal: "893375102", hex: "353FD27E", uses: 33},
    {decimal: "3741546836", hex: "DF037954", uses: 33},
    {decimal: "2541436207", hex: "977B3D2F", uses: 32},
    {decimal: "2243428721", hex: "85B80171", uses: 29},
    {decimal: "3165820186", hex: "BCB2951A", uses: 26},
    {decimal: "2206771543", hex: "8388A957", uses: 20},
    {decimal: "2321443206", hex: "8A5E6986", uses: 15},
    {decimal: "1755775473", hex: "68A701F1", uses: 12},
    {decimal: "2179908516", hex: "81EEC3A4", uses: 10},
    {decimal: "3515414693", hex: "D188F8A5", uses: 8},
    {decimal: "1166208586", hex: "4582EE4A", uses: 8},
    {decimal: "1698638878", hex: "653F2C1E", uses: 6},
    {decimal: "3970774105", hex: "ECAD3459", uses: 6},
    {decimal: "3826571353", hex: "E414D859", uses: 5},
    {decimal: "372364762", hex: "1631D5DA", uses: 5},
    {decimal: "3882677858", hex: "E76CF662", uses: 4},
    {decimal: "233998962", hex: "0DF28A72", uses: 4},
    {decimal: "2876191771", hex: "AB6F341B", uses: 4},
    {decimal: "2647439833", hex: "9DCCB9D9", uses: 3},
    {decimal: "2323781251", hex: "8A821683", uses: 3},
    {decimal: "2882254335", hex: "ABCBB5FF", uses: 3},
    {decimal: "447322047", hex: "1AA997BF", uses: 2},
    {decimal: "2725224838", hex: "A26FA186", uses: 2},
    {decimal: "3246673494", hex: "C1844E56", uses: 2},
    {decimal: "3854653722", hex: "E5C1591A", uses: 2},
    {decimal: "2508036236", hex: "957D988C", uses: 2},
    {decimal: "3142325295", hex: "BB4C142F", uses: 2},
    {decimal: "2097158225", hex: "7D001851", uses: 2},
    {decimal: "823795986", hex: "311A2112", uses: 1},
    {decimal: "1884380292", hex: "70515C84", uses: 1},
    {decimal: "210354621", hex: "0C89C1BD", uses: 1},
    {decimal: "1104009025", hex: "41CDD741", uses: 1},
    {decimal: "2162093235", hex: "80DEECB3", uses: 1},
    {decimal: "1681860746", hex: "643F288A", uses: 1},
    {decimal: "2636122578", hex: "9D2009D2", uses: 1},
    {decimal: "481096658", hex: "1CACF3D2", uses: 1},
    {decimal: "1885419595", hex: "7061384B", uses: 1},
    {decimal: "3872343623", hex: "E6CF4647", uses: 1},
    {decimal: "3692514776", hex: "DC174DD8", uses: 1},
    {decimal: "496397537", hex: "1D966CE1", uses: 1},
    {decimal: "3982957697", hex: "ED671C81", uses: 1},
    {decimal: "1047714111", hex: "3E72D93F", uses: 1},
    {decimal: "3069389210", hex: "B6F3299A", uses: 1},
    {decimal: "1841834709", hex: "6DC82AD5", uses: 1},
    {decimal: "38436433", hex: "024A7E51", uses: 1},
    {decimal: "4140690168", hex: "F6CDEAF8", uses: 1},
    {decimal: "2844523558", hex: "A98BFC26", uses: 1},
] as const

/**
 * 这一列能填哪些值（**列表项**与**粘贴校验**都取这一份）。
 *
 * 只有 `controlTypeHash_` 这一列在册：它不是"随便写个数"的参数，写错一个字节（比如填成十六进制）
 * 技能就直接放不出来 —— 所以粘贴进来的值不在表里就**原样保留当前值**，不接受。
 */
export const CELL_CHOICES: ReadonlySet<string> = new Set(CONTROL_TYPES.map((item) => item.decimal))
