import { describe, expect, it } from 'vitest';
import { buildChangeListView, buildChangeListMessages, validateChangeListText } from '@/lib/changes';
import { STAGE_LAMPS } from '@/lib/stage';
import type { GrowthProfile, StageAssessment, AssessmentLamp } from '@/lib/profile';

const NOW = '2026-09-15T00:00:00.000Z';
const daysAgo = (n: number) => new Date(Date.parse(NOW) - n * 86_400_000).toISOString();

const lampsOf = (stage: number, litKinds: string[], evidence: (k: string) => string): AssessmentLamp[] =>
  (STAGE_LAMPS[stage] ?? []).map((r) => ({ kind: r.kind, lit: litKinds.includes(r.kind), evidence: litKinds.includes(r.kind) ? evidence(r.kind) : '' }));

const assessment = (over: Partial<StageAssessment> = {}): StageAssessment => ({
  actualStage: 1,
  lamps: lampsOf(1, ['stage1_story'], (k) => `依据-${k}`),
  summary: '它看到的你。',
  diagnosis: '为什么是这里。',
  distance: '还有多远。',
  actions: ['今天留意一次心跳。'],
  nextHint: '下一阶段的样子。',
  assessedAt: daysAgo(10),
  ...over,
});

const profile = (
  over: Partial<Omit<GrowthProfile, 'assessment'>> & { assessment?: Partial<GrowthProfile['assessment']> } = {}
): GrowthProfile => {
  const { assessment, ...rest } = over;
  return {
    user_key: 'g:test',
    locale: 'zh-CN',
    portrait: null,
    concerns: [],
    stage: 2,
    stage_started_at: daysAgo(20),
    pinned: [],
    memories: [],
    experiments: [],
    letters: [],
    stamps: [],
    evolution: { dismissedAt: null, lastGeneratedAt: null, proposedSeenAt: null, generatingAt: null },
    assessment: {
      pending: null,
      confirmed: null,
      confirmedAt: null,
      dismissedAt: null,
      generatingAt: null,
      proposedSeenAt: null,
      previousConfirmed: null,
      changeList: null,
      changeListLockAt: null,
      ...assessment,
    },
    created_at: daysAgo(40),
    dailySeen: [],
    payday: null,
    total_active_days: 3,
    last_active_date: daysAgo(1),
    books: [],
    threads: {},
    touch: {},
    ...rest,
  };
};

describe('buildChangeListView（变化清单派生视图：零 schema，纯函数）', () => {
  it('无 confirmed / confirmedAt → null（页面走空态）', () => {
    expect(buildChangeListView(profile())).toBeNull();
    expect(buildChangeListView(profile({ assessment: { confirmed: assessment(), confirmedAt: null } }))).toBeNull();
  });

  it('新灯 = 本次 lit 且有依据、且上次未点亮（上次点亮的不算新——只增不减的对照）', () => {
    const prev = assessment({
      actualStage: 1,
      lamps: lampsOf(1, ['stage1_story', 'stage1_script'], (k) => `旧依据-${k}`),
      assessedAt: daysAgo(40),
    });
    const curr = assessment({
      actualStage: 1,
      lamps: lampsOf(1, ['stage1_story', 'stage1_script', 'stage1_color'], (k) => `新依据-${k}`),
    });
    const view = buildChangeListView(
      profile({ assessment: { confirmed: curr, confirmedAt: daysAgo(10), previousConfirmed: prev } })
    )!;
    expect(view.previousStage).toBe(1);
    expect(view.currentStage).toBe(1);
    expect(view.newLamps.map((l) => l.kind)).toEqual(['stage1_color']);
    expect(view.newLamps[0].evidence).toBe('新依据-stage1_color');
  });

  it('首评无 previousConfirmed：全部点亮且有依据的灯都算新；lit 无依据的灯不算新', () => {
    const curr = assessment({
      lamps: lampsOf(1, ['stage1_story', 'stage1_script'], (k) => `依据-${k}`).map((l) => (l.kind === 'stage1_script' ? { ...l, evidence: '' } : l)),
    });
    const view = buildChangeListView(profile({ assessment: { confirmed: curr, confirmedAt: daysAgo(10) } }))!;
    expect(view.previousStage).toBeNull();
    expect(view.newLamps.map((l) => l.kind)).toEqual(['stage1_story']);
  });

  it('叙述段缓存：forConfirmedAt 匹配才返回；不匹配（新确认）视为过期', () => {
    const curr = assessment();
    const confirmedAt = daysAgo(10);
    const p = profile({
      assessment: {
        confirmed: curr,
        confirmedAt,
        changeList: { text: '这段日子……', generatedAt: daysAgo(5), forConfirmedAt: confirmedAt },
      },
    });
    expect(buildChangeListView(p)!.narration?.text).toBe('这段日子……');
    const stale = profile({
      assessment: {
        confirmed: curr,
        confirmedAt,
        changeList: { text: '旧清单', generatedAt: daysAgo(20), forConfirmedAt: daysAgo(30) },
      },
    });
    expect(buildChangeListView(stale)!.narration).toBeNull();
  });
});

