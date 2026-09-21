// 管理后台闸（V0.2 批 C0，docs/02 §14/§20.3）：后台是运营工具，不进 i18n、不套产品壳。
//
// 管理员 = ADMIN_EMAILS 环境变量白名单（逗号分隔，比较前 trim + 小写归一）。
// 为什么是环境变量而不是库里的 role 列：单人运营（V0.2 拍板形态），加列迁移与
// 授权管理页都是给「多运营者」预留的复杂度——现在没有这个问题；将来真要多人，
// 再迁 role 列（届时白名单作为兜底保留亦可）。
// 未配置 ADMIN_EMAILS = 后台整体关闭（谁都不是管理员）：**显式关闭优于默认开放**。
//
// 调用模式（API）：
//   const gate = await requireApiAdmin();
//   if (!gate.ok) return gate.response;
//
// 页面（admin/layout.tsx）：currentAdmin() → null 时 notFound()（不暴露后台存在）。
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';

/** 解析白名单：逗号分隔 → trim → 小写 → 去空段。未配置/空串 → []（后台关闭）。 */
export function parseAdminEmails(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return parseAdminEmails(process.env.ADMIN_EMAILS).includes(email.trim().toLowerCase());
}

/** 当前请求是不是管理员（页面闸用）。未登录或不在白名单 → null。 */
export async function currentAdmin(): Promise<{ email: string } | null> {
  const session = await auth.api.getSession({ headers: await headers() });
  const email = (session?.user as { email?: string } | undefined)?.email ?? null;
  if (!email || !isAdminEmail(email)) return null;
  return { email };
}

export type AdminAuthResult = { ok: true; email: string } | { ok: false; response: Response };

/** API 闸：游客 401（signed_in_required）；登录但不在白名单 403（not_admin）。 */
export async function requireApiAdmin(): Promise<AdminAuthResult> {
  const session = await auth.api.getSession({ headers: await headers() });
  const email = (session?.user as { email?: string } | undefined)?.email ?? null;
  if (!email) {
    return {
      ok: false,
      response: Response.json({ error: 'unauthorized', reason: 'signed_in_required' }, { status: 401 }),
    };
  }
  if (!isAdminEmail(email)) {
    return {
      ok: false,
      response: Response.json({ error: 'forbidden', reason: 'not_admin' }, { status: 403 }),
    };
  }
  return { ok: true, email };
}
