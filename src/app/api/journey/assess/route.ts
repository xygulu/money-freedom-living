// POST /api/journey/assess：阶段评估（M9 需求③语义修正——评估的是用户实际
// 表现出的认知与行为所处的阶段，不是产品内操作/交互次数）。
// action=generate：提议确认后的评估——服务端复算 shouldOfferAssess 防绕 UI，
//   claimAssessment 原子抢锁防双击双生成；LLM 失败重试一次，仍失败清锁 502，
//   现状态不动、提议不消失。不消耗聊天配额（频率由素材闸控制）。
// action=confirm：记下现在的样子——新点亮灯的心印入档（只增不减），不推进。
// action=advance：走进下一阶段——服务端复算 pending.actualStage > stage 防绕；
//   推进即仪式（stage{n}_entered）。
// action=dismiss：「不是这样的/先不用」→ 14 天冷却，无惩罚；有待确认评估则一并清掉。
import { NextRequest } from 'next/server';
import { resolveIdentity } from '@/lib/identity';
import { getProfile, appendStamps, saveStage, bumpActiveDay, type StageAssessment } from '@/lib/profile';
import {
  gatherAssessMaterial,
  shouldOfferAssess,
  buildAssessMessages,
  validateAssessment,
  saveAssessmentState,
  claimAssessment,
  releaseAssessmentLock,
} from '@/lib/assess';
import { countMaterialSince } from '@/lib/evolution';
import { getJourneyStages } from '@/lib/content';
import { MAX_STAGE } from '@/lib/stage';
import { llmCompleteJson } from '@/lib/llm';
import { track } from '@/lib/analytics';
import { enabledLocales, isLocale } from '@/i18n/config';
import { jsonError } from '@/lib/sse';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const ACTIONS = ['generate', 'confirm', 'advance', 'dismiss'];

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as { locale?: string; action?: string };
    const locale = isLocale(body.locale) && enabledLocales.includes(body.locale) ? body.locale : 'en';
    if (!body.action || !ACTIONS.includes(body.action)) return jsonError('invalid_action', 400);

    const identity = await resolveIdentity(request);
    const profile = await getProfile(identity.key);
    if (!profile?.portrait) return jsonError('profile_not_found', 404);

    const now = new Date().toISOString();
    const state = profile.assessment;
    const respond = (payload: unknown) => {
      const headers: Record<string, string> = { 'Cache-Control': 'no-store' };
      if (identity.newGuestCookie) headers['Set-Cookie'] = identity.newGuestCookie;
      return Response.json(payload, { headers });
    };

    if (body.action === 'dismiss') {
      await saveAssessmentState(identity.key, { pending: null, dismissedAt: now, proposedSeenAt: null });
      return respond({ ok: true });
    }

    if (body.action === 'generate') {
      const baseline = state.confirmedAt ?? profile.created_at;
      const counts = await countMaterialSince(identity.key, profile, baseline, now);
      // 防绕过：卡片亮不亮 UI 和 API 走同一道判定
      if (!shouldOfferAssess(profile, state, counts, now)) return jsonError('assess_not_proposed', 403);
      // 原子占锁：双击/并发只有一次真的在生成
      if (!(await claimAssessment(identity.key, now))) return jsonError('assess_busy', 429);

      try {
        const material = await gatherAssessMaterial(identity.key, profile, baseline);
        const { system, messages } = buildAssessMessages(locale, profile.stage, getJourneyStages(locale), material, {
          confirmed: state.confirmed,
          earnedKinds: profile.stamps.map((s) => s.kind),
        });

        let draft = validateAssessment(await llmCompleteJson({ system, messages, maxTokens: 2600 }), profile.stage);
        if (!draft) {
          console.warn('[api/journey/assess] first draft invalid, retrying once');
          draft = validateAssessment(await llmCompleteJson({ system, messages, maxTokens: 2600 }), profile.stage);
        }
        if (!draft) {
          // 现状态不动、提议不消失：只清锁
          await releaseAssessmentLock(identity.key);
          return jsonError('assessment_generation_failed', 502);
        }

        const assessment: StageAssessment = { ...draft, assessedAt: now };
        // 清锁 + 重置提议埋点纪元 + 待用户确认
        await saveAssessmentState(identity.key, { generatingAt: null, proposedSeenAt: null, pending: assessment });
        await track(
          identity.key,
          'stage_assessment_generated',
          { stage: profile.stage, lit: assessment.lamps.filter((l) => l.lit).length },
          locale
        );
        return respond({ assessment });
      } catch (error) {
        await releaseAssessmentLock(identity.key).catch(() => undefined);
        throw error;
      }
    }

    // confirm / advance 都作用在待确认的评估上
    const pending = state.pending;
    if (!pending) return jsonError('assessment_not_found', 404);

    // 点亮差集（只增不减：以 stamps 为准，已入档的不重复颁）
    const earned = new Set(profile.stamps.map((s) => s.kind));
    const newlyLit = pending.lamps.filter((l) => l.lit && !earned.has(l.kind)).map((l) => l.kind);

    if (body.action === 'confirm') {
      await appendStamps(identity.key, newlyLit);
      await saveAssessmentState(identity.key, { pending: null, confirmed: pending, confirmedAt: now });
      await bumpActiveDay(identity.key);
      await track(identity.key, 'stage_assessment_confirmed', { stage: profile.stage, lit: newlyLit.length }, locale);
      return respond({ ok: true });
    }

    // advance：走进下一阶段。评估说还没到，就不许推进（防绕 UI 直刷）
    const from = profile.stage;
    if (from >= MAX_STAGE) return jsonError('no_next_stage', 400);
    if (pending.actualStage <= from) return jsonError('advance_not_ready', 403);
    const to = from + 1;
    await appendStamps(identity.key, [...newlyLit, `stage${to}_entered`]);
    await saveStage(identity.key, to);
    await saveAssessmentState(identity.key, { pending: null, confirmed: pending, confirmedAt: now });
    await bumpActiveDay(identity.key);
    await track(identity.key, 'stage_advanced', { from: String(from), to: String(to) }, locale);
    return respond({ stage: to });
  } catch (error) {
    console.error('[api/journey/assess] failed:', error);
    return jsonError('server_error', 500);
  }
}
