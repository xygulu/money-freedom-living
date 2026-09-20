/**
 * findUserRecentSessions 单测（2026-09-18 弹层「上次说到这儿」）。
 *
 * mock 整个 `@/lib/db`：fake sql 记下收到的 SQL 片段与参数，按调用次序
 * 回放预设行（第一次调用 = sessions 子查询，第二次 = messages 批量取）。
 * 验证：kind 过滤（onboarding_talk 排除）、open companion 收录、排序、
 * 消息按会话聚合、limit 透传。
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';

// fake sql：模板片段拼文本 + 参数透传；调用结果由测试用例通过队列注入
const resultQueue: Array<Array<Record<string, unknown>>> = [];
const sqlCalls: Array<{ sqlText: string; args: unknown[] }> = [];

vi.mock('@/lib/db', () => {
  const fakeSql = (strings: TemplateStringsArray, ...args: unknown[]) => {
    sqlCalls.push({ sqlText: strings.join('?'), args });
    const rows = resultQueue.shift() ?? [];
    return Promise.resolve(rows);
  };
  return {
    execWithFailover: vi.fn(async (run: (sql: unknown) => Promise<unknown>) => run(fakeSql)),
    getSql: vi.fn(() => fakeSql),
    ensureSchema: vi.fn(),
    iso: (v: unknown) => String(v),
  };
});

import { findUserRecentSessions } from '@/lib/chat';

beforeEach(() => {
  resultQueue.length = 0;
  sqlCalls.length = 0;
});

describe('findUserRecentSessions', () => {
  it('0 会话 → []（不发第二条 messages 查询）', async () => {
    resultQueue.push([]);
    const out = await findUserRecentSessions('u:1', 10);
    expect(out).toEqual([]);
    expect(sqlCalls.length).toBe(1);
  });

  it('单 closed chat 会话：返回完整消息，kind/status 透传', async () => {
    resultQueue.push([{ id: 's1', kind: 'chat', status: 'closed', closed_at: '2026-09-18T10:00:00Z', created_at: '2026-09-18T09:00:00Z' }]);
    resultQueue.push([
      { session_id: 's1', role: 'user', content: '你好' },
      { session_id: 's1', role: 'assistant', content: '我在。' },
    ]);
    const out = await findUserRecentSessions('u:1', 10);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 's1', kind: 'chat', status: 'closed' });
    expect(out[0].messages).toEqual([
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '我在。' },
    ]);
  });

  it('SQL 过滤口径：closed 全收 + open 只收 companion + onboarding_talk 不出现', async () => {
    resultQueue.push([]);
    await findUserRecentSessions('u:1', 10);
    const sqlText = sqlCalls[0].sqlText;
    expect(sqlText).toContain("kind IN ('chat', 'companion')");
    expect(sqlText).toContain("(status = 'closed' OR (kind = 'companion' AND status = 'open'))");
    // 排除体检初谈是 SQL 侧的（kind IN 列表里没有 'onboarding_talk'）
    expect(sqlText).not.toContain('onboarding_talk');
  });

  it('消息跨会话聚合：各自归位、不串会话', async () => {
    resultQueue.push([
      { id: 's2', kind: 'companion', status: 'open', closed_at: null, created_at: '2026-09-18T12:00:00Z' },
      { id: 's1', kind: 'chat', status: 'closed', closed_at: '2026-09-17T10:00:00Z', created_at: '2026-09-17T09:00:00Z' },
    ]);
    resultQueue.push([
      { session_id: 's2', role: 'user', content: '弹层里说的话' },
      { session_id: 's1', role: 'user', content: '正式对话里说的话' },
    ]);
    const out = await findUserRecentSessions('u:1', 10);
    expect(out[0].id).toBe('s2'); // COALESCE(closed_at, created_at) 倒序：open 的最新在前
    expect(out[0].messages).toEqual([{ role: 'user', content: '弹层里说的话' }]);
    expect(out[1].messages).toEqual([{ role: 'user', content: '正式对话里说的话' }]);
  });

  it('limit 透传给 SQL', async () => {
    resultQueue.push([]);
    await findUserRecentSessions('u:1', 3);
    expect(sqlCalls[0].args).toContain(3);
  });

  it('无消息的会话 → messages 为空数组（调用方过滤空包）', async () => {
    resultQueue.push([{ id: 's1', kind: 'chat', status: 'closed', closed_at: null, created_at: '2026-09-18T09:00:00Z' }]);
    resultQueue.push([]);
    const out = await findUserRecentSessions('u:1', 10);
    expect(out).toHaveLength(1);
    expect(out[0].messages).toEqual([]);
  });
});
