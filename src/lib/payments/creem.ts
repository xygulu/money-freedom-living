import * as crypto from 'crypto';
import {
  PaymentProviderError,
  type CheckoutInput,
  type CheckoutResult,
  type NormalizedStatus,
  type PaymentEvent,
  type PaymentProvider,
  type PortalInput,
  type ProviderCheckoutSession,
  type ProviderSubscriptionInfo,
} from './types';

/**
 * Creem 支付平台 adapter（Merchant of Record）。
 *
 * 环境：key 前缀 creem_test_ → test-api.creem.io，其余 → api.creem.io
 * （与官方 SDK/CLI 行为一致，切 live 只需换 key，不改代码）。价格单位是"分"。
 *
 * ⚠️ 平台 API 怪癖：查询接口用 query 参数而非路径参数——路径形式
 * /v1/checkouts/{id} 实测返回 404/500，官方 CLI 内部也是
 * GET /v1/checkouts?checkout_id=...（已踩过坑）。
 */

const TEST_API_BASE = 'https://test-api.creem.io';
const LIVE_API_BASE = 'https://api.creem.io';

/** 中立错误基类的 Creem 实现（路由层只认基类，日志统一带 status/traceId） */
export class CreemApiError extends PaymentProviderError {
  constructor(status: number, message: string, traceId?: string) {
    super(status, message, traceId);
    this.name = 'CreemApiError';
  }
}

function isTestKey(key = process.env.CREEM_API_KEY ?? ''): boolean {
  return key.startsWith('creem_test_');
}

function apiBase(): string {
  return isTestKey() ? TEST_API_BASE : LIVE_API_BASE;
}

async function creemFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const key = process.env.CREEM_API_KEY;
  if (!key) throw new CreemApiError(500, 'CREEM_API_KEY 未配置');
  const res = await fetch(`${apiBase()}${path}`, {
    ...init,
    headers: {
      'x-api-key': key,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
    // Creem 偶发慢，30s 兜底避免请求悬挂占住路由
    signal: AbortSignal.timeout(30_000),
    cache: 'no-store',
  });
  const data = (await res.json().catch(() => null)) as
    | (T & { error?: string; message?: string[]; trace_id?: string })
    | null;
  if (!res.ok) {
    // 错误体形如 {trace_id, status, error, message: [...]}（官方文档格式）
    const detail = Array.isArray(data?.message) ? data.message.join('; ') : data?.error ?? '';
    throw new CreemApiError(res.status, detail || `Creem API HTTP ${res.status}`, data?.trace_id);
  }
  return data as T;
}

// ---------- 载荷类型（只声明我们实际消费的字段，其余官方文档为准） ----------

interface CreemCustomerRef {
  id: string;
  email?: string;
}

interface CreemSubscriptionLike {
  id: string;
  status: string;
  customer: string | CreemCustomerRef;
  metadata?: Record<string, unknown> | null;
  current_period_end_date?: string | null;
  next_transaction_date?: string | null;
}

interface CreemCheckoutPayload {
  id: string;
  status: string;
  checkout_url: string;
  customer?: CreemCustomerRef;
  subscription?: string | CreemSubscriptionLike;
  metadata?: Record<string, unknown> | null;
}

// ---------- 纯函数（导出供单测） ----------

/**
 * 订阅账期解析：优先 current_period_end_date，其次 next_transaction_date
 * （两者官方载荷都会带）。都没有返回 null。
 */
