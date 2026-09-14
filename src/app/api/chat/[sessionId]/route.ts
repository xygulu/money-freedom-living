// POST /api/chat/[sessionId]：向会话发消息，流式拿回复。
// kind=onboarding_talk（M3 体检初谈）与 kind=chat（M4 正式对话）共用此通道：
// - 共同入口安全层：所有用户文本先过两段式危机识别（P§8 全入口覆盖）
// - chat 独有：20 轮温和收尾、首条 AI 回复成功后落账（失败不扣，P§7）、
//   P§6 上下文组装（画像/pinned/memories）、危机命中转稳定陪伴模式
// DELETE：主动结束对话 → 摘要入 memories + 关会话（"今天先到这里"）。
import { NextRequest } from 'next/server';
import { resolveIdentity } from '@/lib/identity';
import {
  getSession,
  getSessionMessages,
  appendMessage,
  closeSession,
  markQuotaConsumed,
  markSafetyFlagged,
  TALK_MAX_USER_MESSAGES,
  CHAT_MAX_MESSAGES,
} from '@/lib/chat';
import { buildTalkSystem } from '@/lib/onboarding';
import { buildChatContext } from '@/lib/prompt';
import { settleSession } from '@/lib/memory';
import { checkSafety, recordSafetyEvent, referralMessage, type SafetyVerdict } from '@/lib/safety';
import { activeBookId, bumpActiveDay, getProfile } from '@/lib/profile';
import { consumeQuota, getQuotaStatus, clientIpFromHeaders, guestKeyForRequest, GUEST_ID_COOKIE } from '@/lib/quota';
import { timeZoneFrom, todayIn } from '@/lib/time';
import { getLlmProviders, llmStream } from '@/lib/llm';
import { getDict } from '@/i18n/get-dict';
import { enabledLocales, isLocale, type Locale } from '@/i18n/config';
import { jsonError, sseResponse } from '@/lib/sse';

export const dynamic = 'force-dynamic';

/** 正在生成回复的会话集合（进程内即可：MVP 单实例；全局 LLM 串行锁之外的快速拒绝层） */
const activeStreams = new Set<string>();
export const maxDuration = 60;

const MESSAGE_MAX = 2000;

