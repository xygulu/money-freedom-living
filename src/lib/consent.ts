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

/**
 * 同意的类型（M11-E）：敏感信息同意与触达（邮件）同意是两件事，必须分开记——
 * 否则"最近一条"会把一封邮件的 opt-in 读成"同意处理敏感信息"（docs/05 §9.3）。
 * 存量行由 DDL 的 DEFAULT 'sensitive' 回填，语义正确。
 */
export type ConsentKind = 'sensitive' | 'touch';

export interface ConsentAnswer {
  kind: ConsentKind;
  granted: boolean;
  ipHash: string | null;
  policyVersion: string;
  createdAt: string;
}

export function hashIp(ip: string): string {
  return createHash('sha256').update(`${ip}:${process.env.RECOVERY_PEPPER ?? ''}`).digest('hex');
}

/** 记录一次同意/拒绝（每次生成画像都记，形成带时间戳的审计链） */
export async function recordConsent(
  userKey: string,
  granted: boolean,
  ipHash: string | null,
  kind: ConsentKind = 'sensitive',
): Promise<void> {
  await getSql()`
    INSERT INTO consent_records (user_key, granted, policy_version, ip_hash, kind)
    VALUES (${userKey}, ${granted}, ${POLICY_VERSION}, ${ipHash}, ${kind})
  `;
}

/** 最近一次同意记录（按类型过滤；画像入口据此提示，未记录则视为未同意） */
export async function latestConsent(userKey: string, kind: ConsentKind = 'sensitive'): Promise<ConsentAnswer | null> {
  const rows = await getSql()`
    SELECT granted, ip_hash, policy_version, created_at, kind
    FROM consent_records WHERE user_key = ${userKey} AND kind = ${kind}
    ORDER BY created_at DESC, id DESC LIMIT 1
  `;
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    kind: (String(row.kind ?? 'sensitive') as ConsentKind),
    granted: Boolean(row.granted),
    ipHash: (row.ip_hash as string | null) ?? null,
    policyVersion: String(row.policy_version),
    createdAt: iso(row.created_at),
  };
}
