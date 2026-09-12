// 阶段进度（M9 需求③「量化但温馨」）：把 content/*/journey 的 advance_when
// 翻译成可计算信号。量化的是「已做到的里程碑」，不是「未完成的任务」——
// 无 deadline、无红点、只增不减；三灯全亮出现推进提议，用户确认才推进。
// 游戏化的协调方式：激励全部后置（心印只点亮不熄灭），阶段 4 没有终点线。
import type { GrowthProfile, Stamp } from '@/lib/profile';

export interface StageCheck {
  kind: Stamp['kind']; // 心印 kind，点亮后入档；展示名走 dict.stamps.<kind>
  labelKey: string; // 未点亮时「这盏灯是什么」的文案 key（dict.journey.<labelKey>）
  done: boolean;
}

export interface StageProgress {
  checks: StageCheck[];
  litCount: number;
  /** 阶段 1-3：灯全亮；阶段 4 与越界输入恒 false（没有下一站） */
  canAdvance: boolean;
}

interface CheckRule {
  kind: Stamp['kind'];
  labelKey: string;
  test: (profile: GrowthProfile) => boolean;
}

const hasCalibration = (section: string) => (p: GrowthProfile) =>
  (p.portrait?.calibrations ?? []).some((c) => c.section === section);

/**
 * 判定表（content/zh-CN/journey/*.md 的 advance_when → 可计算信号，全部来自既有数据）：
 * 阶段 2「用我可以选择替代我必须」用 memories≥3 做近似信号（持续带着新话回来）。
 * 阶段 4 无推进无毕业，不设 checks。
 */
const STAGE_CHECKS: Record<number, CheckRule[]> = {
  1: [
    { kind: 'stage1_story', labelKey: 'stageLampStory', test: (p) => p.portrait !== null },
    { kind: 'stage1_script', labelKey: 'stageLampScript', test: hasCalibration('script') },
    { kind: 'stage1_color', labelKey: 'stageLampColor', test: hasCalibration('baseColor') },
  ],
  2: [
    { kind: 'stage2_claim', labelKey: 'stageLampClaim', test: (p) => p.portrait?.scriptStatus === 'confirmed' },
    { kind: 'stage2_try', labelKey: 'stageLampTry', test: (p) => p.experiments.length >= 1 },
    { kind: 'stage2_voice', labelKey: 'stageLampVoice', test: (p) => p.memories.length >= 3 },
  ],
  3: [
    { kind: 'stage3_seven', labelKey: 'stageLampSeven', test: (p) => p.experiments.length >= 7 },
    { kind: 'stage3_review', labelKey: 'stageLampReview', test: (p) => (p.portrait?.version ?? 1) >= 2 },
  ],
};

export const MAX_STAGE = 4;

export function computeStageProgress(stage: number, profile: GrowthProfile): StageProgress {
  const checks: StageCheck[] = (STAGE_CHECKS[stage] ?? []).map((r) => ({
    kind: r.kind,
    labelKey: r.labelKey,
    done: r.test(profile),
  }));
  return {
    checks,
    litCount: checks.filter((c) => c.done).length,
    canAdvance: checks.length > 0 && stage < MAX_STAGE && checks.every((c) => c.done),
  };
}

/**
 * 已达标但还没颁发的心印（journey 渲染时补发，appendStamps 按 kind 幂等）。
 * 覆盖 1..当前阶段 的全部灯：推进瞬间可能跳过渲染，旧阶段的灯不能就此丢掉。
 * 演进会把 calibrations 清空重开——已入档的心印不回退（只增不减）。
 */
export function pendingStamps(profile: GrowthProfile): Stamp['kind'][] {
  const earned = new Set(profile.stamps.map((s) => s.kind));
  const out: Stamp['kind'][] = [];
  for (let stage = 1; stage <= Math.min(profile.stage, MAX_STAGE - 1); stage++) {
    for (const c of computeStageProgress(stage, profile).checks) {
      if (c.done && !earned.has(c.kind)) out.push(c.kind);
    }
  }
  return out;
}
