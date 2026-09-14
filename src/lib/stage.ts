// 阶段进度（M9 需求③，语义修正版）：进度评估的是用户当前表现出的认知与行为
// 实际所处的阶段——离核心价值「一辈子不愁钱的活法」已达成的进度——与产品内
// 操作/交互次数没有严格关系。灯的点亮由阶段评估判定（assess.ts，AI 提议 + 用户
// 确认），展示真值是 assessment.confirmed.lamps——最近一次确认评估的结论；stamps
// 只是确认仪式同步留下的心印存档（足迹/心印陈列用），不是灯的判定来源。本文件
// 只负责灯的形状与展示判定。只增不减：灯不熄灭、阶段不倒退；无 deadline、无
// 红点；阶段 4 没有终点线。
import type { GrowthProfile, Stamp, ThreadDepth } from '@/lib/profile';
import { DEFAULT_BOOK_ID, type TopicId } from '@/lib/content';

export interface StageCheck {
  kind: Stamp['kind']; // 关联评估结论与确认时入档的心印 kind；展示名走 dict.journey.<labelKey>
  labelKey: string; // 「这盏灯是什么」的文案 key（dict.journey.<labelKey>），点亮/未点亮共用
  done: boolean;
  /** 这盏灯要真实行为记录才点得亮（见 LampRule.needsAction）——未亮时据此提示去记录 */
  needsAction: boolean;
}

export interface StageProgress {
  checks: StageCheck[];
  litCount: number;
}

/**
 * 灯图顶点布局：n 盏灯在单位圆上均布（顶部起始、顺时针）——3 盏=三角、2 盏=
 * 上下两点。返回 0..1 的单位圆坐标（圆心 0.5/0.5、半径 0.5），渲染层再乘尺寸；
 * 外圈即「这个阶段应达的程度」（标准），点亮顶点的连线范围 = 用户现在的位置。
 * 纯函数，便于单测；n=0（阶段 4 无灯）返回空。
 */
export function lampChartPoints(n: number): { x: number; y: number }[] {
  if (n <= 0) return [];
  const start = -Math.PI / 2;
  return Array.from({ length: n }, (_, i) => {
    const angle = start + (i * 2 * Math.PI) / n;
    return { x: 0.5 + 0.5 * Math.cos(angle), y: 0.5 + 0.5 * Math.sin(angle) };
  });
}

export interface LampRule {
  kind: Stamp['kind'];
  labelKey: string;
  /** 给评估 prompt 的内部备注（中文，不面向用户）：什么样的言行才算点亮这盏灯 */
  hint: string;
  /**
   * 这盏灯是否必须有真实行为证据（experiments 里的记录）才允许点亮。
   * true = 说得再对也不算，得真的做过一次；false = 认知/态度类，说出来本身就是到达。
   * 分界看灯判的是什么：认出、听见、认领、话语松动 —— 这些发生在人心里，
   * 对话和日记就是证据；「允许真的发生过」「新做法稳定成日常」「自己看见变化」
   * 讲的是他在日子里做了什么，没有记录就无从谈起，光凭他在聊天里说得漂亮不能点。
   */
  needsAction: boolean;
  /**
   * 这盏灯落在哪条命题线上（M11-A）。灯属于书（路线图可换、可重排），
   * 命题属于人（跨书累加、永不重置）——topic 就是两者之间的桥（docs/05 §3.2）。
   */
  topic: TopicId;
}

/**
 * 灯判定表：每盏灯是本阶段离「一辈子不愁钱的活法」应达程度的一个切面——
 * 判定的是状态到达了没有，不是做过哪些动作（言行只是证据）。判定发生在
 * 评估里（依据素材 + 用户确认），代码里只保留灯的形状。hint 与 content
 * 的 advance_when 一同喂给评估 LLM，一律程度句式书写。
 */
const MONEY_FREEDOM_LAMPS: Record<number, LampRule[]> = {
  1: [
    {
      kind: 'stage1_story',
      labelKey: 'stageLampStory',
      hint: '判定的是程度不是动作：他认出今天的钱模式有来历——早期场景至今还在他身上运行（不只是「记得一件事」，而是「原来它一直在影响我」）',
      needsAction: false,
      topic: 'parents',
    },
    {
      kind: 'stage1_script',
      labelKey: 'stageLampScript',
      hint: '他听得见那个常年在耳边说话的旧声音——知道它说什么、它怎么拦他，并且对它有了自己的态度（认下它的分量，或说出它哪里不对）',
      needsAction: false,
      topic: 'self-worth',
    },
    {
      kind: 'stage1_color',
      labelKey: 'stageLampColor',
      hint: '他认得自己面对钱时反复泛起的底色感受（怕/愧/不配……），并能承认「这是我的底色」——只是看见，不评判',
      needsAction: false,
      topic: 'inner-turmoil',
    },
  ],
  2: [
    {
      kind: 'stage2_claim',
      labelKey: 'stageLampClaim',
      hint: '旧脚本从「天经地义的事实」变成「他自己的东西」——他亲口认领它（它当年保护过他），或明确说它已经不再是我；认领的那一刻，松动就开始了',
      needsAction: false,
      topic: 'self-worth',
    },
    {
      kind: 'stage2_try',
      labelKey: 'stageLampTry',
      hint: '允许真的在他身上发生过——为自己破过一次例、放自己一马，或改写过一句内在台词，体感松了一点（心虚、做砸都算，那说明碰到了旧脚本）；做过什么是证据，「允许了自己」才是标准',
      needsAction: true,
      topic: 'allowing',
    },
    {
      kind: 'stage2_voice',
      labelKey: 'stageLampVoice',
      hint: '他的话语里看得见松动——「我可以选择」「我想试试」开始替代「必须/应该/不敢」；话语是内心松紧的体温计',
      needsAction: false,
      topic: 'boundaries',
    },
  ],
  3: [
    {
      kind: 'stage3_seven',
      labelKey: 'stageLampSeven',
      hint: '新做法在他的日子里稳定下来——与钱打交道时自然用它，不再靠硬撑和提醒；做过几轮只是证据，稳定成日常才是标准',
      needsAction: true,
      topic: 'money-safety',
    },
    {
      kind: 'stage3_review',
      labelKey: 'stageLampReview',
      hint: '他能自己看见变化——不用别人告诉他，他自己说得出「哪里不一样了」；有变化、没变化、说不清都算，只要是自己的观察',
      needsAction: true,
      topic: 'inner-turmoil',
    },
  ],
};

