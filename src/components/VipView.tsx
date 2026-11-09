'use client';

// VIP 视图：权益清单 + 订阅/管理动作 + Creem 回跳后的权益回查。
// 付费墙文案原则（docs/02 §7）：soft gate，说明"VIP 多了什么"，不说"你被限制"。
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Dict } from '@/i18n/get-dict';
import { createCheckout, openPortal, verifyCheckout } from '@/lib/quota-client';

interface Props {
  locale: string;
  isVip: boolean;
  vipUntil: string | null;
  providerConfigured: boolean;
  checkoutId: string | null;
  providerParam: string | null;
  dict: Dict['vip'];
}

export default function VipView({
  locale,
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

  // 支付回跳：有结账 id 就回查一次权益（granted 后刷新服务端状态）。
  // 回跳参数名已在服务端（vip/page）用 config 的 checkoutIdParam 解析成 checkoutId，
  // 这里只把值交给统一请求层 verifyCheckout（内部用 verify API 契约名 checkout_id）。
  useEffect(() => {
    if (!checkoutId || verifyStarted.current) return;
    verifyStarted.current = true;
    setVerifyState('pending');
    verifyCheckout(checkoutId, providerParam)
      .then((res) => {
        if (res.ok && res.granted) {
          setVerifyState('granted');
          router.refresh();
        } else if (res.ok && res.status === 'pending') {
          setVerifyState('pending');
        } else {
          setVerifyState('failed');
        }
      })
      .catch(() => setVerifyState('failed'));
  }, [checkoutId, providerParam, router]);

  async function go(path: 'checkout' | 'portal') {
    if (busy) return;
    setBusy(true);
    setError(null);
    const res = path === 'checkout' ? await createCheckout() : await openPortal();
    if (res.ok && res.url) {
      window.location.href = res.url;
      return;
    }
    setError(res.ok ? t.error : res.error);
    setBusy(false);
  }

  if (verifyState === 'granted') {
    return (
      <div className="border border-line bg-white/60 p-6">
        <p className="text-base">{t.verifyGranted}</p>
        <p className="mt-2 text-sm text-ink-soft">{t.verifyGrantedSub}</p>
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
