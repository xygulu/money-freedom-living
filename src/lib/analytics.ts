import { getSql } from './db';

/**
 * 匿名使用事件（docs/02 §11 验收指标的数据底座）：
 * 只存匿名 user_key（u:<uuid>/g:<随机 hex>，无 PII）、事件名、语言与脱敏元数据
 * （数值/枚举/桶，绝不放用户文本原文——P§9 日志纪律）。
 * best-effort：打点失败只记日志，绝不阻塞业务主流程。
 */
export async function track(
  userKey: string,
  name: string,
  metadata: Record<string, string | number | boolean | null> = {},
  locale?: string
): Promise<void> {
  try {
    await getSql()`
      INSERT INTO events (user_key, name, locale, metadata)
      VALUES (${userKey}, ${name}, ${locale ?? null}, ${JSON.stringify(metadata)}::jsonb)
    `;
  } catch (error) {
    console.error(`[analytics] track(${name}) failed:`, error instanceof Error ? error.message : error);
  }
}
