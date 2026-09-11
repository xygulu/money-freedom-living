import { getSql } from './db';

/**
 * 注册迁移（docs/03 §4）：游客以 g:<cookieId> 攒下的档案，登录后整体搬到
 * u:<userId> 名下——"旅程跟着账号走"的兑现动作。
 *
 * 幂等与冲突策略：
 * - growth_profiles 主键是 user_key：若账号已有档案（老账号回归），保留账号档案、
 *   放弃游客档案（DO NOTHING）；其余表无唯一约束，直接 UPDATE
 * - 迁移过的 (guestKey → userKey) 组合记进程内缓存，后续请求零 DB 开销；
 *   缓存丢失最坏是多跑几条 0 行 UPDATE，结果不变
 * - quota_events 不迁：配额是"当日"语义（键含 day），跨天基本清零，不迁移不吃亏
 */

const migrated = new Set<string>();

export async function migrateGuestData(guestKey: string, userKey: string): Promise<void> {
  if (guestKey === userKey || !guestKey.startsWith('g:') || !userKey.startsWith('u:')) return;
  const cacheKey = `${guestKey}->${userKey}`;
  if (migrated.has(cacheKey)) return;

  const sql = getSql();
  // 1. 档案：账号还没有档案 → 直接换主键名（连画像/足迹/记忆一起搬）；
  //    账号已有档案（老账号回归）→ 保留账号档案，游客档案删除（孤儿数据不留）
  const hasTarget = await sql`SELECT 1 FROM growth_profiles WHERE user_key = ${userKey} LIMIT 1`;
  if (hasTarget.length === 0) {
    await sql`UPDATE growth_profiles SET user_key = ${userKey}, updated_at = now() WHERE user_key = ${guestKey}`;
  } else {
    await sql`DELETE FROM growth_profiles WHERE user_key = ${guestKey}`;
  }
  // 2. 其余表：无唯一约束，直接换 key（0 行 = 游客期没产生数据，同样幂等）。
  //    表名是上面白名单常量（Neon HTTP 驱动不支持标识符参数化，但这里无外部输入）
  await sql`UPDATE chat_sessions SET user_key = ${userKey} WHERE user_key = ${guestKey}`;
  await sql`UPDATE journal_entries SET user_key = ${userKey} WHERE user_key = ${guestKey}`;
  await sql`UPDATE safety_events SET user_key = ${userKey} WHERE user_key = ${guestKey}`;
  await sql`UPDATE events SET user_key = ${userKey} WHERE user_key = ${guestKey}`;
  await sql`UPDATE consent_records SET user_key = ${userKey} WHERE user_key = ${guestKey}`;

  migrated.add(cacheKey);
}

/** 测试钩子：清空进程内迁移缓存 */
export function _resetMigrateCache(): void {
  migrated.clear();
}
