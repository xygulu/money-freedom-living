'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * 配额/支付的客户端请求层：页面组件共用。
 * 错误信息直接用服务端返回的文案（服务端是唯一能判断配额/权益的地方，
 * 前端状态只做展示，绝不能做门禁——用户可以直接调 API）。
 */

export interface PlaySubscription {
  provider: string; // 平台 id（'creem'…）
  status: 'live' | 'grace' | 'ended'; // 平台中立三态
  willCancel: boolean; // 已排期取消（本期结束前仍有效）
}

export interface QuotaStatusResponse {
  authenticated: boolean;
  isVip: boolean;
  limit: number;
  used: number;
  remaining: number;
  vipUntil: string | null;
  subscription: PlaySubscription | null;
}

export type ConsumeApiResult =
  | { ok: true; remaining: number }
  | { ok: false; error: string; code: string };

export type SimpleResult = { ok: true; url?: string } | { ok: false; error: string };

async function postJson<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const err = new Error(String(data.error ?? `HTTP ${res.status}`)) as Error & {
      code?: string;
      payload?: Record<string, unknown>;
    };
    err.code = String(data.code ?? '');
    err.payload = data;
    throw err;
  }
  return data as T;
}

/** 消耗一次配额的门禁调用：通过后前端才真正执行动作（开局/生成/导出……） */
export async function consumeQuota(kind?: string): Promise<ConsumeApiResult> {
  try {
    const data = await postJson<{ ok: true; remaining: number }>('/api/quota/consume', { kind });
    return { ok: true, remaining: data.remaining };
  } catch (error) {
    const err = error as Error & { code?: string };
    return { ok: false, code: err.code ?? 'UNKNOWN', error: err.message || '请求失败，请稍后再试' };
  }
}

/** 创建支付收银台会话（默认平台；可传 provider 指定），返回跳转 url */
export async function createCheckout(provider?: string): Promise<SimpleResult> {
  try {
    const data = await postJson<{ url: string }>('/api/payments/checkout', { provider });
    return { ok: true, url: data.url };
  } catch (error) {
    const err = error as Error;
    return { ok: false, error: err.message || '创建支付会话失败，请稍后再试' };
  }
}

/** 打开订阅管理门户 */
export async function openPortal(): Promise<SimpleResult> {
  try {
    const data = await postJson<{ url: string }>('/api/payments/portal');
    return { ok: true, url: data.url };
  } catch (error) {
    const err = error as Error;
    return { ok: false, error: err.message || '打开订阅管理失败，请稍后再试' };
  }
}

/** 前端可见的支付平台元数据（/api/payments/config 响应） */
export interface PaymentConfig {
  providers: Array<{
    id: string;
    label: string;
    checkoutIdParam: string;
    billingNote: string | null;
  }>;
  defaultProvider: string | null;
}

/** 拉取支付平台元数据（公开端点，渲染平台文案与回跳参数解析用） */
export async function fetchPaymentConfig(): Promise<PaymentConfig | null> {
  try {
    const res = await fetch('/api/payments/config');
    if (!res.ok) return null;
    return (await res.json()) as PaymentConfig;
  } catch (error) {
    console.error('[quota-client] payment config fetch failed:', error);
    return null;
  }
}

/**
 * 核对支付结果（支付成功回跳页用），本地开发收不到 webhook 的主通道。
 * provider 必须与 checkout 时一致地透传：多平台启用时缺省会回退第一个启用
 * 平台，拿错 adapter 回查会 404，用户付了钱权益却不生效。
 */
export async function verifyCheckout(
  checkoutId: string,
  provider?: string | null
): Promise<{ ok: true; granted: boolean } | { ok: false; error: string }> {
  try {
    const params = new URLSearchParams({ checkout_id: checkoutId });
    if (provider) params.set('provider', provider);
    const res = await fetch(`/api/payments/verify?${params.toString()}`);
    const data = (await res.json().catch(() => ({}))) as { granted?: boolean; error?: string };
    if (!res.ok) return { ok: false, error: data.error ?? '核实支付状态失败' };
    return { ok: true, granted: data.granted === true };
  } catch {
    return { ok: false, error: '网络异常，请稍后再试' };
  }
}

/**
 * 拉取配额 + 会员状态的 hook：多组件各自拉一次（数据量小，<1KB），
 * 不引入全局 store；refresh 供消耗配额/订阅成功后手动更新。
 *
 * ⚠️ 必须跟随登录态重拉：配额身份由会话决定（游客 3 / 免费 10 / VIP 100）。
 * - `enabled: false` 期间不请求——传"会话查询未决"（如 better-auth 的
 *   `session.isPending`）避免给已登录用户闪游客配额（实测踩过）
 * - `watch` 放登录态标识（如 `session.data?.user?.id`）：登录/退出后重拉
 */
export function useQuotaStatus(params: {
  enabled?: boolean;
  watch?: unknown;
} = {}): { status: QuotaStatusResponse | null; refresh: () => Promise<void> } {
  const { enabled = true, watch } = params;
  const [status, setStatus] = useState<QuotaStatusResponse | null>(null);

  // 手动刷新（事件回调里调用，setState 合法）
  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/quota');
      setStatus(res.ok ? ((await res.json()) as QuotaStatusResponse) : null);
    } catch (error) {
      console.error('[quota-client] quota fetch failed:', error);
      setStatus(null);
    }
  }, []);

  // 登录态确定/变化时拉一次：setState 全部落在异步回调里
  //（effect 体内不同步 setState，React 19 严格模式会警告）
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    fetch('/api/quota')
      .then(async (res) => (res.ok ? ((await res.json()) as QuotaStatusResponse) : null))
      .then((data) => {
        if (!cancelled) setStatus(data);
      })
      .catch((error) => {
        console.error('[quota-client] quota fetch failed:', error);
        if (!cancelled) setStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, watch]);

  return { status, refresh };
}
