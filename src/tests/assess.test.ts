import { describe, expect, it } from 'vitest';
import {
  validateAssessment,
  shouldOfferAssess,
  buildAssessMessages,
  ASSESS_MIN_MATERIAL,
  ASSESS_MIN_DAYS,
  ASSESS_DISMISS_COOLDOWN_DAYS,
  ASSESS_PENDING_TTL_DAYS,
} from '@/lib/assess';
import { STAGE_LAMPS } from '@/lib/stage';
import { parseAssessmentState, type GrowthProfile, type StageAssessment } from '@/lib/profile';
import type { JourneyStage } from '@/lib/content';

const NOW = '2026-09-15T00:00:00.000Z';
const daysAgo = (n: number) => new Date(Date.parse(NOW) - n * 86_400_000).toISOString();

const stageFixture = (id: number): JourneyStage => ({
  id,
  title: `阶段${id}标题`,
  goal: `阶段${id}的样子（goal 原文）`,
  weeks: id * 2,
  exercises: [],
  ai_stance: { do: [], dont: [] },
  advance_when: [`阶段${id}的标志一`, `阶段${id}的标志二`],
  ritual: `仪式${id}`,
  body: '',
});

const draftFor = (stage: number, over: Record<string, unknown> = {}) => ({
  actualStage: stage,
  lamps: (STAGE_LAMPS[stage] ?? []).map((r) => ({ kind: r.kind, lit: false, evidence: '' })),
  summary: '它看到你正站在这里，有些话开始松动了，不急，慢慢来就好。',
  diagnosis: '旧脚本让你觉得钱一动就危险，所以你先看见、先不评判，这就是位置。',
  distance: '活法还没有终点线；你已经能把感觉说出口，这是第一段路标。',
  actions: ['今天留意一次想花钱的瞬间，写下当时的感受。', '把一段金钱记忆原样讲给它听。'],
  nextHint: '下一阶段在远处，先走好这一段。',
  ...over,
});

