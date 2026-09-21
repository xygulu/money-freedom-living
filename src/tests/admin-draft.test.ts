// C4 起草纯函数测试：校验闸（镜像发布闸语义）+ LLM JSON → 编辑态转换 + kind 前缀规则 + 一签起草/打标（C4b）。
import { describe, expect, it } from 'vitest';
import {
  buildDailyTaggingUser,
  buildLampsUser,
  dailyCardErrors,
  draftToDaily,
  draftToLamps,
  draftToStages,
  kindPrefix,
  validateDraftDaily,
  validateDraftJourney,
  validateDraftLamps,
  validateTagAssignments,
  type DraftStage,
} from '@/lib/admin-draft';

const stage = (id: number, over: Partial<DraftStage> = {}): DraftStage => ({
  id,
  title: `段${id}`,
  goal: '这一段带读者看见什么',
  weeks: 3,
  exercises: ['每天记一件小事'],
  do: ['承接'],
  dont: ['说教'],
  advance_when: ['能说出自己的旧脚本'],
  ritual: '无',
  skippable: true,
  body: '正文'.repeat(60), // ≥100 字符
  ...over,
});

const lamp = (kind: string, over: Record<string, unknown> = {}) => ({
  kind,
  topic: 'self-worth',
  needsAction: false,
  promptHint: '当读者能认出旧脚本时视为到达',
  label: { en: 'Seen', 'zh-CN': '看见', 'zh-TW': '看見', ja: '見えた' },
  hint: { en: 'not yet', 'zh-CN': '还没到', 'zh-TW': '還沒到', ja: 'まだ見えていない' },
  ...over,
});

describe('validateDraftJourney（发布闸的草稿期镜像）', () => {
  it('完整四段草稿通过', () => {
    expect(validateDraftJourney({ stages: [stage(1), stage(2), stage(3), stage(4)] })).toEqual([]);
  });

  it('缺段 / 段 id 重复被拦', () => {
    const errors = validateDraftJourney({ stages: [stage(1), stage(2), stage(3)] });
    expect(errors.some((e) => e.includes('缺第 4 段'))).toBe(true);
    const dup = validateDraftJourney({ stages: [stage(1), stage(1), stage(3), stage(4)] });
    expect(dup.some((e) => e.includes('重复'))).toBe(true);
  });

  it('正文太短被拦（发布闸要求 ≥100 字符）', () => {
    const errors = validateDraftJourney({ stages: [stage(1, { body: '太短' }), stage(2), stage(3), stage(4)] });
    expect(errors.some((e) => e.includes('body 太短'))).toBe(true);
  });

  it('未知命题 / 空数组 / weeks 非法被拦', () => {
    const errors = validateDraftJourney({
      stages: [stage(1, { topics: ['not-a-topic'] }), stage(2, { exercises: [] }), stage(3, { weeks: 0 }), stage(4, { do: ['ok'], dont: [] })],
    });
    expect(errors.some((e) => e.includes('未知命题'))).toBe(true);
    expect(errors.some((e) => e.includes('exercises'))).toBe(true);
    expect(errors.some((e) => e.includes('weeks'))).toBe(true);
    expect(errors.some((e) => e.includes('dont'))).toBe(true);
  });

  it('stages 不是数组直接报缺（不抛异常）', () => {
    expect(validateDraftJourney(null)).toEqual(['草稿缺少 stages 数组']);
    expect(validateDraftJourney({ stages: 'x' })).toEqual(['草稿缺少 stages 数组']);
  });
});

