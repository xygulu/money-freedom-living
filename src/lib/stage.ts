// 阶段进度（M9 需求③，语义修正版）：进度评估的是用户当前表现出的认知与行为
// 实际所处的阶段——离核心价值「一辈子不愁钱的活法」已达成的进度——与产品内
// 操作/交互次数没有严格关系。灯的点亮由阶段评估判定（assess.ts，AI 提议 + 用户
// 确认），展示真值是 assessment.confirmed.lamps——最近一次确认评估的结论；stamps
// 只是确认仪式同步留下的心印存档（足迹/心印陈列用），不是灯的判定来源。本文件
// 只负责灯的形状与展示判定。只增不减：灯不熄灭、阶段不倒退；无 deadline、无
// 红点；阶段 4 没有终点线。
import type { GrowthProfile, Stamp } from '@/lib/profile';

export interface StageCheck {
  kind: Stamp['kind']; // 关联评估结论与确认时入档的心印 kind；展示名走 dict.journey.<labelKey>
  labelKey: string; // 「这盏灯是什么」的文案 key（dict.journey.<labelKey>），点亮/未点亮共用
  done: boolean;
}

export interface StageProgress {
  checks: StageCheck[];
  litCount: number;
}

export interface LampRule {
  kind: Stamp['kind'];
  labelKey: string;
  /** 给评估 prompt 的内部备注（中文，不面向用户）：什么样的言行才算点亮这盏灯 */
  hint: string;
}

/**
 * 灯判定表：每盏灯是本阶段离「一辈子不愁钱的活法」应达程度的一个切面——
 * 判定的是状态到达了没有，不是做过哪些动作（言行只是证据）。判定发生在
 * 评估里（依据素材 + 用户确认），代码里只保留灯的形状。hint 与 content
 * 的 advance_when 一同喂给评估 LLM，一律程度句式书写。
 */
export const STAGE_LAMPS: Record<number, LampRule[]> = {
  1: [
    {
      kind: 'stage1_story',
      labelKey: 'stageLampStory',
      hint: '判定的是程度不是动作：他认出今天的钱模式有来历——早期场景至今还在他身上运行（不只是「记得一件事」，而是「原来它一直在影响我」）',
    },
    {
      kind: 'stage1_script',
      labelKey: 'stageLampScript',
      hint: '他听得见那个常年在耳边说话的旧声音——知道它说什么、它怎么拦他，并且对它有了自己的态度（认下它的分量，或说出它哪里不对）',
    },
    {
      kind: 'stage1_color',
      labelKey: 'stageLampColor',
      hint: '他认得自己面对钱时反复泛起的底色感受（怕/愧/不配……），并能承认「这是我的底色」——只是看见，不评判',
    },
  ],
  2: [
    {
      kind: 'stage2_claim',
      labelKey: 'stageLampClaim',
      hint: '旧脚本从「天经地义的事实」变成「他自己的东西」——他亲口认领它（它当年保护过他），或明确说它已经不再是我；认领的那一刻，松动就开始了',
    },
    {
      kind: 'stage2_try',
      labelKey: 'stageLampTry',
      hint: '允许真的在他身上发生过——为自己破过一次例、放自己一马，或改写过一句内在台词，体感松了一点（心虚、做砸都算，那说明碰到了旧脚本）；做过什么是证据，「允许了自己」才是标准',
    },
    {
      kind: 'stage2_voice',
      labelKey: 'stageLampVoice',
      hint: '他的话语里看得见松动——「我可以选择」「我想试试」开始替代「必须/应该/不敢」；话语是内心松紧的体温计',
    },
  ],
  3: [
    {
      kind: 'stage3_seven',
      labelKey: 'stageLampSeven',
      hint: '新做法在他的日子里稳定下来——与钱打交道时自然用它，不再靠硬撑和提醒；做过几轮只是证据，稳定成日常才是标准',
    },
    {
      kind: 'stage3_review',
      labelKey: 'stageLampReview',
      hint: '他能自己看见变化——不用别人告诉他，他自己说得出「哪里不一样了」；有变化、没变化、说不清都算，只要是自己的观察',
    },
  ],
};

export const MAX_STAGE = 4;

/** 灯的点亮判定 = 最近一次确认的评估里这盏灯亮不亮（评估结论，不是动作记录）。
 *  评估没说亮的灯，即使 stamps 里有历史存档印也不亮。阶段 4 无灯。 */
export function computeStageProgress(stage: number, profile: GrowthProfile): StageProgress {
  const verdict = new Map((profile.assessment.confirmed?.lamps ?? []).map((l) => [l.kind, l.lit]));
  const checks: StageCheck[] = (STAGE_LAMPS[stage] ?? []).map((r) => ({
    kind: r.kind,
    labelKey: r.labelKey,
    done: verdict.get(r.kind) === true,
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
