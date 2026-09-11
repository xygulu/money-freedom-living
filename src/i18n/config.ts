// i18n 配置：四语（en / zh-CN / zh-TW / ja），产品方案 §1 语言开放策略。
//
// - enabledLocales：实际开放的语言（middleware 只会路由到这些；转正即加入）
// - visibleLocales：语言选择器展示的语言（含 Coming soon 锁定项）
// 转正条件（LLM 盲测 + 危机识别抽检 + 母语校对）通过后，把该语言加进 enabledLocales 即可。
export const locales = ['en', 'zh-CN', 'zh-TW', 'ja'] as const;
export type Locale = (typeof locales)[number];

export const defaultLocale: Locale = 'en';

export const enabledLocales: Locale[] = ['en', 'zh-CN'];

export const visibleLocales: { code: Locale; label: string; enabled: boolean }[] = [
  { code: 'en', label: 'English', enabled: true },
  { code: 'zh-CN', label: '简体中文', enabled: true },
  { code: 'zh-TW', label: '繁體中文', enabled: false },
  { code: 'ja', label: '日本語', enabled: false },
];

export function isLocale(value: string | undefined | null): value is Locale {
  return !!value && (locales as readonly string[]).includes(value);
}

export function isEnabled(locale: Locale): boolean {
  return enabledLocales.includes(locale);
}

/** 把 locale 解析为 html lang 属性值 */
export function htmlLang(locale: Locale): string {
  switch (locale) {
    case 'zh-CN':
      return 'zh-Hans';
    case 'zh-TW':
      return 'zh-Hant';
    default:
      return locale;
  }
}
