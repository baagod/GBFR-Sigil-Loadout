/*
  The tool's own copy, in each language it ships.

  Kept as a plain object rather than an i18n library: a handful of strings in three
  languages, so a dependency would be more machinery than the problem.

  Trait names are NOT here - those come from the game's own text tables, one per
  language, and are fetched from the Go side.

  The wording differs per language on purpose: the thing being edited is a trait a
  sigil carries, which the game's own data calls a "skill" (table `skill_status`),
  so Japanese calls it シジル and the asset names stay as the game spells them. The
  search box's placeholder says what typing in it does, so the band above the list
  needs no label of its own.
*/

export const LANGS = ["zh", "en", "ja"] as const;
export type Lang = (typeof LANGS)[number];

/*
  Kept as short as it can be, and as text rather than flag emoji: Windows ships no
  flag glyphs, so a flag renders as two letters there anyway.
*/
export const LANG_LABEL: Record<Lang, string> = {
  zh: "中",
  en: "EN",
  ja: "JA",
};

export type Dict = {
  searchTrait: string;
  clearSearch: string;
  noMatch: string;
  ok: string;
  enable: (name: string) => string;
  readFailed: string;
  writeFailed: string;
};

export const MESSAGES: Record<Lang, Dict> = {
  zh: {
    searchTrait: "搜索因子 | Hex",
    clearSearch: "清除",
    noMatch: "没有匹配的因子",
    ok: "确定",
    enable: (name) => `启用 ${name}`,
    readFailed: "读取失败",
    writeFailed: "写入失败",
  },
  en: {
    searchTrait: "Search sigil | Hex",
    clearSearch: "Clear",
    noMatch: "No matching sigil",
    ok: "OK",
    enable: (name) => `Enable ${name}`,
    readFailed: "Could not read",
    writeFailed: "Could not write",
  },
  ja: {
    searchTrait: "シジル | Hex で検索",
    clearSearch: "クリア",
    noMatch: "一致するシジルがありません",
    ok: "OK",
    enable: (name) => `${name} を有効にする`,
    readFailed: "読み込みに失敗しました",
    writeFailed: "書き込みに失敗しました",
  },
};

/*
  整个工具只有这一处语言设置（存在 loadout.json 的 lang 里，App 读写），所以这里是
  "系统要什么语言"的猜测，只在配置里还没写语言时用一次。

  以前这份文件自己往 localStorage 存语言（当时 SigilEdit 是独立工具）。合并进
  PreEquippedSigils 后那第二个开关和第二条存储路径都没有理由留下：同一个窗口里两套
  语言状态，用户在一页切的语言不会带到另一页。
*/
export function initialLang(): Lang {
  const preferred = navigator.language.toLowerCase();
  if (preferred.startsWith("ja")) return "ja";
  if (preferred.startsWith("zh")) return "zh";
  return "en";
}
