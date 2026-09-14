// 会话记忆沉淀（docs/02 §6 双层记忆 + pinned）：
// 会话结束（轮数上限/主动结束/下次建会话前惰性补）触发一次 LLM JSON 调用，
// 产出 1-2 句轻摘要 + pinned 候选，同请求内完成（MVP 不上队列）。
// 摘要只入 memories（可滚动），pinned 是结构化字段永不参与滚动合并。
import { llmCompleteJson } from '@/lib/llm';
import { appendMemories, addPinned, ensureProfile, type SessionMemory } from '@/lib/profile';
import { getSessionMessages, claimSession } from '@/lib/chat';
import { todayIn } from '@/lib/time';
import type { Locale } from '@/i18n/config';

export interface PinnedCandidate {
  kind: 'taboo' | 'promise' | 'open';
  text: string;
}

export interface SessionDigest {
  summary: string;
  pinned: PinnedCandidate[];
}

// 摘要不只是给下次对话读的：它原样出现在用户的成长历程（「那天聊到的」）里，
// 是念给本人听的，所以全程第二人称「你」——素材里的「用户：」就是「你」。
// 提示词正文也不许拿第三人称当行文样板，模型会照抄。
export const DIGEST_SYSTEM: Record<string, string> = {
  en: `You condense one companion conversation into a memory for the companion's NEXT session. This summary is also shown to the person themselves in their own growth timeline — write it in the second person, speaking directly to them as "you". In the transcript, lines marked 用户 are you, lines marked 陪伴者 are me. Output JSON only: {"summary": "1-2 sentences: what you said and felt — concrete, no advice, no evaluation", "pinned": [{"kind": "taboo|promise|open", "text": "<=80 chars, also second person"}]}. pinned rules — include ONLY explicit items: taboo = something you clearly asked not to discuss again; promise = a concrete commitment or plan you made; open = a topic clearly left unfinished. Maximum 3; empty array if none. Never invent. Red line: summary and pinned must never contain "he/she/they/the user" — this is written to the person, not a report about them; the third person used in these instructions is internal only.`,
  'zh-CN': `你把一段陪伴对话浓缩成给「下次对话」的记忆。这段摘要也会原样出现在用户自己的成长历程里，是念给本人听的——全程用第二人称「你」直接对他说。素材里「用户：」说的话就是「你」，「陪伴者：」是我。只输出 JSON：{"summary": "1-2 句：你说了什么、感受到什么——具体、不给建议、不评价", "pinned": [{"kind": "taboo|promise|open", "text": "≤80 字，同样第二人称"}]}。pinned 规则——只收明确的：taboo=你明确表示别再提的事；promise=你做出的具体承诺或打算；open=明显没聊完的话题。最多 3 条，没有就空数组。禁止编造。红线：summary 与 pinned 一处都不许出现「他/她/这位用户」这类第三人称指代——这是写给他本人的，不是向第三方汇报他；本提示词里用「他」指代他只是内部视角，不得带进输出。`,
  'zh-TW': `你把一段陪伴對話濃縮成給「下次對話」的記憶。這段摘要也會原樣出現在用戶自己的成長歷程裡，是念給本人聽的——全程用第二人稱「你」直接對他說。素材裡「用户：」說的話就是「你」，「陪伴者：」是我。只輸出 JSON：{"summary": "1-2 句：你說了什麼、感受到什麼——具體、不給建議、不評價", "pinned": [{"kind": "taboo|promise|open", "text": "≤80 字，同樣第二人稱"}]}。pinned 規則——只收明確的：taboo=你明確表示別再提的事；promise=你做出的具體承諾或打算；open=明顯沒聊完的話題。最多 3 條，沒有就空陣列。禁止編造。紅線：summary 與 pinned 一處都不許出現「他/她/這位用戶」這類第三人稱指代——這是寫給他本人的，不是向第三方匯報他；本提示詞裡用「他」指代他只是內部視角，不得帶進輸出。`,
  ja: `あなたは同伴対話を「次のセッションのための記憶」に凝縮します。この要約は本人の成長の記録にもそのまま表示されます——本人に向けて、二人称「あなた」で書いてください。素材の「用户：」はあなた、「陪伴者：」はわたしです。JSON のみ出力：{"summary": "1-2 文：あなたが何を言い、何を感じたか——具体的に、助言や評価なし", "pinned": [{"kind": "taboo|promise|open", "text": "≤80字、同じく二人称"}]}。pinned のルール——明示的なものだけ：taboo=あなたが明確に触れないでと言ったこと、promise=あなたがした具体的な約束や予定、open=明らかに未完了の話題。最大 3 件、なければ空配列。創作禁止。レッドライン：summary と pinned に「彼／彼女／このユーザー」などの三人称を一切使わないこと——これは本人へ宛てた文であり、第三者への報告ではありません。この指示文中の三人称は内部視点にすぎず、出力に持ち込まないこと。`,
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
export async function settleSession(userKey: string, locale: Locale, sessionId: string, tz: string): Promise<void> {
  if (!(await claimSession(sessionId))) return;
  const turns = await getSessionMessages(sessionId);
  const digest = await buildSessionDigest(locale, turns);
  if (!digest) return;
  await ensureProfile(userKey, locale);
  // sessionId 让时间线的对话摘要能跳回原文回看页（存量条目无此字段，渲染为不可点）
  // 日期按用户时区：他在自己的深夜聊的天，应该记在他的那一天，不是 UTC 的次日/前日
  const entry: SessionMemory = { date: todayIn(tz), text: digest.summary, sessionId };
  await appendMemories(userKey, [entry]);
  if (digest.pinned.length > 0) await addPinned(userKey, digest.pinned);
}
