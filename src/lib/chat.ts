// 对话会话存取（chat_sessions / chat_messages）。
// kind: 'onboarding_talk'（体检初谈）| 'chat'（正式对话，M4 接配额落账）
import { randomUUID } from 'crypto';
import { ensureSchema, execWithFailover, iso } from '@/lib/db';

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
  closedAt: string | null; // ISO；存量 closed 行为 NULL
  createdAt: string; // ISO；历史列表的显示日期兜底（closed_at 为 NULL 的存量行）
}

/** 初谈轮数硬上限（AI 追问 3-5 轮 + buffer；超限引导生成画像） */
export const TALK_MAX_USER_MESSAGES = 6;

/** 正式对话轮数上限：20 轮 = 40 条消息（用户+AI），到限温和收尾（P§7"1 次 = 一次对话会话"） */
export const CHAT_MAX_MESSAGES = 40;

function rowToSession(row: Record<string, unknown>): ChatSession {
  return {
    id: row.id as string,
    userKey: row.user_key as string,
    locale: row.locale as string,
    kind: row.kind as SessionKind,
    messageCount: row.message_count as number,
    quotaConsumed: row.quota_consumed as boolean,
    safetyFlagged: row.safety_flagged as boolean,
    status: row.status as string,
    closedAt: row.closed_at ? iso(row.closed_at) : null,
    createdAt: iso(row.created_at),
  };
}

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
  return { id, userKey: input.userKey, locale: input.locale, kind: input.kind, messageCount: 0, quotaConsumed: false, safetyFlagged: false, status: 'open', closedAt: null, createdAt: new Date().toISOString() };
}

export async function getSession(sessionId: string): Promise<ChatSession | null> {
  await ensureSchema();
  // 列名清单必须写死字面量：neon sql tag 会把 ${字符串} 参数化成 $1（SELECT $1 返回的是垃圾行）
  const rows = await execWithFailover((sql) =>
    sql`SELECT id, user_key, locale, kind, message_count, quota_consumed, safety_flagged, status, closed_at, created_at
        FROM chat_sessions WHERE id = ${sessionId}`
  );
  return rows[0] ? rowToSession(rows[0]) : null;
}

/** 用户当前打开的正式对话会话（同一时刻最多一个；健壮性起见取最新一条） */
export async function findOpenChatSession(userKey: string): Promise<ChatSession | null> {
  await ensureSchema();
  const rows = await execWithFailover((sql) =>
    sql`SELECT id, user_key, locale, kind, message_count, quota_consumed, safety_flagged, status, closed_at, created_at
        FROM chat_sessions
        WHERE user_key = ${userKey} AND kind = 'chat' AND status = 'open'
        ORDER BY created_at DESC LIMIT 1`
  );
  return rows[0] ? rowToSession(rows[0]) : null;
}

/**
 * 历史会话列表（M9 聊天回看）：closed 会话按"那天的那次对话"倒序。
 * 存量行 closed_at 为 NULL，用 created_at 兜底；含初谈（前端打「体检初谈」标签）。
 */
export async function listClosedChatSessions(userKey: string, limit = 50): Promise<ChatSession[]> {
  await ensureSchema();
  const rows = await execWithFailover((sql) =>
    sql`SELECT id, user_key, locale, kind, message_count, quota_consumed, safety_flagged, status, closed_at, created_at
        FROM chat_sessions
        WHERE user_key = ${userKey} AND status = 'closed'
        ORDER BY COALESCE(closed_at, created_at) DESC
        LIMIT ${limit}`
  );
  return rows.map(rowToSession);
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
  await execWithFailover((sql) =>
    sql`UPDATE chat_sessions SET status = 'closed', closed_at = now() WHERE id = ${sessionId}`
  );
}

/**
 * 原子抢占关闭：status 仍为 open 才关并返回 true。
 * 结算（摘要生成）用它在并发触发（主动结束 + 下次建会话的惰性补）之间
 * 保证 exactly-once——两次摘要文本必有差异，重复入档会污染 memories/pinned。
 */
export async function claimSession(sessionId: string): Promise<boolean> {
  const rows = await execWithFailover((sql) =>
    sql`UPDATE chat_sessions SET status = 'closed', closed_at = now() WHERE id = ${sessionId} AND status = 'open' RETURNING id`
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
