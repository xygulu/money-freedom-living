// 对话会话存取（chat_sessions / chat_messages）。
// kind: 'onboarding_talk'（体检初谈）| 'chat'（正式对话，M4 接配额落账）
//       | 'companion'（陪伴者弹层轻对话，2026-09-18；与 chat 共享配额桶，不写 memory）
import { randomUUID } from 'crypto';
import { ensureSchema, execWithFailover, iso } from '@/lib/db';

export type SessionKind = 'onboarding_talk' | 'chat' | 'companion';

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

/** 陪伴者弹层轻对话上限：10 轮 = 20 条消息——弹层是"顺便说一句"的轻场景，比 /chat 短 */
export const COMPANION_MAX_MESSAGES = 20;

/**
 * A4（?quote 落对话历史，2026-11-13）：清洗 URL 里带来的球气泡原文。
 * nudge 文案本身 ≤80 字（companion-nudge TEMPLATES），300 是防御上限；
 * 折叠空白、去首尾——存进 chat_messages 的就是展示给用户的那一句。
 */
export function normalizeSeedQuote(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.trim().replace(/\s+/g, ' ').slice(0, 300);
}

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

/** 用户当前打开的陪伴者弹层会话（与 open chat 互不影响——两类各持一个同时 open） */
export async function findOpenCompanionSession(userKey: string): Promise<ChatSession | null> {
  await ensureSchema();
  const rows = await execWithFailover((sql) =>
    sql`SELECT id, user_key, locale, kind, message_count, quota_consumed, safety_flagged, status, closed_at, created_at
        FROM chat_sessions
        WHERE user_key = ${userKey} AND kind = 'companion' AND status = 'open'
        ORDER BY created_at DESC LIMIT 1`
  );
  return rows[0] ? rowToSession(rows[0]) : null;
}

/**
 * 弹层「上次说到这儿」：最近 N 个会话（kind ∈ chat/companion，排除体检初谈）
 * 的完整消息，按 COALESCE(closed_at, created_at) 倒序。closed 全收；
 * **open 的 companion 会话也收**——弹层复用 open 会话续聊时需要它的消息
 * （open 的 chat 会话不收，那是 /chat 页的活会话，弹层不掺和）。
 * N 由调用方 clamp（[1,20]）。
 */
export interface RecentSessionBundle {
  id: string;
  kind: SessionKind;
  status: string;
  closedAt: string | null;
  createdAt: string;
  messages: ChatTurn[];
}

export async function findUserRecentSessions(userKey: string, limit: number): Promise<RecentSessionBundle[]> {
  await ensureSchema();
  const sessionRows = await execWithFailover((sql) =>
    sql`SELECT id, kind, status, closed_at, created_at
        FROM chat_sessions
        WHERE user_key = ${userKey}
          AND kind IN ('chat', 'companion')
          AND (status = 'closed' OR (kind = 'companion' AND status = 'open'))
        ORDER BY COALESCE(closed_at, created_at) DESC
        LIMIT ${limit}`
  );
  if (sessionRows.length === 0) return [];
  const ids = sessionRows.map((r) => r.id as string);
  // Postgres 数组字面量 + 显式 cast（与 profile.ts 的 ${JSON.stringify(...)}::jsonb 同一惯用法；
  // id 来自本表 UUID 行，仍防御性剥掉引号/反斜杠）
  const idArrayLiteral = `{${ids.map((id) => `"${id.replace(/["\\]/g, '')}"`).join(',')}}`;
  const messageRows = await execWithFailover((sql) =>
    sql`SELECT session_id, role, content FROM chat_messages
        WHERE session_id = ANY(${idArrayLiteral}::uuid[])
        ORDER BY session_id, id`
  );
  return sessionRows.map((s) => ({
    id: s.id as string,
    kind: s.kind as SessionKind,
    status: s.status as string,
    closedAt: s.closed_at ? iso(s.closed_at) : null,
    createdAt: iso(s.created_at),
    messages: messageRows
      .filter((m) => m.session_id === s.id)
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content as string })),
  }));
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
