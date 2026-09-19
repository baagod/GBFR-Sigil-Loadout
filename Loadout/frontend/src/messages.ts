/*
  整个工具唯一的文案表。

  以前它按**页面**分成两份：配装那两页在 copy.ts、因子编辑页在 i18n.ts。于是同一个窗口里
  有两套机制、两个 `t`，以及同一句话的两种措辞（两个文件各写一遍"没有匹配的因子"）。分法现在
  按**关注点**：语言身份在 lang.ts，文字在这里。

  zh 这一份就是形状本身（`Messages = typeof zh`），其余语言照着它填——`Record<Lang, Messages>`
  是那个"一种语言都不能漏"的检查：漏一种 tsc 就报错，所以四语齐备不靠人眼。

  "因子"在游戏自己的文本里是有译名的：英文 sigil、日文 ジーン、韩文 진
  （见 TXT_SKILL_SUMMARY_113_00），所以那三种语言用游戏的说法，不是音译。其余标签与动词是
  工具自己的话，没有游戏原文可抄。因子的名字不在这里：它们来自游戏文本表，按当前语言从 Go
  侧取（gem.lang.json / chara.lang.json / skill.<lang>.json）。
*/
import type { Lang } from "./lang";

const zh = {
  // 外壳与两个下拉共用的通用字
  tabGeneral: "通用配装",
  tabExclusive: "专属因子",
  tabSigilEdit: "因子编辑",
  langSwitch: "切换语言",
  /** 两个因子下拉的搜索框：写 Hex 也能搜，所以提示里说清这件事。 */
  searchTrait: "搜索因子 | Hex",
  /** 两个因子下拉的"筛不出来"。 */
  noMatch: "无匹配因子",

  // 配装页
  headerPrimary: "主因子",
  headerSecondary: "副因子",
  selectAll: "全选/全不选",
  pickTrait: "选择因子",
  none: "无",
  rowEnable: "启用槽位",
  sigilFail: (e: unknown) => `因子表加载失败：${e}`,
  configFail: (e: unknown) => `配装加载失败：${e}`,
  exclFail: (e: unknown) => `专属因子表加载失败：${e}`,
  saveFail: (e: unknown) => `自动保存失败：${e}`,
  tablesNotReady: "数据表未加载，无法保存",

  // 因子编辑页
  clearSearch: "清除",
  ok: "确定",
  enable: (name: string) => `启用 ${name}`,
  /** 一个数值槽在读屏里叫什么（如 "数值"），行名与等级之外那半句。 */
  valueLabel: "数值",
  readFailed: "读取失败",
  writeFailed: "写入失败",
};

export type Messages = typeof zh;

export const messages: Record<Lang, Messages> = {
  zh,
  en: {
    tabGeneral: "General",
    tabExclusive: "Exclusives",
    tabSigilEdit: "Sigil edit",
    langSwitch: "Switch language",
    searchTrait: "Search sigil | Hex",
    noMatch: "No matching sigils",

    headerPrimary: "Primary Sigil",
    headerSecondary: "Secondary Sigil",
    selectAll: "Select all / none",
    pickTrait: "Select sigil",
    none: "None",
    rowEnable: "Enable slot",
    sigilFail: (e: unknown) => `Failed to load sigil table: ${e}`,
    configFail: (e: unknown) => `Failed to load loadout: ${e}`,
    exclFail: (e: unknown) => `Failed to load exclusive factors: ${e}`,
    saveFail: (e: unknown) => `Auto-save failed: ${e}`,
    tablesNotReady: "Tables not loaded yet; cannot save",

    clearSearch: "Clear",
    ok: "OK",
    enable: (name: string) => `Enable ${name}`,
    valueLabel: "value",
    readFailed: "Could not read",
    writeFailed: "Could not write",
  },
  ja: {
    tabGeneral: "汎用ジーン",
    tabExclusive: "専用ジーン",
    tabSigilEdit: "ジーン編集",
    langSwitch: "言語を切り替え",
    searchTrait: "ジーン | Hex で検索",
    noMatch: "一致するジーンがありません",

    headerPrimary: "メインジーン",
    headerSecondary: "サブジーン",
    selectAll: "全選択/解除",
    pickTrait: "ジーンを選択",
    none: "なし",
    rowEnable: "スロットを有効化",
    sigilFail: (e: unknown) => `ジーンテーブルの読み込みに失敗：${e}`,
    configFail: (e: unknown) => `装備構成の読み込みに失敗：${e}`,
    exclFail: (e: unknown) => `専用ジーンテーブルの読み込みに失敗：${e}`,
    saveFail: (e: unknown) => `自動保存に失敗：${e}`,
    tablesNotReady: "データテーブルが未読み込みのため保存できません",

    clearSearch: "クリア",
    ok: "OK",
    enable: (name: string) => `${name} を有効にする`,
    valueLabel: "数値",
    readFailed: "読み込みに失敗しました",
    writeFailed: "書き込みに失敗しました",
  },
  ko: {
    tabGeneral: "일반 진",
    tabExclusive: "전용 진",
    tabSigilEdit: "진 편집",
    langSwitch: "언어 전환",
    searchTrait: "진 | Hex 검색",
    noMatch: "일치하는 진이 없습니다",

    headerPrimary: "메인 진",
    headerSecondary: "서브 진",
    selectAll: "전체 선택/해제",
    pickTrait: "진 선택",
    none: "없음",
    rowEnable: "슬롯 활성화",
    sigilFail: (e: unknown) => `진 테이블을 불러오지 못했습니다: ${e}`,
    configFail: (e: unknown) => `장비 구성을 불러오지 못했습니다: ${e}`,
    exclFail: (e: unknown) => `전용 진 테이블을 불러오지 못했습니다: ${e}`,
    saveFail: (e: unknown) => `자동 저장 실패: ${e}`,
    tablesNotReady: "데이터 테이블이 아직 로드되지 않아 저장할 수 없습니다",

    clearSearch: "지우기",
    ok: "확인",
    enable: (name: string) => `${name} 활성화`,
    valueLabel: "값",
    readFailed: "읽기에 실패했습니다",
    writeFailed: "쓰기에 실패했습니다",
  },
};
