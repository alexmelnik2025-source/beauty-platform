import { describe, expect, it } from 'vitest';
import { ApiError, BusinessApi, type CustomerDetail, type TokenStore } from '../src/api';
import {
  contactsChange,
  contactsForm,
  emptyContacts,
  existingClient,
  newCustomerBody,
} from '../src/clientContacts';

const client = {
  id: 'c1',
  name: 'Jan Kowalski',
  phone: '+48600100200',
  email: 'jan@example.com',
  locale: 'pl',
  version: 5,
} as CustomerDetail;

describe('a new client (task 332)', () => {
  it('sends the name, the phone with the salon’s code, the email and the language', () => {
    expect(
      newCustomerBody(
        { name: ' Anna  Nowak ', phone: '600 200 300', email: ' Anna@Example.com ', locale: 'uk' },
        '48',
      ),
    ).toEqual({
      ok: true,
      body: { name: 'Anna Nowak', phone: '+48600200300', email: 'anna@example.com', locale: 'uk' },
    });
    expect(
      newCustomerBody({ ...emptyContacts('ru'), name: 'Anna', phone: '600200300' }, '48'),
    ).toEqual({ ok: true, body: { name: 'Anna', phone: '+48600200300', locale: 'ru' } });
  });

  it('points at the first thing to fix', () => {
    expect(newCustomerBody(emptyContacts('pl'), '48')).toEqual({ ok: false, problem: 'name' });
    expect(newCustomerBody({ ...emptyContacts('pl'), name: 'Anna', phone: '12' }, '48')).toEqual({
      ok: false,
      problem: 'phone',
    });
    expect(
      newCustomerBody(
        { ...emptyContacts('pl'), name: 'Anna', phone: '600200300', email: 'anna@' },
        '48',
      ),
    ).toEqual({ ok: false, problem: 'email' });
  });

  it('recognises a client who is already there, with their card', () => {
    const phone = new ApiError(409, 'x', 'CUSTOMER_PHONE_EXISTS', [
      { path: 'customerId', message: 'c9' },
    ]);
    expect(existingClient(phone)).toEqual({ field: 'phone', id: 'c9' });
    expect(existingClient(new ApiError(409, 'x', 'CUSTOMER_EMAIL_EXISTS'))).toEqual({
      field: 'email',
      id: null,
    });
    expect(existingClient(new ApiError(409, 'x', 'VERSION_CONFLICT'))).toBeNull();
    expect(existingClient(new Error('x'))).toBeNull();
  });
});

describe('changing a client’s details (task 333)', () => {
  it('starts from the card; nothing changed = nothing to send', () => {
    const form = contactsForm(client);
    expect(form).toEqual({
      name: 'Jan Kowalski',
      phone: '+48600100200',
      email: 'jan@example.com',
      locale: 'pl',
    });
    expect(contactsChange(client, form, '48')).toEqual({ ok: true, change: null });
  });

  it('sends only what changed; an empty email removes it', () => {
    expect(
      contactsChange(
        client,
        { name: 'Jan Kowalski', phone: '601 100 200', email: '', locale: 'en' },
        '48',
      ),
    ).toEqual({ ok: true, change: { phone: '+48601100200', email: null, locale: 'en' } });
  });

  it('a name and a phone are needed', () => {
    expect(contactsChange(client, { ...contactsForm(client), phone: '' }, '48')).toEqual({
      ok: false,
      problem: 'phone',
    });
  });
});

describe('BusinessApi: client cards', () => {
  it('adds a client, keeps the server’s details of an error, changes the contacts', async () => {
    const calls: { key: string; body: unknown }[] = [];
    let first = true;
    const fetchFn = async (url: string, init?: RequestInit) => {
      const key = `${init?.method} ${url.replace('https://api.test', '')}`;
      calls.push({ key, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (key.startsWith('POST /v1/auth/refresh')) {
        return new Response(
          JSON.stringify({
            accessToken: 'a9',
            expiresIn: 900,
            refreshToken: 'refresh-token-0123456789new',
          }),
        );
      }
      if (key.startsWith('POST') && first) {
        first = false;
        return new Response(
          JSON.stringify({
            error: {
              code: 'CUSTOMER_PHONE_EXISTS',
              message: 'exists',
              details: [{ path: 'customerId', message: 'c9' }, { bad: true }],
            },
          }),
          { status: 409 },
        );
      }
      return new Response(JSON.stringify(client));
    };
    const store: TokenStore = {
      get: async () => 'refresh-token-0123456789abc',
      set: async () => undefined,
    };
    const api = new BusinessApi('https://api.test', store, fetchFn);
    await api.restore();
    const body = { name: 'Anna', phone: '+48600200300', locale: 'pl' as const };
    const refused = await api.createCustomer('o1', body).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ApiError);
    expect((refused as ApiError).details).toEqual([{ path: 'customerId', message: 'c9' }]);
    await api.createCustomer('o1', { ...body, allowDuplicatePhone: true });
    await api.updateCustomerContacts('o1', 'c1', 5, { name: 'Anna N.', email: null });
    expect(calls.slice(1)).toEqual([
      { key: 'POST /v1/organizations/o1/customers', body },
      {
        key: 'POST /v1/organizations/o1/customers',
        body: { ...body, allowDuplicatePhone: true },
      },
      {
        key: 'PATCH /v1/organizations/o1/customers/c1',
        body: { name: 'Anna N.', email: null, version: 5 },
      },
    ]);
  });
});
