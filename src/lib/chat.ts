// 对话会话存取（chat_sessions / chat_messages）。
// kind: 'onboarding_talk'（体检初谈）| 'chat'（正式对话，M4 接配额落账）
import { randomUUID } from 'crypto';
import { ensureSchema, execWithFailover } from '@/lib/db';

export type SessionKind = 'onboarding_talk' | 'chat';

export interface ChatSession {
  id: string;
  userKey: string;
  locale: string;
  kind: SessionKind;
  messageCount: number;
  quotaConsumed: boolean;
  safetyFlagged: boolean;
  status: string;
}

/** 初谈轮数硬上限（AI 追问 3-5 轮 + buffer；超限引导生成画像） */
export const TALK_MAX_USER_MESSAGES = 6;

/** 正式对话轮数上限：20 轮 = 40 条消息（用户+AI），到限温和收尾（P§7"1 次 = 一次对话会话"） */
export const CHAT_MAX_MESSAGES = 40;

export async function createSession(input: {
  userKey: string;
  locale: string;
  kind: SessionKind;
}): Promise<ChatSession> {
  await ensureSchema();
  const id = randomUUID();
  await execWithFailover((sql) =>
    sql`INSERT INTO chat_sessions (id, user_key, locale, kind) VALUES (${id}, ${input.userKey}, ${input.locale}, ${input.kind})`
  );
  return { id, userKey: input.userKey, locale: input.locale, kind: input.kind, messageCount: 0, quotaConsumed: false, safetyFlagged: false, status: 'open' };
}

export async function getSession(sessionId: string): Promise<ChatSession | null> {
  await ensureSchema();
  const rows = await execWithFailover((sql) =>
    sql`SELECT id, user_key, locale, kind, message_count, quota_consumed, safety_flagged, status
        FROM chat_sessions WHERE id = ${sessionId}`
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id as string,
    userKey: row.user_key as string,
    locale: row.locale as string,
    kind: row.kind as SessionKind,
    messageCount: row.message_count as number,
    quotaConsumed: row.quota_consumed as boolean,
    safetyFlagged: row.safety_flagged as boolean,
    status: row.status as string,
  };
}

/** 用户当前打开的正式对话会话（同一时刻最多一个；健壮性起见取最新一条） */
export async function findOpenChatSession(userKey: string): Promise<ChatSession | null> {
  await ensureSchema();
  const rows = await execWithFailover((sql) =>
    sql`SELECT id, user_key, locale, kind, message_count, quota_consumed, safety_flagged, status
        FROM chat_sessions
        WHERE user_key = ${userKey} AND kind = 'chat' AND status = 'open'
        ORDER BY created_at DESC LIMIT 1`
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id as string,
    userKey: row.user_key as string,
    locale: row.locale as string,
    kind: row.kind as SessionKind,
    messageCount: row.message_count as number,
    quotaConsumed: row.quota_consumed as boolean,
    safetyFlagged: row.safety_flagged as boolean,
    status: row.status as string,
  };
}

export async function appendMessage(sessionId: string, role: 'user' | 'assistant', content: string): Promise<void> {
  await execWithFailover((sql) =>
    sql`INSERT INTO chat_messages (session_id, role, content) VALUES (${sessionId}, ${role}, ${content})`
  );
  // 计数用子查询回填而非 +1：并发/重试下永远与真实行数一致
  await execWithFailover((sql) =>
    sql`UPDATE chat_sessions
        SET message_count = (SELECT count(*) FROM chat_messages WHERE session_id = ${sessionId})
        WHERE id = ${sessionId}`
  );
}

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export async function getSessionMessages(sessionId: string): Promise<ChatTurn[]> {
  const rows = await execWithFailover((sql) =>
    sql`SELECT role, content FROM chat_messages WHERE session_id = ${sessionId} ORDER BY id`
  );
  return rows.map((r) => ({ role: r.role as 'user' | 'assistant', content: r.content as string }));
}

/** 会话关闭（画像生成完成后初谈不再可写） */
export async function closeSession(sessionId: string): Promise<void> {
  await execWithFailover((sql) => sql`UPDATE chat_sessions SET status = 'closed' WHERE id = ${sessionId}`);
}

/**
 * 原子抢占关闭：status 仍为 open 才关并返回 true。
 * 结算（摘要生成）用它在并发触发（主动结束 + 下次建会话的惰性补）之间
 * 保证 exactly-once——两次摘要文本必有差异，重复入档会污染 memories/pinned。
 */
export async function claimSession(sessionId: string): Promise<boolean> {
  const rows = await execWithFailover((sql) =>
    sql`UPDATE chat_sessions SET status = 'closed' WHERE id = ${sessionId} AND status = 'open' RETURNING id`
  );
  return rows.length > 0;
}

/** 配额落账置位：POST /api/chat/[id] 的 AI 首条回复成功后调用（P§7"失败不扣"） */
export async function markQuotaConsumed(sessionId: string): Promise<void> {
  await execWithFailover((sql) => sql`UPDATE chat_sessions SET quota_consumed = true WHERE id = ${sessionId}`);
}

/** 危机命中置位：后续轮次注入稳定陪伴模式（docs/03 §6） */
export async function markSafetyFlagged(sessionId: string): Promise<void> {
  await execWithFailover((sql) => sql`UPDATE chat_sessions SET safety_flagged = true WHERE id = ${sessionId}`);
}
