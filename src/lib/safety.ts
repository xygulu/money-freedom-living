// 安全层（P0，docs/03 §6）：危机信号识别的两段式实现。
//  ① 关键词粗筛：content/safety/keywords/{locale}.json（git 管理，召回优先的宽网）
//  ② LLM 语义确认：低温度、只做分类（crisis/domestic_violence/none），不产面向用户文本
// 纪律：LLM 确认失败时按"命中"处理（fail-safe，召回优先、误报可接受）；
//      safety_events 只落引用与类别，绝不落原文（P§9 日志纪律）。
import { getSafetyKeywords, getSafetyResources } from '@/lib/content';
import { llmCompleteJson } from '@/lib/llm';
import { execWithFailover } from '@/lib/db';
import type { Locale } from '@/i18n/config';

export type SafetyCategory = 'crisis' | 'domestic_violence';

export interface SafetyVerdict {
  hit: boolean;
  category: SafetyCategory | null;
  /** true = 关键词命中且 LLM 确认；false = LLM 失败时的 fail-safe 命中 */
  confirmed: boolean;
}

/** 关键词粗筛（纯函数，CI 用 fixtures 抽检）。英文小写归一，中文原样匹配。 */
export function screenKeywords(
  keywords: { crisis: string[]; domesticViolence: string[] },
  text: string
): SafetyCategory | null {
  const lowered = text.toLowerCase();
  if (keywords.crisis.some((k) => lowered.includes(k.toLowerCase()))) return 'crisis';
  if (keywords.domesticViolence.some((k) => lowered.includes(k.toLowerCase()))) return 'domestic_violence';
  return null;
}

const CLASSIFY_SYSTEM: Record<string, string> = {
  en: `You are a safety classifier for a money-mindfulness companion app. Classify the user's message into exactly one of: "crisis" (self-harm or suicide risk about the user themself, now or recent), "domestic_violence" (user is being abused/threatened at home), "none" (anything else, including metaphors, quotes, third-person stories, past events with no current risk, and ordinary money worries). Respond with JSON only: {"category": "crisis"|"domestic_violence"|"none"}.`,
  'zh-CN': `你是金钱陪伴应用的安全分类器。把用户的消息分为且仅分为："crisis"（用户本人当下或近期的自伤/自杀风险）、"domestic_violence"（用户正在遭受家中虐待/暴力/威胁）、"none"（其他一切：比喻、引述、转述他人、无当前风险的往事、普通的金钱困扰）。只输出 JSON：{"category": "crisis"|"domestic_violence"|"none"}。`,
  'zh-TW': `你是金錢陪伴應用的安全分類器。把用戶的訊息分為且僅分為："crisis"（用戶本人當下或近期的自傷/自殺風險）、"domestic_violence"（用戶正在遭受家中虐待/暴力/威脅）、"none"（其他一切：比喻、引述、轉述他人、無當前風險的往事、普通的金錢困擾）。只輸出 JSON：{"category": "crisis"|"domestic_violence"|"none"}。`,
  ja: `あなたはマネー伴走アプリの安全分類器です。ユーザーのメッセージを次のいずれか一つに分類してください："crisis"（本人の現在または直近の自傷・自殺リスク）、"domestic_violence"（家庭内の虐待・暴力・脅迫を受けている）、"none"（その他すべて：比喩、引用、第三者の話、現在のリスクのない過去の出来事、普通なお金の悩み）。JSON のみを出力：{"category": "crisis"|"domestic_violence"|"none"}。`,
};

/** ② LLM 语义确认：只分类，不产面向用户文本。失败返回 null（调用方 fail-safe）。 */
async function classify(locale: Locale, text: string): Promise<SafetyCategory | null> {
  const system = CLASSIFY_SYSTEM[locale] ?? CLASSIFY_SYSTEM.en;
  const result = await llmCompleteJson<{ category?: string }>({
    system,
    messages: [{ role: 'user', content: text.slice(0, 1000) }],
    maxTokens: 64,
    temperature: 0,
  });
  if (result?.category === 'crisis') return 'crisis';
  if (result?.category === 'domestic_violence') return 'domestic_violence';
  if (result?.category === 'none') return null;
  return null;
}

