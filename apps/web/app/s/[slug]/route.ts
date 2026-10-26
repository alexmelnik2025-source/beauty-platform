import { NextResponse, type NextRequest } from 'next/server';
import { pickLocale } from '@/lib/i18n/locales';

/**
 * Short booking link for an Instagram bio, a QR code or a business card: /s/{salon}.
 * Opens the salon's booking page in the visitor's language (Accept-Language), Polish otherwise.
 * Temporary redirect: each visitor gets their own language; extra query (utm_…) is kept.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const salon = (await params).slug.toLowerCase();
  if (!/^[a-z0-9-]{1,80}$/.test(salon)) {
    return new NextResponse('Not found', { status: 404 });
  }
  const locale = pickLocale(request.headers.get('accept-language'));
  const target = new URL(`/${locale}/b/${salon}`, request.url);
  target.search = request.nextUrl.search;
  return NextResponse.redirect(target, 307);
}