export function pickPeriodEnd(sub: {
  current_period_end_date?: string | null;
  next_transaction_date?: string | null;
}): Date | null {
  const raw = sub.current_period_end_date || sub.next_transaction_date;
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Webhook 签名验证：HMAC-SHA256（key=webhook secret，message=原始请求体），
 * hex 后与 creem-signature 头时序安全比较。
 */
export function verifyCreemSignature(rawBody: string, signature: string, secret: string): boolean {
  const computed = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(computed);
  const b = Buffer.from(signature ?? '');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Creem 原生状态 → 中立三态映射。
 * 未知状态返回 null：引擎只更新 provider_status，绝不动权益——
 * 平台将来新增枚举值，最坏结果是"展示没翻译"，而不是"全站 VIP 被清零"。
 */
export function normalizeCreemStatus(providerStatus: string): NormalizedStatus | null {
  switch (providerStatus) {
    case 'active':
    case 'trialing':
      return { status: 'live', willCancel: false };
    case 'scheduled_cancel': // 已排期取消，本期结束前仍有效
      return { status: 'live', willCancel: true };
    case 'past_due': // 扣款失败重试中，宽限期内保留权益
      return { status: 'grace', willCancel: false };
    case 'canceled':
    case 'expired':
    case 'paused': // Creem 暂停不算服务期：宁可撤销，恢复时由新事件重新授予
    case 'incomplete':
    case 'incomplete_expired':
      return { status: 'ended', willCancel: false };
    default:
      return null;
  }
}

// ---------- 载荷小工具：兼容"id 字符串 / 完整对象"两种官方形态 ----------

function customerIdOf(sub: CreemSubscriptionLike): string | null {
  if (typeof sub.customer === 'string') return sub.customer || null;
  return sub.customer?.id ?? null;
}

function customerEmailOf(sub: CreemSubscriptionLike): string | null {
  if (typeof sub.customer === 'string') return null;
  return sub.customer?.email ?? null;
}

function metadataReferenceOf(obj: { metadata?: Record<string, unknown> | null }): string | null {
  const ref = obj.metadata?.referenceId;
  return typeof ref === 'string' && ref ? ref : null;
}

// ---------- Adapter ----------

interface WebhookEventShape {
  id?: string;
  eventType?: string;
  object?: Record<string, unknown>;
}

export const creemProvider: PaymentProvider = {
  id: 'creem',
  label: 'Creem',
  checkoutIdParam: 'checkout_id',

  // 测试 key 提示测试卡号；live key 只留 Merchant of Record 说明
  get billingNote(): string {
    return isTestKey()
      ? '支付由 Creem 处理（Merchant of Record，含全球税费）。测试环境用卡号 4111 1111 1111 1111、任意有效期/CVC 即可模拟支付。'
      : '支付由 Creem 处理（Merchant of Record，含全球税费）。';
  },

  isEnabled(): boolean {
    // fail-closed：key + webhook secret 齐备才参与（secret 缺失 = webhook 无法验签）
    return Boolean(process.env.CREEM_API_KEY && process.env.CREEM_WEBHOOK_SECRET);
  },

  async createCheckout(input: CheckoutInput): Promise<CheckoutResult> {
    const productId = process.env.CREEM_PRODUCT_ID;
    if (!productId) throw new CreemApiError(500, 'CREEM_PRODUCT_ID 未配置');
    const checkout = await creemFetch<CreemCheckoutPayload>('/v1/checkouts', {
      method: 'POST',
      body: JSON.stringify({
        product_id: productId,
        success_url: input.successUrl,
        customer: { email: input.email },
        // referenceId 是权益归属的第一优先级（webhook 与成功页回查都会带回）
        metadata: { referenceId: input.userId },
      }),
    });
    return { url: checkout.checkout_url, sessionId: checkout.id };
  },

  async fetchSession(sessionId: string): Promise<ProviderCheckoutSession | null> {
    const checkout = await creemFetch<CreemCheckoutPayload>(
      `/v1/checkouts?checkout_id=${encodeURIComponent(sessionId)}`
    );
    if (!checkout?.id) return null;
    const subRef = checkout.subscription;
    const subId = typeof subRef === 'string' ? subRef : (subRef?.id ?? null);
    // checkout 载荷不含账期 → 有订阅 id 就拉订阅详情补齐
    let periodEnd: Date | null = null;
    if (subId) {
      const sub = await this.fetchSubscription(subId);
      periodEnd = sub?.periodEnd ?? null;
    }
    return {
      complete: checkout.status === 'completed',
      customerId: checkout.customer?.id ?? null,
      customerEmail: checkout.customer?.email ?? null,
      subscriptionId: subId,
      referenceId: metadataReferenceOf(checkout),
      periodEnd,
    };
  },

  async fetchSubscription(subscriptionId: string): Promise<ProviderSubscriptionInfo | null> {
    const sub = await creemFetch<CreemSubscriptionLike>(
      `/v1/subscriptions?subscription_id=${encodeURIComponent(subscriptionId)}`
    );
    if (!sub?.id) return null;
    return { providerStatus: sub.status ?? null, periodEnd: pickPeriodEnd(sub) };
  },

  normalizeStatus(providerStatus: string): NormalizedStatus | null {
    return normalizeCreemStatus(providerStatus);
  },

  async createPortalUrl(input: PortalInput): Promise<string> {
    if (!input.providerCustomerId) throw new Error('缺少 provider_customer_id');
    return createCreemPortalUrl(input.providerCustomerId);
  },

  async parseWebhook(rawBody: string, headers: Headers): Promise<PaymentEvent | null> {
    const secret = process.env.CREEM_WEBHOOK_SECRET;
    if (!secret) throw new Error('CREEM_WEBHOOK_SECRET 未配置'); // fail-closed
    const signature = headers.get('creem-signature') ?? '';
    if (!verifyCreemSignature(rawBody, signature, secret)) {
      throw new Error('invalid signature');
    }

    // 形状校验：HMAC 只证明来源，不证明该按 Creem 语义解释
    // （防两家平台 secret 配重时事件被错误归一化）
    let event: WebhookEventShape;
    try {
      event = JSON.parse(rawBody) as WebhookEventShape;
    } catch {
      return null;
    }
    if (typeof event?.eventType !== 'string' || typeof event?.object !== 'object' || event.object === null) {
      return null;
    }

    const obj = event.object as Record<string, unknown>;
    const eventType = event.eventType;
    const referenceId = metadataReferenceOf(obj);

    switch (eventType) {
      // ---- 授予/延长 ----
      case 'checkout.completed': {
        const checkout = obj as unknown as CreemCheckoutPayload;
        const sub = normalizeSubscriptionRef(checkout.subscription);
        if (!sub) return null; // 仅订阅制：无订阅 id 的结账不处理
        return {
          type: 'grant',
          referenceId,
          customerId: checkout.customer?.id ?? null,
          customerEmail: checkout.customer?.email ?? null,
          subscriptionId: sub.id,
          providerStatus: sub.providerStatus,
          // checkout 载荷无账期 → 引擎会经 fetchSubscription 补齐
          periodEnd: null,
        };
      }
      case 'subscription.active':
      case 'subscription.trialing':
      case 'subscription.paid': {
        const sub = obj as unknown as CreemSubscriptionLike;
        if (!sub.id) return null;
        return {
          type: 'grant',
          referenceId,
          customerId: customerIdOf(sub),
          customerEmail: customerEmailOf(sub),
          subscriptionId: sub.id,
          providerStatus: sub.status ?? null,
          periodEnd: pickPeriodEnd(sub),
        };
      }
      // ---- 立即撤销 ----
      case 'subscription.expired':
      case 'subscription.paused':
      case 'subscription.canceled': {
        const sub = obj as unknown as CreemSubscriptionLike;
        if (!sub.id) return null;
        return {
          type: 'revoke',
          referenceId,
          customerId: customerIdOf(sub),
          customerEmail: customerEmailOf(sub),
          subscriptionId: sub.id,
          providerStatus: sub.status ?? eventType.replace('subscription.', ''),
        };
      }
      // ---- 只改状态/标记，不动账期 ----
      case 'subscription.scheduled_cancel':
      case 'subscription.past_due':
      case 'subscription.update': {
        const sub = obj as unknown as CreemSubscriptionLike;
        if (!sub.id) return null;
        return {
          type: 'info',
          referenceId,
          customerId: customerIdOf(sub),
          customerEmail: customerEmailOf(sub),
          subscriptionId: sub.id,
          providerStatus: sub.status ?? eventType.replace('subscription.', ''),
        };
      }
      // refund/dispute 等暂不改变权益（人工处理），确认收到即可
      default:
        return null;
    }
  },
};

function normalizeSubscriptionRef(
  ref: string | CreemSubscriptionLike | null | undefined
): { id: string; providerStatus: string | null } | null {
  if (!ref) return null;
  if (typeof ref === 'string') return { id: ref, providerStatus: null };
  return ref.id ? { id: ref.id, providerStatus: ref.status ?? null } : null;
}

/**
 * 客户自助门户链接（Creem 按 customer_id 开门户）。
 * userId → provider_customer_id 的映射由 portal 路由查 subscriptions 后传入。
 */
export async function createCreemPortalUrl(customerId: string): Promise<string> {
  const data = await creemFetch<{ customer_portal_link: string }>('/v1/customers/billing', {
    method: 'POST',
    body: JSON.stringify({ customer_id: customerId }),
  });
  return data.customer_portal_link;
}