describe('validateAssessment（结构校验：禁止半成品评估入库）', () => {
  it('合法草稿通过；lamps 按 STAGE_LAMPS 顺序重构；assessedAt 不在返回值里（由路由填）', () => {
    const rules = STAGE_LAMPS[1];
    const draft = {
      actualStage: 2,
      lamps: [...rules].reverse().map((r, i) => ({
        kind: r.kind,
        lit: i === 0, // 倒序后第一条 = stage1_color
        evidence: '  它说过小时候数着硬币睡觉。  ',
      })),
      summary: '它看到你把故事讲出来了。',
      diagnosis: '旧脚本来自童年数硬币睡觉的场景，它让你把钱和不安连在一起。',
      distance: '你已经敢看这个故事了，离活法还有练习这一段路。',
      actions: ['这周把那个场景讲给它听一次。'],
      nextHint: '下一阶段在门口。',
    };
    const out = validateAssessment(draft, 1);
    expect(out).not.toBeNull();
    expect(out!.actualStage).toBe(2);
    expect(out!.lamps.map((l) => l.kind)).toEqual(rules.map((r) => r.kind));
    expect(out!.lamps[2]).toMatchObject({ lit: true, evidence: '它说过小时候数着硬币睡觉。' });
    expect(out!.lamps[0]).toMatchObject({ lit: false, evidence: '' });
    expect(out!.diagnosis).toContain('数硬币');
    expect(out!.actions).toEqual(['这周把那个场景讲给它听一次。']);
    expect('assessedAt' in out!).toBe(false);
  });

  it('actualStage 越界（倒退/跳两级/非整数）一律拒绝', () => {
    expect(validateAssessment(draftFor(2, { actualStage: 1 }), 2)).toBeNull();
    expect(validateAssessment(draftFor(2, { actualStage: 4 }), 2)).toBeNull();
    expect(validateAssessment(draftFor(2, { actualStage: 2.5 }), 2)).toBeNull();
    expect(validateAssessment(draftFor(2, { actualStage: '2' }), 2)).toBeNull();
    // 在允许区间 [stage, stage+1] 内合法；stage3 最多评到 4（封顶）
    expect(validateAssessment(draftFor(2, { actualStage: 3 }), 2)).not.toBeNull();
    expect(validateAssessment(draftFor(3, { actualStage: 4 }), 3)).not.toBeNull();
  });

  it('程度制硬约束：本阶段灯全亮 ⇒ actualStage 必须判下一阶段（阶段完成即开启）；有灯未点亮不受限', () => {
    const allLit = (stage: number) => ({
      ...draftFor(stage),
      lamps: (STAGE_LAMPS[stage] ?? []).map((r) => ({ kind: r.kind, lit: true, evidence: '程度达成的依据。' })),
    });
    // 全亮 + 停在原地 → 拒绝（不允许「程度全达成却不开下一阶段」的结论存在）
    expect(validateAssessment(allLit(1), 1)).toBeNull();
    expect(validateAssessment(allLit(3), 3)).toBeNull();
    // 全亮 + 下一阶段 → 合法（stage 3 全亮开到 4，封顶不越界）
    expect(validateAssessment({ ...allLit(1), actualStage: 2 }, 1)).not.toBeNull();
    expect(validateAssessment({ ...allLit(3), actualStage: 4 }, 3)).not.toBeNull();
    // 有灯未点亮 → 写当前阶段合法（评估未完成，等素材补充），判在门口也合法
    expect(validateAssessment(draftFor(1, { actualStage: 1 }), 1)).not.toBeNull();
    expect(validateAssessment(draftFor(1, { actualStage: 2 }), 1)).not.toBeNull();
  });

  it('lamps 必须恰好覆盖当前阶段灯集：缺/多/重复/未知 kind 都拒绝', () => {
    const short = draftFor(1);
    short.lamps = short.lamps.slice(1);
    expect(validateAssessment(short, 1)).toBeNull();
    const extra = draftFor(1);
    extra.lamps = [...extra.lamps, { kind: 'stage2_claim', lit: false, evidence: '' }];
    expect(validateAssessment(extra, 1)).toBeNull();
    const dup = draftFor(1);
    dup.lamps = [...dup.lamps, { kind: 'stage1_story', lit: false, evidence: '' }];
    expect(validateAssessment(dup, 1)).toBeNull();
  });

  it('点亮必须有依据；evidence trim 后空串同样拒绝', () => {
    const noEvidence = draftFor(1);
    noEvidence.lamps = STAGE_LAMPS[1].map((r, i) => ({ kind: r.kind, lit: i === 0, evidence: i === 0 ? '   ' : '' }));
    expect(validateAssessment(noEvidence, 1)).toBeNull();
    const missing = draftFor(1);
    missing.lamps = STAGE_LAMPS[1].map((r, i) => ({ kind: r.kind, lit: i === 0, evidence: undefined as unknown as string }));
    expect(validateAssessment(missing, 1)).toBeNull();
  });

  it('summary 10..800（语言感知边界：英文 120 词 ≈ 800 字符）、nextHint 非空且超长截断；非对象输入拒绝', () => {
    expect(validateAssessment(draftFor(1, { summary: '太短了' }), 1)).toBeNull();
    expect(validateAssessment(draftFor(1, { summary: 'x'.repeat(801) }), 1)).toBeNull();
    // 英文 80-120 词 ≈ 500-800 字符——smoke 实测英文草稿 551 字符曾撞 400 上限
    expect(validateAssessment(draftFor(1, { summary: 'x'.repeat(700) }), 1)).not.toBeNull();
    expect(validateAssessment(draftFor(1, { nextHint: '' }), 1)).toBeNull();
    expect(validateAssessment(draftFor(1, { nextHint: '长'.repeat(500) }), 1)).not.toBeNull();
    expect(validateAssessment(null, 1)).toBeNull();
    expect(validateAssessment('ok', 1)).toBeNull();
  });

  it('诊断式报告三件套：diagnosis/distance 缺失、过短、超长都拒绝', () => {
    expect(validateAssessment(draftFor(1, { diagnosis: undefined }), 1)).toBeNull();
    expect(validateAssessment(draftFor(1, { diagnosis: '太短' }), 1)).toBeNull();
    expect(validateAssessment(draftFor(1, { diagnosis: '长'.repeat(801) }), 1)).toBeNull();
    expect(validateAssessment(draftFor(1, { diagnosis: '长'.repeat(800) }), 1)).not.toBeNull();
    expect(validateAssessment(draftFor(1, { distance: '' }), 1)).toBeNull();
    expect(validateAssessment(draftFor(1, { distance: '还远' }), 1)).toBeNull();
    expect(validateAssessment(draftFor(1, { distance: '长'.repeat(601) }), 1)).toBeNull();
    expect(validateAssessment(draftFor(1, { distance: '长'.repeat(600) }), 1)).not.toBeNull();
  });

  it('actions：非数组/空数组/超 4 条/空白条目/单条超 200 字符都拒绝；2-3 条合法', () => {
    expect(validateAssessment(draftFor(1, { actions: '想一想' }), 1)).toBeNull();
    expect(validateAssessment(draftFor(1, { actions: [] }), 1)).toBeNull();
    expect(validateAssessment(draftFor(1, { actions: ['一', '二', '三', '四', '五'] }), 1)).toBeNull();
    // 空白条目会被过滤导致数量不一致——半成品拒绝
    expect(validateAssessment(draftFor(1, { actions: ['  ', '第二条行动建议'] }), 1)).toBeNull();
    expect(validateAssessment(draftFor(1, { actions: ['长'.repeat(201)] }), 1)).toBeNull();
    expect(validateAssessment(draftFor(1, { actions: ['  去掉首尾空格  '] }), 1)).not.toBeNull();
    expect(validateAssessment(draftFor(1, { actions: ['一', '二', '三'] }), 1)).not.toBeNull();
  });
});

