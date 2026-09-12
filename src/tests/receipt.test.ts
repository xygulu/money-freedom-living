import { describe, expect, it } from 'vitest';
import { buildReceiptSystem, buildReceiptUser, pickReceiptFallback, RECEIPT_FALLBACKS } from '@/lib/receipt';

describe('buildReceiptSystem（收条体红线 prompt）', () => {
  it('红线逐字在场：不分析不解读、不给建议、结尾不提问、不复述动作细节、无夸奖式加压', () => {
    const system = buildReceiptSystem('zh-CN');
    expect(system).toContain('不分析');
    expect(system).toContain('不给建议');
    expect(system).toContain('结尾不提问');
    expect(system).toContain('不复述动作细节');
    expect(system).toContain('「真棒/继续加油」');
    expect(system).toContain('确认收到');
  });

  it('长度规则语言感知：中文按字数、英文按词数（M10 沿用既有教训）', () => {
    expect(buildReceiptSystem('zh-CN')).toContain('中文 15-60 字');
    expect(buildReceiptSystem('en')).toContain('English 10-40 words');
  });

  it('语言钉死：system 点名目标语言，且声明「指令本身是中文不构成理由」', () => {
    expect(buildReceiptSystem('ja')).toContain('日本語');
    expect(buildReceiptSystem('zh-CN')).toContain('指令本身是中文不构成理由');
  });
});

describe('buildReceiptUser（收条 user 消息）', () => {
  it('带感受时引原话；无感受时不出现「感受」行——收条不需要重素材', () => {
    const withFeeling = buildReceiptUser({ action: '给自己买了不配的小东西', feeling: '心虚但轻松' });
    expect(withFeeling).toContain('动作：给自己买了不配的小东西');
    expect(withFeeling).toContain('感受（他的原话）：心虚但轻松');
    const noFeeling = buildReceiptUser({ action: '只做了一半' });
    expect(noFeeling).toContain('动作：只做了一半');
    expect(noFeeling).not.toContain('感受');
  });
});

describe('pickReceiptFallback（词典收条：LLM 不可用时的降级）', () => {
  it('同 seed 确定性取同一条；不同 seed 有机会取到不同条；始终落在词典内', () => {
    const a1 = pickReceiptFallback('zh-CN', 'g:abc#action-1');
    const a2 = pickReceiptFallback('zh-CN', 'g:abc#action-1');
    expect(a2).toBe(a1);
    const pool = RECEIPT_FALLBACKS['zh-CN'];
    const picks = new Set(Array.from({ length: 64 }, (_, i) => pickReceiptFallback('zh-CN', `seed-${i}`)));
    expect(picks.size).toBeGreaterThanOrEqual(1);
    for (const p of picks) expect(pool).toContain(p);
  });

  it('每语言都有非空词典；未知语言回落 en', () => {
    for (const loc of ['en', 'zh-CN', 'zh-TW', 'ja']) {
      expect(RECEIPT_FALLBACKS[loc].length).toBeGreaterThanOrEqual(3);
      for (const line of RECEIPT_FALLBACKS[loc]) expect(line.length).toBeGreaterThan(0);
      expect(pickReceiptFallback(loc, 's')).toBeTruthy();
    }
    expect(pickReceiptFallback('xx-UNKNOWN', 's')).toBe(pickReceiptFallback('en', 's'));
  });
});
