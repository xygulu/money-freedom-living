'use client';

// VIP 视图：权益清单 + 订阅/管理动作 + Creem 回跳后的权益回查。
// 付费墙文案原则（docs/02 §7）：soft gate，说明"VIP 多了什么"，不说"你被限制"。
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Dict } from '@/i18n/get-dict';

interface Props {
  locale: string;
  loggedIn: boolean;
  isVip: boolean;
  vipUntil: string | null;
  providerConfigured: boolean;
  checkoutId: string | null;
  providerParam: string | null;
  dict: Dict['vip'];
}

export default function VipView({
  locale,
  loggedIn,
  isVip,
  vipUntil,
  providerConfigured,
  checkoutId,
  providerParam,
  dict: t,
}: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verifyState, setVerifyState] = useState<'idle' | 'pending' | 'granted' | 'failed'>('idle');
  const verifyStarted = useRef(false);

  // Creem 回跳：有 checkout_id 就回查一次权益（granted 后刷新服务端状态）
  useEffect(() => {
    if (!checkoutId || !loggedIn || verifyStarted.current) return;
    verifyStarted.current = true;
    setVerifyState('pending');
    const params = new URLSearchParams({ checkout_id: checkoutId });
    if (providerParam) params.set('provider', providerParam);
    fetch(`/api/payments/verify?${params.toString()}`)
      .then((res) => res.json())
      .then((data: { granted?: boolean; status?: string }) => {
        if (data.granted) {
          setVerifyState('granted');
          router.refresh();
        } else if (data.status === 'pending') {
          setVerifyState('pending');
        } else {
          setVerifyState('failed');
        }
      })
      .catch(() => setVerifyState('failed'));
  }, [checkoutId, loggedIn, providerParam, router]);

  async function go(path: 'checkout' | 'portal') {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/payments/${path}`, { method: 'POST' });
      const data = (await res.json()) as { url?: string; error?: string };
      if (data.url) {
        window.location.href = data.url;
        return;
      }
      setError(data.error ?? t.error);
    } catch {
      setError(t.error);
    } finally {
      setBusy(false);
    }
  }

  if (verifyState === 'granted') {
    return (
      <div className="border border-line bg-white/60 p-6">
        <p className="text-base">{t.verifyGranted}</p>
        <p className="mt-2 text-sm text-ink-soft">{t.verifyGrantedSub}</p>
      </div>
    );
  }

  // 未登录：订阅需要账号（跨设备保留 VIP 权益）
  if (!loggedIn) {
    return (
      <div className="border border-line p-6">
        <p className="text-sm leading-relaxed text-ink-soft">{t.loginRequired}</p>
        <a
          href={`/${locale}/login?next=/${locale}/vip`}
          className="mt-5 inline-block border border-ink px-5 py-2.5 text-sm transition-colors hover:bg-ink hover:text-paper"
        >
          {t.loginCta}
        </a>
      </div>
    );
  }

  // VIP 生效中
  if (isVip) {
    return (
      <div className="border border-line bg-white/60 p-6">
        <p className="text-base">{t.active}</p>
        {vipUntil && (
          <p className="mt-2 text-sm text-ink-soft">
            {t.until.replace('{date}', new Date(vipUntil).toLocaleDateString())}
          </p>
        )}
        <ul className="mt-5 flex flex-col gap-2 text-sm text-ink-soft">
          <li>· {t.perkChat}</li>
          <li>· {t.perkJournal}</li>
          <li>· {t.perkReport}</li>
        </ul>
        <button
          onClick={() => go('portal')}
          disabled={busy}
          className="mt-6 border border-ink px-5 py-2.5 text-sm transition-colors hover:bg-ink hover:text-paper disabled:opacity-50"
        >
          {t.manage}
        </button>
        {error && <p className="mt-4 text-sm text-ink-soft">{error}</p>}
      </div>
    );
  }

  // 免费登录：权益清单 + 订阅
  return (
    <div className="flex flex-col">
      {verifyState === 'pending' && <p className="mb-6 text-sm text-ink-soft">{t.verifyPending}</p>}
      {verifyState === 'failed' && <p className="mb-6 text-sm text-ink-soft">{t.verifyFailed}</p>}

      <ul className="flex flex-col gap-3 border border-line bg-white/60 p-6 text-sm leading-relaxed">
        <li>· {t.perkChat}</li>
        <li>· {t.perkJournal}</li>
        <li>· {t.perkReport}</li>
      </ul>

      <button
        onClick={() => go('checkout')}
        disabled={busy}
        className="mt-6 self-start border border-ink px-5 py-2.5 text-sm transition-colors hover:bg-ink hover:text-paper disabled:opacity-50"
      >
        {busy ? '…' : t.subscribe}
      </button>

      {!providerConfigured && <p className="mt-4 text-sm leading-relaxed text-ink-soft/70">{t.notConfigured}</p>}
      {error && <p className="mt-4 text-sm text-ink-soft">{error}</p>}
    </div>
  );
}
