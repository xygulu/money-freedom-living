import { defaultLocale, type Locale, isLocale } from './config';
import en from './messages/en.json';
import zhCN from './messages/zh-CN.json';
import zhTW from './messages/zh-TW.json';
import ja from './messages/ja.json';

const dicts: Record<Locale, typeof en> = {
  en,
  'zh-CN': zhCN,
  'zh-TW': zhTW,
  ja,
};

export type Dict = typeof en;

/** 取某语言的文案字典；请求期内保持引用稳定（静态 import，构建期内联） */
export function getDict(locale: string): Dict {
  return isLocale(locale) ? dicts[locale] : dicts[defaultLocale];
}
