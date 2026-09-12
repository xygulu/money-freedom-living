// POST /api/me/delete：删除账号（删除权，docs/02 §9「删除权级联承诺」）。
// 级联范围：业务表（growth_profiles/画像版本快照/对话会话与原文/日记/安全事件/
// 事件/同意记录，user_key 无外键须手动删）→ 认证表（session/account，entitlements 与 subscriptions
// 随 "user" 行外键 CASCADE）。删除前打一条 account_deleted 事件（含在删除范围里，
// 只是审计口径：用户此前存在过）。删除后登录态全失效（session 表行已清）。
// 备份滚动清除与模型 provider 零保留承诺在 /privacy 政策文本中写明。
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { getSql, ensureSchema } from '@/lib/db';
import { track } from '@/lib/analytics';
import { jsonError } from '@/lib/sse';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    const user = session?.user as { id: string; username?: string } | undefined;
    if (!user) return jsonError('NOT_AUTHENTICATED', 401);

    const body = (await request.json().catch(() => ({}))) as { confirm?: string };
    if (body.confirm !== 'DELETE') {
      return NextResponse.json({ code: 'CONFIRM_REQUIRED', error: '确认词不对，未删除' }, { status: 400 });
    }

    const userKey = `u:${user.id}`;
    await ensureSchema();
    const sql = getSql();

    await track(userKey, 'account_deleted');

    // 业务表（无外键，手动级联；chat_messages 随 chat_sessions 外键 CASCADE）
    await sql`DELETE FROM growth_profiles WHERE user_key = ${userKey}`;
    await sql`DELETE FROM portrait_versions WHERE user_key = ${userKey}`;
    await sql`DELETE FROM chat_sessions WHERE user_key = ${userKey}`;
    await sql`DELETE FROM journal_entries WHERE user_key = ${userKey}`;
    await sql`DELETE FROM safety_events WHERE user_key = ${userKey}`;
    await sql`DELETE FROM events WHERE user_key = ${userKey}`;
    await sql`DELETE FROM consent_records WHERE user_key = ${userKey}`;
    if (user.username) {
      // 恢复码限速的账号维度审计行（subject = username）
      await sql`DELETE FROM recovery_attempts WHERE scope = 'account' AND subject = ${user.username}`;
    }

    // 认证表：先删 session/account，再删 user（entitlements/subscriptions 随之外键级联）
    await sql`DELETE FROM session WHERE "userId" = ${user.id}`;
    await sql`DELETE FROM account WHERE "userId" = ${user.id}`;
    await sql`DELETE FROM "user" WHERE id = ${user.id}`;

    // 清登录态 cookie（asResponse 拿到 better-auth 序列化好的 Set-Cookie）
    const signOut = await auth.api.signOut({ headers: request.headers, asResponse: true });
    const cookies = signOut.headers.getSetCookie();

    const headers: Record<string, string> = { 'Cache-Control': 'no-store' };
    if (cookies.length > 0) headers['Set-Cookie'] = cookies.join(', ');
    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...headers, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('[api/me/delete] failed:', error);
    return jsonError('server_error', 500);
  }
}
