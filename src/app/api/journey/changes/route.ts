// POST /api/journey/changes：《我变了什么》叙述段（M10，docs/03 §11）。
// 无已确认评估 → 404（入口本就不会出现）；已有与 confirmedAt 匹配的缓存 →
// 直接返回不重生成；否则 claimChangeList 原子抢锁（防双击双生成）→ LLM 生成
// → validateChangeListText → 落缓存。LLM 失败清锁 502——页面结构化部分仍在，
// 只缺叙述段，不阻塞任何东西。全免费（评估确认后的回望不设付费墙）。
import { NextRequest } from 'next/server';
import { resolveIdentity } from '@/lib/identity';
import { getProfile } from '@/lib/profile';
import {
  buildChangeListMessages,
  claimChangeList,
  gatherChangeListMaterial,
  releaseChangeListLock,
  saveChangeList,
  validateChangeListText,
} from '@/lib/changes';
import { llmComplete } from '@/lib/llm';
import { track } from '@/lib/analytics';
import { enabledLocales, isLocale } from '@/i18n/config';
import { jsonError } from '@/lib/sse';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as { locale?: string };
    const locale = isLocale(body.locale) && enabledLocales.includes(body.locale) ? body.locale : 'en';

    const identity = await resolveIdentity(request);
    const profile = await getProfile(identity.key);
    if (!profile?.portrait) return jsonError('profile_not_found', 404);

    const now = new Date().toISOString();
    const state = profile.assessment;
    if (!state.confirmed || !state.confirmedAt) return jsonError('change_not_confirmed', 404);

    // 缓存命中：同一次确认的清单直接返回（幂等，第二次点不重烧 LLM）
    if (state.changeList && state.changeList.forConfirmedAt === state.confirmedAt && state.changeList.text) {
      return Response.json({ changeList: state.changeList, cached: true }, { headers: { 'Cache-Control': 'no-store' } });
    }

    if (!(await claimChangeList(identity.key, now))) return jsonError('change_busy', 429);

    try {
      const material = await gatherChangeListMaterial(identity.key, profile);
      const prevLit = new Set((state.previousConfirmed?.lamps ?? []).filter((l) => l.lit).map((l) => l.kind));
      const newLamps = state.confirmed.lamps
        .filter((l) => l.lit && l.evidence && !prevLit.has(l.kind))
        .map((l) => ({ kind: l.kind, evidence: l.evidence }));
      const { system, messages } = buildChangeListMessages(locale, material, {
        confirmed: state.confirmed,
        previousConfirmed: state.previousConfirmed ?? null,
        newLamps,
        earnedKinds: profile.stamps.map((s) => s.kind),
      });

      const text = validateChangeListText(await llmComplete({ system, messages, maxTokens: 1600, temperature: 0.6 }));
      if (!text) {
        await releaseChangeListLock(identity.key);
        return jsonError('change_generation_failed', 502);
      }

      const entry = { text, generatedAt: now, forConfirmedAt: state.confirmedAt };
      await saveChangeList(identity.key, entry);
      await track(identity.key, 'change_list_generated', { cached: 'false' }, locale);
      return Response.json({ changeList: entry, cached: false }, { headers: { 'Cache-Control': 'no-store' } });
    } catch (error) {
      await releaseChangeListLock(identity.key).catch(() => undefined);
      throw error;
    }
  } catch (error) {
    console.error('[api/journey/changes] failed:', error);
    return jsonError('server_error', 500);
  }
}
