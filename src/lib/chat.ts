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
  status: string;
}

/** 初谈轮数硬上限（AI 追问 3-5 轮 + buffer；超限引导生成画像） */
export const TALK_MAX_USER_MESSAGES = 6;

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
  return { id, userKey: input.userKey, locale: input.locale, kind: input.kind, messageCount: 0, quotaConsumed: false, status: 'open' };
}

export async function getSession(sessionId: string): Promise<ChatSession | null> {
  await ensureSchema();
  const rows = await execWithFailover((sql) =>
    sql`SELECT id, user_key, locale, kind, message_count, quota_consumed, status
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
