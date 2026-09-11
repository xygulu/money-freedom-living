import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import generated from '@/generated/content.json';
import { screenKeywords, referralMessage } from '@/lib/safety';
import type { SafetyKeywords } from '@/lib/content';
import type { Locale } from '@/i18n/config';

// 抽检集进 CI（docs/03 §6）：粗筛召回必须 100%（召回优先、误报可接受），
// none 样本不得被关键词误杀（误报由 LLM 语义确认兜，但宽到杀 none 就是词表写坏了）。
// LLM 语义确认的真实验证在 M8 危机抽检（Go/No-Go 门），CI 只验证词表网。
const LOCALES: Locale[] = ['en', 'zh-CN'];

interface Fixtures {
  crisis: string[];
  domesticViolence: string[];
  none: string[];
}

const keywordsByLocale = generated.safety as unknown as Record<string, { keywords: SafetyKeywords }>;
const fixturesByLocale = Object.fromEntries(
  LOCALES.map((locale) => [
    locale,
    JSON.parse(readFileSync(join(__dirname, 'safety-fixtures', `${locale}.json`), 'utf8')) as Fixtures,
  ])
);

describe.each(LOCALES)('safety 粗筛抽检（%s）', (locale) => {
  const keywords = keywordsByLocale[locale].keywords;
  const fixtures = fixturesByLocale[locale];

  it('crisis 样本全部命中且类目正确', () => {
    for (const text of fixtures.crisis) {
      expect(screenKeywords(keywords, text), `漏检: ${text}`).toBe('crisis');
    }
  });

  it('domesticViolence 样本全部命中且类目正确', () => {
    for (const text of fixtures.domesticViolence) {
      expect(screenKeywords(keywords, text), `漏检: ${text}`).toBe('domestic_violence');
    }
  });

  it('none 样本零误杀', () => {
    for (const text of fixtures.none) {
      expect(screenKeywords(keywords, text), `误杀: ${text}`).toBeNull();
    }
  });
});

describe('转介消息（服务端定死文案，不走 LLM）', () => {
  it('en 危机转介含 988 与国际目录', () => {
    const message = referralMessage('en', 'crisis');
    expect(message).toContain('988');
    expect(message).toContain('findahelpline.com');
  });

  it('zh-CN 家暴转介含 12338，与危机类目资源区分', () => {
    const dv = referralMessage('zh-CN', 'domestic_violence');
    expect(dv).toContain('12338');
    expect(dv).not.toContain('12356');
    const crisis = referralMessage('zh-CN', 'crisis');
    expect(crisis).toContain('12356');
    expect(crisis).not.toContain('12338');
  });
});
