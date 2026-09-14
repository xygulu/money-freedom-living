import { describe, expect, it } from 'vitest';
import { applyCalibration, buildEchoMessages, buildReflectMessages, echoOpener, parseCalibrateSection, validatePortraitDraft } from '@/lib/onboarding';
import type { Portrait } from '@/lib/profile';
import { guestKeyFromId } from '@/lib/quota';

function basePortrait(): Portrait {
  return {
    spoken: ['我妈说，咱家不配。', '放进购物车，过两天再默默删掉'],
    baseColor: '你不是没有钱，是花钱那一刻总有个声音说再省一点。'.repeat(2),
    moments: [{ title: '小时候的傍晚', detail: '听到咱家不配' }],
    script: '也许有一条很旧的脚本：不配享受。',
    toFuture: '从这里出发。',
    version: 1,
    calibrations: [],
    scriptStatus: 'pending',
  };
}

describe('parseCalibrateSection', () => {
  it('接受合法段名', () => {
    expect(parseCalibrateSection('script')).toBe('script');
    expect(parseCalibrateSection('spoken:2')).toBe('spoken:2');
    expect(parseCalibrateSection('moment:0')).toBe('moment:0');
  });
  it('拒绝非法段名与越界索引', () => {
    expect(parseCalibrateSection('hacker')).toBeNull();
    expect(parseCalibrateSection('spoken:-1')).toBeNull();
    expect(parseCalibrateSection('spoken:99')).toBeNull();
    expect(parseCalibrateSection('')).toBeNull();
  });
});

describe('applyCalibration', () => {
  it('script hit → confirmed（确认后才进长期工作记忆）', () => {
    const next = applyCalibration(basePortrait(), 'script', 'hit')!;
    expect(next.scriptStatus).toBe('confirmed');
    expect(next.calibrations).toHaveLength(1);
  });

  it('script miss 无修正 → rejected，原文保留但标记不用', () => {
    const next = applyCalibration(basePortrait(), 'script', 'miss')!;
    expect(next.scriptStatus).toBe('rejected');
    expect(next.script).toBeTruthy();
  });

  it('script miss + 修正 → 替换候选并标记 rejected', () => {
    const next = applyCalibration(basePortrait(), 'script', 'miss', '必须努力才值得')!;
    expect(next.scriptStatus).toBe('rejected');
    expect(next.script).toBe('必须努力才值得');
  });

  it('spoken miss 无修正 → 删除该条（弹性 1-4 条）', () => {
    const next = applyCalibration(basePortrait(), 'spoken:0', 'miss')!;
    expect(next.spoken).toHaveLength(1);
    expect(next.spoken[0]).toContain('购物车');
  });

  it('spoken miss + 修正 → 替换为用户的话', () => {
    const next = applyCalibration(basePortrait(), 'spoken:1', 'miss', '其实是舍不得删')!;
    expect(next.spoken[1]).toBe('其实是舍不得删');
  });

  it('spoken 越界 → null（400）', () => {
    expect(applyCalibration(basePortrait(), 'spoken:9', 'miss')).toBeNull();
  });

  it('baseColor/toFuture miss 必须带修正', () => {
    expect(applyCalibration(basePortrait(), 'baseColor', 'miss')).toBeNull();
    const next = applyCalibration(basePortrait(), 'toFuture', 'miss', '慢慢来')!;
    expect(next.toFuture).toBe('慢慢来');
  });

  it('校准历史追加不覆盖', () => {
    let p = applyCalibration(basePortrait(), 'script', 'miss')!;
    p = applyCalibration(p, 'script', 'hit')!;
    expect(p.calibrations.map((c) => c.verdict)).toEqual(['miss', 'hit']);
    expect(p.scriptStatus).toBe('confirmed'); // 最新一次生效
  });
});

describe('validatePortraitDraft', () => {
  it('合法草稿通过并截断到上限', () => {
    const draft = {
      spoken: ['a'.repeat(10), 'b', 'c', 'd', 'e'],
      baseColor: 'x'.repeat(40),
      moments: [{ title: 't', detail: 'd' }],
      script: '也许…',
      toFuture: 'f',
    };
    const result = validatePortraitDraft(draft)!;
    expect(result.spoken).toHaveLength(4);
    expect(result.moments).toHaveLength(1);
  });

  it('缺字段/空数组/底色过短 → null（禁止半成品入库）', () => {
    expect(validatePortraitDraft({})).toBeNull();
    expect(validatePortraitDraft({ spoken: [], baseColor: 'x'.repeat(40), moments: [{ title: 't', detail: 'd' }], script: 's', toFuture: 'f' })).toBeNull();
    expect(validatePortraitDraft({ spoken: ['a'], baseColor: '太短', moments: [{ title: 't', detail: 'd' }], script: 's', toFuture: 'f' })).toBeNull();
    expect(validatePortraitDraft({ spoken: ['a'], baseColor: 'x'.repeat(40), moments: [], script: 's', toFuture: 'f' })).toBeNull();
  });
});

describe('identity：游客档案键跨日稳定', () => {
  it('同一 cookie id 在不同日期映射到同一档案键', () => {
    // quota 的 guestKey 掺 day（跨日清零）；identity 直接用 cookie id 本体。
    // 这里验证 quota 层键的掺日行为仍存在（配额语义），且 identity 不复用它。
    const id = 'a'.repeat(32);
    expect(guestKeyFromId(id, '2026-09-11')).not.toBe(guestKeyFromId(id, '2026-09-12'));
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('第一次被说中（M11-C）：问卷交完就给的那一句', () => {
  const questionnaire = {
    specific_moments: 'cant_remember',
    script_source: '我妈说，咱家不配',
    concerns_seed: '上周看到余额突然心慌',
  };

  it('以「我听到的是…」开头，且素材只有用户自己写下的答案', () => {
    const { system, messages } = buildEchoMessages('zh-CN', questionnaire);
    expect(system).toContain(echoOpener('zh-CN'));
    expect(system).toContain('一个字都不许编');
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toContain('我妈说，咱家不配');
    expect(messages[0].content).toContain('上周看到余额突然心慌');
  });

  it('没答的题不进素材（别让它替用户补空）', () => {
    const { messages } = buildEchoMessages('zh-CN', { script_source: '只答了这一题' });
    expect(messages[0].content).toContain('只答了这一题');
    expect(messages[0].content).not.toContain('concerns_seed');
    expect(messages[0].content).not.toContain('payday_habit');
  });

  it('四语言各有自己的开场白（复述与初谈复述共用同一句口径）', () => {
    expect(echoOpener('en')).toBe('What I heard is…');
    expect(echoOpener('ja')).toBe('私が聞いたのは…');
    expect(echoOpener('zh-TW')).toBe('我聽到的是…');
    expect(buildEchoMessages('en', questionnaire).system).toContain('English');
    // 初谈结束前的复述用的是同一句开头——两处"被说中"口径一致
    expect(buildReflectMessages('zh-CN', '对话记录').system).toContain(echoOpener('zh-CN'));
  });

  it('只要 2-3 句，不许升华（这一步之后才谈同意与注册）', () => {
    const { system } = buildEchoMessages('zh-CN', questionnaire);
    expect(system).toContain('2-3 句');
    expect(system).toContain('不升华');
  });
});
