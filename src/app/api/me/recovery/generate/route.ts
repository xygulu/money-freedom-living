// POST /api/me/recovery/generate：登录用户生成/重置恢复码。
// 12 位去易混字符，只存 sha256(pepper+code)（growth_profiles.recovery_code_hash）；
// 明码仅在本次响应返回一次，用户自行离线保存。重新生成 = 旧码作废。
import { NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { ensureProfile } from '@/lib/profile';
import { generateRecoveryCode, hashRecoveryCode, saveRecoveryCode, formatCode } from '@/lib/recovery';
import { jsonError } from '@/lib/sse';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    const user = session?.user as { id: string } | undefined;
    if (!user) return jsonError('NOT_AUTHENTICATED', 401);

    // 游客期没做过任何动作的账号可能还没有档案行
    const identity = { key: `u:${user.id}` };
    await ensureProfile(identity.key, 'en');

    const code = generateRecoveryCode();
    await saveRecoveryCode(identity.key, hashRecoveryCode(code));

    return new Response(JSON.stringify({ code: formatCode(code) }), {
      headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('[api/me/recovery/generate] failed:', error);
    return jsonError('server_error', 500);
  }
}
