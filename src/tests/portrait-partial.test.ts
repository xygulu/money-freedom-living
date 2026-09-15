/**
 * PortraitLockedCard 单测：i18n 4 语 × 2 section 完整覆盖（8 用例）。
 *
 * 用户 2026-09-14 拍板：访客访问 /portrait 时，AI 推断段（"我听到的可能" +
 * "给未来的你"）替换为锁卡——文案必须每语都有，且 lock 段 CTA 都用同一条。
 *
 * 测试方法：从各语 i18n 字典里取 portrait.locked[section] 的三件套
 * （eyebrow/title/body）+ cta，断言非空（覆盖所有 4 语 × 2 section）。
 */
import { describe, expect, it } from 'vitest';
import { getDict } from '@/i18n/get-dict';

const LOCALES = ['zh-CN', 'en', 'zh-TW', 'ja'] as const;
const SECTIONS = ['script', 'toFuture'] as const;

describe('portrait.locked i18n 完整覆盖（访客画像 partial 锁卡）', () => {
  for (const locale of LOCALES) {
    for (const section of SECTIONS) {
      it(`[${locale}] portrait.locked.${section}.{eyebrow,title,body} 三件套 + cta 都非空`, () => {
        const dict = getDict(locale);
        const locked = dict.portrait.locked[section];
        expect(locked.eyebrow.length, `${locale}/${section}.eyebrow`).toBeGreaterThan(0);
        expect(locked.title.length, `${locale}/${section}.title`).toBeGreaterThan(0);
        expect(locked.body.length, `${locale}/${section}.body`).toBeGreaterThan(0);
        expect(dict.portrait.locked.cta.length, `${locale}/locked.cta`).toBeGreaterThan(0);
      });
    }
  }
});

describe('portrait.guestBanner i18n 完整覆盖', () => {
  for (const locale of LOCALES) {
    it(`[${locale}] portrait.guestBanner 非空`, () => {
      const dict = getDict(locale);
      expect(dict.portrait.guestBanner.length).toBeGreaterThan(0);
    });
  }
});

describe('landing.hook + cta* 4 语完整覆盖', () => {
  for (const locale of LOCALES) {
    it(`[${locale}] landing.hook + hookSub + ctaTest + ctaPortrait + ctaSignIn 都非空`, () => {
      const dict = getDict(locale);
      expect(dict.landing.hook.length, `${locale}/hook`).toBeGreaterThan(0);
      expect(dict.landing.hookSub.length, `${locale}/hookSub`).toBeGreaterThan(0);
      expect(dict.landing.ctaTest.length, `${locale}/ctaTest`).toBeGreaterThan(0);
      expect(dict.landing.ctaPortrait.length, `${locale}/ctaPortrait`).toBeGreaterThan(0);
      expect(dict.landing.ctaSignIn.length, `${locale}/ctaSignIn`).toBeGreaterThan(0);
    });
  }
});