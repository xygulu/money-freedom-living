import { describe, expect, it, vi } from 'vitest';
import { getBookLamps, getDailyPool, localizedText, pickDaily } from '@/lib/content';
import {
  actionEvidenceKinds,
  computeStageProgress,
  lampsFor,
  stageAdvanceTarget,
  stageLampScales,
} from '@/lib/stage';
import { validateAssessment } from '@/lib/assess';
import type { GrowthProfile } from '@/lib/profile';

// V0.2 B4（docs/02 §20.2）：灯表在内容层（content/books/<id>/lamps.md），未知书显式报错。
// v1 只有一本书，这里用内容 fixture 造两本，守换书那一刻的三件事：
// ① 各判各的（旧书的灯 kind 进不了新书的评估）；② 旧书亮过的灯不会熄；
// ③ 段数、灯图、推进判定、行动硬闸、每日一签都按当前这本书算。
// books.test.ts 守"不传 bookId = v1 零变化"，这里守"传了就真按那本书算"。

const fixture = vi.hoisted(() => {
  const stageMd = (id: number, title: string) => ({
    id,
    title,
    goal: '',
    weeks: 1,
    exercises: [],
    ai_stance: { do: [], dont: [] },
    advance_when: [],
    ritual: '',
    body: '',
  });
  // 书 A：两段；段 1 两盏灯（段 2 故意不配灯——认识的书缺段就是没灯，不借别家的）
  const bookA = {
    stages: [stageMd(1, '看见'), stageMd(2, '松动')],
    lamps: {
      1: [
        {
          kind: 'a1_see',
          label: { en: 'Seeing A', 'zh-CN': '看见甲' },
          hint: { en: 'the standard of a1_see' },
          promptHint: '内部备注：甲灯怎么判',
          needsAction: false,
          topic: 'self-worth',
        },
        {
          kind: 'a1_do',
          label: { en: 'Doing A' },
          hint: { en: 'the standard of a1_do' },
          promptHint: '内部备注：乙灯怎么判',
          needsAction: true,
          topic: 'allowing',
        },
      ],
    },
    daily: [
      { text: '签·甲', type: 'observation', stages: [1], reflection: '' },
      { text: '签·乙', type: 'practice', stages: [1], reflection: '' },
    ],
  };
  // 书 B：两段，只有段 1 配了一盏灯（kind 与书 A 零交集；段 2 无灯所以推进判定不涉及它）
  const bookB = {
    stages: [stageMd(1, '落地'), stageMd(2, '走远')],
    lamps: {
      1: [
        {
          kind: 'b1_act',
          label: { en: 'B lamp', ja: 'Bの灯' },
          hint: { en: 'the standard of b1_act' },
          promptHint: '内部备注：丙灯怎么判',
          needsAction: true,
          topic: 'money-safety',
        },
      ],
    },
    daily: [
      { text: '签·乙', type: 'observation', stages: [1], reflection: '' },
      { text: '签·丙', type: 'way', stages: [1], reflection: '' },
    ],
  };
  const meta = (id: string) => ({
    id,
    title: { en: id, 'zh-CN': id },
    author: '',
    source: '',
    topics: [],
    status: 'active',
    note: '',
  });
  return {
    books: [meta('test-a'), meta('test-b')],
    journey: {
      'test-a': { 'zh-CN': bookA.stages },
      'test-b': { 'zh-CN': bookB.stages },
    },
    daily: {
      'test-a': { 'zh-CN': bookA.daily },
      'test-b': { 'zh-CN': bookB.daily },
    },
    lamps: {
      'test-a': { 1: bookA.lamps[1] },
      'test-b': { 1: bookB.lamps[1] },
    },
    practices: [],
    safety: {},
    builtAt: '2026-09-20T00:00:00Z',
  };
});

vi.mock('@/generated/content.json', () => ({ default: fixture }));

