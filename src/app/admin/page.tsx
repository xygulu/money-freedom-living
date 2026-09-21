// 后台首页（V0.2 批 C0 落位页）：批 C 五步的进度清单。
// C1-C4 逐批把真功能换进来；这一页先回答「后台在不在、我是不是管理员」。
const STEPS = [
  { id: 'C0', title: '管理员闸', status: 'done', note: 'ADMIN_EMAILS 白名单 + /admin 页面闸 + API 闸（requireApiAdmin）' },
  { id: 'C1', title: '新书脚手架', status: 'todo', note: '一条命令生成 content/books/<id>/ 目录骨架' },
  { id: 'C2', title: '校验增强', status: 'todo', note: '发布闸口收拢内容包校验，不合规挡下不上线' },
  { id: 'C3', title: '发布即生效', status: 'todo', note: '运行时重载内容装载，改书不用重新部署' },
  { id: 'C4', title: '打标与校正页', status: 'todo', note: '贴素材 → AI 自动打标 → 人工校正 → 发布' },
] as const;

export default function AdminPage() {
  return (
    <section>
      <h1 className="text-lg font-medium">书的内容包生产</h1>
      <ul className="mt-4 flex flex-col gap-2" data-admin-steps>
        {STEPS.map((s) => (
          <li key={s.id} data-admin-step={s.id} data-status={s.status} className="flex items-baseline gap-3 border border-line bg-white/60 px-4 py-3">
            <span className="shrink-0 text-xs tracking-widest text-ink-soft">{s.id}</span>
            <span>
              <span className="text-sm">
                {s.title}
                {s.status === 'done' && <span className="ml-2 text-xs text-ink-soft">✅</span>}
                {s.status === 'todo' && <span className="ml-2 text-xs text-ink-soft">待做</span>}
              </span>
              <span className="mt-0.5 block text-xs leading-relaxed text-ink-soft/70">{s.note}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
