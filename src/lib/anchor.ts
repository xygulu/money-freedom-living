/**
 * 周期情绪锚点（docs/02 §5）：发薪日因国家/公司而异——默认不猜，用户自设
 * （monthly = 每月某日；weekly/biweekly = 每周/双周的某天，day 存 0-6，0 = 周日）。
 * 锚点日当天旅程页被动呈现一句感知文案；Web Push（v1.5）后才变主动。
 * 与全站"今天"语义一致，按 UTC 判断。
 */
export interface Payday {
  type: 'monthly' | 'biweekly' | 'weekly';
  day?: number;
}

export function isAnchorDay(payday: Payday, now: Date = new Date()): boolean {
  if (payday.type === 'monthly') {
    return payday.day != null && payday.day >= 1 && payday.day <= 28 && now.getUTCDate() === payday.day;
  }
  if (payday.day == null || payday.day < 0 || payday.day > 6) return false;
  if (now.getUTCDay() !== payday.day) return false;
  if (payday.type === 'weekly') return true;
  // 双周：相位无基准（无从得知公司双周薪起算周），用 epoch 周数偶数近似，
  // 产品语义上"约每两周想起一次"即达标
  const epochWeek = Math.floor((now.getTime() / 86_400_000 + 4) / 7); // 1970-01-01 是周四
  return epochWeek % 2 === 0;
}

/** 校验请求体里的锚点设置；null = 清除。不合法返回 null（调用方自行区分语义） */
export function parsePaydayInput(input: unknown): Payday | null | undefined {
  if (input === null) return null;
  if (typeof input !== 'object') return undefined;
  const { type, day } = input as { type?: unknown; day?: unknown };
  if (type !== 'monthly' && type !== 'biweekly' && type !== 'weekly') return undefined;
  if (type === 'monthly') {
    if (typeof day !== 'number' || !Number.isInteger(day) || day < 1 || day > 28) return undefined;
    return { type, day };
  }
  if (typeof day !== 'number' || !Number.isInteger(day) || day < 0 || day > 6) return undefined;
  return { type, day };
}