/**
 * 按书索引的灯表（M11-A）。v1 只有一本书，但索引从此带 bookId：
 * 换书 = 换路线图（灯的形状可以不同），不影响用户在命题上已经走到的程度。
 * 未知 bookId 一律回落 v1 书——路线图不能是空的。
 */
export const BOOK_LAMPS: Record<string, Record<number, LampRule[]>> = {
  [DEFAULT_BOOK_ID]: MONEY_FREEDOM_LAMPS,
};

export function lampsFor(bookId: string, stage: number): LampRule[] {
  return (BOOK_LAMPS[bookId] ?? MONEY_FREEDOM_LAMPS)[stage] ?? [];
}

/** 当前书的灯表。存量调用点（按 stage 直接索引）保持不变，见 docs/05 §4.6 */
export const STAGE_LAMPS: Record<number, LampRule[]> = MONEY_FREEDOM_LAMPS;

/**
 * 灯亮之后落在命题线上的程度（docs/05 §4.6）：
 * 认知类的灯亮 = 在这条命题上"看见了"；行为类的灯亮 = 旧做法真的被替换过一次；
 * 本阶段灯全亮（随之开启下一段）= 这条命题在这本书里走完了。只增不减由 mergeDepth 兜住。
 */
export function lampDepth(rule: LampRule, stageAllLit: boolean): ThreadDepth {
  if (stageAllLit) return 'mastered';
  return rule.needsAction ? 'replaced' : 'seen';
}

/** 本阶段里「必须有真实行为记录才允许点亮」的灯 kind（评估 prompt 与硬闸共用）。 */
export function actionEvidenceKinds(stage: number): string[] {
  return (STAGE_LAMPS[stage] ?? []).filter((r) => r.needsAction).map((r) => r.kind);
}

export const MAX_STAGE = 4;

/** 灯的点亮判定 = 最近一次确认的评估里这盏灯亮不亮（评估结论，不是动作记录）。
 *  评估没说亮的灯，即使 stamps 里有历史存档印也不亮。阶段 4 无灯。 */
export function computeStageProgress(stage: number, profile: GrowthProfile): StageProgress {
  const verdict = new Map((profile.assessment.confirmed?.lamps ?? []).map((l) => [l.kind, l.lit]));
  const checks: StageCheck[] = (STAGE_LAMPS[stage] ?? []).map((r) => ({
    kind: r.kind,
    labelKey: r.labelKey,
    done: verdict.get(r.kind) === true,
    needsAction: r.needsAction,
  }));
  return { checks, litCount: checks.filter((c) => c.done).length };
}

/** 四段刻度（全局进度条用）：走过的段整段填充（阶段推进只发生在评估确认仪式
 *  里，「走过」本身就是评估结论）；当前段按最近一次确认评估点亮的灯数；未到的
 *  段全空——没有评估过的进度不造假。stage4 total=0（无灯无刻度）。 */
export function stageLampScales(profile: GrowthProfile): { id: number; lit: number; total: number }[] {
  const verdict = new Map((profile.assessment.confirmed?.lamps ?? []).map((l) => [l.kind, l.lit]));
  return [1, 2, 3, 4].map((id) => {
    const rules = STAGE_LAMPS[id] ?? [];
    const lit =
      id < profile.stage
        ? rules.length
        : id === profile.stage
          ? rules.filter((r) => verdict.get(r.kind) === true).length
          : 0;
    return { id, lit, total: rules.length };
  });
}

/** 程度制联动：确认评估里本阶段灯全亮 = 本阶段应达程度全达成 → 下一阶段随之
 *  开启（不由素材/动作门槛决定，也不需要单独的推进动作）。返回应推进到的阶段
 *  号；无需推进返回 null。纯函数，getProfile 落库自愈与 confirm 收口共用同一判定。 */
export function stageAdvanceTarget(profile: GrowthProfile): number | null {
  const stage = profile.stage;
  if (stage >= MAX_STAGE) return null;
  const rules = STAGE_LAMPS[stage] ?? [];
  if (rules.length === 0) return null;
  const lit = new Set((profile.assessment.confirmed?.lamps ?? []).filter((l) => l.lit).map((l) => l.kind));
  return rules.every((r) => lit.has(r.kind)) ? stage + 1 : null;
}
