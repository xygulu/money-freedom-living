// POST /api/journey/experiment：微行动卡"完成实验 + 一句话感受"写入 experiments[]（docs/02 阶段 3）。
// 做砸的实验也是数据——记成功或记没做都算；感受可空；完成即计活跃足迹。
// 感受文本是用户文本入口：过安全层（P§8），命中落事件、照常写入（用户的话就是用户的话）。
import { NextRequest } from 'next/server';
import { resolveIdentity } from '@/lib/identity';
import { appendExperiment, bumpActiveDay, ensureProfile } from '@/lib/profile';
import { checkSafety, recordSafetyEvent } from '@/lib/safety';
import { track } from '@/lib/analytics';
import { enabledLocales, isLocale, type Locale } from '@/i18n/config';
import { jsonError } from '@/lib/sse';

export const dynamic = 'force-dynamic';

const ACTION_MAX = 300;
const FEELING_MAX = 500;

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      action?: string;
      feeling?: string;
      locale?: string;
    };
    const action = typeof body.action === 'string' ? body.action.trim().slice(0, ACTION_MAX) : '';
    if (!action) return jsonError('empty_action', 400);
    const feeling = typeof body.feeling === 'string' ? body.feeling.trim().slice(0, FEELING_MAX) : '';
    const locale: Locale = isLocale(body.locale) && enabledLocales.includes(body.locale) ? body.locale : 'en';

    const identity = await resolveIdentity(request);

    let safetyHit = false;
    if (feeling) {
      const verdict = await checkSafety(locale, feeling);
      if (verdict.hit) {
        safetyHit = true;
        await recordSafetyEvent(identity.key, 'experiment', verdict.category ?? 'crisis');
      }
    }

    // 对话本身就是建档动作：微行动完成也可能发生在体检之前（无档案行先建）
    await ensureProfile(identity.key, locale);
    await appendExperiment(identity.key, { date: new Date().toISOString().slice(0, 10), action, feeling });
    try {
      await bumpActiveDay(identity.key);
    } catch (error) {
      console.error('[api/journey/experiment] bumpActiveDay failed:', error);
    }
    await track(identity.key, 'experiment_saved', { safety: safetyHit }, locale);

    const headers: Record<string, string> = { 'Cache-Control': 'no-store' };
    if (identity.newGuestCookie) headers['Set-Cookie'] = identity.newGuestCookie;
    return new Response(JSON.stringify({ ok: true, safety: safetyHit }), {
      headers: { ...headers, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('[api/journey/experiment] failed:', error);
    return jsonError('server_error', 500);
  }
}
