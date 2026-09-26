// POST /api/me/push：壳（Capacitor/iOS）上报 APNs 设备 token（docs/11 M2）。
// DELETE /api/me/push?token=…：卸载前主动注销（主动调用是礼貌，410 反馈是兜底）。
//
// 游客可上报（同 wishes 的理由：首启发生在注册之前）；注册时随游客迁移带走。
// 同意语义：iOS 系统通知权限 = opt-in（壳侧拿到权限才调到这里）；退订 = 系统设置
// 关通知/卸载。服务端不再设第二套开关——两套开关必然漂移。
// APNs token 是不透明的设备标识（P§9 日志纪律：不进日志、不进埋点）。
import { NextRequest } from 'next/server';
import { resolveIdentity } from '@/lib/identity';
import { ensureProfile, upsertPushToken, removePushToken } from '@/lib/profile';
import { jsonError } from '@/lib/sse';

export const dynamic = 'force-dynamic';

/** APNs token 是 64 字节 hex（旧格式）或 ~178 字符 base64（新格式）——给个宽范围防形状退化。 */
function isValidDeviceToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{32,256}$/.test(token);
}

export async function POST(request: NextRequest) {
  try {
    const identity = await resolveIdentity(request);
    const body = (await request.json().catch(() => ({}))) as { token?: unknown; platform?: unknown };
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    if (!isValidDeviceToken(token)) return jsonError('invalid_token', 400);
    // 首版只发 iOS（docs/11 §5）；别的平台名直接拒，别让坏形状悄悄入库
    const platform = body.platform ?? 'ios';
    if (platform !== 'ios') return jsonError('invalid_platform', 400);

    await ensureProfile(identity.key, 'en');
    await upsertPushToken(identity.key, token, 'ios');

    const headers: Record<string, string> = { 'Cache-Control': 'no-store' };
    if (identity.newGuestCookie) headers['Set-Cookie'] = identity.newGuestCookie;
    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...headers, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('[api/me/push] failed:', error);
    return jsonError('server_error', 500);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const identity = await resolveIdentity(request);
    const token = request.nextUrl.searchParams.get('token')?.trim() ?? '';
    if (!isValidDeviceToken(token)) return jsonError('invalid_token', 400);
    await removePushToken(identity.key, token);
    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('[api/me/push] delete failed:', error);
    return jsonError('server_error', 500);
  }
}
