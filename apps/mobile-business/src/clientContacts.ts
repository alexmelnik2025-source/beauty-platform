import { ApiError, type CustomerDetail, type Locale } from './api';
import { checkNewClient, type ClientProblem } from './newVisit';

/**
 * Task 332: "+ Dodaj klienta" in "Klienci"; task 333: "Zmień dane" in the client card — the name,
 * phone, email and the language of the client's messages (owners and managers). No React Native
 * here, so it is tested in Vitest (test/clientContacts.test.ts). The server checks everything again.
 */

/** Languages a client's messages can be in, as the card offers them. */
export const CLIENT_LANGUAGES: Locale[] = ['pl', 'uk', 'ru', 'en'];

export interface ContactsForm {
  name: string;
  phone: string;
  email: string;
  locale: CustomerDetail['locale'];
}

export interface NewCustomer {
  name: string;
  phone: string;
  email?: string;
  locale: CustomerDetail['locale'];
  allowDuplicatePhone?: boolean;
}

export interface ContactsChange {
  name?: string;
  phone?: string;
  email?: string | null;
  locale?: CustomerDetail['locale'];
}

export function emptyContacts(locale: Locale): ContactsForm {
  return { name: '', phone: '', email: '', locale };
}

export function contactsForm(client: CustomerDetail): ContactsForm {
  return {
    name: client.name,
    phone: client.phone ?? '',
    email: client.email ?? '',
    locale: client.locale,
  };
}

/** A new client ready to send, or the first thing to fix. */
export function newCustomerBody(
  form: ContactsForm,
  dial: string,
): { ok: true; body: NewCustomer } | { ok: false; problem: ClientProblem } {
  const checked = checkNewClient(form, dial);
  if (!checked.ok) return checked;
  return { ok: true, body: { ...checked.customer, locale: form.locale } };
}

/** Only what changed (null = nothing), or the first thing to fix. An empty email removes it. */
export function contactsChange(
  client: CustomerDetail,
  form: ContactsForm,
  dial: string,
): { ok: true; change: ContactsChange | null } | { ok: false; problem: ClientProblem } {
  const checked = checkNewClient(form, dial);
  if (!checked.ok) return checked;
  const { name, phone, email } = checked.customer;
  const change: ContactsChange = {};
  if (name !== client.name) change.name = name;
  if (phone !== client.phone) change.phone = phone;
  if ((email ?? null) !== client.email) change.email = email ?? null;
  if (form.locale !== client.locale) change.locale = form.locale;
  return { ok: true, change: Object.keys(change).length > 0 ? change : null };
}

/** Why the new card was refused when the client is already there: which field, and their card. */
export function existingClient(
  error: unknown,
): { field: 'phone' | 'email'; id: string | null } | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  const field =
    error.code === 'CUSTOMER_PHONE_EXISTS'
      ? 'phone'
      : error.code === 'CUSTOMER_EMAIL_EXISTS'
        ? 'email'
        : null;
  if (!field) return null;
  const id = error.details.find((d) => d.path === 'customerId')?.message ?? null;
  return { field, id };
}
