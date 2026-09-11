import { createHash, randomInt } from 'crypto';
import { getSql } from './db';

/**
 * 恢复码（docs/02 §7/§9：Safari ITP 会清游客存储，恢复码是账号的最后一把备用钥匙；
 * 也用于忘记密码时重置）。
 * - 12 位，去易混字符 23456789ABCDEFGHJKMNPQRSTUVWXYZ，4-4-4 展示
 * - 只存 sha256(RECOVERY_PEPPER + code)：库泄露也推不出码
 * - 限速（docs/03 §4）：账号 5 次/时 + IP 20 次/时 + 全局失败 100 次/时锁定
 */

const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const RECOVERY_CODE_LENGTH = 12;

// 限速阈值（每窗口 1 小时）
const LIMITS = { account: 5, ip: 20, globalFails: 100 } as const;

export function generateRecoveryCode(): string {
  let code = '';
  for (let i = 0; i < RECOVERY_CODE_LENGTH; i++) code += ALPHABET[randomInt(ALPHABET.length)];
  return code;
}

export function normalizeCode(input: string): string {
  return input.toUpperCase().replace(/[^2-9A-Z]/g, '');
}

export function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(`${process.env.RECOVERY_PEPPER ?? ''}${normalizeCode(code)}`).digest('hex');
}

/** 展示格式 4-4-4；库里存无分隔符 */
export function formatCode(code: string): string {
  const n = normalizeCode(code);
  return [n.slice(0, 4), n.slice(4, 8), n.slice(8, 12)].join('-');
}

// ---- growth_profiles.recovery_code_hash：一人一码，重生成即作废旧码 ----

export async function saveRecoveryCode(userKey: string, codeHash: string): Promise<void> {
  await getSql()`
    UPDATE growth_profiles SET recovery_code_hash = ${codeHash}, updated_at = now()
    WHERE user_key = ${userKey}
  `;
}

export async function getRecoveryCodeHash(userKey: string): Promise<string | null> {
  const rows = await getSql()`
    SELECT recovery_code_hash FROM growth_profiles WHERE user_key = ${userKey}
  `;
  return (rows[0]?.recovery_code_hash as string | null) ?? null;
}

// ---- 限速：每次验证尝试记 (scope, subject, ok)，按窗口计数 ----

/** 账号/IP 维度数全部尝试（防爆破不分成败）；global 维度只数失败（失败锁定） */
async function countAttempts(scope: string, subject: string, failsOnly: boolean): Promise<number> {
  const rows = await getSql()`
    SELECT count(*)::int AS n FROM recovery_attempts
    WHERE scope = ${scope} AND subject = ${subject}
      AND created_at > now() - interval '1 hour'
      AND (CASE WHEN ${failsOnly} THEN ok = false ELSE true END)
  `;
  return rows[0]?.n ?? 0;
}

export async function recordAttempt(scope: 'account' | 'ip' | 'global', subject: string, ok: boolean): Promise<void> {
  await getSql()`
    INSERT INTO recovery_attempts (scope, subject, ok) VALUES (${scope}, ${subject}, ${ok})
  `;
}

/**
 * 验证前限速检查。返回 null = 放行；'locked' = 拒绝。
 * 任一阈值触发即整体验证关闭 1 小时（滚动窗口），不区分哪个维度先满。
 */
export async function checkRateLimits(username: string, ipHash: string): Promise<'locked' | null> {
  const [account, ip, globalFails] = await Promise.all([
    countAttempts('account', username, false),
    countAttempts('ip', ipHash, false),
    countAttempts('global', '*', true),
  ]);
  if (globalFails >= LIMITS.globalFails) return 'locked';
  if (account >= LIMITS.account) return 'locked';
  if (ip >= LIMITS.ip) return 'locked';
  return null;
}