describe('validateDraftLamps（kind 前缀防跨书撞 + 末段不给灯）', () => {
  it('段 1-3 有灯、kind 带书前缀 → 通过', () => {
    const raw = { stages: { 1: [lamp('mybook_stage1_a')], 2: [lamp('mybook_stage2_a')], 3: [lamp('mybook_stage3_a')] } };
    expect(validateDraftLamps(raw, 'my-book')).toEqual([]);
  });

  it('kind 缺书前缀被拦（防撞 v1 的 stage1_story 那批）', () => {
    const errors = validateDraftLamps({ stages: { 1: [lamp('stage1_story')] } }, 'my-book');
    expect(errors.some((e) => e.includes('必须以 mybook_ 开头'))).toBe(true);
  });

  it('末段（4）给灯被拦；全空被拦；未知 topic、缺四语被拦', () => {
    const errors = validateDraftLamps(
      {
        stages: {
          4: [lamp('mybook_stage4_x')],
        },
      },
      'my-book',
    );
    expect(errors.some((e) => e.includes('只允许 1/2/3'))).toBe(true);
    expect(errors.some((e) => e.includes('灯表为空'))).toBe(true);

    const missing = validateDraftLamps(
      { stages: { 1: [lamp('mybook_stage1_a', { topic: 'nope', label: { en: 'x' } })] } },
      'my-book',
    );
    expect(missing.some((e) => e.includes('topic'))).toBe(true);
    expect(missing.some((e) => e.includes('label 缺 zh-CN'))).toBe(true);
  });

  it('stages 不是对象直接报缺（不抛异常）', () => {
    expect(validateDraftLamps(null, 'x')).toEqual(['灯表草稿缺少 stages 对象']);
  });
});

describe('kindPrefix 与转换', () => {
  it('kindPrefix 去连字符', () => {
    expect(kindPrefix('the-courage-to-be-disliked')).toBe('thecouragetobedisliked');
  });

  it('draftToStages：按 id 排序、文件名 <id>.md、skippable 缺省 true、free_alt 归一空串', () => {
    const stages = draftToStages([stage(2), stage(1, { skippable: undefined, free_alt: undefined })]);
    expect(stages.map((s) => s.id)).toEqual([1, 2]);
    expect(stages[0]?.file).toBe('1.md');
    expect(stages[0]?.skippable).toBe(true);
    expect(stages[0]?.free_alt).toBe('');
  });

  it('draftToLamps：丢弃非法段号键（行级垃圾由校验闸管，转换输入已保证干净），四语补空串', () => {
    const lamps = draftToLamps({
      1: [lamp('p_1'), lamp('p_1b', { label: undefined, hint: undefined })],
      4: [lamp('p_4')], // 末段丢弃
      x: [lamp('p_x')], // 非数字段丢弃
    });
    expect(Object.keys(lamps)).toEqual(['1']);
    expect(lamps['1']).toHaveLength(2);
    expect(lamps['1']?.[0]?.label['ja']).toBe('見えた');
    expect(lamps['1']?.[1]?.label['en']).toBe('');
  });

  it('buildLampsUser 带上 kind 前缀与各段走完标志', () => {
    const user = buildLampsUser([stage(1), stage(2)], 'myprefix');
    expect(user).toContain('myprefix_');
    expect(user).toContain('段 1「段1」');
    expect(user).toContain('能说出自己的旧脚本');
  });
});