// C3 起运行时优先读磁盘 content.json——本测试要用上面的 fixture，就得让磁盘读取
// 失败（抛错），装载层才回落到这份被 mock 的「打包副本」。语义与 C3 之前的测试一致。
vi.mock('node:fs', () => ({
  readFileSync: () => {
    throw new Error('ENOENT (test fixture): lamps.test 用 mock 的 content.json，不读磁盘');
  },
}));

const BOOK_A = 'test-a';
const BOOK_B = 'test-b';

const p = (over: Partial<GrowthProfile> = {}): GrowthProfile =>
  ({
    user_key: 'u:lamps-test',
    locale: 'zh-CN',
    portrait: null,
    concerns: [],
    stage: 1,
    stage_started_at: '2026-09-01T00:00:00Z',
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
    },
    created_at: '2026-08-01T00:00:00Z',
    dailySeen: [],
    payday: null,
    total_active_days: 0,
    last_active_date: null,
    books: [],
    threads: {},
    touch: {},
    ...over,
  }) as GrowthProfile;

const draftFor = (kinds: string[]) => ({
  actualStage: 1,
  lamps: kinds.map((kind) => ({ kind, lit: false, evidence: '' })),
  summary: '这是一段够长的评估总结，用来通过长度校验的下限要求。',
  diagnosis: '他现在在这里，是因为旧脚本还在替他做决定，这一段还没走完。',
  distance: '离「一辈子不愁钱的活法」还有一段，先把看见这件事坐实。',
  nextHint: '今天先记一件真实发生的小事。',
  actions: ['写下今天最想说却没说的那一句'],
});

describe('换书时的灯：各判各的，谁也不熄谁', () => {
  it('旧书的灯 kind 进不了新书的评估（换书 = 换路线图）', () => {
    const aKinds = lampsFor(BOOK_A, 1).map((r) => r.kind);
    const bKinds = lampsFor(BOOK_B, 1).map((r) => r.kind);
    expect(bKinds.some((k) => aKinds.includes(k))).toBe(false);
    // 拿书 A 的灯去判书 B → 判不过；拿书 B 自己的灯 → 判得过
    expect(validateAssessment(draftFor(aKinds), 1, true, BOOK_B)).toBeNull();
    expect(validateAssessment(draftFor(bKinds), 1, true, BOOK_B)).not.toBeNull();
    // 反过来也一样：书 A 还是按书 A 的灯判，没被书 B 影响
    expect(validateAssessment(draftFor(bKinds), 1, true, BOOK_A)).toBeNull();
    expect(validateAssessment(draftFor(aKinds), 1, true, BOOK_A)).not.toBeNull();
  });

  it('旧书亮过的灯不会因为换书熄掉：心印按 kind 存，新书判的是另一批 kind', () => {
    const earned = lampsFor(BOOK_A, 1).map((r) => r.kind); // 书 A 里亮过的
    const judgedNow = new Set(lampsFor(BOOK_B, 1).map((r) => r.kind)); // 书 B 这次要判的
    expect(earned.some((k) => judgedNow.has(k))).toBe(false); // 碰都碰不到 → 熄不掉
  });

  it('认识的书缺某段 → 那段就是没灯；不认识的整本书 → 显式报错（红线 6）', () => {
    // 书 A 的第 2 段没配灯：不借任何别家的来判
    expect(lampsFor(BOOK_A, 2)).toEqual([]);
    // 整本不认识 → 宁可炸也不静默拿 v1 的标准判人
    expect(() => lampsFor('no-such-book', 1)).toThrow(/no-such-book/);
    expect(getBookLamps('no-such-book')).toBeNull();
  });
});

