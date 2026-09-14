import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import {
  consumeQuota,
  clientIpFromHeaders,
  guestKeyForRequest,
  guestCookieHeader,
  GUEST_ID_COOKIE,
  isVipOnlyKind,
} from '@/lib/quota';
import { timeZoneFrom, todayIn } from '@/lib/time';
import { isUserVip } from '@/lib/entitlements';

// POST /api/quota/consume：动作门禁（消耗一次当日配额）+ VIP-only 功能门禁。
// 前端在执行受保护动作（开局/生成/导出……）之前先调它，通过后才真正执行。
//
// body（可省略）：{ kind?: string }  —— 功能 key，参与 VIP-only 判定与落库分类
//
// 响应约定：
//   200 { ok: true, limit, used, remaining, isVip }
//   403 { code: 'QUOTA_EXCEEDED', error, limit }   —— 当日次数用完
//   403 { code: 'FEATURE_VIP_ONLY', error }        —— 该功能仅限 VIP
//
// ⚠️ 纪律一：所有"重复触发就是损失"的动作都必须走本门禁——包括"再来一次/
// 重试/继续下一轮"这类页内按钮。只给首入口加门禁的话，重玩按钮直接调
// 前端动作函数就能绕过配额（实测踩过：结束页重玩直接 startGame() 导致无限玩）。
//
// ⚠️ 纪律二：本端点防的是"超发"（并发不超过上限），不防"重复消耗"——
// 同一 tick 的双击会发出两个 POST 且都成功（React state 守卫要等 re-render）。
// 前端触发回调里用 useRef 守卫（立即生效），参考 examples/vip-page.tsx。
export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  const user = session?.user as { id: string } | undefined;
  const userId = user?.id ?? null;

  // kind 缺失/非 JSON body 时按 'default' 处理（宽松解析，别让脏 body 挡使用）
  let kind = 'default';
  try {
    const body = (await request.json()) as { kind?: unknown } | null;
    if (typeof body?.kind === 'string' && body.kind) kind = body.kind;
  } catch {
    // 无 body：按默认功能
  }

  // VIP-only 功能：游客/免费用户直接 403（前端隐藏入口，这里是服务端兜底，
  // 防止直接调接口）
  if (isVipOnlyKind(kind)) {
    const allowed = userId ? await isUserVip(userId) : false;
    if (!allowed) {
      return NextResponse.json(
        { code: 'FEATURE_VIP_ONLY', error: '该功能是 VIP 专属' },
        { status: 403, headers: { 'Cache-Control': 'no-store' } }
      );
    }
  }

  // 游客身份：匿名 cookie 优先，IP 兜底（与 GET /api/quota 同一解析——
  // 展示桶和扣减桶必须是同一个，否则剩余次数显示与实际扣减错位）
  // 日界线按用户所在时区，不按服务器：游客 key 与配额桶都得用同一个「今天」
  const today = todayIn(timeZoneFrom(request.cookies));
  const guest = guestKeyForRequest(
    request.cookies.get(GUEST_ID_COOKIE)?.value,
    clientIpFromHeaders(request.headers),
    today
  );
  const headers: Record<string, string> = { 'Cache-Control': 'no-store' };
  if (!userId && guest.newCookieId) {
    headers['Set-Cookie'] = guestCookieHeader(guest.newCookieId);
  }

  try {
    const result = await consumeQuota({ userId, guestKey: guest.guestKey, kind, day: today });
    if (!result.ok) {
      return NextResponse.json(
        {
          code: 'QUOTA_EXCEEDED',
          error: userId
            ? '今日次数已用完，明天再来或开通 VIP'
            : '今日游客次数已用完，注册后每天可用 10 次',
          limit: result.status.limit,
        },
        { status: 403, headers }
      );
    }
    const { used, remaining, limit, isVip } = result.status;
    return NextResponse.json({ ok: true, limit, used, remaining, isVip }, { headers });
  } catch (error) {
    console.error('[api/quota/consume] failed:', error);
    return NextResponse.json(
      { code: 'INTERNAL_ERROR', error: '请求失败，请稍后再试' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
