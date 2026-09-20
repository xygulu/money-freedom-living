// /api/chat/[sessionId] 闸门（M3 初谈 / M4 正式对话 / 陪伴者弹层 共用，按 kind 分流）。
//
// 用户 2026-09-15 bugfix：上一批把 /api/chat/* 整体加 401，误伤 onboarding_talk
// （金钱关系测试的对话），访客进入 /onboarding 后第一条消息发不出去。
//
// 修复：闸门按 session.kind 分流——
// - kind='onboarding_talk'（M3 体检初谈）：访客可走完（用户原话"访客 = 只能做金钱关系测试"）
// - kind='chat'（M4 正式对话）：必须登录（401）
// - kind='companion'（2026-09-18 陪伴者弹层）：必须登录——球挂在 /journey-new（访客已
//   被 layout 闸 302），且弹层对话接 memories/画像上下文，访客无档可接
//
// 默认收紧（2026-09-18）：只有显式列入 ALLOW_GUEST 的 kind 才放行访客；未来新增
// kind 忘了写鉴权时默认必须登录，不再默认放行。
//
// 单独抽出这个函数（不用 route 内部 if）的原因：route handler 在 vitest 下要
// 起 NextRequest runtime + DB + LLM stub，不适合单测。把判定变成纯函数，
// 单测覆盖 kind × 身份组合就行；route 端只是把 gate 串到 response 上。
import type { ChatSession, SessionKind } from '@/lib/chat';
import type { RequestIdentity } from '@/lib/identity';

export type SessionGateResult =
  | { ok: true }
  | { ok: false; response: Response };

/** 访客可用的 kind 白名单：目前只有体检初谈（金钱关系测试走完的前提） */
const ALLOW_GUEST: ReadonlySet<SessionKind> = new Set<SessionKind>(['onboarding_talk']);

export function gateSessionChat({
  session,
  identity,
}: {
  session: ChatSession;
  identity: Pick<RequestIdentity, 'userId'>;
}): SessionGateResult {
  if (!identity.userId && !ALLOW_GUEST.has(session.kind)) {
    return {
      ok: false,
      response: Response.json(
        { error: 'unauthorized', reason: 'signed_in_required' },
        { status: 401 },
      ),
    };
  }
  return { ok: true };
}
