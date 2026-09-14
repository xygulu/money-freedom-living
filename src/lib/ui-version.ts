// 前台改造（70-2 A2）— ui_version 机制。
//
// 存在哪里：纯 cookie `mfl_ui_version` ∈ { 'new'(default), 'classic' }。
// 不进 growth_profiles（与现有 mfl_tz 一致——表现层偏好归 cookie）。
// 读：getUiVersion() —— server 端组件调用，cookies() 解析。
// 写：通过 POST /api/ui-version 设置；客户端 fetch 后 router.refresh() 即生效。
//
// 用户授权"新版好就废除旧版"，所以本文件加一个轻量使用统计
// （getUiVersionUsageStats）供后续评估使用——废除时只删调用点。
import { cookies } from 'next/headers';

export const UI_VERSION_COOKIE = 'mfl_ui_version';
export const UI_VERSIONS = ['new', 'classic'] as const;
export type UiVersion = (typeof UI_VERSIONS)[number];

export const DEFAULT_UI_VERSION: UiVersion = 'new';

export function isUiVersion(v: unknown): v is UiVersion {
  return typeof v === 'string' && (UI_VERSIONS as readonly string[]).includes(v);
}

/** 服务端读：缺省回落到 new；非法值也回落到 new（白名单防御）。 */
export async function getUiVersion(): Promise<UiVersion> {
  try {
    const cookieList = await cookies();
    const raw = cookieList.get(UI_VERSION_COOKIE)?.value;
    return isUiVersion(raw) ? raw : DEFAULT_UI_VERSION;
  } catch {
    return DEFAULT_UI_VERSION;
  }
}

/** 服务端写：包成完整 Set-Cookie 头。HttpOnly=false（前端 CSS/JS 也读得到，备将来用）。 */
export function buildUiVersionCookie(value: UiVersion): string {
  const oneYear = 365 * 24 * 60 * 60;
  return `${UI_VERSION_COOKIE}=${value}; Path=/; Max-Age=${oneYear}; SameSite=Lax`;
}

/** 客户端读：document.cookie 解析；缺省回落 new。 */
export function readUiVersionClient(): UiVersion {
  if (typeof document === 'undefined') return DEFAULT_UI_VERSION;
  const m = document.cookie.match(/(?:^|; )mfl_ui_version=([^;]*)/);
  const v = m ? decodeURIComponent(m[1]) : null;
  return isUiVersion(v) ? v : DEFAULT_UI_VERSION;
}

/**
 * 使用统计（废除依据）。本批"已废除"判据草拟：
 * - classic cookie 写入率（用户主动切的占访问用户比）< 5% 且持续 30 天
 * - 无 classic 专属回归
 * - 用户反馈（feedback 库）无反对声
 * 落到 ui_version_view_events 表（脚本迁移时建）。
 * 现版本只读 cookie，不主动埋点——本批只统计"曾经切到 classic 又切回 new" 的
 * 切换次数，作为最粗的偏好信号；废除前再补完整埋点。
 */
export interface UiVersionFlipStats {
  flipsToClassic: number;
  flipsToNew: number;
}