describe('buildChangeListMessages（叙述段 prompt：素材与红线）', () => {
  const material = {
    portrait: {
      spoken: ['钱一動我就想躲。'],
      moments: [],
      baseColor: '钱像警报。',
      script: '守不住。',
      scriptStatus: 'confirmed' as const,
      confirmedSections: [],
    },
    memories: [{ date: '2026-09-12', text: '今天没买单' }],
    journals: [],
    experiments: [{ date: '2026-09-12', action: '给自己买了不配的小东西', feeling: '心虚但轻松' }],
    letters: [],
    missCorrections: [],
  };

  it('上次评估在场（位置/当时样子/当时的灯）；无上次时用首份清单行——两者互斥', () => {
    const prev = assessment({ actualStage: 1, summary: '上次它看到的样子。', assessedAt: daysAgo(40) });
    const curr = assessment({ actualStage: 2 });
    const withPrev = buildChangeListMessages('zh-CN', material, {
      confirmed: curr, previousConfirmed: prev, newLamps: [], earnedKinds: ['stage1_story'],
    });
    expect(withPrev.system).toContain('上次在阶段 1，这次在阶段 2');
    expect(withPrev.messages[0].content).toContain('## 上一次确认的评估（位置：阶段 1）');
    expect(withPrev.messages[0].content).toContain('上次它看到的样子。');

    const first = buildChangeListMessages('zh-CN', material, {
      confirmed: curr, previousConfirmed: null, newLamps: [], earnedKinds: [],
    });
    expect(first.system).toContain('这是你的第一份清单');
    expect(first.messages[0].content).not.toContain('上一次确认的评估');
  });

  it('人称钉死：叙述段是念给他本人听的，通篇第二人称——指令与素材标题都不得用「他」带节奏', () => {
    const withPrev = buildChangeListMessages('zh-CN', material, {
      confirmed: assessment({ actualStage: 2 }), previousConfirmed: assessment({ actualStage: 1 }), newLamps: [], earnedKinds: [],
    });
    expect(withPrev.system).toContain('全程用第二人称「你」直接对他说');
    expect(withPrev.system).toContain('一处都不许出现「他/她/这位用户」这类第三人称指代');
    expect(withPrev.system).toContain('不是向第三方汇报他');
    // 指令正文（红线段之前）不得用第三人称描述他做过什么——那会把行文带成汇报口吻
    const brief = withPrev.system.slice(0, withPrev.system.indexOf('红线：'));
    expect(brief).toContain('你走到了哪里');
    expect(brief).toContain('你做过的具体的事');
    expect(brief).not.toContain('他走到了哪里');
    expect(brief).not.toContain('他做过的具体的事');
    // 素材标题同理：喂进去的抬头也是行文样板
    expect(withPrev.messages[0].content).toContain('## 体检画像（你说过的关于自己的话）');
    expect(withPrev.messages[0].content).toContain('新点亮的心印（依据是你的原话）：');
  });

  it('红线逐字在场：禁编造/不评判不打分不比较/没变化就诚实/无理财建议；长度语言感知', () => {
    const { system } = buildChangeListMessages('zh-CN', material, {
      confirmed: assessment(), previousConfirmed: null, newLamps: [], earnedKinds: [],
    });
    expect(system).toContain('禁止编造');
    expect(system).toContain('不评判、不打分、不比较');
    expect(system).toContain('没变化就说没变化');
    expect(system).toContain('不出现任何理财建议');
    expect(system).toContain('150-400 字');
    const en = buildChangeListMessages('en', material, {
      confirmed: assessment(), previousConfirmed: null, newLamps: [], earnedKinds: [],
    }).system;
    expect(en).toContain('100-250 words');
    expect(en).toContain('English');
  });

  it('新灯依据进 user 消息；没有新灯时明说（不许编）', () => {
    const lamps = buildChangeListMessages('zh-CN', material, {
      confirmed: assessment(),
      previousConfirmed: null,
      newLamps: [{ kind: 'stage1_story', evidence: '我第一次把那件事讲了出来' }],
      earnedKinds: [],
    }).messages[0].content;
    expect(lamps).toContain('- stage1_story：我第一次把那件事讲了出来');

    const none = buildChangeListMessages('zh-CN', material, {
      confirmed: assessment(), previousConfirmed: null, newLamps: [], earnedKinds: [],
    }).messages[0].content;
    expect(none).toContain('这次没有新点亮的灯');
  });
});

describe('validateChangeListText（叙述段结构边界）', () => {
  it('非字符串 / 过短（<30）/ 超长（>3000）判失败；trim 后合法文本通过', () => {
    expect(validateChangeListText(42)).toBeNull();
    expect(validateChangeListText('太短了')).toBeNull();
    expect(validateChangeListText('x'.repeat(3001))).toBeNull();
    const ok = ` ${'这段日子，你把心里的话一句句说了出来，做的事也一件件记下了。'.repeat(1)} `;
    expect(validateChangeListText(ok)!.length).toBeLessThanOrEqual(3000);
    expect(validateChangeListText(ok)).not.toContain('\n ');
  });
});
