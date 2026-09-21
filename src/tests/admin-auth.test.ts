import { afterEach, describe, expect, it, vi } from 'vitest';
import { currentAdmin, isAdminEmail, parseAdminEmails, requireApiAdmin } from '@/lib/admin-auth';

// 批 C0（docs/02 §20.3）：管理员闸的纯逻辑与三层行为。
// auth 只 mock getSession——admin-auth 不该碰 DB 之外的任何东西；
// 白名单解析是环境变量字符串 → 数组，页面闸（notFound）与 API 闸（401/403）共享同一判定。

const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(async () => new Headers()) }));

afterEach(() => {
  vi.unstubAllEnvs();
  getSession.mockReset();
});

describe('ADMIN_EMAILS 白名单解析', () => {
  it('逗号分隔、trim、大小写归一、空段丢弃', () => {
    vi.stubEnv('ADMIN_EMAILS', ' A@X.com , b@Y.coM ,,c@z.cn,');
    expect(parseAdminEmails(process.env.ADMIN_EMAILS)).toEqual(['a@x.com', 'b@y.com', 'c@z.cn']);
  });

  it('未配置 / 空串 → 空数组（后台整体关闭，显式关闭优于默认开放）', () => {
    vi.stubEnv('ADMIN_EMAILS', '');
    expect(parseAdminEmails(process.env.ADMIN_EMAILS)).toEqual([]);
    vi.stubEnv('ADMIN_EMAILS', undefined as unknown as string);
    expect(parseAdminEmails(process.env.ADMIN_EMAILS)).toEqual([]);
  });

  it('isAdminEmail：命中不分大小写；白名单外的邮箱、空值、未配置环境都拒绝', () => {
    vi.stubEnv('ADMIN_EMAILS', 'op@ink.ink');
    expect(isAdminEmail('OP@Ink.ink ')).toBe(true);
    expect(isAdminEmail('other@ink.ink')).toBe(false);
    expect(isAdminEmail(null)).toBe(false);
    expect(isAdminEmail(undefined)).toBe(false);
    expect(isAdminEmail('')).toBe(false);
    vi.stubEnv('ADMIN_EMAILS', undefined as unknown as string);
    expect(isAdminEmail('op@ink.ink')).toBe(false); // 未配置 = 谁都不是管理员
  });
});

describe('currentAdmin（页面闸的真源）', () => {
  it('登录且在白名单 → 返回邮箱；白名单外 / 未登录 / session 无邮箱 → null', async () => {
    vi.stubEnv('ADMIN_EMAILS', 'op@ink.ink');
    getSession.mockResolvedValue({ user: { email: 'op@ink.ink' } });
    await expect(currentAdmin()).resolves.toEqual({ email: 'op@ink.ink' });

    getSession.mockResolvedValue({ user: { email: 'stranger@ink.ink' } });
    await expect(currentAdmin()).resolves.toBeNull();

    getSession.mockResolvedValue({ user: {} });
    await expect(currentAdmin()).resolves.toBeNull();

    getSession.mockResolvedValue(undefined);
    await expect(currentAdmin()).resolves.toBeNull();
  });
});

describe('requireApiAdmin（API 闸）', () => {
  it('管理员 → ok；登录非管理员 → 403 not_admin；游客 → 401 signed_in_required', async () => {
    vi.stubEnv('ADMIN_EMAILS', 'op@ink.ink');

    getSession.mockResolvedValue({ user: { email: 'op@ink.ink' } });
    const ok = await requireApiAdmin();
    expect(ok).toEqual({ ok: true, email: 'op@ink.ink' });

    getSession.mockResolvedValue({ user: { email: 'stranger@ink.ink' } });
    const forbidden = await requireApiAdmin();
    expect(forbidden.ok).toBe(false);
    if (!forbidden.ok) {
      expect(forbidden.response.status).toBe(403);
      await expect(forbidden.response.json()).resolves.toMatchObject({ error: 'forbidden', reason: 'not_admin' });
    }

    getSession.mockResolvedValue(undefined);
    const unauthorized = await requireApiAdmin();
    expect(unauthorized.ok).toBe(false);
    if (!unauthorized.ok) {
      expect(unauthorized.response.status).toBe(401);
      await expect(unauthorized.response.json()).resolves.toMatchObject({
        error: 'unauthorized',
        reason: 'signed_in_required',
      });
    }
  });
});