describe('validateDraftDaily / dailyCardErrors（一签闸，C4b）', () => {
  const card = (i: number, over: Record<string, unknown> = {}) => ({
    text: `签 ${i}`,
    type: 'observation',
    stages: [(i % 4) + 1],
    reflection: `问 ${i}`,
    topics: ['self-worth'],
    ...over,
  });
  const pool = (n: number, over: Record<string, unknown> = {}) => ({ cards: Array.from({ length: n }, (_, i) => card(i, over)) });

  it('90 条全型全覆盖通过', () => {
    const cards = Array.from({ length: 90 }, (_, i) => card(i, { type: ['observation', 'practice', 'way'][i % 3] }));
    expect(validateDraftDaily({ cards })).toEqual([]);
  });

  it('不足 90 条 / 缺 type / 缺段覆盖被拦', () => {
    const errors = validateDraftDaily(pool(89));
    expect(errors.some((e) => e.includes('只有 89 条'))).toBe(true);

    const badType = validateDraftDaily({ cards: [card(0, { type: 'quote' }), ...Array.from({ length: 92 }, (_, i) => card(i))] });
    expect(badType.some((e) => e.includes('type 必须是'))).toBe(true);

    const onlyStage1 = validateDraftDaily({ cards: Array.from({ length: 90 }, (_, i) => card(i, { stages: [1] })) });
    expect(onlyStage1.some((e) => e.includes('没有覆盖第 2 段'))).toBe(true);
  });

  it('topics 不是 1-2 个 / 未知命题被拦（发布闸硬拦缺标签的镜像）', () => {
    expect(dailyCardErrors(card(0, { topics: [] }), 'c')).toEqual([expect.stringContaining('topics 必须是 1-2 个')]);
    expect(dailyCardErrors(card(0, { topics: ['self-worth', 'allowing', 'parents'] }), 'c').length).toBe(1);
    expect(dailyCardErrors(card(0, { topics: ['nope'] }), 'c')[0]).toContain('未知命题');
  });

  it('cards 不是数组直接报缺（不抛异常）', () => {
    expect(validateDraftDaily(null)).toEqual(['一签草稿缺少 cards 数组']);
    expect(validateDraftDaily({ cards: 'x' })).toEqual(['一签草稿缺少 cards 数组']);
  });

  it('draftToDaily：字段归一化（非法 type 落 observation、stages/topics 保形）', () => {
    const cards = draftToDaily([card(0, { type: 'bogus' }) as never]);
    expect(cards[0]?.type).toBe('observation');
    expect(cards[0]?.topics).toEqual(['self-worth']);
  });
});

describe('validateTagAssignments（存量打标校验，C4b）', () => {
  it('0..N-1 每条恰好一行、topics 1-2 合法 → 通过且按 i 排序', () => {
    const raw = { tags: [{ i: 1, topics: ['allowing'] }, { i: 0, topics: ['self-worth', 'parents'] }] };
    const { errors, assignments } = validateTagAssignments(raw, 2);
    expect(errors).toEqual([]);
    expect(assignments).toEqual([
      { i: 0, topics: ['self-worth', 'parents'] },
      { i: 1, topics: ['allowing'] },
    ]);
  });

  it('缺行 / 重复 i / 越界 / topics 0 个或 3 个 / 未知命题全被点名', () => {
    const { errors } = validateTagAssignments({ tags: [{ i: 0, topics: ['self-worth'] }] }, 2);
    expect(errors.some((e) => e.includes('缺第 1 条'))).toBe(true);

    const dup = validateTagAssignments({ tags: [{ i: 0, topics: ['self-worth'] }, { i: 0, topics: ['allowing'] }] }, 2);
    expect(dup.errors.some((e) => e.includes('重复'))).toBe(true);

    const range = validateTagAssignments({ tags: [{ i: 5, topics: ['self-worth'] }] }, 2);
    expect(range.errors.some((e) => e.includes('越界'))).toBe(true);

    const badTopics = validateTagAssignments({ tags: [{ i: 0, topics: [] }, { i: 1, topics: ['a', 'b', 'c'] }, { i: 2, topics: ['nope'] }] }, 3);
    expect(badTopics.errors.filter((e) => e.includes('1-2 个')).length).toBe(2);
    expect(badTopics.errors.some((e) => e.includes('未知命题'))).toBe(true);
  });

  it('非对象 / 缺 tags 数组直接报缺（不抛异常）', () => {
    expect(validateTagAssignments(null, 1).errors).toEqual(['打标输出缺少 tags 数组']);
    expect(validateTagAssignments({}, 1).errors).toEqual(['打标输出缺少 tags 数组']);
  });

  it('buildDailyTaggingUser 带序号、type 与反思', () => {
    const user = buildDailyTaggingUser([{ text: '签·甲', type: 'way', reflection: '问一句' }]);
    expect(user).toContain('0. [way] 签·甲');
    expect(user).toContain('问一句');
    expect(user).toContain('"tags"');
  });
});
