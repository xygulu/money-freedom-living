'use client';

// 新密码设置表单（邮件链接落地页用）：token 来自 better-auth 302 回跳的 ?token=。
// POST /api/auth/reset-password {newPassword, token}；成功后引导去登录页（本页不建会话）。
// token 缺失/无效时只给「重新发一封」的引导，不暴露具体原因。
import { useState } from 'react';
import Link from 'next/link';
import type { Dict } from '@/i18n/get-dict';

export default function ResetPasswordForm({
  locale,
  t,
  token,
}: {
  locale: string;
  t: Dict['login'];
  token: string;
}) {
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const inputClass =
    'mt-2 w-full border border-line bg-white/60 p-3 text-sm outline-none focus:border-ink';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (newPassword !== confirm) {
      setError(t.resetMismatch);
      return;
    }
    if (newPassword.length < 6) {
      setError(t.resetTooShort);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newPassword, token }),
      });
      if (response.ok) {
        setDone(true);
      } else {
        // 400 = token 无效/过期（长度已在前端拦）；统一引去重新发信
        setError(t.resetInvalid);
      }
    } catch {
      setError(t.resetInvalid);
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="flex flex-col gap-4 text-sm leading-relaxed">
        <p data-reset-success>{t.resetSuccess}</p>
        <Link
          href={`/${locale}/login`}
          className="self-start border border-ink px-5 py-2.5 transition-colors hover:bg-ink hover:text-paper"
        >
          {t.signIn}
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col">
      <label className="text-sm text-ink-soft" htmlFor="reset-password-new">
        {t.resetNewPassword}
      </label>
      <input
        id="reset-password-new"
        type="password"
        value={newPassword}
        onChange={(e) => setNewPassword(e.target.value)}
        required
        minLength={6}
        autoComplete="new-password"
        className={inputClass}
      />

      <label className="mt-4 text-sm text-ink-soft" htmlFor="reset-password-confirm">
        {t.resetConfirm}
      </label>
      <input
        id="reset-password-confirm"
        type="password"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        required
        minLength={6}
        autoComplete="new-password"
        className={inputClass}
      />

      {error && <p className="mt-4 text-sm text-ink-soft">{error}</p>}

      <button
        type="submit"
        disabled={busy}
        className="mt-6 border border-ink px-5 py-2.5 text-sm transition-colors hover:bg-ink hover:text-paper disabled:opacity-50"
      >
        {busy ? '…' : t.resetSubmit}
      </button>
    </form>
  );
}
