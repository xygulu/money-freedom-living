'use client';

// 登出入口（70-2 加固）：设置里补账号登出。
//
// 用户 2026-09-14 拍板"二次确认"——点"登出"先切到「真的要登出？」确认态，
// 再点才真发请求；中途可取消。这比单次点击更符合"这是一个不可逆动作"的预期，
// 也比浏览器 confirm() 友好（不打断、不打断屏幕阅读）。
//
// 落点：① /me 顶部（MeAccount 标题上方）② /archive 第三段「设置与账号」下。
// 落点都用同一份 i18n 文案（me.signOut / me.signOutConfirm），共用 busy / err 状态。
//
// Better Auth 的 sign-out：先用 authClient.signOut()；失败兜底 fetch('/api/auth/sign-out')。
// 成功后跳回 /{locale} 落地页——会话清空后受保护页会跳回登录。
import { useState } from 'react';
import { authClient } from '@/lib/auth-client';

export interface SignOutButtonLabels {
  /** 按钮初始文案（zh-CN: "登出"） */
  btn: string;
  /** 二次确认文案（zh-CN: "真的要登出？"） */
  confirm: string;
  /** 取消按钮文案（沿用 me.deleteCancel = "先留着"） */
  cancel: string;
}

interface Props {
  locale: string;
  labels: SignOutButtonLabels;
  className?: string;
}

export default function SignOutButton({ locale, labels, className }: Props) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function handleSignOut() {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      await authClient.signOut();
      window.location.href = `/${locale}`;
      return;
    } catch {
      // Better Auth 客户端失败时直接走原生端点兜底（Better Auth 已暴露 POST /api/auth/sign-out）
      try {
        await fetch('/api/auth/sign-out', { method: 'POST', credentials: 'include' });
        window.location.href = `/${locale}`;
        return;
      } catch {
        setErr('failed');
        setBusy(false);
      }
    }
  }

  if (!confirming) {
    return (
      <div className={className} data-sign-out>
        <button
          type="button"
          onClick={() => setConfirming(true)}
          disabled={busy}
          data-sign-out-btn
          className="text-sm text-ink-soft underline underline-offset-4 hover:text-ink disabled:opacity-40"
        >
          {labels.btn}
        </button>
        {err && <p className="mt-2 text-xs text-red-700" data-sign-out-err>{err}</p>}
      </div>
    );
  }

  return (
    <div className={className} data-sign-out data-sign-out-confirming>
      <p className="text-sm text-ink-soft">{labels.confirm}</p>
      <div className="mt-3 flex gap-3">
        <button
          type="button"
          onClick={handleSignOut}
          disabled={busy}
          data-sign-out-confirm-btn
          className="border border-ink px-4 py-1.5 text-sm transition-colors hover:bg-ink hover:text-paper disabled:opacity-40"
        >
          {labels.btn}
        </button>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          disabled={busy}
          data-sign-out-cancel-btn
          className="text-sm text-ink-soft underline underline-offset-4 disabled:opacity-40"
        >
          {labels.cancel}
        </button>
      </div>
      {err && <p className="mt-2 text-xs text-red-700" data-sign-out-err>{err}</p>}
    </div>
  );
}
