// POST /api/touch/consent：触达（邮件）同意的开关。
//
// 为什么单开一个路由，不塞进画像那条（docs/05 §9.3）：触达同意与敏感信息同意是
// **两件事**，打包勾选在 GDPR 下不成立。这里记的是 kind='touch' 的同意链，
// 与 kind='sensitive' 各走各的，`latestConsent` 按 kind 过滤，互不污染。
//
// 打开时生成 unsubToken（每封信的退订凭据）；关闭时**不清 token**——
// 清了就等于把已经发出去那几封信的退订链接一起作废了。
import { NextRequest, NextResponse } from 'next/server';
import * as crypto from 'crypto';
import { resolveIdentity } from '@/lib/identity';
import { getProfile, saveTouch } from '@/lib/profile';
import { recordConsent, hashIp } from '@/lib/consent';
import { clientIpFromHeaders } from '@/lib/quota';
import { track } from '@/lib/analytics';
import { jsonError } from '@/lib/sse';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as { optIn?: boolean };
    if (typeof body.optIn !== 'boolean') return jsonError('invalid_opt_in', 400);

    const identity = await resolveIdentity(request);
    const profile = await getProfile(identity.key);
    if (!profile) return jsonError('profile_required', 400);

    const token = profile.touch?.unsubToken ?? crypto.randomBytes(24).toString('base64url');
    await saveTouch(identity.key, body.optIn
      ? { emailOptIn: true, optInAt: new Date().toISOString(), unsubToken: token }
      : { emailOptIn: false });

    await recordConsent(identity.key, body.optIn, hashIp(clientIpFromHeaders(request.headers)), 'touch');
    await track(identity.key, body.optIn ? 'touch_opt_in' : 'touch_opt_out', { source: 'settings' });

    return NextResponse.json({ ok: true, optIn: body.optIn }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[touch/consent]', error instanceof Error ? error.message : error);
    return jsonError('touch_consent_failed', 500);
  }
}
