// 发布即生效（V0.2 C3，docs/02 §14 定案：发布不需要重新部署）：
// 管理员闸 → 子进程跑 scripts/build-content.mjs（C2 发布闸在里面）→
// 成功 → reloadContent() 换掉内存 bundle，下一次请求就是新内容；
// 失败 → 校验错误原样带回，后台页直接展示，旧内容继续服务（发布失败不影响线上）。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { requireApiAdmin } from '@/lib/admin-auth';
import { reloadContent } from '@/lib/content';

const run = promisify(execFile);

export async function POST() {
  const gate = await requireApiAdmin();
  if (!gate.ok) return gate.response;

  try {
    // process.execPath（而不是裸 "node"）：子进程不依赖 PATH
    const { stdout } = await run(process.execPath, ['scripts/build-content.mjs'], {
      cwd: process.cwd(),
      timeout: 60_000,
    });
    const bundle = reloadContent();
    return Response.json({
      ok: true,
      books: bundle.books.length,
      builtAt: bundle.builtAt,
      log: stdout.trim(),
    });
  } catch (error) {
    // build-content 校验失败 → exit 1，错误清单在 stderr/stdout；原样带回
    const e = error as { stdout?: string; stderr?: string; message?: string };
    const log = [e.stdout, e.stderr, e.message].filter(Boolean).join('\n').trim();
    return Response.json({ ok: false, error: 'build_failed', log }, { status: 422 });
  }
}
