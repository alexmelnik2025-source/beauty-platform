/**
 * Task 688 (owner's rule: errors at the field): the client's contact fields on the booking "Dane"
 * step and in "Powiadom mnie, gdy zwolni się termin" are looked at before sending, so an empty or
 * wrong field is said under it instead of in the browser's bubble. The same limits as the server.
 */

export type ContactField = 'name' | 'phone' | 'email' | 'terms';
export type ContactProblems = Partial<Record<ContactField, string>>;

/** A plain look at an e-mail address: something@something.something, no spaces. */
export const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The server's phone rule: "+", a country code and 7 to 15 digits in all. */
export const PHONE_SHAPE = /^\+[1-9]\d{6,14}$/;

export function contactProblems(
  input: {
    name: string;
    /** The phone already normalized ("+48600100200"); undefined when this form does not ask it. */
    phone?: string;
    /** Undefined when this form does not ask it (a signed-in client's own address). */
    email?: string;
    acceptTerms: boolean;
  },
  texts: { name: string; phone: string; email: string; terms: string },
): ContactProblems {
  const found: ContactProblems = {};
  if (!input.name.trim()) found.name = texts.name;
  if (input.phone !== undefined && !PHONE_SHAPE.test(input.phone.replace(/[\s()-]/g, ''))) {
    found.phone = texts.phone;
  }
  if (input.email !== undefined && !EMAIL_SHAPE.test(input.email.trim())) {
    found.email = texts.email;
  }
  if (!input.acceptTerms) found.terms = texts.terms;
  return found;
}

/** The order the fields stand in on screen: the cursor goes to the first one with an error. */
export const CONTACT_ORDER: readonly ContactField[] = ['name', 'phone', 'email', 'terms'];
