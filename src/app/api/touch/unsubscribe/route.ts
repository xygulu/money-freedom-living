// GET /api/touch/unsubscribe?token=…&locale=…：一键退订（M11-E，docs/05 §9.5）。
//
// 走 GET 是因为这条链接要在邮件客户端里被点开——退订必须是一下就成，不能要求先登录、
// 先确认、先找到设置项。宁可被邮件客户端预取误退订（用户可在「我的」里重新打开），
// 也不要出现一封退不掉的信。
//
// 只关 emailOptIn，**不清 unsubToken**：清了，已经发出去那几封信的退订链接会跟着失效。
import { NextRequest, NextResponse } from 'next/server';
import { findUserKeyByUnsubToken, saveTouch } from '@/lib/profile';
import { recordConsent, hashIp } from '@/lib/consent';
import { clientIpFromHeaders } from '@/lib/quota';
import { track } from '@/lib/analytics';
import { defaultLocale, enabledLocales, isLocale } from '@/i18n/config';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const token = url.searchParams.get('token') ?? '';
  const raw = url.searchParams.get('locale');
  const locale = isLocale(raw) && enabledLocales.includes(raw) ? raw : defaultLocale;
  const landing = (ok: string) => NextResponse.redirect(new URL(`/${locale}/unsubscribe?ok=${ok}`, url.origin));

  try {
    const userKey = await findUserKeyByUnsubToken(token);
    if (!userKey) return landing('0');

    await saveTouch(userKey, { emailOptIn: false });
    await recordConsent(userKey, false, hashIp(clientIpFromHeaders(request.headers)), 'touch');
    await track(userKey, 'touch_opt_out', { source: 'email' }, locale);
    return landing('1');
  } catch (error) {
    console.error('[touch/unsubscribe]', error instanceof Error ? error.message : error);
    return landing('0');
  }
}
