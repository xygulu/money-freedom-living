// 70-2 加固 · 版本隔离：journeyHrefFor / withJourneyHref 单测。
//
// 目的：切换 ui_version cookie 后，"回到今天这一步" 链接必须只在该版本内跳转。
// - new      → /{locale}/journey-new
// - classic  → /{locale}/journey
//
// 验证策略：
// - journeyHrefFor × 3（新/经典/默认值）
// - withJourneyHref × 10（四语各 new + classic + 不污染原 dict + 不写回原 dict）

import { describe, expect, it } from 'vitest';
import { journeyHrefFor, withJourneyHref } from '@/lib/ui-version';
import { getDict } from '@/i18n/get-dict';
import type { Dict } from '@/i18n/get-dict';

describe('journeyHrefFor', () => {
  it('new：返回 /{locale}/journey-new', () => {
    expect(journeyHrefFor('zh-CN', 'new')).toBe('/zh-CN/journey-new');
  });

  it('classic：返回 /{locale}/journey', () => {
    expect(journeyHrefFor('zh-CN', 'classic')).toBe('/zh-CN/journey');
  });

  it('四语一致：new + classic 各语种都返回正确 href', () => {
    const locales: Array<'en' | 'zh-CN' | 'zh-TW' | 'ja'> = ['en', 'zh-CN', 'zh-TW', 'ja'];
    for (const locale of locales) {
      expect(journeyHrefFor(locale, 'new')).toBe(`/${locale}/journey-new`);
      expect(journeyHrefFor(locale, 'classic')).toBe(`/${locale}/journey`);
    }
  });
});

describe('withJourneyHref', () => {
  const locales: Array<'en' | 'zh-CN' | 'zh-TW' | 'ja'> = ['en', 'zh-CN', 'zh-TW', 'ja'];

  for (const locale of locales) {
    it(`${locale} + new：注入 nav.journeyHref = /${locale}/journey-new`, () => {
      const base = getDict(locale);
      const out = withJourneyHref(base, locale, 'new');
      expect(out.nav.journeyHref).toBe(`/${locale}/journey-new`);
    });

    it(`${locale} + classic：注入 nav.journeyHref = /${locale}/journey`, () => {
      const base = getDict(locale);
      const out = withJourneyHref(base, locale, 'classic');
      expect(out.nav.journeyHref).toBe(`/${locale}/journey`);
    });
  }

  it('返回新对象：不写回原 dict（不污染静态字典）', () => {
    const base = getDict('zh-CN');
    const before = base.nav.journeyHref;
    const out = withJourneyHref(base, 'zh-CN', 'new');
    expect(out).not.toBe(base); // 新对象引用
    expect(out.nav).not.toBe(base.nav); // nav 段也是新对象
    expect(base.nav.journeyHref).toBe(before); // 原 dict 未被改写
  });

  it('保留 dict 其它段（nav 其它键 + 其它段不变）', () => {
    const base = getDict('zh-CN');
    const out = withJourneyHref(base, 'zh-CN', 'new');
    // nav 其它键保留
    expect(out.nav.journey).toBe(base.nav.journey);
    expect(out.nav.chat).toBe(base.nav.chat);
    expect(out.nav.journal).toBe(base.nav.journal);
    expect(out.nav.me).toBe(base.nav.me);
    // 其它段（顶层键）原样引用
    expect(out.companion).toBe(base.companion);
    expect(out.me).toBe(base.me);
    expect(out.newJourney).toBe(base.newJourney);
  });

  it('与 journeyHrefFor 输出等价（双函数不会跑偏）', () => {
    const base = getDict('en');
    expect(withJourneyHref(base, 'en', 'new').nav.journeyHref).toBe(journeyHrefFor('en', 'new'));
    expect(withJourneyHref(base, 'en', 'classic').nav.journeyHref).toBe(journeyHrefFor('en', 'classic'));
  });

  it('不破坏 Dict 类型契约（仍满足 Dict 类型）', () => {
    const base: Dict = getDict('zh-CN');
    const out: Dict = withJourneyHref(base, 'zh-CN', 'classic');
    // 类型层断言：仍能按 Dict 读取任意顶层键
    expect(out.newJourney.actChoices).toBeDefined();
    expect(out.companion.chatMode).toBeDefined();
    expect(out.archivePage).toBeDefined();
  });
});
