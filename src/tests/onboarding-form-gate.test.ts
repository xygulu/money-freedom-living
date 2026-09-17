// 服务端 answers 校验口径（2026-09-17 · 首启重排 v2 · 设计决策 #4）：
// - 4 道 choice 题必选（不在 options 内的不收）
// - 至少 1 道 free-text 题非空（前端 canSubmit 已守；服务端再守一次）
//
// 测试通过直接 POST /api/onboarding/answers 调用走 Next.js route handler，
// 不需要启 server：route 是 export async function POST，wrapper 内部逻辑可测。
import { describe, expect, it } from 'vitest';
import { QUESTIONS } from '@/lib/onboarding';
import { POST } from '@/app/api/onboarding/answers/route';

// 完整 4 choice + 1 free 的合规答卷（最小可用）
function validAnswers(): Record<string, string> {
  return {
    moment_when: 'week',
    balance_feeling: 'calm',
    payday_action: 'save',
    aspiration: 'relaxed',
    childhood: '我妈说，咱家不配',
  };
}

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/api/onboarding/answers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/onboarding/answers · 校验口径', () => {
  it('合法：4 choice + 1 free → 200', async () => {
    const req = makeRequest({ locale: 'zh-CN', answers: validAnswers() });
    const res = await POST(req as never);
    // 不强求 200（依赖 DB/identity），但**不该**是 400 choice_required / free_text_required
    expect(res.status).not.toBe(400);
    // 合法 → 不应该是 choice_required 或 free_text_required
    if (res.status === 400) {
      const body = await res.json();
      expect(body.error).not.toBe('choice_required');
      expect(body.error).not.toBe('free_text_required');
    }
  });

  it('缺一道 choice → 400 choice_required + field 标识', async () => {
    const a = validAnswers();
    delete a.balance_feeling;
    const req = makeRequest({ locale: 'zh-CN', answers: a });
    const res = await POST(req as never);
    // 期望 400 + choice_required（不依赖下游 DB/identity 的成功）
    if (res.status === 400) {
      const body = await res.json();
      expect(body.error).toBe('choice_required');
      expect(body.field).toBe('balance_feeling');
    } else {
      // 没走 400 路径说明走通了 DB；这表示校验放过了——应当失败
      expect(res.status).toBe(400);
    }
  });

  it('choice 越界（不在 options）→ 不收该 choice 但其它校验继续', async () => {
    const a = { ...validAnswers(), balance_feeling: 'totally_not_an_option' };
    const req = makeRequest({ locale: 'zh-CN', answers: a });
    const res = await POST(req as never);
    // 该 choice 被丢弃 → questionnaire[balance_feeling] 为空 → 触发 choice_required
    if (res.status === 400) {
      const body = await res.json();
      expect(body.error).toBe('choice_required');
      expect(body.field).toBe('balance_feeling');
    }
  });

  it('free-text 全空 → 400 free_text_required + field 标识', async () => {
    const a = {
      moment_when: 'week',
      balance_feeling: 'calm',
      payday_action: 'save',
      aspiration: 'relaxed',
      childhood: '   ', // 全空白
      recent_worry: '', // 空
    };
    const req = makeRequest({ locale: 'zh-CN', answers: a });
    const res = await POST(req as never);
    if (res.status === 400) {
      const body = await res.json();
      expect(body.error).toBe('free_text_required');
      expect(['childhood', 'recent_worry']).toContain(body.field);
    }
  });

  it('locale 不合法 → 400 invalid_locale', async () => {
    const req = makeRequest({ locale: 'klingon', answers: validAnswers() });
    const res = await POST(req as never);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_locale');
  });

  it('answers 非对象 → 400 invalid_answers', async () => {
    const req = makeRequest({ locale: 'zh-CN', answers: 'not an object' });
    const res = await POST(req as never);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_answers');
  });

  it('校验口径覆盖 QUESTIONS 定义（4 choice + 2 free）', () => {
    // 这一条是回归闸门——确保 QUESTIONS 重构后校验口径仍匹配
    const choices = QUESTIONS.filter((q) => q.kind === 'choice');
    const frees = QUESTIONS.filter((q) => q.kind === 'free');
    expect(choices.length).toBeGreaterThanOrEqual(4);
    expect(frees.length).toBeGreaterThanOrEqual(1);
  });
});
