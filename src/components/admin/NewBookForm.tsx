'use client';

// 后台新建书表单（输入书名即可，其余可选）：建骨架 → 直接跳工作台 AI 起草。
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
        body: JSON.stringify({ titleZh, titleEn: titleEn || undefined, author: author || undefined, bookId: bookId || undefined }),
      });
      const data = (await res.json()) as { ok: boolean; bookId?: string; log?: string[] };
      if (data.ok && data.bookId) {
        router.push(`/admin/books/${data.bookId}`);
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
          placeholder="作者（可选）"
          value={author}
          onChange={(e) => setAuthor(e.target.value)}
          aria-label="作者"
        />
        <button
          type="submit"
          disabled={busy || !titleZh.trim()}
          className="border border-line bg-ink px-3 py-1 text-sm text-white disabled:opacity-40"
        >
          {busy ? '创建中……' : '建书并进入工作台'}
        </button>
      </div>
      <input
        className={`${inputCls} w-56 text-xs`}
        placeholder="bookId（留空自动生成）"
        value={bookId}
        onChange={(e) => setBookId(e.target.value)}
        aria-label="bookId"
      />
      <p className="text-xs leading-relaxed text-ink-soft/70">
        只填书名即可：自动建草稿骨架 → 跳工作台 → 「一键生成整包」让 AI 起草 journey/灯表/一签，再人工校正。
        素材框贴了摘录会更贴书；不贴就按书名生成（知名书更贴）。
      </p>
      {error && <pre className="text-xs leading-relaxed text-red-600">{error}</pre>}
    </form>
  );
}
