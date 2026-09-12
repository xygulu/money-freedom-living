// 阶段进度（M9 需求③，语义修正版）：进度评估的是用户当前表现出的认知与行为
// 实际所处的阶段——离核心价值「一辈子不愁钱的活法」已达成的进度——与产品内
// 操作/交互次数没有严格关系。灯的点亮由阶段评估（assess.ts，AI 提议 + 用户确认）
// 颁发心印来记录：stamps 数组就是「已点亮集合」的唯一事实源，本文件只负责灯的
// 形状与展示判定。只增不减：灯不熄灭、阶段不倒退；无 deadline、无红点；阶段 4
// 没有终点线。
import type { GrowthProfile, Stamp } from '@/lib/profile';

export interface StageCheck {
  kind: Stamp['kind']; // 心印 kind，点亮后入档；展示名走 dict.stamps.<kind>
  labelKey: string; // 未点亮时「这盏灯是什么」的文案 key（dict.journey.<labelKey>）
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
 * 灯判定表：每盏灯是一个认知/行为里程碑。content 各阶段 journey 文档的
 * advance_when 本来就是认知描述（「用户能描述一种反复出现的金钱感受」），
 * 错的是此前把它降级成操作计数的机械 test——现在判定发生在评估里（依据
 * 素材 + 用户确认），代码里只保留灯的形状。hint 与 advance_when 一同喂
 * 给评估 LLM。
 */
export const STAGE_LAMPS: Record<number, LampRule[]> = {
  1: [
    {
      kind: 'stage1_story',
      labelKey: 'stageLampStory',
      hint: '能具体说出早期金钱记忆或家庭场景——有细节、有场景，不是概括性的话',
    },
    {
      kind: 'stage1_script',
      labelKey: 'stageLampScript',
      hint: '对「我听到的可能」或自己的旧脚本有了真实态度：认领它对自己的影响，或说出它哪里不对',
    },
    {
      kind: 'stage1_color',
      labelKey: 'stageLampColor',
      hint: '能描述并承认一种反复出现的金钱感受（如罪恶感、怕没钱），且是从自己的话里自然带出来的，不是被问才挤出一句',
    },
  ],
  2: [
    {
      kind: 'stage2_claim',
      labelKey: 'stageLampClaim',
      hint: '从「知道」到「承认」：亲口认领那个旧脚本是自己的，或明确说出它已经不再是我',
    },
    {
      kind: 'stage2_try',
      labelKey: 'stageLampTry',
      hint: '真的做过一件「不配的小事」或改写过一句内在台词，并且说了真实体感——做砸了、心虚了都算',
    },
    {
      kind: 'stage2_voice',
      labelKey: 'stageLampVoice',
      hint: '语言在变：对话或日记里出现「我可以选择」「我想试试」这类说法，而不是只有「必须/应该/不敢」',
    },
  ],
  3: [
    {
      kind: 'stage3_seven',
      labelKey: 'stageLampSeven',
      hint: '练习在重复中成为日常：实验做了不止一轮（书里的数字是 7），语气里不再是完成任务感，而是生活的一部分',
    },
    {
      kind: 'stage3_review',
      labelKey: 'stageLampReview',
      hint: '自己看出了变化：能自己说出「哪里不一样了」——有变化、没变化、说不清，只要是自己的观察都算',
    },
  ],
};

export const MAX_STAGE = 4;

/** 灯的点亮判定 = stamps 里是否已有这枚印（评估确认时颁发）。阶段 4 无灯。 */
export function computeStageProgress(stage: number, profile: GrowthProfile): StageProgress {
  const earned = new Set(profile.stamps.map((s) => s.kind));
  const checks: StageCheck[] = (STAGE_LAMPS[stage] ?? []).map((r) => ({
    kind: r.kind,
    labelKey: r.labelKey,
    done: earned.has(r.kind),
  }));
  return { checks, litCount: checks.filter((c) => c.done).length };
}
