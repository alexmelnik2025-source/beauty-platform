/**
 * Task Q2: where a client booking on the salon's page came from, for the salon's "Skąd przyszli".
 *
 * The utm_source of the link wins (the salon's QR code carries "qr", a bio link may carry
 * "instagram"); then "embed" in the window on the salon's own site; then "catalogue" when the
 * client came from one of our own pages (the catalogue, the home page, "My visits"); "web"
 * otherwise. With the QR code of a specialist (?utm_source=qr&staff=…) also whose code it was.
 */
export function bookingChannel(
  search: string,
  referrer: string,
  origin: string,
): { channel: string; channelStaffId?: string } {
  const params = new URLSearchParams(search);
  const source = (params.get('utm_source') ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, 40);
  if (source) {
    const staff = params.get('staff') ?? '';
    return source === 'qr' && /^[0-9a-f-]{36}$/i.test(staff)
      ? { channel: 'qr', channelStaffId: staff }
      : { channel: source };
  }
  if (params.get('embed') === '1') return { channel: 'embed' };
  if (referrer && origin && referrer.startsWith(`${origin}/`)) return { channel: 'catalogue' };
  return { channel: 'web' };
}
