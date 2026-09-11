// /[locale]/recover：恢复码找回（忘记密码 / Safari ITP 清存储后的账号找回）。
// 纯客户端表单：POST /api/me/recovery/recover（服务端限速 + 哈希比对 + 重置密码），
// 成功后引导去登录页用新密码登录。
import { notFound } from 'next/navigation';
import { enabledLocales, isLocale } from '@/i18n/config';
import { getDict } from '@/i18n/get-dict';
import RecoverForm from '@/components/RecoverForm';

export const dynamic = 'force-static';

export default async function recoverPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale) || !enabledLocales.includes(locale)) notFound();
  const dict = getDict(locale);

  return (
    <div className="mx-auto flex max-w-md flex-col pt-16">
      <h1 className="text-2xl font-medium tracking-tight">{dict.login.recoverTitle}</h1>
      <p className="mt-2 text-sm leading-relaxed text-ink-soft">{dict.login.recoverHint}</p>
      <div className="mt-8">
        <RecoverForm locale={locale} dict={dict} />
      </div>
    </div>
  );
}
