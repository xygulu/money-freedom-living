/**
 * 支付平台中立抽象层。
 *
 * 目标：接入新支付平台 = 新增一个 adapter 文件 + registry 注册一行 + env 配置，
 * 不改表结构、不改路由 URL、不改前端交互。
 *
 * 契约纪律（所有 adapter 必须遵守）：
 * - isEnabled() 必须 key + webhook secret 齐备才返回 true（fail-closed：
 *   secret 缺失的平台不参与 webhook 验签探测，绝不"跳过验签"）
 * - parseWebhook()：验签失败抛错；验签通过但事件不认识/不需要处理 → 返回 null
 * - webhook 侧不可归属用户、未知事件一律返回 200（让平台停止重试），
 *   只有瞬时 DB 错误才允许 5xx
 * - HMAC 只证明"来自持有 secret 的一方"，不证明语义：adapter 验签后必须做
 *   载荷形状校验，防止两家平台 secret 配重了时事件被错误解释
 */

/** 中立订阅三态：只决定"账期是否计入权益"（current_period_end 永远是硬上界） */
export type SubscriptionStatus = 'live' | 'grace' | 'ended';

/** 中立化后的 webhook 事件（adapter 的 parseWebhook 产出） */
export type PaymentEvent =
  | {
      type: 'grant'; // 授予/延长（checkout.completed、subscription.active/paid/trialing）
      referenceId: string | null; // 结账时埋的本站 userId
      customerId: string | null;
      customerEmail: string | null;
      subscriptionId: string;
      providerStatus: string | null;
      /** 载荷自带账期；null 时引擎会向平台反查，再缺则兜底 */
      periodEnd: Date | null;
    }
  | {
      type: 'revoke'; // 立即撤销（expired/paused/canceled）
      referenceId: string | null;
      customerId: string | null;
      customerEmail: string | null;
      subscriptionId: string;
      providerStatus: string | null;
    }
  | {
      type: 'info'; // 只改状态/标记，不动账期（scheduled_cancel/past_due/update）
      referenceId: string | null;
      customerId: string | null;
      customerEmail: string | null;
      subscriptionId: string;
      providerStatus: string | null;
    };

/** 状态映射结果：normalizeStatus 返回 null 表示未知状态（引擎不动权益） */
export interface NormalizedStatus {
  status: SubscriptionStatus;
  willCancel: boolean;
}

export interface CheckoutResult {
  url: string; // 托管收银台跳转地址
  sessionId: string; // 平台侧结账会话 id（成功页回查用）
}

/** 结账会话回查结果（成功页 verify 通道） */
export interface ProviderCheckoutSession {
  complete: boolean; // 是否已支付完成
  customerId: string | null;
  customerEmail: string | null;
  subscriptionId: string | null;
  /** 结账时埋的本站 userId（归属第一优先级） */
  referenceId: string | null;
  /** 账期截止（多数平台 checkout 载荷没有，null 时引擎自行补） */
  periodEnd: Date | null;
}

export interface ProviderSubscriptionInfo {
  providerStatus: string | null;
  periodEnd: Date | null;
}

export interface CheckoutInput {
  userId: string;
  email: string;
  successUrl: string;
  // 未来若有多档位（月/年）：在此加 planId，各 adapter 自行映射自家
  // product/price env。当前单档位，不为假设的需求提前抽象。
}

export interface PortalInput {
  userId: string;
  /** 用户在该平台的 customer id（portal 路由查 subscriptions 后传入） */
  providerCustomerId: string | null;
}

/**
 * 平台 API 错误的中立基类：路由层只认它，不认任何 adapter 的具体错误类
 * （接入新平台 = 继承它，平台错误日志自动带上 status/traceId，无需改路由）。
 */
export class PaymentProviderError extends Error {
  status: number;
  provider?: string;
  traceId?: string;
  constructor(status: number, message: string, traceId?: string) {
    super(message);
    this.name = 'PaymentProviderError';
    this.status = status;
    this.traceId = traceId;
  }
}

export interface PaymentProvider {
  /** 平台标识（subscriptions.provider / webhook provider 参数取值） */
  id: string;
  /** 平台展示名（日志与面向用户的支付说明场景使用，如 "Creem"） */
  label: string;
  /**
   * 平台回跳 success_url 时结账会话 id 的查询参数名（各平台不同：
   * Creem 是 checkout_id，Stripe 是 session_id……）。前端据此从回跳 URL
   * 取值传给 /api/payments/verify，保证新平台接入不改前端。
   * 经 GET /api/payments/config 暴露给前端。
   */
  readonly checkoutIdParam: string;
  /** 面向用户的支付说明（/vip 页脚注；无则前端回退通用文案） */
  readonly billingNote?: string;
  /** 配置齐备才启用（见顶部 fail-closed 纪律） */
  isEnabled(): boolean;
  /** 创建托管收银台会话 */
  createCheckout(input: CheckoutInput): Promise<CheckoutResult>;
  /** 结账会话回查；会话不存在返回 null */
  fetchSession(sessionId: string): Promise<ProviderCheckoutSession | null>;
  /** 订阅详情；订阅不存在返回 null */
  fetchSubscription(subscriptionId: string): Promise<ProviderSubscriptionInfo | null>;
  /** 平台原生状态 → 中立三态；未知状态返回 null（引擎不动权益） */
  normalizeStatus(providerStatus: string): NormalizedStatus | null;
  /** 客户自助管理门户（可选能力） */
  createPortalUrl?(input: PortalInput): Promise<string>;
  /** 验签 + 形状校验 + 归一化；验签失败抛错，不认识/不处理的事件返回 null */
  parseWebhook(rawBody: string, headers: Headers): Promise<PaymentEvent | null>;
}
