// /[locale]/login：登录 / 注册（MVP 最小闭环）。
// 独立存在的理由：订阅 VIP 必须登录（checkout 路由 401 未登录）；
// 游客身份不能跨设备保留——注册/登录后游客档案自动迁移 g:→u:（lib/migrate.ts）。
import { headers } from 'next/headers';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getDict } from '@/i18n/get-dict';
import { enabledLocales, isLocale } from '@/i18n/config';
import { auth, getEnabledSocialProviders } from '@/lib/auth';
import AuthForm from '@/components/AuthForm';

export const dynamic = 'force-dynamic';

export default async function loginPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ next?: string }>;
}) {
  const { locale } = await params;
  if (!isLocale(locale) || !enabledLocales.includes(locale)) notFound();
  const dict = getDict(locale);

  // 已登录用户不需要这页
  const session = await auth.api.getSession({ headers: await headers() });
  if (session?.user) {
    const { next } = await searchParams;
    redirect(next && next.startsWith('/') ? next : `/${locale}/me`);
  }

  const { next } = await searchParams;
  const social = getEnabledSocialProviders();
  return (
    <div className="flex flex-col pt-16">
      <h1 className="text-2xl font-medium tracking-tight">{dict.login.title}</h1>
      <p className="mt-3 text-sm leading-relaxed text-ink-soft">{dict.login.sub}</p>
      <div className="mt-8">
        <AuthForm next={next && next.startsWith('/') ? next : `/${locale}/me`} dict={dict.login} social={social} />
      </div>
      <Link href={`/${locale}/recover`} className="mt-4 text-sm text-ink-soft underline underline-offset-4">
        {dict.login.recoverLink}
      </Link>
    </div>
  );
}
