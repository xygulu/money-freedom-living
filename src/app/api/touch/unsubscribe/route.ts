// /api/touch/unsubscribe?token=…&locale=…：退订（M11-E，docs/05 §9.5）。
//
// 两个动词，两条路，这是有意分开的：
//   GET  —— 只把人送到确认页，**什么都不改**。
//   POST —— 真的退订。
//
// 为什么不能像原来那样 GET 一打开就退：邮件客户端和企业邮关会替用户**预取**信里的
// 每一条链接来做安全扫描。一个人根本没点，信就已经退掉了，而且他不会知道——直到某天
// 发现「怎么再也没收到过」。退订必须是用户按下去的，不能是扫描器替他按的。
// 这是 HTTP 的老规矩：GET 不该有副作用。之前那版图省事，赌的是用户的知情权。
//
// 确认页只多一次点击，换回来的是「只有人能退订」。而对真正要求"一下就成"的场景，
// RFC 8058 已经给了正解：信头挂 List-Unsubscribe + List-Unsubscribe-Post，收件方
// （Gmail/Yahoo）在界面上给一个退订按钮，替用户 POST 过来——那条路照样是一键，
// 而且打的是这里的 POST。
//
// 只关 emailOptIn，**不清 unsubToken**：清了，已经发出去那几封信的退订链接会跟着失效。
import { NextRequest, NextResponse } from 'next/server';
import { findUserKeyByUnsubToken, saveTouch } from '@/lib/profile';
import { recordConsent, hashIp } from '@/lib/consent';
import { clientIpFromHeaders } from '@/lib/quota';
import { track } from '@/lib/analytics';
import { defaultLocale, enabledLocales, isLocale } from '@/i18n/config';

export const dynamic = 'force-dynamic';

function localeOf(url: URL): string {
  const raw = url.searchParams.get('locale');
  return isLocale(raw) && enabledLocales.includes(raw) ? raw : defaultLocale;
}

/** GET 只带路：把 token 原样交给确认页，一个字段都不动 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const locale = localeOf(url);
  const token = url.searchParams.get('token') ?? '';
  const to = new URL(`/${locale}/unsubscribe`, url.origin);
  if (token) to.searchParams.set('token', token);
  else to.searchParams.set('ok', '0'); // 没 token 就没什么可确认的，直接给失效那版
  return NextResponse.redirect(to);
}

export async function POST(request: NextRequest) {
  const url = new URL(request.url);
  const locale = localeOf(url);
  // token 优先看表单（确认页提交的那份），没有再退回查询串（收件方的一键退订）
  const raw = await request.text().catch(() => '');
  const form = new URLSearchParams(raw);
  const token = form.get('token') ?? url.searchParams.get('token') ?? '';
  // RFC 8058 规定收件方 POST 的正文就是这一串。是它=机器替人按的，回 JSON 就行；
  // 不是它=我们自己确认页上的表单，得把人送回落地页看见一句「已经退订了」。
  const oneClick = form.get('List-Unsubscribe') === 'One-Click';

  const done = (ok: string) =>
    oneClick
      ? NextResponse.json({ ok: ok === '1' }, { status: ok === '1' ? 200 : 400 })
      : NextResponse.redirect(new URL(`/${locale}/unsubscribe?ok=${ok}`, url.origin), 303);

  try {
    const userKey = await findUserKeyByUnsubToken(token);
    if (!userKey) return done('0');

    await saveTouch(userKey, { emailOptIn: false });
    await recordConsent(userKey, false, hashIp(clientIpFromHeaders(request.headers)), 'touch');
    await track(userKey, 'touch_opt_out', { source: oneClick ? 'one_click' : 'email' }, locale);
    return done('1');
  } catch (error) {
    console.error('[touch/unsubscribe]', error instanceof Error ? error.message : error);
    return done('0');
  }
}
