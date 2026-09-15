// POST /api/portrait/evolve：画像演进（M9 需求②）。
// action=dismiss：「暂不」→ 14 天冷却（无 LLM）。
// action=generate：提议确认后的重画——服务端复算 shouldPropose 防绕 UI，
// claimEvolution 原子抢锁防双击双生成；LLM 失败重试一次，仍失败清锁 502，
// 现画像不动、提议不消失。不消耗聊天配额（对齐体检；频率由素材闸控制）。
import { NextRequest } from 'next/server';
import { requireApiUser } from '@/lib/api-auth';
import { getProfile, savePortrait, bumpActiveDay, type Portrait } from '@/lib/profile';
import {
  baselineFor,
  countMaterialSince,
  gatherEvolveMaterial,
  shouldPropose,
  buildEvolveMessages,
  listPortraitVersions,
  insertPortraitVersion,
  saveEvolution,
  claimEvolution,
  releaseEvolutionLock,
} from '@/lib/evolution';
import { validatePortraitDraft } from '@/lib/onboarding';
import { llmCompleteJson } from '@/lib/llm';
import { track } from '@/lib/analytics';
import { enabledLocales, isLocale } from '@/i18n/config';
import { jsonError } from '@/lib/sse';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as { locale?: string; action?: string };
    const locale = isLocale(body.locale) && enabledLocales.includes(body.locale) ? body.locale : 'en';
    if (body.action !== 'generate' && body.action !== 'dismiss') return jsonError('invalid_action', 400);

    // 访客闸（用户 2026-09-14 拍板：访客 = 只能做金钱关系测试）
    const auth = await requireApiUser();
    if (!auth.ok) return auth.response;
    const identity = auth.identity;
    const profile = await getProfile(identity.key);
    if (!profile?.portrait) return jsonError('profile_not_found', 404);

    const now = new Date().toISOString();
    const versions = await listPortraitVersions(identity.key);
    const baseline = baselineFor(profile, versions);
    const counts = await countMaterialSince(identity.key, profile, baseline, now);
    // 防绕过：卡片亮不亮 UI 和 API 走同一道判定
    if (!shouldPropose(profile, counts, now)) return jsonError('evolve_not_proposed', 403);

    if (body.action === 'dismiss') {
      await saveEvolution(identity.key, { dismissedAt: now });
      const headers: Record<string, string> = { 'Cache-Control': 'no-store' };
      if (identity.newGuestCookie) headers['Set-Cookie'] = identity.newGuestCookie;
      return Response.json({ ok: true }, { headers });
    }

    // 原子占锁：双击/并发只有一次真的在生成
    if (!(await claimEvolution(identity.key, now))) return jsonError('evolve_busy', 429);

    const previous = profile.portrait;
    try {
      const material = await gatherEvolveMaterial(identity.key, profile, baseline);
      const { system, messages } = buildEvolveMessages(locale, previous, material);

      let draft = validatePortraitDraft(await llmCompleteJson({ system, messages, maxTokens: 2000 }));
      if (!draft) {
        console.warn('[api/portrait/evolve] first draft invalid, retrying once');
        draft = validatePortraitDraft(await llmCompleteJson({ system, messages, maxTokens: 2000 }));
      }
      if (!draft) {
        // 现画像不动、提议不消失：只清锁
        await releaseEvolutionLock(identity.key);
        return jsonError('portrait_generation_failed', 502);
      }

      const nextVersion = previous.version + 1;
      // 懒回填：存量用户当前版不在版本表，先补上（演进基线从此有锚点）
      if (!versions.some((v) => v.version === previous.version)) {
        await insertPortraitVersion(identity.key, previous.version, previous, 'backfill');
      }
      const nextPortrait: Portrait = {
        questionnaire: previous.questionnaire,
        spoken: draft.spoken,
        baseColor: draft.baseColor,
        moments: draft.moments,
        script: draft.script,
        toFuture: draft.toFuture,
        version: nextVersion,
        calibrations: [],
        scriptStatus: 'pending',
        createdAt: now,
      };
      await insertPortraitVersion(identity.key, nextVersion, nextPortrait, 'evolve', {
        memories: material.memories.length,
        journals: material.journals.length,
        experiments: material.experiments.length,
        daysSince: counts.daysSince,
      });
      await savePortrait(identity.key, nextPortrait);
      // 清锁 + 记录生成时刻 + 重置提议埋点纪元（proposedSeenAt: null）
      await saveEvolution(identity.key, { generatingAt: null, lastGeneratedAt: now, proposedSeenAt: null });
      await bumpActiveDay(identity.key);
      await track(identity.key, 'portrait_evolved', { from: String(previous.version), to: String(nextVersion) }, locale);

      const headers: Record<string, string> = { 'Cache-Control': 'no-store' };
      if (identity.newGuestCookie) headers['Set-Cookie'] = identity.newGuestCookie;
      return Response.json({ portrait: nextPortrait, previousVersion: previous.version }, { headers });
    } catch (error) {
      await releaseEvolutionLock(identity.key).catch(() => undefined);
      throw error;
    }
  } catch (error) {
    console.error('[api/portrait/evolve] failed:', error);
    return jsonError('server_error', 500);
  }
}
