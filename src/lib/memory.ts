// 会话记忆沉淀（docs/02 §6 双层记忆 + pinned）：
// 会话结束（轮数上限/主动结束/下次建会话前惰性补）触发一次 LLM JSON 调用，
// 产出 1-2 句轻摘要 + pinned 候选，同请求内完成（MVP 不上队列）。
// 摘要只入 memories（可滚动），pinned 是结构化字段永不参与滚动合并。
import { llmCompleteJson } from '@/lib/llm';
import { appendMemories, addPinned, ensureProfile, type SessionMemory } from '@/lib/profile';
import { getSessionMessages, claimSession } from '@/lib/chat';
import type { Locale } from '@/i18n/config';

export interface PinnedCandidate {
  kind: 'taboo' | 'promise' | 'open';
  text: string;
}

export interface SessionDigest {
  summary: string;
  pinned: PinnedCandidate[];
}

const DIGEST_SYSTEM: Record<string, string> = {
  en: `You condense one companion conversation into a memory for the companion's NEXT session. Output JSON only: {"summary": "1-2 sentences: what the user said and felt — concrete, no advice, no evaluation", "pinned": [{"kind": "taboo|promise|open", "text": "<=80 chars"}]}. pinned rules — include ONLY explicit items: taboo = user clearly asked not to discuss something; promise = a concrete commitment or plan the user made; open = a topic clearly left unfinished. Maximum 3; empty array if none. Never invent.`,
  'zh-CN': `你把一段陪伴对话浓缩成给"下次对话"的记忆。只输出 JSON：{"summary": "1-2 句：用户说了什么、感受到什么——具体、不给建议、不评价", "pinned": [{"kind": "taboo|promise|open", "text": "≤80 字"}]}。pinned 规则——只收明确的：taboo=用户明确表示别再提的事；promise=用户做出的具体承诺或打算；open=明显没聊完的话题。最多 3 条，没有就空数组。禁止编造。`,
  'zh-TW': `你把一段陪伴對話濃縮成給「下次對話」的記憶。只輸出 JSON：{"summary": "1-2 句：用戶說了什麼、感受到什麼——具體、不給建議、不評價", "pinned": [{"kind": "taboo|promise|open", "text": "≤80 字"}]}。pinned 規則——只收明確的：taboo=用戶明確表示別再提的事；promise=用戶做出的具體承諾或打算；open=明顯沒聊完的話題。最多 3 條，沒有就空陣列。禁止編造。`,
  ja: `あなたは同伴対話を「次のセッションのための記憶」に凝縮します。JSON のみ出力：{"summary": "1-2 文：ユーザーが何を言い、何を感じたか——具体的に、助言や評価なし", "pinned": [{"kind": "taboo|promise|open", "text": "≤80字"}]}。pinned のルール——明示的なものだけ：taboo=ユーザーが明確に触れないでと言ったこと、promise=ユーザーがした具体的な約束や予定、open=明らかに未完了の話題。最大 3 件、なければ空配列。創作禁止。`,
};

/** 摘要结构校验（纯函数）：半成品直接判失败——宁缺勿错，错记忆比没记忆更伤"它记得我" */
export function validateDigest(raw: unknown): SessionDigest | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const d = raw as Record<string, unknown>;
  if (typeof d.summary !== 'string') return null;
  const summary = d.summary.trim();
  if (summary.length < 8 || summary.length > 400) return null;
  const pinned: PinnedCandidate[] = Array.isArray(d.pinned)
    ? d.pinned
        .filter(
          (p): p is { kind: string; text: string } =>
            typeof p === 'object' && p !== null && typeof (p as { text?: unknown }).text === 'string'
        )
        .map((p) => ({ kind: p.kind, text: p.text.trim().slice(0, 80) }))
        .filter((p): p is PinnedCandidate => ['taboo', 'promise', 'open'].includes(p.kind) && p.text.length > 0)
        .slice(0, 3)
    : [];
  return { summary, pinned };
}

/** 一次 LLM 调用产出摘要 + pinned；失败返回 null（记忆是增强项，绝不阻塞对话） */
export async function buildSessionDigest(locale: Locale, turns: { role: string; content: string }[]): Promise<SessionDigest | null> {
  if (turns.length === 0) return null;
  const transcript = turns
    .map((t) => `${t.role === 'user' ? '用户' : '陪伴者'}：${t.content}`)
    .join('\n')
    .slice(0, 6000);
  try {
    const raw = await llmCompleteJson<unknown>({
      system: DIGEST_SYSTEM[locale] ?? DIGEST_SYSTEM.en,
      messages: [{ role: 'user', content: transcript }],
      maxTokens: 400,
      temperature: 0.3,
    });
    return raw ? validateDigest(raw) : null;
  } catch (error) {
    console.error('[memory] digest failed:', error);
    return null;
  }
}

/**
 * 会话结算：摘要 + pinned 落档、关闭会话。exactly-once：先用原子抢占关会话，
 * 抢不到说明另一处（主动结束 / 20 轮收尾 / 下次建会话惰性补）已在结算——直接返回，
 * 避免两次 LLM 摘要文本各异导致 memories/pinned 重复入档。
 * 全程 best-effort：LLM 失败也要关会话（已在抢占时关掉）。
 * 对话本身就是建档动作：没有档案行先建（appendMemories 才有落点）。
 */
export async function settleSession(userKey: string, locale: Locale, sessionId: string): Promise<void> {
  if (!(await claimSession(sessionId))) return;
  const turns = await getSessionMessages(sessionId);
  const digest = await buildSessionDigest(locale, turns);
  if (!digest) return;
  await ensureProfile(userKey, locale);
  const entry: SessionMemory = { date: new Date().toISOString().slice(0, 10), text: digest.summary };
  await appendMemories(userKey, [entry]);
  if (digest.pinned.length > 0) await addPinned(userKey, digest.pinned);
}
