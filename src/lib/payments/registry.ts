import { creemProvider } from './creem';
import type { PaymentProvider } from './types';

/**
 * 支付平台注册表：接入新平台 = 写一个 adapter（实现 PaymentProvider）+ 在这里加一行。
 *
 * 启用判定在各 adapter 的 isEnabled()（key + webhook secret 齐备，fail-closed），
 * 未配置的平台自动不参与 checkout/webhook/portal。
 */
const PROVIDERS: PaymentProvider[] = [creemProvider];

/** 所有已注册平台（不论是否启用；路由层只用启用的） */
export function listRegisteredProviders(): PaymentProvider[] {
  return PROVIDERS;
}

/** 当前已启用（配置齐备）的平台 */
export function listEnabledProviders(): PaymentProvider[] {
  return PROVIDERS.filter((p) => p.isEnabled());
}

/** 默认平台：第一个启用的（单平台期恒命中；多平台时是 checkout/portal 的缺省项） */
export function getDefaultProvider(): PaymentProvider | null {
  return listEnabledProviders()[0] ?? null;
}

/** 按 id 取启用平台；未注册/未启用返回 null */
export function getEnabledProvider(id: string): PaymentProvider | null {
  return listEnabledProviders().find((p) => p.id === id) ?? null;
}
