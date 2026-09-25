import { describe, expect, it } from 'vitest';
import { DEFAULT_BOOK_ID, formatBookTitles, getDailyPool, getJourneyStage, getJourneyStages, getPracticesForStage, pickDaily } from '@/lib/content';

const ENABLED = ['en', 'zh-CN'] as const;

describe('journey 内容', () => {
  it.each(ENABLED)('%s 有完整四阶段', (locale) => {
    const stages = getJourneyStages(locale);
    expect(stages.map((s) => s.id).sort()).toEqual([1, 2, 3, 4]);
    for (const s of stages) {
      expect(s.title).toBeTruthy();
      expect(s.goal).toBeTruthy();
      expect(s.weeks).toBeGreaterThan(0);
      expect(s.exercises.length).toBeGreaterThan(0);
      expect(s.ai_stance.do.length).toBeGreaterThan(0);
      expect(s.ai_stance.dont.length).toBeGreaterThan(0);
      expect(s.advance_when.length).toBeGreaterThan(0);
      expect(s.body.length).toBeGreaterThan(100); // system prompt 原料不能是空壳
    }
  });

  it.each(ENABLED)('%s journey M10 可选字段合法：topics 枚举、free_alt 非空、skippable 布尔', (locale) => {
    const TOPICS = ['self-worth', 'parents', 'inner-turmoil', 'boundaries', 'money-safety', 'allowing'];
    for (const s of getJourneyStages(locale)) {
      if (s.topics !== undefined) {
        expect(s.topics.length).toBeGreaterThan(0);
        for (const t of s.topics) expect(TOPICS).toContain(t);
      }
      if (s.free_alt !== undefined) expect(s.free_alt.trim().length).toBeGreaterThan(0);
      if (s.skippable !== undefined) expect(typeof s.skippable).toBe('boolean');
    }
    // 阶段 1 的回忆功课可永远跳过；阶段 2 的花钱实验必须给 0 元替代版
    expect(getJourneyStage(locale, 1)?.skippable).toBe(true);
    expect(getJourneyStage(locale, 2)?.free_alt?.trim().length ?? 0).toBeGreaterThan(0);
  });

  it('按 id 可取单阶段', () => {
    expect(getJourneyStage('zh-CN', 3)?.title).toBe('练习');
    expect(getJourneyStage('en', 4)?.title).toBe('Living');
    expect(getJourneyStage('zh-CN', 99)).toBeNull();
  });

  it('未开放语言不返回内容', () => {
    expect(getJourneyStages('ja')).toEqual([]);
    expect(getJourneyStages('zh-TW')).toEqual([]);
  });
});

describe('一签素材池', () => {
  it.each(ENABLED)('%s 备量 ≥90 且无重复', (locale) => {
    const pool = getDailyPool(locale);
    expect(pool.length).toBeGreaterThanOrEqual(90);
    expect(new Set(pool.map((c) => c.text)).size).toBe(pool.length);
    for (const card of pool) {
      expect(['observation', 'practice', 'way']).toContain(card.type);
      expect(card.stages.length).toBeGreaterThan(0);
      expect(card.reflection).toBeTruthy();
    }
  });

  it('各开放语言条数一致（结构对齐）', () => {
    const counts = ENABLED.map((l) => getDailyPool(l).length);
    expect(new Set(counts).size).toBe(1);
  });

  it('每个阶段都有足够的一签（≥15，避免某阶段迅速耗尽）', () => {
    for (const locale of ENABLED) {
      for (let stage = 1; stage <= 4; stage++) {
        expect(getDailyPool(locale).filter((c) => c.stages.includes(stage)).length).toBeGreaterThanOrEqual(15);
      }
    }
  });
});