/**
 * 两段式识别入口：关键词未命中直接放行（宽网保证召回）；命中后 LLM 确认，
 * 确认失败仍按命中处理（fail-safe）。
 */
export async function checkSafety(locale: Locale, text: string): Promise<SafetyVerdict> {
  const keywords = getSafetyKeywords(locale);
  const screened = screenKeywords(keywords, text);
  if (!screened) return { hit: false, category: null, confirmed: false };
  try {
    const category = await classify(locale, text);
    if (category) return { hit: true, category, confirmed: true };
    return { hit: false, category: null, confirmed: false }; // LLM 明确说 none → 放行
  } catch {
    return { hit: true, category: screened, confirmed: false }; // LLM 挂了 → 宁可误报
  }
}

/** 安全事件落库：只存 user_key/source/category，不存原文（P§9）。失败不阻塞主流程。 */
export async function recordSafetyEvent(userKey: string, source: string, category: SafetyCategory): Promise<void> {
  try {
    await execWithFailover((sql) =>
      sql`INSERT INTO safety_events (user_key, source, category, handled) VALUES (${userKey}, ${source}, ${category}, true)`
    );
  } catch (error) {
    console.error('[safety] event insert failed:', error);
  }
}

// ---- 转介消息（命中危机时作为该轮 AI 回复插入对话流，docs/02 §8.1）----
// 文案在服务端定死（资源表驱动），不走 LLM——这一句永远不能出错。

const CARE_OPENING: Record<Locale, string> = {
  en: 'I need to pause here, because what you just said matters more than any conversation about money.',
  'zh-CN': '我想先停下来，因为刚才那句话，比任何关于钱的话题都重要。',
  'zh-TW': '我想先停下來，因為剛才那句話，比任何關於錢的話題都重要。',
  ja: 'ここで一度立ち止まらせてください。今あなたが言ってくれたことは、お金の話よりもずっと大切だから。',
};

const CARE_BODY: Record<Locale, string> = {
  en: 'You are not alone, and you should not carry this by yourself. Please consider reaching out to someone trained to stand beside you right now:',
  'zh-CN': '你不是一个人，也不该独自扛着这些。此刻，让受过专业训练的人陪在你身边：',
  'zh-TW': '你不是一個人，也不該獨自扛著這些。此刻，讓受過專業訓練的人陪在你身邊：',
  ja: 'あなたはひとりではありません。ひとりで抱え込まないでください。今、専門の訓練を受けた人のそばに：',
};

const CARE_CLOSING: Record<Locale, string> = {
  en: 'If you are in immediate danger, please contact emergency services first. I am still here whenever you want to talk — no tasks, no pressure.',
  'zh-CN': '如果你此刻处在紧急危险中，请先拨打急救电话。我一直在，你想说什么时候都可以——没有任务，没有压力。',
  'zh-TW': '如果你此刻處在緊急危險中，請先撥打急救電話。我一直在，你想說什麼時候都可以——沒有任務，沒有壓力。',
  ja: '今すぐ危険がある場合は、まず緊急通報に連絡してください。私はいつでもここにいます——課題もプレッシャーもありません。',
};

/** 命中后的转介回复：关心 + 该类目资源 + 不冷落的收尾（资源表逐条核实后才上线，docs/02 §8） */
export function referralMessage(locale: Locale, category: SafetyCategory): string {
  const resources = getSafetyResources(locale);
  const list = category === 'crisis' ? resources.crisis : resources.domesticViolence;
  const lines = [
    CARE_OPENING[locale],
    '',
    CARE_BODY[locale],
    ...list.map((r) => `- ${r.name}：${r.contact}${r.note ? `（${r.note}）` : ''}`),
    '',
    CARE_CLOSING[locale],
  ];
  return lines.join('\n');
}
