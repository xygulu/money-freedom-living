'use client';

// /me 账户区（登录态可见）：恢复码（生成一次、明码只显示一次）、数据导出、删除账号。
// 恢复码是 Safari ITP 清存储后的找回钥匙（docs/02 §9）；删除走两步确认（输入 DELETE）。
import { useState } from 'react';
import type { Dict } from '@/i18n/get-dict';
import SignOutButton from './SignOutButton';

interface Props {
  locale: string;
  dict: Dict;
}

export default function MeAccount({ locale, dict }: Props) {
  const t = dict.me;
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');

  async function generateCode() {
    setBusy(true);
    setNotice('');
    try {
      const response = await fetch('/api/me/recovery/generate', { method: 'POST' });
      const data = await response.json();
      if (response.ok && data.code) {
        setCode(data.code);
        setNotice('');
      } else {
        setNotice(t.error);
      }
    } catch {
      setNotice(t.error);
    } finally {
      setBusy(false);
    }
  }

  async function deleteAccount() {
    if (confirmText !== 'DELETE') return;
    setBusy(true);
    try {
      const response = await fetch('/api/me/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: 'DELETE' }),
      });
      if (response.ok) {
        // 删除后回到首页（账号已不存在，受保护页会话已失效）
        window.location.href = `/${locale}`;
        return;
      }
      setNotice(t.error);
    } catch {
      setNotice(t.error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-10 border-t border-line">
      {/* 登出（70-2 加固：用户 2026-09-14 要求设置里补账号登出，带二次确认） */}
      <div className="flex justify-end pt-4">
        <SignOutButton
          locale={locale}
          labels={{
            btn: t.signOut,
            confirm: t.signOutConfirm,
            cancel: t.deleteCancel,
          }}
        />
      </div>

      {/* 恢复码 */}
      <div className="border-b border-line py-6">
        <h2 className="text-base">{t.recovery}</h2>
        <p className="mt-1 text-sm text-ink-soft">{t.recoveryHint}</p>
        {code ? (
          <div className="mt-4">
            <p className="text-xs text-ink-soft">{t.recoveryOnce}</p>
            <p className="mt-2 select-all font-mono text-lg tracking-widest">{code}</p>
            <button type="button" onClick={generateCode} disabled={busy} className="mt-3 text-xs text-ink-soft underline underline-offset-4 disabled:opacity-40">
              {t.recoveryRegenerate}
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={generateCode}
            disabled={busy}
            className="mt-4 border border-ink px-5 py-2 text-sm transition-colors hover:bg-ink hover:text-paper disabled:opacity-40"
          >
            {t.recoveryGenerate}
          </button>
        )}
      </div>

      {/* 导出 */}
      <div className="border-b border-line py-6">
        <h2 className="text-base">{t.exportData}</h2>
        <p className="mt-1 text-sm text-ink-soft">{t.exportHint}</p>
        <a
          href="/api/me/export"
          className="mt-4 inline-block border border-ink px-5 py-2 text-sm transition-colors hover:bg-ink hover:text-paper"
        >
          {t.exportBtn}
        </a>
      </div>

      {/* 删除 */}
      <div className="border-b border-line py-6">
        <h2 className="text-base">{t.deleteAccount}</h2>
        <p className="mt-1 text-sm text-ink-soft">{t.deleteHint}</p>
        {!confirmOpen ? (
          <button
            type="button"
            onClick={() => setConfirmOpen(true)}
            className="mt-4 border border-line px-5 py-2 text-sm text-red-700 hover:border-red-700 disabled:opacity-40"
          >
            {t.deleteBtn}
          </button>
        ) : (
          <div className="mt-4 flex flex-col gap-3 text-sm">
            <p className="leading-relaxed text-ink-soft">{t.deleteConfirmHint}</p>
            <input
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder="DELETE"
              className="w-48 rounded border border-line bg-white/60 px-3 py-2 font-mono outline-none focus:border-red-700"
            />
            <div className="flex gap-3">
              <button
                type="button"
                disabled={confirmText !== 'DELETE' || busy}
                onClick={deleteAccount}
                className="rounded-full bg-red-700 px-5 py-1.5 text-sm text-white hover:opacity-90 disabled:opacity-40"
              >
                {t.deleteConfirmBtn}
              </button>
              <button type="button" onClick={() => setConfirmOpen(false)} className="text-ink-soft underline underline-offset-4">
                {t.deleteCancel}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* 隐私政策 */}
      <div className="py-6">
        <a href={`/${locale}/privacy`} className="text-xs text-ink-soft underline underline-offset-4">
          {t.privacyLink}
        </a>
      </div>

      {notice && <p className="pb-6 text-sm text-red-700">{notice}</p>}
    </div>
  );
}
