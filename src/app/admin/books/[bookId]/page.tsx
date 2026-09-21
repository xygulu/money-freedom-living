// 书工作台（V0.2 C4）：贴素材 → AI 起草 → 人工逐项校正 → 保存。
// 页面闸与 /admin 同一道（layout 里的 currentAdmin → notFound）。
import { notFound } from 'next/navigation';
import BookEditor from '@/components/admin/BookEditor';
import { readAdminBook } from '@/lib/admin-content';

export const dynamic = 'force-dynamic';

export default async function AdminBookPage({
  params,
  searchParams,
}: {
  params: Promise<{ bookId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { bookId } = await params;
  const sp = await searchParams;
  const state = readAdminBook(bookId);
  if (!state) notFound();
  // ?autodraft=1 只由「新建书」成功链路带过来：进工作台即自动整包生成
  return <BookEditor bookId={bookId} initial={state} autodraft={sp.autodraft === '1'} />;
}
