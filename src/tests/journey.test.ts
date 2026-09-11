import { describe, expect, it } from 'vitest';
import { getJourneyStage, pickDaily, pickExercise } from '@/lib/content';
import { buildLetterReplySystem } from '@/lib/letters';
import { buildJournalReplySystem } from '@/lib/journal';
import type { Locale } from '@/i18n/config';

const locale: Locale = 'zh-CN';
const key = 'g:a'.padEnd(34, '0');

describe('pickExercise（今日微行动确定性抽取）', () => {
  it('同一天同一用户同一阶段 → 同一条', () => {
    const a = pickExercise(locale, '2026-09-11', 3, key);
    const b = pickExercise(locale, '2026-09-11', 3, key);
    expect(a).not.toBeNull();
    expect(a).toBe(b);
  });

  it('不同用户同一天可以拿到不同练习（不制造"全班作业"感）', () => {
    const pool = new Set(
      Array.from({ length: 12 }, (_, i) => pickExercise(locale, '2026-09-11', 3, `g:user${i}`.padEnd(34, '0')))
    );
    // 12 个不同 key 至少散到 2 条（哈希均匀性下限，防退化成恒定第一条）
    expect(pool.size).toBeGreaterThanOrEqual(2);
  });

  it('练习一定来自当前阶段的 exercises', () => {
    const stage3 = pickExercise(locale, '2026-09-11', 3, key);
    expect(stage3).toBeTypeOf('string');
    // 阶段内容里确实存在这条（exercises 白名单）
    const exercises = getJourneyStage(locale, 3)?.exercises ?? [];
    expect(exercises).toContain(stage3);
  });
});

describe('pickDaily seenTexts 去重（90 天不重复的机制侧）', () => {
  it('seen 里的签不再出现（候选未耗尽时）', () => {
    const first = pickDaily(locale, '2026-09-11', 1, []);
    const seen = pickDaily(locale, '2026-09-12', 1, first ? [first.text] : []);
    expect(seen?.text).not.toBe(first?.text);
  });
});

describe('信件/日记回应提示词红线', () => {
  it('信件回信：明确禁止分析、解读、建议，且不提问', () => {
    for (const l of ['en', 'zh-CN', 'zh-TW', 'ja'] as Locale[]) {
      const sys = buildLetterReplySystem(l);
      expect(sys).toContain('不分析');
      expect(sys).toContain('不解读');
      expect(sys).toContain('不给');
      expect(sys).toContain('结尾不提问');
    }
  });

  it('日记回应：禁止理财建议与诊断，要求引用具体细节', () => {
    for (const l of ['en', 'zh-CN', 'zh-TW', 'ja'] as Locale[]) {
      const sys = buildJournalReplySystem(l);
      expect(sys).toContain('理财建议');
      expect(sys).toContain('诊断');
      expect(sys).toContain('具体细节');
    }
  });
});
