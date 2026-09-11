// POST /api/me/recovery/recover：恢复码验证 + 重置密码（无需登录）。
// 用途：忘记密码 / Safari ITP 清了存储后的账号找回（docs/02 §9 游客身份行）。
// 流程：限速检查 → 用户名查用户 → 比对恢复码哈希 → 通过则重写 account.password
//（复用项目自定义 scrypt，格式与登录验证一致）。成功后用户用新密码走正常登录。
// 限速（docs/03 §4）：账号 5 次/时 + IP 20 次/时 + 全局失败 100 次/时。
// 防用户名枚举：用户名不存在与码错误返回同一响应。
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { hashPassword } from '@/lib/password';
import { getRecoveryCodeHash, hashRecoveryCode, checkRateLimits, recordAttempt, normalizeCode } from '@/lib/recovery';
import { hashIp } from '@/lib/consent';
import { getSql } from '@/lib/db';
import { clientIpFromHeaders } from '@/lib/quota';
import { jsonError } from '@/lib/sse';

export const dynamic = 'force-dynamic';

const GENERIC_ERROR = { code: 'RECOVERY_FAILED', error: '用户名、恢复码或新密码不对' };

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      username?: string;
      code?: string;
      newPassword?: string;
    };
    const username = (body.username ?? '').trim();
    const code = normalizeCode(body.code ?? '');
    const newPassword = body.newPassword ?? '';
    if (!username || code.length !== 12 || newPassword.length < 6) {
      return NextResponse.json(GENERIC_ERROR, { status: 400 });
    }

    const ipHash = hashIp(clientIpFromHeaders(request.headers));
    if ((await checkRateLimits(username, ipHash)) === 'locked') {
      return jsonError('RATE_LIMITED', 429);
    }

    const rows = await getSql()`SELECT id FROM "user" WHERE username = ${username} LIMIT 1`;
    const userId = rows[0]?.id as string | undefined;
    const storedHash = userId ? await getRecoveryCodeHash(`u:${userId}`) : null;

    if (!userId || !storedHash || storedHash !== hashRecoveryCode(code)) {
      // 失败三个维度都记（global 只在失败时才有意义）
      await recordAttempt('account', username, false);
      await recordAttempt('ip', ipHash, false);
      await recordAttempt('global', '*', false);
      return NextResponse.json(GENERIC_ERROR, { status: 401 });
    }

    // 重置密码：写入与 better-auth 登录验证一致的 scrypt 格式（lib/password.ts）
    const passwordHash = await hashPassword(newPassword);
    await getSql()`
      UPDATE account SET password = ${passwordHash} WHERE "userId" = ${userId} AND "providerId" = 'credential'
    `;
    await recordAttempt('account', username, true);
    await recordAttempt('ip', ipHash, true);

    // 安全省念：这个账号的现有登录态全部失效（找回 = 可能是设备丢失场景）
    await getSql()`DELETE FROM session WHERE "userId" = ${userId}`;

    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('[api/me/recovery/recover] failed:', error);
    return jsonError('server_error', 500);
  }
}
