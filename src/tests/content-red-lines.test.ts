// C4/U9 内容红线显式条款（2026-09-24）：此前只有"泛化创伤"软约束，
// 三条硬边界——①不提供投资/税务/法律建议 ②不鼓励借贷 ③不主动深挖童年——
// 现为 SAFETY_RULES（对话 + 弹层共享）的显式明文。本测试把"显式"钉死：
// 四语缺任何一条 = 红线在那一语上不成立。
import { describe, expect, it } from 'vitest';
import { SAFETY_RULES } from '@/lib/prompt';
import { buildJournalReplySystem } from '@/lib/journal';
import type { Locale } from '@/i18n/config';

const LOCALES: Locale[] = ['en', 'zh-CN', 'zh-TW', 'ja'];

// 每条红线在四语里的判别词（手动核对过各语文本；改文案时这里同步改）
const RED_LINES: { name: string; match: RegExp }[] = [
  { name: '① 不提供投资/税务/法律建议', match: /(investment|投资|投資|投資)/ },
  { name: '① 附：税务', match: /(tax|税务|稅務|税務)/ },
  { name: '① 附：法律', match: /(legal|法律)/ },
  { name: '② 不鼓励借贷', match: /(borrowing|借贷|借貸|借金)/ },
  { name: '③ 不主动深挖童年', match: /(childhood|童年|童年|幼少期)/ },
];

describe('SAFETY_RULES 内容红线显式条款（C4/U9）', () => {
  for (const locale of LOCALES) {
    it(`${locale}: 三条红线全部显式存在`, () => {
      const text = SAFETY_RULES[locale];
      for (const line of RED_LINES) {
        expect(text, `${locale} 缺 ${line.name}`).toMatch(line.match);
      }
    });
  }

  it('红线仍是最高优先级块（标题不被削弱）', () => {
    for (const locale of LOCALES) {
      expect(SAFETY_RULES[locale]).toMatch(/^## /m);
    }
  });
});

describe('journal 回应提示词同批补齐', () => {
  it('禁止清单含借贷与童年两条', () => {
    const text = buildJournalReplySystem('zh-CN');
    expect(text).toContain('借贷');
    expect(text).toContain('童年');
  });
});
