// GET /api/chat/recent?limit=N：弹层「上次说到这儿」的历史拉取（2026-09-18）。
// 返回当前用户最近 N 个 closed 会话（kind ∈ chat/companion，排除体检初谈——
// 初谈语气是"追问体检"，混进弹层会让回看变味）的完整消息。
// requireApiUser：访客无对话历史（访客闸同口径）。
import { NextRequest } from 'next/server';
import { requireApiUser } from '@/lib/api-auth';
import { findUserRecentSessions } from '@/lib/chat';
import { timeZoneFrom, todayIn } from '@/lib/time';

export const dynamic = 'force-dynamic';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 20;

export async function GET(request: NextRequest) {
  try {
    const auth = await requireApiUser();
    if (!auth.ok) return auth.response;
    const identity = auth.identity;

    const raw = Number(request.nextUrl.searchParams.get('limit') ?? '');
    const limit = Number.isFinite(raw) && raw >= 1 ? Math.min(Math.floor(raw), MAX_LIMIT) : DEFAULT_LIMIT;

    const sessions = await findUserRecentSessions(identity.key, limit);
    // day 按用户时区归日（closed_at 为 NULL 的存量行用 created_at 兜底）。
    // 同时透传 closedAt/createdAt 原始 ISO：弹层在客户端用浏览器自己的时区重算
    // （用户 2026-09-18 反馈"要根据用户的时区来自动判断"——客户端 Intl 不传
    // timeZone 即本机时区，比服务端 cookie 更可靠）。
    const tz = timeZoneFrom(request.cookies);
    const headers: Record<string, string> = { 'Cache-Control': 'no-store' };
    if (identity.newGuestCookie) headers['Set-Cookie'] = identity.newGuestCookie;
    return Response.json(
      {
        sessions: sessions.map((s) => ({
          id: s.id,
          kind: s.kind,
          status: s.status,
          day: todayIn(tz, new Date(s.closedAt ?? s.createdAt)),
          closedAt: s.closedAt,
          createdAt: s.createdAt,
          messages: s.messages,
        })),
      },
      { headers }
    );
  } catch (error) {
    console.error('[api/chat/recent] failed:', error);
    return Response.json({ error: 'server_error' }, { status: 500 });
  }
}
