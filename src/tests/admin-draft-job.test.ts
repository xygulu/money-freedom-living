// 起草后台任务测试：生命周期/整包串行/失败即停/同书互斥/onLog 流（不落盘，runDraftStep 用 mock）。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { findRunningDraftJob, getDraftJob, startDraftJob } from '@/lib/admin-draft-job';
import { runDraftStep } from '@/lib/admin-draft-run';
import type { AdminBookState } from '@/lib/admin-content';

vi.mock('@/lib/admin-draft-run', () => ({ runDraftStep: vi.fn() }));

const stepMock = vi.mocked(runDraftStep);
const fakeState = { meta: { status: 'draft' } } as unknown as AdminBookState;
const flush = () => new Promise((r) => setTimeout(r, 5));

beforeEach(() => {
  stepMock.mockReset();
});

describe('startDraftJob 生命周期', () => {
  it('整包 happy path：journey→daily 串行两步，段标题进日志，state 取最后一步', async () => {
    stepMock.mockResolvedValueOnce({ ok: true, log: ['journey ✅'], state: fakeState });
    stepMock.mockResolvedValueOnce({ ok: true, log: ['一签 ✅'], state: { ...fakeState, tag: 2 } as unknown as AdminBookState });
    const job = startDraftJob({ bookId: 'job-a', kind: 'all', source: '', email: 'a@b.c' });
    await flush();
    expect(job.status).toBe('done');
    expect(job.error).toBeNull();
    expect(stepMock).toHaveBeenCalledTimes(2);
    expect(stepMock.mock.calls[0]?.[1]).toBe('journey');
    expect(stepMock.mock.calls[1]?.[1]).toBe('daily');
    expect(job.log).toContain('── journey + 灯表（1/2）──');
    expect(job.log).toContain('── 一签池（2/2）──');
    expect(job.state).toEqual({ ...fakeState, tag: 2 });
    expect(getDraftJob(job.id)?.id).toBe(job.id);
  });

  it('前一步失败即停：daily 不再烧 token，error 透传', async () => {
    // 真实 runDraftStep 的所有日志行都走 onLog 流（say 同源）；mock 镜像这一点
    stepMock.mockImplementationOnce(async (_b, _k, _s, _e, onLog) => {
      onLog?.('第 1 批未过校验：只有 5 条');
      return { ok: false, error: 'draft_invalid', log: ['第 1 批未过校验：只有 5 条'] };
    });
    const job = startDraftJob({ bookId: 'job-b', kind: 'all', source: '', email: 'a@b.c' });
    await flush();
    expect(job.status).toBe('failed');
    expect(job.error).toBe('draft_invalid');
    expect(stepMock).toHaveBeenCalledTimes(1);
    expect(job.log.join('\n')).toContain('只有 5 条');
  });

  it('步骤抛异常 → failed + llm_failed，不炸进程', async () => {
    stepMock.mockRejectedValueOnce(new Error('OOM?'));
    const job = startDraftJob({ bookId: 'job-c', kind: 'journey', source: '', email: 'a@b.c' });
    await flush();
    expect(job.status).toBe('failed');
    expect(job.error).toBe('llm_failed');
    expect(job.log.join('\n')).toContain('任务异常：OOM?');
    expect(job.finishedAt).not.toBeNull();
  });

  it('onLog 流式行与返回日志同源——不重复入任务日志', async () => {
    stepMock.mockImplementationOnce(async (_bookId, _kind, _source, _email, onLog) => {
      onLog?.('一签池 zh-CN 第 1/3 批：30 条（累计 30）');
      return { ok: true, log: ['一签池 zh-CN 第 1/3 批：30 条（累计 30）'], state: fakeState };
    });
    const job = startDraftJob({ bookId: 'job-d', kind: 'daily', source: '', email: 'a@b.c' });
    await flush();
    expect(job.status).toBe('done');
    expect(job.log.filter((l) => l.includes('第 1/3 批'))).toHaveLength(1);
  });

  it('同书互斥：running 期间 findRunningDraftJob 命中；不同书不误伤', async () => {
    let release!: (v: { ok: true; log: string[]; state: AdminBookState }) => void;
    stepMock.mockImplementationOnce(() => new Promise((res) => (release = res)));
    const job = startDraftJob({ bookId: 'job-e', kind: 'daily', source: '', email: 'a@b.c' });
    await flush();
    expect(job.status).toBe('running');
    expect(findRunningDraftJob('job-e')?.id).toBe(job.id);
    expect(findRunningDraftJob('job-other')).toBeNull();
    release({ ok: true, log: [], state: fakeState });
    await flush();
    expect(job.status).toBe('done');
    expect(findRunningDraftJob('job-e')).toBeNull();
  });

  it('getDraftJob 查无此任务 → null', () => {
    expect(getDraftJob('no-such-id')).toBeNull();
  });

  it('confirm 透传到 runDraftStep（第 7 位置参数）；每一步都带同一份', async () => {
    stepMock.mockResolvedValue({ ok: true, log: [], state: fakeState });
    const confirm = { known: true, title: '测试之书', author: '某人', coreMethod: '金钱心理', note: '' };
    const job = startDraftJob({ bookId: 'job-f', kind: 'all', source: '', email: 'a@b.c', confirm });
    await flush();
    expect(job.status).toBe('done');
    expect(stepMock).toHaveBeenCalledTimes(2);
    expect(stepMock.mock.calls[0]?.[6]).toEqual(confirm);
    expect(stepMock.mock.calls[1]?.[6]).toEqual(confirm);
  });

  it('不带 confirm → runDraftStep 收到 undefined（旧路径语义不变）', async () => {
    stepMock.mockResolvedValue({ ok: true, log: [], state: fakeState });
    startDraftJob({ bookId: 'job-g', kind: 'daily', source: '', email: 'a@b.c' });
    await flush();
    expect(stepMock.mock.calls[0]?.[6]).toBeUndefined();
  });
});
