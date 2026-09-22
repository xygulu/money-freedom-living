'use client';

// 后台新建书表单（输入书名即可，其余可选）：AI 识别书名 → 认识就建骨架并跳
// 工作台弹确认卡（管理员确认「是这本书」才开始生成，2026-09-23 确认闸）；
// 不认识 422 提示补作者（可勾「自编/小众书」跳过识别只建骨架）。
// 后台不进 i18n，文案固定中文。
import { useRouter } from 'next/navigation';
import { useState } from 'react';

const inputCls = 'border border-line bg-white px-2 py-1 text-sm';

export default function NewBookForm() {
  const router = useRouter();
  const [titleZh, setTitleZh] = useState('');
  const [titleEn, setTitleEn] = useState('');
  const [author, setAuthor] = useState('');
  const [bookId, setBookId] = useState('');
  const [skipCheck, setSkipCheck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/books', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          titleZh,
          titleEn: titleEn || undefined,
          author: author || undefined,
          bookId: bookId || undefined,
          skipUnknownCheck: skipCheck || undefined,
        }),
      });
      const data = (await res.json()) as { ok: boolean; bookId?: string; autodraft?: boolean; log?: string[] };
      if (data.ok && data.bookId) {
        router.push(`/admin/books/${data.bookId}${data.autodraft ? '?autodraft=1' : ''}`);
        return;
      }
      setError((data.log ?? ['创建失败']).join('\n'));
    } catch {
      setError('网络错误，没建成');
    }
    setBusy(false);
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="mt-3 flex flex-col gap-2" data-admin-new-book>
      <div className="flex flex-wrap items-center gap-2">
        <input
          className={`${inputCls} w-56`}
          placeholder="书名（必填）"
          value={titleZh}
          onChange={(e) => setTitleZh(e.target.value)}
          aria-label="书名（zh-CN）"
        />
        <input
          className={`${inputCls} w-56`}
          placeholder="英文名（可选）"
          value={titleEn}
          onChange={(e) => setTitleEn(e.target.value)}
          aria-label="英文名"
        />
        <input
          className={`${inputCls} w-40`}
          placeholder="作者（可选，帮助识别）"
          value={author}
          onChange={(e) => setAuthor(e.target.value)}
          aria-label="作者"
        />
        <button
          type="submit"
          disabled={busy || !titleZh.trim()}
          className="border border-line bg-ink px-3 py-1 text-sm text-white disabled:opacity-40"
        >
          {busy ? (skipCheck ? '建书中……' : '识别并建书中……') : '建书（AI 识别后到工作台确认生成）'}
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-4">
        <input
          className={`${inputCls} w-56 text-xs`}
          placeholder="bookId（留空自动生成）"
          value={bookId}
          onChange={(e) => setBookId(e.target.value)}
          aria-label="bookId"
        />
        <label className="flex items-center gap-1.5 text-xs text-ink-soft">
          <input type="checkbox" checked={skipCheck} onChange={(e) => setSkipCheck(e.target.checked)} />
          自编/小众书（AI 可能不认识）——跳过识别只建骨架，之后贴素材再起草
        </label>
      </div>
      <p className="text-xs leading-relaxed text-ink-soft/70">
        只填书名即可：AI 先识别这本书——找到后会先告诉你它找到的是哪本（书名/作者/核心主张），
        你在工作台确认无误才开始生成；找不到或不确定会拒绝，需要补作者或贴素材。
        素材框贴了摘录会更贴书。
      </p>
      {error && <pre className="text-xs leading-relaxed text-red-600">{error}</pre>}
    </form>
  );
}
