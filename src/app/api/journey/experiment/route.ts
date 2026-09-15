// POST /api/journey/experiment：微行动卡"完成实验 + 一句话感受"写入 experiments[]（docs/02 阶段 3）。
// 做砸的实验也是数据——记成功或记没做都算；感受可空；完成即计活跃足迹。
// 感受文本是用户文本入口：过安全层（P§8），命中落事件、照常写入（用户的话就是用户的话）。
import { NextRequest } from 'next/server';
import { requireApiUser } from '@/lib/api-auth';
import { appendExperiment, bumpActiveDay, ensureProfile } from '@/lib/profile';
import { checkSafety, recordSafetyEvent, referralMessage } from '@/lib/safety';
import { track } from '@/lib/analytics';
import { getLlmProviders, llmComplete } from '@/lib/llm';
import { buildReceiptSystem, buildReceiptUser, pickReceiptFallback } from '@/lib/receipt';
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

    // 访客闸（用户 2026-09-14 拍板：访客 = 只能做金钱关系测试）
    const auth = await requireApiUser();
    if (!auth.ok) return auth.response;
    const identity = auth.identity;

    let safetyHit = false;
    if (feeling) {
      const verdict = await checkSafety(locale, feeling);
      if (verdict.hit) {
        safetyHit = true;
        await recordSafetyEvent(identity.key, 'experiment', verdict.category ?? 'crisis');
      }
    }

    // 对话本身就是建档动作：微行动完成也可能发生在体检之前（无档案行先建）
    const profile = await ensureProfile(identity.key, locale);
    // M10 即时见证：用户人生第一件被记录的小事值得一次即时回应（其余也回应，只埋点区分首次）
    const isFirstExperiment = profile.experiments.length === 0;
    await appendExperiment(identity.key, { date: new Date().toISOString().slice(0, 10), action, feeling });
    try {
      await bumpActiveDay(identity.key);
    } catch (error) {
      console.error('[api/journey/experiment] bumpActiveDay failed:', error);
    }
    await track(identity.key, 'experiment_saved', { safety: safetyHit }, locale);
    if (isFirstExperiment) {
      await track(identity.key, 'micro_action_first_done', { stage: String(profile.stage) }, locale);
    }

    // M10 即时见证回应：命中安全层→转介文案作收条；LLM 可用→收条体；
    // 失败/无 provider 静默降级词典收条——回应本身绝不阻塞记录
    const fallback = pickReceiptFallback(locale, `${identity.key}#${action}`);
    let receipt = safetyHit ? referralMessage(locale, 'crisis') : fallback;
    if (!safetyHit && getLlmProviders().length > 0) {
        try {
          const raw = await llmComplete({
            system: buildReceiptSystem(locale),
            messages: [{ role: 'user', content: buildReceiptUser({ action, feeling: feeling || undefined }) }],
            maxTokens: 200,
            temperature: 0.7,
          });
          const text = raw.trim();
          if (text) receipt = text;
        } catch (error) {
          console.error('[api/journey/experiment] receipt llm failed:', error);
        }
      }
    await track(identity.key, 'micro_action_instant_response_shown', { llm: String(receipt !== fallback) }, locale);

    const headers: Record<string, string> = { 'Cache-Control': 'no-store' };
    if (identity.newGuestCookie) headers['Set-Cookie'] = identity.newGuestCookie;
    return new Response(JSON.stringify({ ok: true, safety: safetyHit, receipt }), {
      headers: { ...headers, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('[api/journey/experiment] failed:', error);
    return jsonError('server_error', 500);
  }
}
