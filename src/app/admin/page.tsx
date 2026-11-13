// 后台首页（V0.2 批 C 落位页）：批 C 五步的进度清单 + 书列表（选书进入工作台）+ 发布按钮。
// 改内容不在这里——这里选书、看状态、把已校正的内容包推上线。
import Link from 'next/link';
import NewBookForm from '@/components/admin/NewBookForm';
import PublishButton from '@/components/admin/PublishButton';
import { listAdminBooks } from '@/lib/admin-content';

const STEPS = [
  { id: 'C0', title: '管理员闸', status: 'done', note: 'ADMIN_EMAILS 白名单 + /admin 页面闸 + API 闸（requireApiAdmin）' },
  { id: 'C1', title: '新书脚手架', status: 'done', note: '后台「新建书」或 pnpm new-book <id> "<书名>" 生成 content/books/<id>/ 骨架' },
  { id: 'C2', title: '校验增强', status: 'done', note: '发布闸收拢在 build-content：结构校验对 draft 生效，量级闸只在 active 硬拦' },
  { id: 'C3', title: '发布即生效', status: 'done', note: '发布 = 重编译 content.json + 进程内热替换，失败 422 带校验日志、旧内容继续服务' },
  { id: 'C4', title: '打标与校正页', status: 'done', note: '书列表 → 贴素材 → AI 起草整包 → 人工逐项校正 → 发布（存量批量打标见工作台）' },
] as const;

export const dynamic = 'force-dynamic';

export default function AdminPage() {
  const books = listAdminBooks();
  return (
    <section>
      <h1 className="text-lg font-medium">书的内容包生产</h1>
      <p className="mt-2 text-xs text-ink-soft">
        <Link href="/admin/metrics" className="underline underline-offset-2">→ 机制仪表（验证期漏斗）</Link>
      </p>

      <ul className="mt-4 flex flex-col gap-2" data-admin-steps>
        {STEPS.map((s) => (
          <li key={s.id} data-admin-step={s.id} data-status={s.status} className="flex items-baseline gap-3 border border-line bg-white/60 px-4 py-3">
            <span className="shrink-0 text-xs tracking-widest text-ink-soft">{s.id}</span>
            <span>
              <span className="text-sm">
                {s.title}
                <span className="ml-2 text-xs text-ink-soft">✅</span>
              </span>
              <span className="mt-0.5 block text-xs leading-relaxed text-ink-soft/70">{s.note}</span>
            </span>
          </li>
        ))}
      </ul>

      <div className="mt-8 border border-line bg-white/60 p-4">
        <h2 className="text-sm">新建书（输入书名 → AI 生成内容包 → 校正 → 发布）</h2>
        <NewBookForm />
      </div>

      <div className="mt-8 border border-line bg-white/60 p-4">
        <h2 className="text-sm">书（点开进入工作台：贴素材 → AI 起草 → 校正）</h2>
        <ul className="mt-3 flex flex-col gap-2" data-admin-books>
          {books.map((b) => (
            <li key={b.id} data-admin-book={b.id} data-status={b.status} className="border border-line px-4 py-3">
              <Link href={`/admin/books/${b.id}`} className="text-sm underline-offset-2 hover:underline">
                《{b.title}》<span className="ml-2 text-xs text-ink-soft">{b.id}</span>
              </Link>
              <span className="ml-3 text-xs text-ink-soft/70">
                {b.status === 'active' ? '已发布' : '草稿'} · 段 {b.stageCount} · 灯 {b.lampCount} · 一签 {b.dailyCount}
              </span>
            </li>
          ))}
          {books.length === 0 && <li className="text-xs text-ink-soft">还没有书——用上面的「新建书」</li>}
        </ul>
      </div>

      <div className="mt-6 border border-line bg-white/60 p-4">
        <h2 className="text-sm">发布</h2>
        <p className="mt-1 text-xs leading-relaxed text-ink-soft/70">
          重新编译 content/ 全部书稿并立即生效（先过发布闸：不合规挡下，旧内容继续服务）。
          内容源文件在工作台里改，这里只负责推上线。
        </p>
        <div className="mt-3">
          <PublishButton />
        </div>
      </div>
    </section>
  );
}
