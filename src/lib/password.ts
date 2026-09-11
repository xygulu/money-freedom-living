import { randomBytes, scrypt, timingSafeEqual } from 'crypto';

/**
 * 密码哈希：scrypt（Node 默认参数 N=16384/r=8/p=1）+ 16 字节随机盐。
 * 存储格式为单字符串 `${saltHex}:${hashHex}`，供 better-auth 的
 * emailAndPassword.password 自定义钩子使用（account.password 列）。
 * 手写认证时代的存量用户就是这套参数，拼上冒号后原样可验。
 */

const KEY_LENGTH = 64;

function scryptAsync(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, (err, derived) =>
      err ? reject(err) : resolve(derived)
    );
  });
}

/** 哈希并返回 `${saltHex}:${hashHex}` */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scryptAsync(password, salt);
  return `${salt.toString('hex')}:${derived.toString('hex')}`;
}

/** 校验密码；存储值畸形（缺冒号/非 hex/长度不符）一律返回 false，不抛错 */
export async function verifyPassword(
  stored: string,
  password: string
): Promise<boolean> {
  const separatorIndex = stored.indexOf(':');
  if (separatorIndex <= 0) return false;
  const salt = Buffer.from(stored.slice(0, separatorIndex), 'hex');
  const expected = Buffer.from(stored.slice(separatorIndex + 1), 'hex');
  if (salt.length === 0 || expected.length === 0) return false;
  const derived = await scryptAsync(password, salt);
  // 长度不同直接 false，避免 timingSafeEqual 抛错
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}
