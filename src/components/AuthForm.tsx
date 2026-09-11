'use client';

// 登录 / 注册表单（better-auth email+password；注册需用户名）。
// 成功后整页跳回 next（默认 /me）；注册/登录态由 better-auth session cookie 承载。
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { authClient } from '@/lib/auth-client';
import type { Dict } from '@/i18n/get-dict';

export default function AuthForm({
  next,
  dict: t,
}: {
  next: string;
  dict: Dict['login'];
}) {
  const router = useRouter();
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result =
        mode === 'signup'
          ? await authClient.signUp.email({ name: username, username, email, password })
          : await authClient.signIn.email({ email, password });
      if (result.error) {
        setError(t.error);
        return;
      }
      router.push(next);
      router.refresh();
    } catch {
      setError(t.error);
    } finally {
      setBusy(false);
    }
  }

  const inputClass =
    'mt-2 w-full border border-line bg-white/60 p-3 text-sm outline-none focus:border-ink';

  return (
    <form onSubmit={submit} className="flex flex-col">
      {mode === 'signup' && (
        <>
          <label className="text-sm text-ink-soft" htmlFor="auth-username">
            {t.username}
          </label>
          <input
            id="auth-username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
            minLength={3}
            maxLength={20}
            autoComplete="username"
            className={inputClass}
          />
        </>
      )}
      <label className="mt-4 text-sm text-ink-soft" htmlFor="auth-email">
        {t.email}
      </label>
      <input
        id="auth-email"
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
        autoComplete="email"
        className={inputClass}
      />
      <label className="mt-4 text-sm text-ink-soft" htmlFor="auth-password">
        {t.password}
      </label>
      <input
        id="auth-password"
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
        minLength={6}
        autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
        className={inputClass}
      />

      {error && <p className="mt-4 text-sm text-ink-soft">{error}</p>}

      <button
        type="submit"
        disabled={busy}
        className="mt-6 border border-ink px-5 py-2.5 text-sm transition-colors hover:bg-ink hover:text-paper disabled:opacity-50"
      >
        {busy ? '…' : mode === 'signup' ? t.signUp : t.signIn}
      </button>

      <button
        type="button"
        onClick={() => {
          setMode(mode === 'signup' ? 'signin' : 'signup');
          setError(null);
        }}
        className="mt-4 text-sm text-ink-soft underline underline-offset-4"
      >
        {mode === 'signup' ? t.toSignIn : t.toSignUp}
      </button>

      <p className="mt-6 text-xs leading-relaxed text-ink-soft/70">{t.note}</p>
    </form>
  );
}
