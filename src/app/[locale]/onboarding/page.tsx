import { notFound } from 'next/navigation';
import { getDict } from '@/i18n/get-dict';
import { enabledLocales, isLocale } from '@/i18n/config';
import { bookTitle, getBooks } from '@/lib/content';
import OnboardingWizard from '@/components/OnboardingWizard';

export default async function onboardingPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale) || !enabledLocales.includes(locale)) notFound();
  const dict = getDict(locale);
  // 选书屏（V0.2 A2）只列在册 active 书；不在册的走「我提到过这本书」愿望入口。
  // topics 随书带给选命题屏（V0.2 B1：选项来自本书 topics）
  const books = getBooks()
    .filter((b) => b.status === 'active')
    .map((b) => ({ id: b.id, title: bookTitle(b.id, locale), topics: b.topics }));
  return <OnboardingWizard locale={locale} dict={dict} books={books} />;
}
