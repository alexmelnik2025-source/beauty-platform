import { redirect } from 'next/navigation';

/**
 * /{locale}/app opens the calendar. Task 428: the redirect is done by the server — the client-side
 * `router.replace` in an effect was sometimes dropped right after signing in, and the page stayed on
 * a spinner at /pl/app.
 */
export default async function CabinetHome({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  redirect(`/${locale}/app/calendar`);
}