describe('shouldOfferAssess（提议闸：首评/素材/天数/冷却/锁/TTL）', () => {
  const profile = (over: Partial<GrowthProfile> = {}): GrowthProfile => ({
    user_key: 'u:test',
    locale: 'zh-CN',
    portrait: { spoken: [], baseColor: 'x', moments: [], script: '', toFuture: '', version: 1, calibrations: [], scriptStatus: 'confirmed' },
    concerns: [],
    stage: 1,
    stage_started_at: '2026-08-01T00:00:00Z',
    pinned: [],
    memories: [],
    experiments: [],
    letters: [],
    stamps: [],
    evolution: { dismissedAt: null, lastGeneratedAt: null, proposedSeenAt: null, generatingAt: null },
    assessment: { pending: null, confirmed: null, confirmedAt: null, dismissedAt: null, generatingAt: null, proposedSeenAt: null },
    created_at: '2026-08-01T00:00:00Z',
    dailySeen: [],
    payday: null,
    total_active_days: 0,
    last_active_date: null,
    ...over,
  });
  const counts = (material: number, daysSince = 0) => ({
    memories: material,
    journals: 0,
    experiments: 0,
    daysSince,
  });
  const pendingAssessment = (assessedAt: string): StageAssessment => ({
    actualStage: 1,
    lamps: STAGE_LAMPS[1].map((r) => ({ kind: r.kind, lit: false, evidence: '' })),
    summary: '待确认的评估。',
    diagnosis: '待确认的评估诊断，说明为什么在这里。',
    distance: '待确认的评估距离，路标式描述。',
    actions: ['待确认的行动建议。'],
    nextHint: '下一阶段。',
    assessedAt,
  });

  it('首评闸：从未确认过（confirmedAt 空）→ 画像即素材，零素材零天数也提议', () => {
    const p = profile();
    expect(p.assessment.confirmedAt).toBeNull();
    expect(shouldOfferAssess(p, p.assessment, counts(0, 0), NOW)).toBe(true);
  });

  it(`已评过：素材 ≥${ASSESS_MIN_MATERIAL} 即提议，与天数无关；不足则看 ${ASSESS_MIN_DAYS} 天兜底；零素材永不提议`, () => {
    const p = profile({ assessment: { pending: null, confirmed: null, confirmedAt: daysAgo(30), dismissedAt: null, generatingAt: null, proposedSeenAt: null } });
    expect(shouldOfferAssess(p, p.assessment, counts(3), NOW)).toBe(true);
    expect(shouldOfferAssess(p, p.assessment, counts(ASSESS_MIN_MATERIAL - 1, ASSESS_MIN_DAYS - 1), NOW)).toBe(false);
    // 满 14 天且有任何素材 → 提议；零素材不提议（评估需要证据）
    expect(shouldOfferAssess(p, p.assessment, counts(1, ASSESS_MIN_DAYS), NOW)).toBe(true);
    expect(shouldOfferAssess(p, p.assessment, counts(0, 90), NOW)).toBe(false);
  });

  it('无画像 / 阶段 4（无灯无终点线）不提议——首评也不能越过这两道', () => {
    expect(shouldOfferAssess(profile({ portrait: null }), profile().assessment, counts(10), NOW)).toBe(false);
    expect(shouldOfferAssess(profile({ stage: 4 }), profile().assessment, counts(10), NOW)).toBe(false);
    expect(shouldOfferAssess(profile({ portrait: null, stage: 4 }), profile().assessment, counts(0), NOW)).toBe(false);
  });

  it('首评 dismiss 后冷却期内不提；冷却过线仍会再提（否则 dismiss 一次的新用户永远锁死在无进度态）', () => {
    const cooling = profile({ assessment: { pending: null, confirmed: null, confirmedAt: null, dismissedAt: daysAgo(1), generatingAt: null, proposedSeenAt: null } });
    expect(shouldOfferAssess(cooling, cooling.assessment, counts(0), NOW)).toBe(false);
    const cooled = profile({ assessment: { pending: null, confirmed: null, confirmedAt: null, dismissedAt: daysAgo(ASSESS_DISMISS_COOLDOWN_DAYS), generatingAt: null, proposedSeenAt: null } });
    expect(shouldOfferAssess(cooled, cooled.assessment, counts(0), NOW)).toBe(true);
  });

  it('生成锁在途（未过期）不提议——首评与复评一视同仁', () => {
    const locked = profile({ assessment: { pending: null, confirmed: null, confirmedAt: null, dismissedAt: null, generatingAt: daysAgo(0), proposedSeenAt: null } });
    expect(shouldOfferAssess(locked, locked.assessment, counts(10), NOW)).toBe(false);
  });

  it('pending 未过期不提议；超 TTL 的遗留 pending 不再阻塞（confirmedAt 空时经首评闸可覆盖重评）', () => {
    const fresh = profile({ assessment: { pending: pendingAssessment(daysAgo(1)), confirmed: null, confirmedAt: null, dismissedAt: null, generatingAt: null, proposedSeenAt: null } });
    expect(shouldOfferAssess(fresh, fresh.assessment, counts(10), NOW)).toBe(false);
    const stale = profile({ assessment: { pending: pendingAssessment(daysAgo(ASSESS_PENDING_TTL_DAYS)), confirmed: null, confirmedAt: null, dismissedAt: null, generatingAt: null, proposedSeenAt: null } });
    expect(shouldOfferAssess(stale, stale.assessment, counts(0), NOW)).toBe(true);
  });
});

