// /[locale]/reset-password：重置密码落地页（邮件链接的终点）。
// 流程：邮件链接 → better-auth GET /api/auth/reset-password/:token 校验 →
// 302 回本页 ?token=VALID_TOKEN（或 ?error=INVALID_TOKEN）→ 表单设新密码。
// 带 searchParams，不能 force-static。
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { enabledLocales, isLocale } from '@/i18n/config';
import { getDict } from '@/i18n/get-dict';
import ResetPasswordForm from '@/components/ResetPasswordForm';

export default async function resetPasswordPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ token?: string; error?: string }>;
}) {
  const { locale } = await params;
  if (!isLocale(locale) || !enabledLocales.includes(locale)) notFound();
  const dict = getDict(locale);
  const { token, error } = await searchParams;
  const invalid = !token || error === 'INVALID_TOKEN';

  return (
    <div className="mx-auto flex max-w-md flex-col pt-16">
      <h1 className="text-2xl font-medium tracking-tight">{dict.login.resetTitle}</h1>
      <p className="mt-2 text-sm leading-relaxed text-ink-soft">{dict.login.resetHint}</p>
      <div className="mt-8">
        {invalid ? (
          <div className="flex flex-col gap-4 text-sm leading-relaxed" data-reset-invalid>
            <p>{dict.login.resetInvalid}</p>
            <Link
              href={`/${locale}/forgot-password`}
              className="self-start border border-ink px-5 py-2.5 transition-colors hover:bg-ink hover:text-paper"
            >
              {dict.login.forgotSubmit}
            </Link>
          </div>
        ) : (
          <ResetPasswordForm locale={locale} t={dict.login} token={token} />
        )}
      </div>
    </div>
  );
}