export async function POST(request: NextRequest, ctx: { params: Promise<{ sessionId: string }> }) {
  let sessionId: string | undefined;
  try {
    ({ sessionId } = await ctx.params);
    const body = (await request.json().catch(() => ({}))) as { message?: string; silent?: boolean; opener?: boolean };
    const message = typeof body.message === 'string' ? body.message.trim().slice(0, MESSAGE_MAX) : '';
    // opener：会话第一条 AI 主动开场（归来问候），不带用户消息
    if (!message && !body.opener) return jsonError('empty_message', 400);

    const identity = await resolveIdentity(request);
    const session = await getSession(sessionId);
    if (!session || session.userKey !== identity.key) return jsonError('session_not_found', 404);
    if (session.status !== 'open') return jsonError('session_closed', 409);
    if (getLlmProviders().length === 0) return jsonError('llm_not_configured', 503);
    // 会话级互斥：同一会话同时只允许一个回复流（重开页面/连点会并发触发两个 LLM 流，
    // 配合全局串行锁防串写错序）。占坑必须与预检同步原子——若 DB 往返后才置位，存在
    // 竞态窗口，并发请求会双双钻过（实测）。释放责任在出口：非流式 return 走 releaseSlot；
    // 流式路径由生成器 finally 释放（respondToMessage / 收尾生成器内部）。
    if (activeStreams.has(sessionId)) return jsonError('reply_in_progress', 429);
    activeStreams.add(sessionId);
    const releaseSlot = () => activeStreams.delete(sessionId!); // 此处必已赋值
    // 非流式错误出口：先释放再返回（否则坑位泄漏，会话从此永远 409）
    const bail = (code: string, status: number): Response => {
      releaseSlot();
      return jsonError(code, status);
    };

    const sessionLocale: Locale = isLocale(session.locale) && enabledLocales.includes(session.locale) ? session.locale : 'en';
    const profile = await getProfile(identity.key);

    // ---- 初谈纪律（M3 语义原样保留 + 入口安全层）----
    if (session.kind === 'onboarding_talk') {
      if (!message) return bail('empty_message', 400);
      const userTurns = (await getSessionMessages(sessionId)).filter((m) => m.role === 'user').length;
      if (userTurns >= TALK_MAX_USER_MESSAGES) return bail('talk_limit_reached', 409);
      const questionnaire = profile?.portrait?.questionnaire;
      if (!questionnaire) return bail('questionnaire_required', 400);
      return respondToMessage({
        request,
        identity,
        sessionId,
        locale: sessionLocale,
        message,
        silent: body.silent === true,
        system: buildTalkSystem(sessionLocale, questionnaire, timeZoneFrom(request.cookies)),
        stableMode: false, // 初谈轮数极短，命中后的转介轮已足够；画像生成有独立红线
      });
    }

    // ---- 正式对话（kind=chat）----
    const isOpener = body.opener === true;
    if (isOpener && session.messageCount > 0) return bail('empty_message', 400); // opener 只属于空会话

    if (session.messageCount >= CHAT_MAX_MESSAGES) {
      // 20 轮到限：不再生成，温和收尾并结算（P§7"今天先到这里，明天它还在"）
      const dict = getDict(sessionLocale);
      return sseResponse(
        (async function* () {
          try {
            yield { session: sessionId, wrap: true, delta: dict.chat.wrapUp };
            await settleSession(identity.key, sessionLocale, sessionId, timeZoneFrom(request.cookies));
          } finally {
            releaseSlot();
          }
        })()
      );
    }

    const context = buildChatContext({
      locale: sessionLocale,
      stage: profile?.stage ?? 1,
      portrait: profile?.portrait ?? null,
      concerns: profile?.concerns ?? [],
      pinned: profile?.pinned ?? [],
      memories: profile?.memories ?? [],
      history: await getSessionMessages(sessionId),
      stableMode: session.safetyFlagged,
      opener: isOpener,
      tz: timeZoneFrom(request.cookies),
      bookId: profile ? activeBookId(profile) : undefined,
      threads: profile?.threads,
    });

    return respondToMessage({
      request,
      identity,
      sessionId,
      locale: sessionLocale,
      message,
      silent: body.silent === true,
      opener: isOpener,
      system: context.system,
      history: context.messages,
      consumeAfterReply: !session.quotaConsumed,
      bumpActive: true,
      stableMode: session.safetyFlagged,
    });
  } catch (error) {
    console.error('[api/chat/sessionId] failed:', error);
    if (sessionId) activeStreams.delete(sessionId);
    return jsonError('server_error', 500);
  }
}

// ---- 共用回复管线：安全检查 → 入库 → LLM 流式 → 落账/足迹 ----

interface ReplyParams {
  request: NextRequest;
  identity: { key: string; userId: string | null; newGuestCookie: string | null };
  sessionId: string;
  locale: Locale;
  message: string;
  silent: boolean;
  /** AI 主动开场：不落用户消息、跳过安全筛查（无用户文本） */
  opener?: boolean;
  /** chat 会话的预组装上下文（缺省 = 初谈，已同步传入） */
  system?: string;
  history?: { role: 'user' | 'assistant'; content: string }[];
  /** chat 会话首条回复成功后落账（P§7 失败不扣）；初谈/转介轮不落账 */
  consumeAfterReply?: boolean;
  bumpActive?: boolean;
  stableMode: boolean;
}

