/**
 * /api/chat/[sessionId] 闸门单测：gateSessionChat() 按 session.kind 分流。
 *
 * 用户 2026-09-15 bugfix：上一批把 /api/chat/* 整体加 401，误伤 onboarding_talk
 * （金钱关系测试的对话）。把判定抽成纯函数 gateSessionChat，2 × 2 = 4 用例
 * 覆盖"kind × 身份"全组合。route handler 不在本测覆盖——它要 NextRequest +
 * DB + LLM stub，不适合 vitest。
 */
import { describe, expect, it } from 'vitest';
import { gateSessionChat } from '@/lib/chat-auth';
import type { ChatSession } from '@/lib/chat';
import type { RequestIdentity } from '@/lib/identity';

function baseSession(over: Partial<ChatSession> = {}): ChatSession {
  return {
    id: 'test-session',
    userKey: 'g:cookie-id',
    locale: 'zh-CN',
    kind: 'onboarding_talk',
    messageCount: 0,
    quotaConsumed: false,
    safetyFlagged: false,
    status: 'open',
    closedAt: null,
    createdAt: '2026-09-15T00:00:00.000Z',
    ...over,
  };
}

function guest(): Pick<RequestIdentity, 'userId'> {
  return { userId: null };
}
function signedIn(): Pick<RequestIdentity, 'userId'> {
  return { userId: 'test-user' };
}

describe('gateSessionChat：M3 初谈对访客放行', () => {
  it('kind=onboarding_talk + 访客 → 放行（金钱关系测试可走完）', () => {
    const r = gateSessionChat({ session: baseSession({ kind: 'onboarding_talk' }), identity: guest() });
    expect(r.ok).toBe(true);
  });

  it('kind=onboarding_talk + 已登录 → 放行', () => {
    const r = gateSessionChat({ session: baseSession({ kind: 'onboarding_talk' }), identity: signedIn() });
    expect(r.ok).toBe(true);
  });
});

describe('gateSessionChat：M4 正式对话要登录', () => {
  it('kind=chat + 访客 → 401 + {error:"unauthorized", reason:"signed_in_required"}', async () => {
    const r = gateSessionChat({ session: baseSession({ kind: 'chat' }), identity: guest() });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.response.status).toBe(401);
    const body = (await r.response.json()) as { error: string; reason: string };
    expect(body.error).toBe('unauthorized');
    expect(body.reason).toBe('signed_in_required');
  });

  it('kind=chat + 已登录 → 放行', () => {
    const r = gateSessionChat({ session: baseSession({ kind: 'chat' }), identity: signedIn() });
    expect(r.ok).toBe(true);
  });
});

describe('gateSessionChat：companion 弹层（2026-09-18）', () => {
  it('kind=companion + 访客 → 401（球挂在 /journey-new，访客本就被 layout 闸挡住；防御兜底）', async () => {
    const r = gateSessionChat({ session: baseSession({ kind: 'companion' }), identity: guest() });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.response.status).toBe(401);
    const body = (await r.response.json()) as { error: string; reason: string };
    expect(body.reason).toBe('signed_in_required');
  });

  it('kind=companion + 已登录 → 放行', () => {
    const r = gateSessionChat({ session: baseSession({ kind: 'companion' }), identity: signedIn() });
    expect(r.ok).toBe(true);
  });
});

describe('gateSessionChat：boundary', () => {
  it('不抛错（纯函数，session / identity 字段不被改）', () => {
    const session = baseSession({ kind: 'onboarding_talk', messageCount: 3 });
    const identity = guest();
    const r = gateSessionChat({ session, identity });
    expect(r.ok).toBe(true);
    expect(session.messageCount).toBe(3);
    expect(identity.userId).toBeNull();
  });

  it('默认收紧：未知 kind（防御性强转）+ 访客 → 401（未来新增 kind 忘写鉴权也不放行）', async () => {
    const session = baseSession({ kind: 'future_kind' as never });
    const r = gateSessionChat({ session, identity: guest() });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.response.status).toBe(401);
  });
});