describe('灯的形状与文案属于书（U6）', () => {
  it('computeStageProgress 按书画 checks：kind、数量、文案都来自这一本的灯表', () => {
    const progress = computeStageProgress('zh-CN', 1, p(), BOOK_B);
    expect(progress.checks.map((c) => c.kind)).toEqual(['b1_act']);
    expect(progress.litCount).toBe(0);
    // 文案从灯表按 locale 解析：ja 直取；zh-CN 缺失回落 en（灯名永不空白）
    expect(progress.checks[0].label).toBe('B lamp');
    const ja = computeStageProgress('ja', 1, p(), BOOK_B);
    expect(ja.checks[0].label).toBe('Bの灯');
    // 书 A 的第一盏 zh-CN 直取
    expect(computeStageProgress('zh-CN', 1, p(), BOOK_A).checks[0].label).toBe('看见甲');
  });

  it('localizedText 的回落顺序：目标语言 → en → 调用方兜底', () => {
    expect(localizedText({ ja: 'Bの灯', en: 'B lamp' }, 'zh-CN', '兜底')).toBe('B lamp');
    expect(localizedText({ ja: 'Bの灯' }, 'zh-CN', '兜底')).toBe('兜底');
    expect(localizedText(undefined, 'zh-CN', '兜底')).toBe('兜底');
  });

  it('行动类硬闸认的也是这本书的 kind——不会拿上一本的 kind 去要证据', () => {
    expect(actionEvidenceKinds(1, BOOK_A)).toEqual(['a1_do']);
    expect(actionEvidenceKinds(1, BOOK_B)).toEqual(['b1_act']);
    expect(actionEvidenceKinds(1, BOOK_B).some((k) => actionEvidenceKinds(1, BOOK_A).includes(k))).toBe(false);
  });
});

describe('灯图与推进按书画（段数属于书）', () => {
  it('灯图按书画：书 A 两段（第 2 段无灯）、书 B 两段（只有段 1 有灯），都不拿 v1 的 4 段凑', () => {
    const profile = p();
    expect(stageLampScales(profile, BOOK_A)).toEqual([
      { id: 1, lit: 0, total: 2 },
      { id: 2, lit: 0, total: 0 },
    ]);
    expect(stageLampScales(profile, BOOK_B)).toEqual([
      { id: 1, lit: 0, total: 1 },
      { id: 2, lit: 0, total: 0 },
    ]);
  });

  it('下一段开没开也按这本书的灯判：亮了谁家的灯，只有在谁家的路线图上才算数', () => {
    const lit = (kinds: string[]) => ({
      ...p().assessment,
      confirmed: {
        actualStage: 1,
        lamps: kinds.map((kind) => ({ kind, lit: true, evidence: '真做过一次' })),
        summary: 's',
        diagnosis: 'd',
        distance: 'x',
        nextHint: 'n',
        actions: [],
      },
      confirmedAt: '2026-09-02T00:00:00Z',
    });
    const aKinds = lampsFor(BOOK_A, 1).map((r) => r.kind);
    const bKinds = lampsFor(BOOK_B, 1).map((r) => r.kind);
    // 只亮了书 A 的灯 → 在书 B 的路线图上还没走完这一段
    expect(stageAdvanceTarget(p({ assessment: lit(aKinds) as never }), BOOK_B)).toBeNull();
    // 亮的是书 B 自己的那一盏 → 往下开一段
    expect(stageAdvanceTarget(p({ assessment: lit(bKinds) as never }), BOOK_B)).toBe(2);
    // 同一份"全亮"结论挪回书 A 的路线图：书 A 有两盏 → 也推进（各判各的，互不亏欠）
    expect(stageAdvanceTarget(p({ assessment: lit(aKinds) as never }), BOOK_A)).toBe(2);
  });
});

describe('每日一签：池子按书各出各的，看过的却是全局去重', () => {
  it('同一句话换了一本书不会当成新的再发一遍', () => {
    const first = pickDaily('zh-CN', '2026-09-10', 1, [], BOOK_A)!;
    expect(first).toBeTruthy();
    // 把书 A 里看过的那句拿到书 B 的池子里——两池有交集（签·乙），交集必须出局
    const again = pickDaily('zh-CN', '2026-09-10', 1, [first.text], BOOK_B);
    expect(again).not.toBeNull();
    expect(again!.text).not.toBe(first.text);
  });

  it('不认识的书没有池子：返回 null（不借 v1 的签充数）', () => {
    expect(getDailyPool('zh-CN', 'no-such-book')).toEqual([]);
    expect(pickDaily('zh-CN', '2026-09-10', 1, [], 'no-such-book')).toBeNull();
  });
});