async function respondToMessage(params: ReplyParams): Promise<Response> {
  const { request, identity, sessionId, locale, message, silent, opener } = params;

  // 坑位已由调用方（POST）原子占下；这里只负责各出口的释放：
  // silent 直返 / 同步阶段失败（catch）/ 转介流结束 / LLM 流结束（含中途断开）
  try {
    // 入口安全层：两段式识别（LLM 确认失败 = fail-safe 命中，宁可误报）。
    // silent 消息（「我听到的是」确认补充）同样筛查：命中只落事件，不打断确认流。
    let safety: SafetyVerdict = { hit: false, category: null, confirmed: false };
    if (message) safety = await checkSafety(locale, message);
    if (safety.hit) {
      await markSafetyFlagged(sessionId);
      await recordSafetyEvent(identity.key, 'chat', safety.category ?? 'crisis');
    }

    if (message) await appendMessage(sessionId, 'user', message);
    if (silent) {
      activeStreams.delete(sessionId);
      return new Response(null, {
        status: 204,
        headers: { 'Cache-Control': 'no-store', ...(identity.newGuestCookie ? { 'Set-Cookie': identity.newGuestCookie } : {}) },
      });
    }

    // 危机命中：该轮回复 = 转介消息（服务端定死文案，不走 LLM），不消耗配额（危机陪伴永远免费）
    if (safety.hit) {
      const referral = referralMessage(locale, safety.category ?? 'crisis');
      await appendMessage(sessionId, 'assistant', referral);
      return sseResponse(
        (async function* () {
          try {
            yield { session: sessionId, safety: safety.category ?? 'crisis' };
            yield { delta: referral };
          } finally {
            activeStreams.delete(sessionId);
          }
        })()
      );
    }
  } catch (error) {
    // 流开始前的同步阶段失败（安全筛查/入库）：释放流锁后上抛（POST 兜底转 500）
    activeStreams.delete(sessionId);
    throw error;
  }

  // 传入的 history 是用户消息入库前组装的（chat 分支预算裁剪），必须补上当前这条；
  // opener 无用户消息，history 原样用。未传（初谈）则重取库，天然含新消息。
  const history = params.history
    ? message
      ? [...params.history, { role: 'user' as const, content: message }]
      : params.history
    : await getSessionMessages(sessionId);
  const system = params.system ?? '';

  async function* events() {
    // 流锁释放点全在生成器 finally：正常结束 / 中途出错 / 客户端断开（return() 也会触发）
    try {
      yield { session: sessionId };
      let full = '';
      // Anthropic API 要求至少一条 message：opener（空历史）时给一条占位用户消息
      // 占位文案按会话语言给（硬编码中文会让非中文会话的开场被带偏语言，实测 ja 踩过）
      const openerPlaceholder: Record<Locale, string> = {
        en: '(the conversation is starting — greet first)',
        'zh-CN': '（对话开始——先打个招呼）',
        'zh-TW': '（對話開始——先打個招呼）',
        ja: '（会話の始まり——まず挨拶を）',
      };
      const llmMessages =
        history.length > 0 ? history : [{ role: 'user' as const, content: openerPlaceholder[locale] ?? '（对话开始）' }];
      for await (const delta of llmStream({ system, messages: llmMessages, maxTokens: 700 })) {
        full += delta;
        yield { delta };
      }
      if (!full.trim()) return; // 失败/空流：不落账、不置位，会话可重试（失败不扣）
      await appendMessage(sessionId, 'assistant', full.trim());
      if (params.bumpActive) {
        try {
          await bumpActiveDay(identity.key);
        } catch (error) {
          console.error('[api/chat/sessionId] bumpActiveDay failed:', error);
        }
      }
      // 首条 AI 回复成功 → 落账（P§7：先 consume 成功才置位）。
      // VIP 无限额度：不占配额，仅置位避免后续每轮重复预检。
      if (params.consumeAfterReply) {
        try {
          // 日界线按用户所在时区：额度在用户的午夜刷新，不是服务器的
          const today = todayIn(timeZoneFrom(request.cookies));
          const guest = guestKeyForRequest(
            request.cookies.get(GUEST_ID_COOKIE)?.value,
            clientIpFromHeaders(request.headers),
            today
          );
          const status = await getQuotaStatus({ userId: identity.userId, guestKey: guest.guestKey, day: today });
          if (status.isVip) {
            await markQuotaConsumed(sessionId);
          } else {
            const result = await consumeQuota({ userId: identity.userId, guestKey: guest.guestKey, kind: 'chat_session', day: today });
            if (result.ok) await markQuotaConsumed(sessionId);
            else console.error('[api/chat/sessionId] consume rejected after reply:', JSON.stringify(result.status));
          }
        } catch (error) {
          console.error('[api/chat/sessionId] consume failed:', error);
        }
      }
      void opener;
    } finally {
      activeStreams.delete(sessionId);
    }
  }

  const response = sseResponse(events());
  if (identity.newGuestCookie) response.headers.set('Set-Cookie', identity.newGuestCookie);
  return response;
}

export async function DELETE(request: NextRequest, ctx: { params: Promise<{ sessionId: string }> }) {
  try {
    const { sessionId } = await ctx.params;
    const identity = await resolveIdentity(request);
    const session = await getSession(sessionId);
    if (!session || session.userKey !== identity.key) return jsonError('session_not_found', 404);
    if (session.kind === 'chat') {
      const locale: Locale = isLocale(session.locale) && enabledLocales.includes(session.locale) ? session.locale : 'en';
      await settleSession(identity.key, locale, sessionId, timeZoneFrom(request.cookies));
    } else {
      await closeSession(sessionId);
    }
    return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[api/chat/sessionId] delete failed:', error);
    return jsonError('server_error', 500);
  }
}
