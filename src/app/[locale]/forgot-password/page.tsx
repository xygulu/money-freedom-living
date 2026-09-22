// /[locale]/forgot-password：邮箱重置密码（忘记密码的邮件通道）。
// 纯客户端表单：POST better-auth /api/auth/request-password-reset → Resend 发信；
// 邮件里的链接经 better-auth 校验后 302 回 /[locale]/reset-password?token=…。
// 与 /recover（恢复码通道）并存：两条找回路，用户哪条记得走哪条。
import { notFound } from 'next/navigation';
import { enabledLocales, isLocale } from '@/i18n/config';
import { getDict } from '@/i18n/get-dict';
import ForgotPasswordForm from '@/components/ForgotPasswordForm';

export const dynamic = 'force-static';

export default async function forgotPasswordPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale) || !enabledLocales.includes(locale)) notFound();
  const dict = getDict(locale);

  return (
    <div className="mx-auto flex max-w-md flex-col pt-16">
      <h1 className="text-2xl font-medium tracking-tight">{dict.login.forgotTitle}</h1>
      <p className="mt-2 text-sm leading-relaxed text-ink-soft">{dict.login.forgotHint}</p>
      <div className="mt-8">
        <ForgotPasswordForm locale={locale} t={dict.login} />
      </div>
    </div>
  );
}
