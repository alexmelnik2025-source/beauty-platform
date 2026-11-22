/** The API sends the amount only when the client has proved their email. */
export function paymentNoticeAmount(details: unknown): { value: number; currency: string } | null {
  if (!Array.isArray(details)) return null;
  const fields = new Map<string, string>();
  for (const field of details) {
    if (field && typeof field.path === 'string' && typeof field.message === 'string') {
      fields.set(field.path, field.message);
    }
  }
  const amount = fields.get('amountGrosze');
  const currency = fields.get('currency');
  if (!amount || !/^\d+$/.test(amount) || !currency || !/^[A-Z]{3}$/.test(currency)) return null;
  const value = Number(amount);
  return Number.isSafeInteger(value) ? { value, currency } : null;
}
