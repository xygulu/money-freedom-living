'use client';

// 恢复码找回表单：用户名 + 12 位恢复码 + 新密码 → 服务端验证并重置密码。
// 成功后引导去登录页（本页不直接创建会话——找回场景本就从无会话开始）。
import { useState } from 'react';
import Link from 'next/link';
import type { Dict } from '@/i18n/get-dict';

export default function RecoverForm({ locale, dict }: { locale: string; dict: Dict }) {
  const t = dict.login;
  const [username, setUsername] = useState('');
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/me/recovery/recover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, code, newPassword }),
      });
      if (response.ok) {
        setDone(true);
      } else {
        setError(t.recoverError);
      }
    } catch {
      setError(t.recoverError);
    } finally {
      setBusy(false);
    }
  }

  const inputClass =
    'mt-2 w-full border border-line bg-white/60 p-3 text-sm outline-none focus:border-ink';

  if (done) {
    return (
      <div className="flex flex-col gap-4 text-sm leading-relaxed">
        <p>{t.recoverSuccess}</p>
        <Link href={`/${locale}/login`} className="self-start border border-ink px-5 py-2.5 transition-colors hover:bg-ink hover:text-paper">
          {t.signIn}
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col">
      <label className="text-sm text-ink-soft" htmlFor="recover-username">
        {t.username}
      </label>
      <input
        id="recover-username"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        required
        minLength={3}
        maxLength={20}
        autoComplete="username"
        className={inputClass}
      />

      <label className="mt-4 text-sm text-ink-soft" htmlFor="recover-code">
        {t.recoverCode}
      </label>
      <input
        id="recover-code"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        required
        minLength={12}
        maxLength={20}
        autoComplete="off"
        placeholder="XXXX-XXXX-XXXX"
        className={`${inputClass} font-mono tracking-widest uppercase`}
      />

      <label className="mt-4 text-sm text-ink-soft" htmlFor="recover-password">
        {t.recoverNewPassword}
      </label>
      <input
        id="recover-password"
        type="password"
        value={newPassword}
        onChange={(e) => setNewPassword(e.target.value)}
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
        {busy ? '…' : t.recoverSubmit}
      </button>

      <Link href={`/${locale}/login`} className="mt-4 text-sm text-ink-soft underline underline-offset-4">
        {t.toSignIn}
      </Link>
    </form>
  );
}