describe('pickDaily 抽取机制', () => {
  it('同参数确定性：同一天同阶段拿到同一条', () => {
    const a = pickDaily('zh-CN', '2026-09-08', 1);
    const b = pickDaily('zh-CN', '2026-09-08', 1);
    expect(a?.text).toBe(b?.text);
  });

  it('日期种子分布均匀（连续 30 天无聚集）', () => {
    // stage 1 候选 24 条抽 30 天，生日碰撞下期望 distinct ≈17.5；12 是宽松下界
    const texts = new Set(
      Array.from({ length: 30 }, (_, i) => pickDaily('zh-CN', `2026-10-${String(i + 1).padStart(2, '0')}`, 1)?.text),
    );
    expect(texts.size).toBeGreaterThanOrEqual(12);
  });

  it('90 天不重复：配合 seenTexts 排除，候选耗尽前每日一签零重复', () => {
    const stage1Pool = getDailyPool('zh-CN').filter((c) => c.stages.includes(1));
    const seen: string[] = [];
    const drawn: string[] = [];
    for (let i = 0; i < stage1Pool.length; i++) {
      const day = String(i + 1).padStart(2, '0');
      const card = pickDaily('zh-CN', `2026-10-${day}`, 1, seen);
      expect(card).not.toBeNull();
      drawn.push(card!.text);
      seen.push(card!.text);
    }
    expect(new Set(drawn).size).toBe(drawn.length);
  });

  it('seenTexts 排除已看过的一签', () => {
    const pool = getDailyPool('en');
    const seen = pool.filter((c) => c.stages.includes(1)).map((c) => c.text);
    const card = pickDaily('en', '2026-09-08', 1, seen);
    expect(seen).not.toContain(card?.text); // 候选耗尽回落全阶段池
  });

  it('阶段过滤：stage 3 的签一定适配 stage 3', () => {
    for (let i = 0; i < 20; i++) {
      const card = pickDaily('zh-CN', `2026-09-${String(i + 1).padStart(2, '0')}`, 3);
      expect(card?.stages).toContain(3);
    }
  });
});

describe('pickDaily 焦点调度（V0.2 B5：设焦点优先该线，未设与今天等价）', () => {
  it('设焦点：抽到的一签一定在焦点命题线上（连续 10 天）', () => {
    for (let i = 0; i < 10; i++) {
      const day = String(i + 1).padStart(2, '0');
      const card = pickDaily('zh-CN', `2026-10-${day}`, 1, [], DEFAULT_BOOK_ID, 'inner-turmoil');
      expect(card?.topics).toContain('inner-turmoil');
    }
  });

  it('焦点线的候选全被看过：回落原逻辑（绝不因焦点返回 null）', () => {
    const pool = getDailyPool('zh-CN');
    const focusedTexts = pool
      .filter((c) => c.stages.includes(1) && c.topics.includes('inner-turmoil'))
      .map((c) => c.text);
    expect(focusedTexts.length).toBeGreaterThan(0);
    const card = pickDaily('zh-CN', '2026-10-01', 1, focusedTexts, DEFAULT_BOOK_ID, 'inner-turmoil');
    expect(card).not.toBeNull();
    // 该线的 stage-1 候选已全部看过，回落后的候选必然不在焦点线上
    expect(card?.topics).not.toContain('inner-turmoil');
  });

  it('未设焦点（undefined/null）与旧签名结果完全一致', () => {
    for (let i = 0; i < 10; i++) {
      const day = `2026-10-${String(i + 1).padStart(2, '0')}`;
      expect(pickDaily('zh-CN', day, 1, [], DEFAULT_BOOK_ID, null)?.text).toBe(pickDaily('zh-CN', day, 1)?.text);
      expect(pickDaily('zh-CN', day, 1, [], DEFAULT_BOOK_ID, undefined)?.text).toBe(pickDaily('zh-CN', day, 1)?.text);
    }
  });
});

describe('practices 通道', () => {
  it('示例笔记通过 fact/opinion 与 stage 校验', () => {
    const notes = getPracticesForStage(3);
    expect(notes.length).toBeGreaterThan(0);
    for (const n of notes) {
      expect(['fact', 'opinion']).toContain(n.type);
      expect([1, 2, 3, 4]).toContain(n.stage);
      expect(n.body.length).toBeGreaterThan(50);
    }
  });
});

describe('formatBookTitles（归属行，2026-09-24：用户需要知道在落地的是哪几本书）', () => {
  it('zh-CN/zh-TW 用《》，紧排不分隔', () => {
    expect(formatBookTitles(['一生把钱看轻', '不愁钱的活法'], 'zh-CN')).toBe('《一生把钱看轻》《不愁钱的活法》');
    expect(formatBookTitles(['一生把錢看輕'], 'zh-TW')).toBe('《一生把錢看輕》');
  });

  it('ja 用『』，en 用弯引号加逗号分隔', () => {
    expect(formatBookTitles(['一生お金に困らない生き方'], 'ja')).toBe('『一生お金に困らない生き方』');
    expect(formatBookTitles(['A', 'B'], 'en')).toBe('“A”, “B”');
  });

  it('空列表给空串（调用侧负责整行不渲染）', () => {
    for (const locale of ['zh-CN', 'zh-TW', 'ja', 'en'] as const) {
      expect(formatBookTitles([], locale)).toBe('');
    }
  });
});
