'use client';

// 邮箱重置密码表单：注册邮箱 → better-auth /request-password-reset → Resend 发信。
// redirectTo 用当前 origin 现拼（不走环境变量）——用户从哪个域名进来，邮件链接就落回哪个域名。
// 服务端对不存在的邮箱也返回 ok（防枚举），所以 ok 一律按「已发出」提示。
import { useState } from 'react';
import Link from 'next/link';
import type { Dict } from '@/i18n/get-dict';

export default function ForgotPasswordForm({ locale, t }: { locale: string; t: Dict['login'] }) {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const inputClass =
    'mt-2 w-full border border-line bg-white/60 p-3 text-sm outline-none focus:border-ink';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/auth/request-password-reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: email.trim(),
          redirectTo: `${window.location.origin}/${locale}/reset-password`,
        }),
      });
      if (response.ok) {
        setSent(true);
      } else {
        setError(t.forgotError);
      }
    } catch {
      setError(t.forgotError);
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <div className="flex flex-col gap-4 text-sm leading-relaxed">
        <p data-forgot-sent>{t.forgotSent}</p>
        <Link
          href={`/${locale}/login`}
          className="self-start border border-ink px-5 py-2.5 transition-colors hover:bg-ink hover:text-paper"
        >
          {t.toSignIn}
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col">
      <label className="text-sm text-ink-soft" htmlFor="forgot-email">
        {t.forgotEmailLabel}
      </label>
      <input
        id="forgot-email"
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
        autoComplete="email"
        className={inputClass}
      />

      {error && <p className="mt-4 text-sm text-ink-soft">{error}</p>}

      <button
        type="submit"
        disabled={busy}
        className="mt-6 border border-ink px-5 py-2.5 text-sm transition-colors hover:bg-ink hover:text-paper disabled:opacity-50"
      >
        {busy ? '…' : t.forgotSubmit}
      </button>

      <Link href={`/${locale}/login`} className="mt-4 text-sm text-ink-soft underline underline-offset-4">
        {t.toSignIn}
      </Link>
    </form>
  );
}
