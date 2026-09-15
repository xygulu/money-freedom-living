// API 闸：访客访问需登录端点 → 401 `unauthorized`（防绕过页面的 UX redirect）。
//
// 用户 2026-09-14 拍板："未登录的用户只能做金钱关系测试"——
// /api/onboarding/* 仍对访客开放（测试本身）；其他 API 加 401。
//
// 调用模式：
//   export async function POST(request: Request) {
//     const auth = await requireApiUser();
//     if (!auth.ok) return auth.response;
//     // 用 auth.identity 替代原来的 resolveIdentity
//   }

import { headers, cookies } from 'next/headers';
import { resolveIdentity, type RequestIdentity } from '@/lib/identity';

export type ApiAuthResult =
  | { ok: true; identity: RequestIdentity }
  | { ok: false; response: Response };

export async function requireApiUser(): Promise<ApiAuthResult> {
  const identity = await resolveIdentity({
    headers: await headers(),
    cookies: await cookies(),
  });
  if (!identity.userId) {
    return {
      ok: false,
      response: Response.json(
        { error: 'unauthorized', reason: 'signed_in_required' },
        { status: 401 },
      ),
    };
  }
  return { ok: true, identity };
}