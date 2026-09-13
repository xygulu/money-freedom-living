// 日记（金钱心事）共享逻辑：VIP AI 回应的提示词与结构（docs/02 §5 /journal）。
// 回应原则与对话一致——接住情绪、回应具体细节，不给理财建议、不诊断、不评判。
// 安全性：crisis 命中的日记不走 LLM 回应（写库时已标记 safety_hit，回应时直接转介）。
import { execWithFailover, ensureSchema, iso } from '@/lib/db';
import { LOCALE_NAME } from '@/lib/onboarding';
import type { Locale } from '@/i18n/config';

export interface JournalEntry {
  id: number;
  locale: string;
  content: string;
  safetyHit: boolean;
  aiReply: string | null;
  repliedAt: string | null;
  createdAt: string;
}

function rowToEntry(row: Record<string, unknown>): JournalEntry {
  return {
    id: row.id as number,
    locale: row.locale as string,
    content: row.content as string,
    safetyHit: row.safety_hit as boolean,
    aiReply: (row.ai_reply as string | null) ?? null,
    repliedAt: row.replied_at ? iso(row.replied_at) : null,
    createdAt: iso(row.created_at),
  };
}

export async function getJournalEntries(userKey: string, limit = 50): Promise<JournalEntry[]> {
  await ensureSchema();
  const rows = await execWithFailover((sql) =>
    sql`SELECT id, locale, content, safety_hit, ai_reply, replied_at, created_at
        FROM journal_entries WHERE user_key = ${userKey}
        ORDER BY created_at DESC LIMIT ${limit}`
  );
  return rows.map(rowToEntry);
}

/** 单条（VIP 回应路由用；归属校验靠 user_key 相等） */
export async function getJournalEntry(userKey: string, id: number): Promise<JournalEntry | null> {
  await ensureSchema();
  const rows = await execWithFailover((sql) =>
    sql`SELECT id, locale, content, safety_hit, ai_reply, replied_at, created_at
        FROM journal_entries WHERE id = ${id} AND user_key = ${userKey}`
  );
  return rows[0] ? rowToEntry(rows[0]) : null;
}

export async function saveJournalReply(userKey: string, id: number, reply: string): Promise<void> {
  await execWithFailover((sql) =>
    sql`UPDATE journal_entries SET ai_reply = ${reply}, replied_at = now() WHERE id = ${id} AND user_key = ${userKey}`
  );
}

/** 基线之后的日记条数（演进提议判定计数用，不拉全行） */
export async function countJournalEntriesSince(userKey: string, sinceISO: string): Promise<number> {
  const rows = await execWithFailover((sql) =>
    sql`SELECT count(*)::int AS n FROM journal_entries WHERE user_key = ${userKey} AND created_at > ${sinceISO}`
  );
  return (rows[0]?.n as number) ?? 0;
}

/**
 * VIP 日记回应提示词：接住、回应具体的那个细节，简短。
 * 不给理财建议、不诊断、不要求"更积极"；结尾最多一个开放的轻问题，也可以没有。
 */
export function buildJournalReplySystem(locale: Locale): string {
  return [
    `你是一位温和的陪伴者。用户刚写完一段金钱心事（日记），你是唯一读到它的人。请始终用${LOCALE_NAME[locale] ?? 'English'}回复。`,
    '## 回应规则',
    '- 100-200 字；接住情绪，回应日记里至少一个具体细节（引用其中的原词）。',
    '- 不评价写得好不好，不总结，不升华。没问怎么办，就不要给怎么办。',
    '- 禁止：理财建议、省钱/赚钱方法、诊断或贴标签（抑郁/焦虑等）、"你要更积极"式劝导、排比说教。',
    '- 结尾最多一个开放的轻问题，也可以只是接住没有问题。',
    '- 危机语境已被系统处理，你只负责温和陪伴当下这段文字。',
  ].join('\n');
}
