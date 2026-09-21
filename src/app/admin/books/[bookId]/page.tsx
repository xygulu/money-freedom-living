// 书工作台（V0.2 C4）：贴素材 → AI 起草 → 人工逐项校正 → 保存。
// 页面闸与 /admin 同一道（layout 里的 currentAdmin → notFound）。
import { notFound } from 'next/navigation';
import BookEditor from '@/components/admin/BookEditor';
import { readAdminBook } from '@/lib/admin-content';

export const dynamic = 'force-dynamic';

export default async function AdminBookPage({ params }: { params: Promise<{ bookId: string }> }) {
  const { bookId } = await params;
  const state = readAdminBook(bookId);
  if (!state) notFound();
  return <BookEditor bookId={bookId} initial={state} />;
}
