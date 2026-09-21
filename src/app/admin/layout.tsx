// 运营后台壳（V0.2 批 C0）：/admin 顶层段（proxy 已豁免 locale 分流），
// 不套产品壳、不进 i18n——运营者是唯一读者，中文写死。
// 闸：非管理员 notFound()（404，不暴露后台存在）；未配置 ADMIN_EMAILS 时同样 404。
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { currentAdmin } from '@/lib/admin-auth';
import '../globals.css';

export const metadata: Metadata = {
  title: '运营后台',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic'; // 闸要读 session（headers/cookies）

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const admin = await currentAdmin();
  if (!admin) notFound();

  return (
    <html lang="zh-CN">
      <body className="min-h-dvh bg-paper antialiased">
        <div className="mx-auto flex min-h-dvh max-w-3xl flex-col px-5 py-10">
          <header className="border-b border-line pb-4">
            <p className="text-xs tracking-widest text-ink-soft">运营后台</p>
            <p className="mt-1 text-sm text-ink-soft" data-admin-email>
              {admin.email}
            </p>
          </header>
          <main className="flex-1 pt-6">{children}</main>
        </div>
      </body>
    </html>
  );
}
