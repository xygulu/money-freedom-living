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

interface ContentBundle {
  journey: Record<string, JourneyStage[]>;
  daily: Record<string, DailyCard[]>;
  practices: PracticeNote[];
  safety: Record<string, { keywords: SafetyKeywords; resources: SafetyResources }>;
  builtAt: string;
}

const bundle = generated as ContentBundle;

export function getJourneyStages(locale: Locale): JourneyStage[] {
  return (isEnabled(locale) ? bundle.journey[locale] : null) ?? [];
}

export function getJourneyStage(locale: Locale, id: number): JourneyStage | null {
  return getJourneyStages(locale).find((s) => s.id === id) ?? null;
}

export function getDailyPool(locale: Locale): DailyCard[] {
  return (isEnabled(locale) ? bundle.daily[locale] : null) ?? [];
}

export function getPractices(): PracticeNote[] {
  return bundle.practices;
}

/** 阶段相关的创造者笔记（按 stage 过滤，非全量注入——见 docs/02 §10） */
export function getPracticesForStage(stage: number): PracticeNote[] {
  return getPractices().filter((p) => p.stage === stage);
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
): DailyCard | null {
  const pool = getDailyPool(locale);
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
export function pickExercise(locale: Locale, dateISO: string, stage: number, userKey: string): string | null {
  const stageContent = getJourneyStage(locale, stage);
  const exercises = stageContent?.exercises ?? [];
  if (exercises.length === 0) return null;
  return exercises[hash(`${dateISO}#${userKey}`) % exercises.length];
}
