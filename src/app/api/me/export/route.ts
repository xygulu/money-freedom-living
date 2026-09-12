// GET /api/me/export：导出本人全部数据（GDPR/CCPA 数据可携权，docs/02 §9）。
// 下载一份 JSON：账号信息 + 成长档案（画像/微行动/信件/一签记录）+ 画像版本快照 +
// 日记原文 + 全部对话原文。原文只给本人（这是删除权与可携权的"权利"主体）。
import { NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { getProfile } from '@/lib/profile';
import { getJournalEntries } from '@/lib/journal';
import { getSql, ensureSchema } from '@/lib/db';
import { track } from '@/lib/analytics';
import { jsonError } from '@/lib/sse';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    const user = session?.user as { id: string; email?: string; username?: string; createdAt?: string } | undefined;
    if (!user) return jsonError('NOT_AUTHENTICATED', 401);

    const userKey = `u:${user.id}`;
    const profile = await getProfile(userKey);
    const journal = await getJournalEntries(userKey);

    // 对话原文（chat_messages）随会话一起取；只取本人会话
    await ensureSchema();
    const sessions = await getSql()`
      SELECT id, locale, kind, message_count, safety_flagged, status, created_at
      FROM chat_sessions WHERE user_key = ${userKey} ORDER BY created_at
    `;
    const messages = await getSql()`
      SELECT m.session_id, m.role, m.content, m.created_at
      FROM chat_messages m
      JOIN chat_sessions s ON s.id = m.session_id
      WHERE s.user_key = ${userKey} ORDER BY m.id
    `;
    // 画像历代快照（含当前版）：可携权要求"演进过程"同样可带走
    const portraitVersions = await getSql()`
      SELECT version, portrait, source, material, created_at
      FROM portrait_versions WHERE user_key = ${userKey} ORDER BY version
    `;

    const payload = {
      format: 'money-freedom-living-export/v1',
      exportedAt: new Date().toISOString(),
      account: { email: user.email ?? null, username: user.username ?? null, createdAt: user.createdAt ?? null },
      profile: profile
        ? {
            locale: profile.locale,
            stage: profile.stage,
            portrait: profile.portrait,
            concerns: profile.concerns,
            pinned: profile.pinned,
            memories: profile.memories,
            experiments: profile.experiments,
            letters: profile.letters,
            dailySeen: profile.dailySeen,
            payday: profile.payday,
            totalActiveDays: profile.total_active_days,
          }
        : null,
      journal,
      portraitVersions,
      conversations: { sessions, messages },
    };

    await track(userKey, 'data_exported');

    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    return new Response(JSON.stringify(payload, null, 2), {
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="money-freedom-living-${date}.json"`,
      },
    });
  } catch (error) {
    console.error('[api/me/export] failed:', error);
    return jsonError('server_error', 500);
  }
}