describe('buildAssessMessages（评估 prompt：诊断四问、红线、语言钉死、标尺、素材）', () => {
  const material = {
    portrait: {
      scriptSource: '小时候家里为交电费吵了一晚上。',
      concernsSeed: '最近一到发薪日就心慌。',
      spoken: ['钱一動我就想躲。'],
      moments: [{ title: '发薪日', detail: '盯着余额心里发虚' }],
      baseColor: '钱像一个随时会醒的警报。',
      script: '也许钱到你手里就守不住。',
      scriptStatus: 'pending' as const,
      confirmedSections: ['baseColor'],
    },
    memories: [{ date: '2026-09-10', text: '我今天没买单，心里发虚，但还是付了' }],
    journals: [{ createdAt: '2026-09-11T00:00:00Z', content: '日记原文：原来我可以不买' }],
    experiments: [{ date: '2026-09-12', action: '给自己买了不配的小东西', feeling: '心虚但轻松' }],
    letters: [{ stage: 1, content: '给现在的自己：辛苦了', createdAt: '2026-09-01T00:00:00Z' }],
    missCorrections: [{ section: 'script', correction: '那不是我的剧本' }],
  };

  it('诊断四问逐字在场：他在哪/为什么是这里/离活法多远/下一步做什么；JSON shape 含新字段', () => {
    const { system } = buildAssessMessages('zh-CN', 1, [stageFixture(1), stageFixture(2)], material, { earnedKinds: [] });
    expect(system).toContain('诊断式评估');
    expect(system).toContain('为什么是这里（diagnosis）');
    expect(system).toContain('离「一辈子不愁钱的活法」还有多远（distance）');
    expect(system).toContain('下一步可以做什么（actions）');
    expect(system).toContain('本阶段全部灯点亮时必须写');
    expect(system).toContain('下一阶段随之开启');
    expect(system).toContain('"diagnosis"');
    expect(system).toContain('"distance"');
    expect(system).toContain('"actions"');
  });

  it('红线逐字在场：证据禁编造/没看到就说没看到/不评判不打分/无理财建议/画像也是素材但有保留', () => {
    const { system } = buildAssessMessages('zh-CN', 1, [stageFixture(1), stageFixture(2)], material, { earnedKinds: [] });
    expect(system).toContain('不是用户操作了多少次、完成了多少任务');
    expect(system).toContain('禁止编造');
    expect(system).toContain('没看到就如实说没看到');
    expect(system).toContain('不评判、不打分、不比较');
    expect(system).toContain('体检画像也是素材');
    expect(system).toContain('与这段时间的言行放在一起看');
    expect(system).toContain('diagnosis 只解释心理机制，不做医疗诊断、不用病症词汇、不评判人格');
    expect(system).toContain('distance 不给数字承诺、不制造焦虑');
    expect(system).toContain('不出现任何理财建议');
    expect(system).toContain('宁可点得少，不可编造');
  });

  it('人称钉死：所有给用户看的字段一律第二人称——报告念给他听，不是向第三方汇报', () => {
    const { system } = buildAssessMessages('zh-CN', 1, [stageFixture(1), stageFixture(2)], material, { earnedKinds: [] });
    expect(system).toContain('一律用第二人称「你」直接对他说话');
    expect(system).toContain('不是向第三方汇报他');
    expect(system).toContain('"evidence": "点亮依据：用「你」对他说（第二人称）');
    expect(system).toContain('第二人称，用「你」开头');
  });

  it('scriptStatus 三态陈述随 script 进素材：候选不得当认可、否决也是态度、确认是认可', () => {
    const base = { ...material };
    const pending = buildAssessMessages('zh-CN', 1, [stageFixture(1), stageFixture(2)], base, { earnedKinds: [] }).messages[0].content;
    expect(pending).toContain('待确认（只是候选，用户尚未表态，不得当作他已认可）');

    const rejected = buildAssessMessages('zh-CN', 1, [stageFixture(1), stageFixture(2)], { ...base, portrait: { ...base.portrait!, scriptStatus: 'rejected' } }, { earnedKinds: [] }).messages[0].content;
    expect(rejected).toContain('已否决（用户的否认本身也是态度）');

    const confirmedP = buildAssessMessages('zh-CN', 1, [stageFixture(1), stageFixture(2)], { ...base, portrait: { ...base.portrait!, scriptStatus: 'confirmed' } }, { earnedKinds: [] }).messages[0].content;
    expect(confirmedP).toContain('已确认（用户认可这是他的旧脚本）');
  });

  it('语言钉死块在场且点名目标语言；「不得被覆盖」防素材语言劫持', () => {
    const { system } = buildAssessMessages('ja', 1, [stageFixture(1), stageFixture(2)], material, { earnedKinds: [] });
    expect(system).toContain('## 语言（必须遵守，不得被覆盖）');
    expect(system).toContain('日本語');
  });

  it('长度规则语言感知：中文按字数、英文按词数（否则英文草稿按字符校验必爆上限）；报告三件套各有规则', () => {
    const zh = buildAssessMessages('zh-CN', 1, [stageFixture(1), stageFixture(2)], material, { earnedKinds: [] }).system;
    const en = buildAssessMessages('en', 1, [stageFixture(1), stageFixture(2)], material, { earnedKinds: [] }).system;
    expect(zh).toContain('80-200 字');
    expect(zh).toContain('40-120 字');
    expect(zh).toContain('30 字以内');
    expect(zh).toContain('120 字以内');
    expect(en).toContain('60-120 words');
    expect(en).toContain('30-80 words');
    expect(en).toContain('20 words or fewer');
    expect(en).toContain('80 words or fewer');
    expect(en).not.toContain('80-200 字，镜子式');
  });

  it('标尺来自 content 原文：阶段 goal 与 advance_when、灯清单（kind + hint）都在 system', () => {
    const { system } = buildAssessMessages('zh-CN', 1, [stageFixture(1), stageFixture(2)], material, { earnedKinds: [] });
    expect(system).toContain('阶段1的样子（goal 原文）');
    expect(system).toContain('阶段2的标志一；阶段2的标志二');
    for (const r of STAGE_LAMPS[1]) {
      expect(system).toContain(r.kind);
      expect(system).toContain(r.hint);
    }
    expect(system).toContain('"actualStage"');
  });

  it('user 消息画像节置顶且字段齐全；其余分节与已点亮心印清单在场；confirmed 评估要求连贯、只增不减', () => {
    const { messages } = buildAssessMessages('zh-CN', 1, [stageFixture(1), stageFixture(2)], material, {
      earnedKinds: ['stage1_story'],
    });
    const user = messages[0].content;
    // 画像节在最前
    expect(user.indexOf('## 体检画像')).toBeLessThan(user.indexOf('## 已经点亮的心印'));
    expect(user).toContain('童年金钱场景：小时候家里为交电费吵了一晚上。');
    expect(user).toContain('最近的担心：最近一到发薪日就心慌。');
    expect(user).toContain('「钱一動我就想躲。」');
    expect(user).toContain('发薪日：盯着余额心里发虚');
    expect(user).toContain('金钱底色：钱像一个随时会醒的警报。');
    expect(user).toContain('用户确认「说中了」的画像段落：baseColor');
    // 其余分节
    expect(user).toContain('我今天没买单，心里发虚，但还是付了');
    expect(user).toContain('心虚但轻松');
    expect(user).toContain('给现在的自己：辛苦了');
    expect(user).toContain('那不是我的剧本');
    expect(user).toContain('- stage1_story');

    const confirmed: StageAssessment = {
      actualStage: 1,
      lamps: STAGE_LAMPS[1].map((r) => ({ kind: r.kind, lit: r.kind === 'stage1_story', evidence: 'x' })),
      summary: '上次它看到你把故事讲了出来。',
      diagnosis: '上次它看到你的旧脚本还在拧紧。',
      distance: '上次它看到你在第一段路上。',
      actions: ['继续把感觉讲出来。'],
      nextHint: '继续。',
      assessedAt: daysAgo(30),
    };
    const withConfirmed = buildAssessMessages('zh-CN', 1, [stageFixture(1), stageFixture(2)], material, {
      confirmed,
      earnedKinds: ['stage1_story'],
    });
    expect(withConfirmed.system).toContain('已经点亮的灯不会熄灭');
    expect(withConfirmed.system).toContain('stage1_story');
  });

  it('portrait 为 null 时画像节显示 (无)，不崩；choice 类问卷答案不进素材', () => {
    const { messages } = buildAssessMessages('en', 1, [stageFixture(1), stageFixture(2)], {
      portrait: null,
      memories: [],
      journals: [],
      experiments: [],
      letters: [],
      missCorrections: [],
    }, { earnedKinds: [] });
    const user = messages[0].content;
    expect(user).toContain('## 体检画像（他说过的关于自己的话）\n(无)');
    expect(user).toContain('(无)');
  });
  it('M10 归因对照行：有 confirmed 评估时，system 提示在 diagnosis 里描述归因方式的变化（只描述，不打分）', () => {
    const confirmed: StageAssessment = {
      actualStage: 1,
      lamps: STAGE_LAMPS[1].map((r) => ({ kind: r.kind, lit: false, evidence: '' })),
      summary: '上次的样子。', diagnosis: '上次的原因。', distance: '上次的距离。',
      actions: ['上次的小步。'], nextHint: '继续。', assessedAt: daysAgo(30),
    };
    const withIt = buildAssessMessages('zh-CN', 1, [stageFixture(1), stageFixture(2)], material, {
      confirmed, earnedKinds: [],
    }).system;
    expect(withIt).toContain('归因对照');
    expect(withIt).toContain('只描述看见的变化，不打分、不比较好坏');
    const withoutIt = buildAssessMessages('zh-CN', 1, [stageFixture(1), stageFixture(2)], material, { earnedKinds: [] }).system;
    expect(withoutIt).not.toContain('归因对照');
  });

  it('M10 命题行：阶段 content 带 topics 时进 system（中文标签），不带则不出现在 prompt 里', () => {
    const withTopics: JourneyStage = { ...stageFixture(2), topics: ['allowing', 'boundaries'] };
    const { system } = buildAssessMessages('zh-CN', 2, [stageFixture(1), withTopics], material, { earnedKinds: [] });
    expect(system).toContain('本阶段涉及的命题：允许自己、关系与边界');
    const plain = buildAssessMessages('zh-CN', 1, [stageFixture(1), stageFixture(2)], material, { earnedKinds: [] }).system;
    expect(plain).not.toContain('本阶段涉及的命题');
  });

});

describe('parseAssessmentState（容脏读取）', () => {
  it("'{}' / null / 脏值 → 全空默认；合法对象透传", () => {
    const empty = {
      pending: null,
      confirmed: null,
      confirmedAt: null,
      dismissedAt: null,
      generatingAt: null,
      proposedSeenAt: null,
      previousConfirmed: null,
      changeList: null,
      changeListLockAt: null,
    };
    expect(parseAssessmentState({})).toEqual(empty);
    expect(parseAssessmentState(null)).toEqual(empty);
    expect(parseAssessmentState('junk')).toEqual(empty);
    const dirty = parseAssessmentState({ pending: 'x', confirmedAt: 42, dismissedAt: '2026-09-01T00:00:00Z' });
    expect(dirty.pending).toBeNull();
    expect(dirty.confirmedAt).toBeNull();
    expect(dirty.dismissedAt).toBe('2026-09-01T00:00:00Z');
  });
});
