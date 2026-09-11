// POST /api/onboarding/answers：体检问卷落库（首次流程，永不占配额——P§7）
// 答案进 portrait.questionnaire（画像素材）；Q6（最近一次为钱心慌）同时种一条 concern
import { NextRequest, NextResponse } from 'next/server';
import { resolveIdentity } from '@/lib/identity';
import { ensureProfile, savePortrait, addConcern, savePayday } from '@/lib/profile';
import { QUESTIONS, paydayFromAnswers } from '@/lib/onboarding';
import { enabledLocales, isLocale } from '@/i18n/config';
import { jsonError } from '@/lib/sse';

export const dynamic = 'force-dynamic';

const FREE_MAX = 500;

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { locale?: string; answers?: Record<string, string> };
    const locale = body.locale;
    if (!isLocale(locale) || !enabledLocales.includes(locale)) return jsonError('invalid_locale', 400);
    if (typeof body.answers !== 'object' || body.answers === null) return jsonError('invalid_answers', 400);

    // 按问卷定义收窄答案：未知字段丢弃、choice 越界丢弃、free 截断
    const questionnaire: Record<string, string> = {};
    for (const q of QUESTIONS) {
      const raw = body.answers[q.id];
      if (typeof raw !== 'string' || raw.trim() === '') continue;
      if (q.kind === 'choice') {
        if (q.options?.includes(raw)) questionnaire[q.field] = raw;
      } else {
        questionnaire[q.field] = raw.trim().slice(0, FREE_MAX);
      }
    }
    // 两道开放题至少答一题才收（全选择题也能生成画像，但素材会薄——前端已引导）
    if (Object.keys(questionnaire).length === 0) return jsonError('empty_answers', 400);

    const identity = await resolveIdentity(request);
    const profile = await ensureProfile(identity.key, locale);

    const portrait = {
      ...(profile.portrait ?? {}),
      questionnaire,
      spoken: profile.portrait?.spoken ?? [],
      baseColor: profile.portrait?.baseColor ?? '',
      moments: profile.portrait?.moments ?? [],
      script: profile.portrait?.script ?? '',
      toFuture: profile.portrait?.toFuture ?? '',
      version: profile.portrait?.version ?? 0,
      calibrations: profile.portrait?.calibrations ?? [],
      scriptStatus: profile.portrait?.scriptStatus ?? 'pending',
    };
    await savePortrait(identity.key, portrait);

    // Q6 → concerns 种子（开放中的心事，后续对话上下文的一部分）
    const worry = questionnaire.concerns_seed;
    if (worry && !profile.concerns.some((c) => c.content === worry)) {
      await addConcern(identity.key, worry);
    }

    // 发薪日锚点：默认不猜（null），问卷 Q4 只反映习惯不设锚点
    await savePayday(identity.key, paydayFromAnswers(questionnaire));

    const headers: Record<string, string> = { 'Cache-Control': 'no-store' };
    if (identity.newGuestCookie) headers['Set-Cookie'] = identity.newGuestCookie;
    return NextResponse.json({ ok: true }, { headers });
  } catch (error) {
    console.error('[api/onboarding/answers] failed:', error);
    return jsonError('server_error', 500);
  }
}
