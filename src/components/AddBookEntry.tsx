'use client';

// 加书入口（汇入制，V0.2 批 C）：旅程页尾一行低调文字，展开后按书给「带进来」。
//
// 产品口径（用户 2026-09-22 拍板）：书不是用来读的，是内容落地——加一本书 = 它的
// 落地内容（一签池/练习/practices）并入这个人按场景组织的成长，已有书不动。
// 所以这里只说「场景」语言（topics 走 dict.topics 用户文案，绝不用 TOPICS_ZH 内部名），
// 不做书架、无进度无红点（docs/02 §20.7 红线 8）；候选为空时父级整个不渲染（红线 1）。
//
// 失败静默恢复按钮（全站无红字口径）；成功给一行回执 + router.refresh() 让服务端
// 重取档案——下一屏起一签/练习的池子里就有它的内容。
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Dict } from '@/i18n/get-dict';
import type { TopicId } from '@/lib/content';

interface BookCandidate {
  id: string;
  title: string;
  topics: TopicId[];
}

interface Props {
  locale: string;
  dict: Dict;
  books: BookCandidate[];
}

export default function AddBookEntry({ locale, dict, books }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [addedId, setAddedId] = useState<string | null>(null);

  async function addBook(bookId: string) {
    if (busyId) return;
    setBusyId(bookId);
    try {
      const response = await fetch('/api/me/books', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bookId, locale, mode: 'add' }),
      });
      if (!response.ok) throw new Error(String(response.status));
      router.refresh(); // 服务端重取档案：下一屏起一签/练习的池子里就有它的内容
      setAddedId(bookId);
    } catch (err) {
      console.warn('[addBook] failed:', err);
    } finally {
      setBusyId(null);
    }
  }

  if (addedId) {
    // 加好了：一行回执（refresh 已在成功回调里触发；池子变化，本入口随之消失）
    return (
      <p data-added-book={addedId} className="mt-8 text-sm text-ink-soft">
        {dict.addBook.added}
      </p>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        data-add-book-entry=""
        onClick={() => setOpen(true)}
        className="mt-8 text-sm text-ink-soft underline decoration-ink-soft/40 underline-offset-4 transition-colors hover:text-ink"
      >
        {dict.addBook.entry}
      </button>
    );
  }

  return (
    <div data-add-book-entry="" className="mt-8 border-t border-ink/10 pt-6">
      <ul className="space-y-4">
        {books.map((book) => (
          <li key={book.id}>
            <p className="text-sm text-ink">{book.title}</p>
            <p className="mt-1 text-xs text-ink-soft">
              {dict.addBook.topicsLead}
              {book.topics.map((t) => dict.topics[t]).join(' · ')}
            </p>
            <button
              type="button"
              data-add-book-confirm={book.id}
              disabled={busyId !== null}
              onClick={() => addBook(book.id)}
              className="mt-2 rounded-full border border-ink/25 px-4 py-1.5 text-sm text-ink transition-colors hover:border-ink disabled:opacity-50"
            >
              {dict.addBook.confirm}
            </button>
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={() => setOpen(false)}
        className="mt-4 text-xs text-ink-soft transition-colors hover:text-ink"
      >
        {dict.addBook.close}
      </button>
    </div>
  );
}
