// POST /api/touch/preview：把一封触达信寄到**指定地址**，用来验通道与排版（M11-E）。
//
// 为什么要有这个端点：`/api/touch/dispatch` 发给的是真实用户，验证模板不能拿他们试。
// 这里用一份**合成档案**组信，一行真实数据都不读、不写——数据库在这个文件里完全没出现。
// 模板是四语 dict、组信是 TS 纯函数，所以和 dispatch 同理：逻辑在路由，脚本只是薄壳。
//
// 三条安全边界：
// 1. 同一把 `TOUCH_CRON_SECRET` 守门（没配 503 / 不符 403），不开无认证的发信口。
// 2. 收件人必须在 body 里显式写明，且过 `isDeliverableEmail`——不接受保留域名。
// 3. 信里的退订 token 是假的（`preview-...`），点了只会跳 `ok=0`：预览信**退不掉任何
//    真人**。这是有意的——一封样信不该有动真实档案的能力。
import { NextRequest, NextResponse } from 'next/server';
import { composeTouch, touchConfigured, isDeliverableEmail, TOUCH_NODES, type TouchNode } from '@/lib/touch';
import { sendResendEmail } from '@/lib/email-resend';
import type { GrowthProfile } from '@/lib/profile';
import { getDict } from '@/i18n/get-dict';
import { defaultLocale, enabledLocales, isLocale } from '@/i18n/config';
import { jsonError } from '@/lib/sse';

export const dynamic = 'force-dynamic';

/** 合成档案：只填 composeTouch 会读到的那几个字段，其余给最小值 */
function syntheticProfile(locale: string, echo: string | null): GrowthProfile {
  const now = new Date().toISOString();
  return {
    user_key: 'preview',
    locale,
    portrait: null,
    concerns: [],
    stage: 1,
    stage_started_at: now,
    pinned: [],
    memories: [],
    experiments: [],
    // 有 echo 就走「引用你写过的那句」那版，没有就走 bodyNoEcho —— 两版都要能预览
    letters: echo ? [{ stage: 1, content: echo, state: 'kept', aiReply: null, createdAt: now }] : [],
    stamps: [],
    evolution: {},
    assessment: {
      pending: null, confirmed: null, confirmedAt: null, dismissedAt: null,
      generatingAt: null, proposedSeenAt: null, previousConfirmed: null,
      changeList: null, changeListLockAt: null,
    },
    created_at: now,
    dailySeen: [],
    payday: null,
    total_active_days: 1,
    last_active_date: null,
    books: [],
    threads: {},
    touch: { emailOptIn: true, unsubToken: 'preview-not-a-real-token' },
  } as unknown as GrowthProfile;
}

export async function POST(request: NextRequest) {
  const secret = process.env.TOUCH_CRON_SECRET;
  if (!secret) return jsonError('touch_cron_not_configured', 503);
  if (request.headers.get('x-touch-secret') !== secret) return jsonError('forbidden', 403);

  const body = (await request.json().catch(() => ({}))) as {
    node?: string; locale?: string; to?: string; send?: boolean; echo?: string;
  };

  const node = (TOUCH_NODES as readonly number[]).includes(Number(String(body.node ?? '').slice(1)))
    ? (body.node as TouchNode)
    : null;
  if (!node) return jsonError('bad_node', 400);

  const locale = isLocale(body.locale) && enabledLocales.includes(body.locale) ? body.locale : defaultLocale;
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? new URL(request.url).origin;
  const echo = (body.echo ?? '').trim() || null;

  const letter = composeTouch({ node, profile: syntheticProfile(locale, echo), dict: getDict(locale), locale, baseUrl });
  if (!letter) return jsonError('no_template', 400);

  // 不发就只回信的内容——排版、禁语、链接都能在命令行里先看一遍
  if (body.send !== true) {
    return NextResponse.json({ ok: true, sent: false, node, locale, letter }, { headers: { 'Cache-Control': 'no-store' } });
  }

  const to = (body.to ?? '').trim();
  if (!to || !isDeliverableEmail(to)) return jsonError('bad_recipient', 400);
  if (!touchConfigured()) return jsonError('resend_not_configured', 503);

  try {
    const { id } = await sendResendEmail({ to, subject: letter.subject, text: letter.text, html: letter.html });
    return NextResponse.json(
      { ok: true, sent: true, node, locale, id },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    console.error('[touch/preview] send failed', node, error instanceof Error ? error.message : error);
    return jsonError('send_failed', 502);
  }
}
