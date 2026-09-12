import { createHash } from 'crypto';
import { getSql, iso } from './db';

/**
 * 敏感信息单独同意（docs/02 §9：金钱困扰、童年记忆、心理状态可能构成敏感个人信息，
 * 画像生成前单独征求，不与用户协议打包勾选）。
 * - 同意记录带时间戳 / IP 哈希 / 政策版本号存服务端，游客同意同样记录（可追溯）
 * - 拒绝者可继续使用问卷与日记，但不生成画像、不进行 AI 深谈
 */

/** 隐私政策版本：文案实质修订时递增，历史同意记录据此审计 */
export const POLICY_VERSION = '2026-09-v1';

export interface ConsentAnswer {
  granted: boolean;
  ipHash: string | null;
  policyVersion: string;
  createdAt: string;
}

export function hashIp(ip: string): string {
  return createHash('sha256').update(`${ip}:${process.env.RECOVERY_PEPPER ?? ''}`).digest('hex');
}

/** 记录一次同意/拒绝（每次生成画像都记，形成带时间戳的审计链） */
export async function recordConsent(userKey: string, granted: boolean, ipHash: string | null): Promise<void> {
  await getSql()`
    INSERT INTO consent_records (user_key, granted, policy_version, ip_hash)
    VALUES (${userKey}, ${granted}, ${POLICY_VERSION}, ${ipHash})
  `;
}

/** 最近一次同意记录（画像入口据此提示，未记录则视为未同意） */
export async function latestConsent(userKey: string): Promise<ConsentAnswer | null> {
  const rows = await getSql()`
    SELECT granted, ip_hash, policy_version, created_at
    FROM consent_records WHERE user_key = ${userKey}
    ORDER BY created_at DESC, id DESC LIMIT 1
  `;
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    granted: Boolean(row.granted),
    ipHash: (row.ip_hash as string | null) ?? null,
    policyVersion: String(row.policy_version),
    createdAt: iso(row.created_at),
  };
}
