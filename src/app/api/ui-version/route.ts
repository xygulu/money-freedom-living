// POST /api/ui-version —— 设 ui_version cookie。
//
// 入参：{ version: 'new' | 'classic' }
// 出参：204 No Content + Set-Cookie
//
// 不打点：cookie 设置是表现层偏好，跟产品数据正交。要做事后统计
// 在 client 端 readUiVersionClient() 后比对上一次值，记到
// ui_version_view_events（迁移脚本建）——本批只暴露切换入口，埋点放后续。
import { NextResponse } from 'next/server';
import { buildUiVersionCookie, isUiVersion } from '@/lib/ui-version';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const version =
    typeof body === 'object' && body !== null && 'version' in body
      ? (body as Record<string, unknown>).version
      : null;
  if (!isUiVersion(version)) {
    return NextResponse.json({ error: 'invalid_version' }, { status: 400 });
  }
  const res = new NextResponse(null, { status: 204 });
  res.headers.set('Set-Cookie', buildUiVersionCookie(version));
  return res;
}
