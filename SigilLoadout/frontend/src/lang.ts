/*
  语言身份：这个可视工具支持哪几种、每种在切换键上叫什么、以及"系统要哪一种"。

  与文案分开，是因为两者变化的原因不同：加一种语言要动这里和 messages.ts 各一次，而改一句话
  只动 messages.ts。以前这两件事和"哪个页面用哪份文案"混在一起（配装两页在 copy.ts、因子编辑页
  在 i18n.ts），于是同一份表被切成两半、两个 t 并存。
*/

export const LANGS = ["zh", "en", "ja", "ko"] as const;
export type Lang = (typeof LANGS)[number];

/*
  每种语言用它自己的使用者第一眼认得的形式——中 / EN / 日 / 한——而不是四个语言代码：
  语言切换只有在看的人能找到自己那一项时才有用。用文字而不是国旗 emoji：Windows 不带国旗
  字形，画出来就是两个字母。
*/
export const LANG_LABEL: Record<Lang, string> = {
  zh: "中",
  en: "EN",
  ja: "日",
  ko: "한",
};

/*
  整个可视工具只有这一处"系统要什么语言"的猜测——只在配置里还没写语言时用一次（语言本身存在
  loadout.json 的 lang 里，由 App 读写）。

  语言只存 loadout.json 一处，不进 localStorage：同一个窗口里两套语言状态的话，
  用户在一页切的语言不会带到另一页。
*/
export function initialLang(): Lang {
  const preferred = navigator.language.toLowerCase();
  // 四个代码互不为前缀，所以"谁先谁后"不影响结果。
  return LANGS.find((lang) => preferred.startsWith(lang)) ?? "en";
}
