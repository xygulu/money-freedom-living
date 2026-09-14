// POST /api/onboarding/reflect：两次复述，一个出口。
// - mode='echo'（P0-3 首启重排后的**第一句「我听到的是…」**）：素材只有他刚在对话里
//   说的那句话——首屏不出现问卷，所以这一句必须在**前 3 分钟内**、用他自己的词说回去。
// - mode='reflect' + sessionId：初谈结束前的 3-5 句复述（画像生成前的素材校验）。
// - mode='reflect' 无 sessionId（M11-C 旧路径）：问卷一交完就说回给他（保留兼容）。
// 复述本身不入库——画像素材 = 问卷 + 会话记录 + 用户补充。
import { NextRequest } from 'next/server';
import { resolveIdentity } from '@/lib/identity';
import { getProfile } from '@/lib/profile';
import { getSession, getSessionMessages } from '@/lib/chat';
import { buildEchoMessages, buildReflectMessages } from '@/lib/onboarding';
import { llmComplete } from '@/lib/llm';
import { track } from '@/lib/analytics';
import { getSql } from '@/lib/db';
import { enabledLocales, isLocale } from '@/i18n/config';
import { jsonError } from '@/lib/sse';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** 首次"说中了"耗时的上限（超过就不是"这一次"了，当脏数据丢掉）：2 小时 */
const ELAPSED_MAX_S = 7200;

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      sessionId?: string;
      locale?: string;
      elapsedMs?: number;
      mode?: string;
    };
    const sessionId = body.sessionId;
    const locale = body.locale;
    const mode = body.mode === 'echo' ? 'echo' : 'reflect';
    if (!isLocale(locale) || !enabledLocales.includes(locale)) return jsonError('invalid_locale', 400);

    const identity = await resolveIdentity(request);
    const headers: Record<string, string> = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' };
    if (identity.newGuestCookie) headers['Set-Cookie'] = identity.newGuestCookie;

    let prompt: ReturnType<typeof buildEchoMessages>;
    let source: 'survey' | 'talk';

    if (sessionId) {
      const session = await getSession(sessionId);
      if (!session || session.userKey !== identity.key) return jsonError('session_not_found', 404);
      const history = await getSessionMessages(sessionId);
      if (history.length === 0) return jsonError('empty_session', 400);
      const chatText = history.map((m) => `${m.role === 'user' ? '用户' : '你'}：${m.content}`).join('\n\n');
      prompt = mode === 'echo' ? buildEchoMessages(locale, {}, chatText) : buildReflectMessages(locale, chatText);
      source = 'talk';
    } else {
      // 问卷版（旧路径）：素材就是他刚写下的那几行（answers 路由已落进 portrait.questionnaire）
      const profile = await getProfile(identity.key);
      const questionnaire = (profile?.portrait?.questionnaire ?? {}) as Record<string, string>;
      // 什么都没说过就不能编（P0-3 后首启是先说话；没说话 = 没有素材）
      if (Object.keys(questionnaire).length === 0) return jsonError('empty_answers', 400);
      prompt = buildEchoMessages(locale, questionnaire);
      source = 'survey';
    }

    const summary = (await llmComplete({ system: prompt.system, messages: prompt.messages, maxTokens: 600 })).trim();

    // 首次"说中了"耗时（docs/05 §7 指标：< 3 分钟）。只记第一次，只记秒数——
    // 复述原文属敏感内容，一个字都不进埋点
    const prior = await getSql()`
      SELECT count(*)::int AS n FROM events WHERE user_key = ${identity.key} AND name = 'first_echo_shown'`;
    if (prior[0].n === 0) {
      const seconds = Math.round(Math.max(0, Math.min(Number(body.elapsedMs) || 0, ELAPSED_MAX_S * 1000)) / 1000);
      await track(identity.key, 'first_echo_shown', { source, seconds, under3min: seconds > 0 && seconds < 180 }, locale);
    }

    return new Response(JSON.stringify({ summary, source }), { headers });
  } catch (error) {
    console.error('[api/onboarding/reflect] failed:', error);
    return jsonError('server_error', 500);
  }
}
