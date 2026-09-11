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
  social = [],
}: {
  next: string;
  dict: Dict['login'];
  /** 服务端按凭证是否配齐传入；空数组 = 不渲染社交按钮（优雅降级） */
  social: ('google' | 'github')[];
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

  // 社交登录：整页跳去 provider 授权页，回来落在 callbackURL（next）
  async function signInSocial(provider: 'google' | 'github') {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await authClient.signIn.social({ provider, callbackURL: next });
      if (result.error || !result.data?.url) {
        setError(t.error);
        return;
      }
      window.location.href = result.data.url;
    } catch {
      setError(t.error);
      setBusy(false);
    }
  }

  const inputClass =
    'mt-2 w-full border border-line bg-white/60 p-3 text-sm outline-none focus:border-ink';

  return (
    <form onSubmit={submit} className="flex flex-col">
      {social.length > 0 && (
        <>
          <div className="flex flex-col gap-2">
            {social.includes('google') && (
              <button
                type="button"
                onClick={() => signInSocial('google')}
                disabled={busy}
                className="flex items-center justify-center gap-2 border border-line bg-white/60 px-5 py-2.5 text-sm transition-colors hover:border-ink disabled:opacity-50"
              >
                <svg aria-hidden="true" width="18" height="18" viewBox="0 0 18 18">
                  <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z" />
                  <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.32A9 9 0 0 0 9 18Z" />
                  <path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.96H.96a9 9 0 0 0 0 8.08l3-2.32Z" />
                  <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.59A9 9 0 0 0 .96 4.96l3 2.32C4.68 5.16 6.66 3.58 9 3.58Z" />
                </svg>
                {t.continueWithGoogle}
              </button>
            )}
            {social.includes('github') && (
              <button
                type="button"
                onClick={() => signInSocial('github')}
                disabled={busy}
                className="flex items-center justify-center gap-2 border border-line bg-white/60 px-5 py-2.5 text-sm transition-colors hover:border-ink disabled:opacity-50"
              >
                <svg aria-hidden="true" width="18" height="18" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.42 7.42 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
                </svg>
                {t.continueWithGithub}
              </button>
            )}
          </div>
          <div className="mt-6 flex items-center gap-3" role="separator">
            <span className="h-px flex-1 bg-line" />
            <span className="text-xs text-ink-soft/70">{t.orContinue}</span>
            <span className="h-px flex-1 bg-line" />
          </div>
        </>
      )}
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
