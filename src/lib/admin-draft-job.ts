// 起草后台任务（2026-09-22）：起草一次要 2-8 分钟，同步 HTTP 响应过 Cloudflare Tunnel
// 必被 100 秒空闲上限掐断（浏览器看到 524/网络错误，服务端其实还在跑）——改成
// 「POST 立刻回 jobId，任务在服务端进程内继续跑，前端轮询 GET 取进度」。
// 任务表挂 globalThis（dev HMR 换模块实例也不丢）；单人后台工具，不做持久化——
// 进程重启丢任务无妨（草稿以源文件为准，重跑即可）。
import type { AdminBookState } from '@/lib/admin-content';
import { runDraftStep } from '@/lib/admin-draft-run';

export type DraftJobKind = 'journey' | 'daily' | 'all';

export interface DraftJob {
  id: string;
  bookId: string;
  kind: DraftJobKind;
  status: 'running' | 'done' | 'failed';
  log: string[];
  state: AdminBookState | null;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
}

const store = globalThis as unknown as { __mflDraftJobs?: Map<string, DraftJob> };
const jobs: Map<string, DraftJob> = (store.__mflDraftJobs ??= new Map());

export function getDraftJob(id: string): DraftJob | null {
  return jobs.get(id) ?? null;
}

/** 同一本书同时只许一个起草任务（文件写盘会互相踩） */
export function findRunningDraftJob(bookId: string): DraftJob | null {
  for (const job of jobs.values()) {
    if (job.bookId === bookId && job.status === 'running') return job;
  }
  return null;
}

export function startDraftJob(input: { bookId: string; kind: DraftJobKind; source: string; email: string }): DraftJob {
  const job: DraftJob = {
    id: crypto.randomUUID(),
    bookId: input.bookId,
    kind: input.kind,
    status: 'running',
    log: [],
    state: null,
    error: null,
    startedAt: Date.now(),
    finishedAt: null,
  };
  jobs.set(job.id, job);
  void runJob(job, input.email, input.source);
  return job;
}

async function runJob(job: DraftJob, email: string, source: string): Promise<void> {
  const steps: Array<'journey' | 'daily'> = job.kind === 'all' ? ['journey', 'daily'] : [job.kind];
  try {
    for (const [i, kind] of steps.entries()) {
      if (steps.length > 1) job.log.push(`── ${kind === 'journey' ? 'journey + 灯表' : '一签池'}（${i + 1}/${steps.length}）──`);
      const r = await runDraftStep(job.bookId, kind, source, email, (line) => job.log.push(line));
      if (!r.ok) {
        // 整包前一步失败就停：不烧后续步骤的 LLM token（比旧 draftAll 的「失败也继续」更省）
        job.status = 'failed';
        job.error = r.error ?? 'draft_failed';
        return;
      }
      if (r.state) job.state = r.state;
    }
    job.status = 'done';
  } catch (error) {
    job.status = 'failed';
    job.error = 'llm_failed';
    job.log.push(`任务异常：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    job.finishedAt = Date.now();
    pruneJobs();
  }
}

/** 已结束的任务只留最近 20 个，防 Map 涨天期 */
function pruneJobs(): void {
  const finished = [...jobs.values()].filter((j) => j.status !== 'running').sort((a, b) => b.startedAt - a.startedAt);
  for (const job of finished.slice(20)) jobs.delete(job.id);
}
