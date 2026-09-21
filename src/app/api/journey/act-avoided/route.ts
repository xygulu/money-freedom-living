// POST /api/journey/act-avoided —— 「他绕开的」变成记录（V0.2 尾批 O8，docs/02 §19.2）。
//
// 跳过 / 换一个这两下在 ActCard 里本来零落痕——回看时那天的绕开无从呈现。
// 本路由只收一个枚举（kind ∈ skip | swap），走既有 events 通道记一笔
// `act_avoided {kind}`：不加表、不加列、不加问题、**不收任何文本**（P§9）。
// 第③问未答零新增——close 时的 `day_close_saved {thought:false}` 已覆盖，
// 回看侧（/timeline）从这两类事件拼出那天的「绕开」事实，事实表述不是评估。
import { NextRequest } from 'next/server';
import { requireApiUser } from '@/lib/api-auth';
import { track } from '@/lib/analytics';
import { enabledLocales, isLocale } from '@/i18n/config';
import { jsonError } from '@/lib/sse';

export const dynamic = 'force-dynamic';

const KINDS = new Set(['skip', 'swap']);

export async function POST(request: NextRequest) {
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  const body = (await request.json().catch(() => ({}))) as { kind?: string; locale?: string };
  if (body.kind !== 'skip' && body.kind !== 'swap') return jsonError('bad_kind', 400);
  const locale = typeof body.locale === 'string' && isLocale(body.locale) && enabledLocales.includes(body.locale) ? body.locale : undefined;

  // best-effort：track 内部吞错，绝不阻塞前端
  await track(auth.identity.key, 'act_avoided', { kind: body.kind }, locale);
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
}
