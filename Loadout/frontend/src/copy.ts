import type { Lang } from "./i18n"

/*
  配装那两页的文案。zh 这一份就是形状本身（`T = typeof zh`），其余三种语言照着它填——
  `Record<Lang, T>` 是那个"一种语言都不能漏"的检查，而因子编辑页自己那份在 i18n.ts。

  "因子"在游戏自己的文本里是有译名的：英文 sigil、日文 ジーン、韩文 진
  （见 TXT_SKILL_SUMMARY_113_00），所以那三种语言用的是游戏的说法，不是音译。
  剩下的标签与动词是工具自己的话，没有游戏原文可抄。
*/
const zh = {
  tabGeneral: "通用配装",
  tabExclusive: "专属因子",
  tabSigilEdit: "因子编辑",
  headerPrimary: "主因子",
  headerSecondary: "副因子",
  selectAll: "全选/全不选",
  pickTrait: "选择因子",
  none: "无",
  search: "搜索",
  empty: "无匹配因子",
  sigilFail: (e: unknown) => `因子表加载失败：${e}`,
  configFail: (e: unknown) => `配装加载失败：${e}`,
  exclFail: (e: unknown) => `专属因子表加载失败：${e}`,
  saveFail: (e: unknown) => `自动保存失败：${e}`,
  tablesNotReady: "数据表未加载，无法保存",
  langSwitch: "切换语言",
  rowEnable: "启用槽位",
}

export type T = typeof zh

export const copy: Record<Lang, T> = {
  zh,
  en: {
    tabGeneral: "General",
    tabExclusive: "Exclusives",
    tabSigilEdit: "Sigil edit",
    headerPrimary: "Primary Sigil",
    headerSecondary: "Secondary Sigil",
    selectAll: "Select all / none",
    pickTrait: "Select sigil",
    none: "None",
    search: "Search",
    empty: "No matching sigils",
    sigilFail: (e: unknown) => `Failed to load sigil table: ${e}`,
    configFail: (e: unknown) => `Failed to load loadout: ${e}`,
    exclFail: (e: unknown) => `Failed to load exclusive factors: ${e}`,
    saveFail: (e: unknown) => `Auto-save failed: ${e}`,
    tablesNotReady: "Tables not loaded yet; cannot save",
    langSwitch: "Switch language",
    rowEnable: "Enable slot",
  },
  ja: {
    tabGeneral: "汎用ジーン",
    tabExclusive: "専用ジーン",
    tabSigilEdit: "ジーン編集",
    headerPrimary: "メインジーン",
    headerSecondary: "サブジーン",
    selectAll: "全選択/解除",
    pickTrait: "ジーンを選択",
    none: "なし",
    search: "検索",
    empty: "一致するジーンがありません",
    sigilFail: (e: unknown) => `ジーンテーブルの読み込みに失敗：${e}`,
    configFail: (e: unknown) => `装備構成の読み込みに失敗：${e}`,
    exclFail: (e: unknown) => `専用ジーンテーブルの読み込みに失敗：${e}`,
    saveFail: (e: unknown) => `自動保存に失敗：${e}`,
    tablesNotReady: "データテーブルが未読み込みのため保存できません",
    langSwitch: "言語を切り替え",
    rowEnable: "スロットを有効化",
  },
  ko: {
    tabGeneral: "일반 진",
    tabExclusive: "전용 진",
    tabSigilEdit: "진 편집",
    headerPrimary: "메인 진",
    headerSecondary: "서브 진",
    selectAll: "전체 선택/해제",
    pickTrait: "진 선택",
    none: "없음",
    search: "검색",
    empty: "일치하는 진이 없습니다",
    sigilFail: (e: unknown) => `진 테이블을 불러오지 못했습니다: ${e}`,
    configFail: (e: unknown) => `장비 구성을 불러오지 못했습니다: ${e}`,
    exclFail: (e: unknown) => `전용 진 테이블을 불러오지 못했습니다: ${e}`,
    saveFail: (e: unknown) => `자동 저장 실패: ${e}`,
    tablesNotReady: "데이터 테이블이 아직 로드되지 않아 저장할 수 없습니다",
    langSwitch: "언어 전환",
    rowEnable: "슬롯 활성화",
  },
}
