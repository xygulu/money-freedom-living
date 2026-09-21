// 问卷定义（叶子模块，V0.2 批 A 期间从 onboarding.ts 拆出）：
// OnboardingWizard 是客户端组件，C3 给 content.ts 引入 node:fs 后，任何把
// content.ts 拉进浏览器 chunk 的 import 都会让 Turbopack panic（页面 500）。
// 问卷定义是纯数据，不该连坐——搬到这里（零依赖），onboarding.ts re-export
// 保持既有 import（API 路由、测试）不动。
// ---------- 问卷（docs/02 §2①：收集具体的事，不是量表分数） ----------

export interface QuestionDef {
  id: 'moment_when' | 'balance_feeling' | 'childhood' | 'payday_action' | 'aspiration' | 'recent_worry';
  /** choice=四选一，free=开放题 */
  kind: 'choice' | 'free';
  /** choice 题的选项值（文案在 messages.onboarding.questions.<id>.options） */
  options?: string[];
  /** 进档案的字段（portrait.questionnaire 的键） */
  field: string;
}

export const QUESTIONS: QuestionDef[] = [
  { id: 'moment_when', kind: 'choice', options: ['week', 'month', 'cant_remember', 'dare_not'], field: 'specific_moments' },
  { id: 'balance_feeling', kind: 'choice', options: ['calm', 'avoid', 'panic', 'whatever'], field: 'money_feeling' },
  { id: 'childhood', kind: 'free', field: 'script_source' },
  { id: 'payday_action', kind: 'choice', options: ['repay', 'save', 'treat', 'nothing'], field: 'payday_habit' },
  { id: 'aspiration', kind: 'choice', options: ['relaxed', 'dare_spend', 'earn_well', 'free_of_money'], field: 'aspiration' },
  { id: 'recent_worry', kind: 'free', field: 'concerns_seed' },
];
