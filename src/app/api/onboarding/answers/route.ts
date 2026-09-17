// POST /api/onboarding/answers：体检问卷落库（首次流程，永不占配额——P§7）
// 答案进 portrait.questionnaire（画像素材）；Q6（最近一次为钱心慌）同时种一条 concern
//
// 校验口径（2026-09-17 · 首启重排 v2 · 设计决策 #4）：
// - 4 道 choice 题必选（不在 options 内的不收）
// - 至少 1 道 free-text 题非空（否则前端 canSubmit 拒；但服务端再守一次，
//   防止直接打 API 的绕过）
// 任一不满足 → 400 + { code: 'choice_required' | 'free_text_required', field }
// 老的 empty_answers 兜底（按题意是"答案全空"）保留为 alias。
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

    // 校验口径：4 道 choice 必选
    const missingChoice = QUESTIONS.find((q) => q.kind === 'choice' && !questionnaire[q.field]);
    if (missingChoice) {
      return jsonError('choice_required', 400, { field: missingChoice.id });
    }
    // 至少 1 道 free-text 非空
    const hasFreeText = QUESTIONS.some((q) => q.kind === 'free' && questionnaire[q.field]);
    if (!hasFreeText) {
      const freeQ = QUESTIONS.find((q) => q.kind === 'free');
      return jsonError('free_text_required', 400, { field: freeQ ? freeQ.id : '' });
    }

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
