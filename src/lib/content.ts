// content/ 装载层：只读构建期产物 src/generated/content.json（pnpm build-content 生成）
// 源文件在 content/（git 管理），改内容后重跑脚本，代码永远不直接读运行时文件系统
import generated from '@/generated/content.json';
import { isEnabled, type Locale } from '@/i18n/config';

/** 六命题（docs/02 §10 命题索引）：跨书索引，M10 仅用于内容归属与评估 prompt 参考 */
export const TOPICS = [
  'self-worth',
  'parents',
  'inner-turmoil',
  'boundaries',
  'money-safety',
  'allowing',
] as const;
export type TopicId = (typeof TOPICS)[number];

/** 命题的中文标签（prompt 内部备注用，不直接展示给用户） */
export const TOPICS_ZH: Record<TopicId, string> = {
  'self-worth': '我不配',
  parents: '和父母的关系',
  'inner-turmoil': '情绪与内耗',
  boundaries: '关系与边界',
  'money-safety': '金钱与安全感',
  allowing: '允许自己',
};

export interface JourneyStage {
  id: number;
  title: string;
  goal: string;
  weeks: number;
  exercises: string[];
  ai_stance: { do: string[]; dont: string[] };
  advance_when: string[];
  ritual: string;
  body: string;
  /** M10 可选 frontmatter 直通（gray-matter 原样保留 snake_case 键，故字段名不转驼峰） */
  free_alt?: string;
  skippable?: boolean;
  topics?: TopicId[];
}

export type DailyType = 'observation' | 'practice' | 'way';

export interface DailyCard {
  text: string;
  type: DailyType;
  stages: number[];
  reflection: string;
}

export interface PracticeNote {
  file: string;
  /** M11-B：笔记归属的书（content/practices 的 frontmatter 缺省时归 DEFAULT_BOOK_ID） */
  bookId: string;
  date: string;
  type: 'fact' | 'opinion';
  stage: number;
  tags: string[];
  body: string;
}

export interface SafetyKeywords {
  crisis: string[];
  domesticViolence: string[];
}

export interface SafetyResource {
  name: string;
  contact: string;
  note?: string;
}

export interface SafetyResources {
  verifyNote: string;
  crisis: SafetyResource[];
  domesticViolence: SafetyResource[];
}

/** 一本书的元信息（content/books/<id>/meta.md）——书是内容层，成长归用户，见 docs/05 §2 */
export interface BookMeta {
  id: string;
  /** 书名四语（zh-TW/ja 未转正也先备着，转正时无需改内容） */
  title: Record<string, string>;
  author: string;
  source: string;
  topics: TopicId[];
  status: 'active' | 'draft';
  note: string;
}

interface ContentBundle {
  books: BookMeta[];
  /** journey[bookId][locale] */
  journey: Record<string, Record<string, JourneyStage[]>>;
  /** daily[bookId][locale] */
  daily: Record<string, Record<string, DailyCard[]>>;
  practices: PracticeNote[];
  safety: Record<string, { keywords: SafetyKeywords; resources: SafetyResources }>;
  builtAt: string;
}

const bundle = generated as ContentBundle;

/**
 * v1 的书。所有 bookId 参数缺省时落到它——存量用户档案里没有 books 字段时同样按它归位，
 * 保证「多书架构上线后存量用户零变化」（docs/05 §10 验收 B）。
 */
export const DEFAULT_BOOK_ID = 'money-freedom';

export function getBooks(): BookMeta[] {
  return bundle.books;
}

export function getBook(bookId: string): BookMeta | null {
  return bundle.books.find((b) => b.id === bookId) ?? null;
}

/** 书名：目标语言缺失时回落到 en，再回落到 bookId 本身（书名永远有东西可显示） */
export function bookTitle(bookId: string, locale: Locale): string {
  const book = getBook(bookId);
  if (!book) return bookId;
  return book.title[locale]?.trim() || book.title.en?.trim() || bookId;
}

export function getJourneyStages(locale: Locale, bookId: string = DEFAULT_BOOK_ID): JourneyStage[] {
  return (isEnabled(locale) ? bundle.journey[bookId]?.[locale] : null) ?? [];
}

export function getJourneyStage(locale: Locale, id: number, bookId: string = DEFAULT_BOOK_ID): JourneyStage | null {
  return getJourneyStages(locale, bookId).find((s) => s.id === id) ?? null;
}

export function getDailyPool(locale: Locale, bookId: string = DEFAULT_BOOK_ID): DailyCard[] {
  return (isEnabled(locale) ? bundle.daily[bookId]?.[locale] : null) ?? [];
}

export function getPractices(): PracticeNote[] {
  return bundle.practices;
}

/** 阶段相关的创造者笔记（按 stage 过滤，非全量注入——见 docs/02 §10；跨书时再按 bookId 收窄） */
export function getPracticesForStage(stage: number, bookId?: string): PracticeNote[] {
  return getPractices().filter((p) => p.stage === stage && (bookId === undefined || p.bookId === bookId));
}

/** 危机词表（git 管理的粗筛网，召回优先——safety.ts 消费） */
export function getSafetyKeywords(locale: Locale): SafetyKeywords {
  return (
    (isEnabled(locale) ? bundle.safety[locale]?.keywords : null) ?? { crisis: [], domesticViolence: [] }
  );
}

/** 转介资源表（上线前逐条核实，docs/02 §8） */
export function getSafetyResources(locale: Locale): SafetyResources {
  return (
    (isEnabled(locale) ? bundle.safety[locale]?.resources : null) ?? {
      verifyNote: '',
      crisis: [],
      domesticViolence: [],
    }
  );
}

/** djb2 + murmur3 finalizer——一签确定性抽取用；仅末位不同的输入（连续日期）也能均匀散开 */
function hash(str: string): number {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = (Math.imul(h, 33) + str.charCodeAt(i)) | 0;
  h ^= h >>> 16;
  h = Math.imul(h, 2246822507);
  h ^= h >>> 13;
  h = Math.imul(h, 3266489909);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * 今日一签：确定性抽取——同一天同一阶段看到同一条（共时感），同一用户 90 天不重复。
 * seenTexts 由调用方从用户档案传入；某阶段候选耗尽后自动回落全阶段池。
 */
export function pickDaily(
  locale: Locale,
  dateISO: string,
  stage: number,
  seenTexts: string[] = [],
  bookId: string = DEFAULT_BOOK_ID,
): DailyCard | null {
  const pool = getDailyPool(locale, bookId);
  if (pool.length === 0) return null;

  const seen = new Set(seenTexts);
  const candidates = pool.filter((c) => c.stages.includes(stage) && !seen.has(c.text));
  const fallback = pool.filter((c) => !seen.has(c.text));
  const finalPool = candidates.length > 0 ? candidates : fallback.length > 0 ? fallback : pool;

  return finalPool[hash(`${dateISO}#${stage}`) % finalPool.length];
}

/**
 * 今日微行动：按当前阶段练习确定性抽取（同一天同一用户同一条，docs/02 §5）。
 * 练习只提议不指派——卡上永远给"随便聊聊/只看看签"的替代出口，可跳过。
 */
export function pickExercise(locale: Locale, dateISO: string, stage: number, userKey: string, bookId: string = DEFAULT_BOOK_ID): string | null {
  const stageContent = getJourneyStage(locale, stage, bookId);
  const exercises = stageContent?.exercises ?? [];
  if (exercises.length === 0) return null;
  return exercises[hash(`${dateISO}#${userKey}`) % exercises.length];
}
