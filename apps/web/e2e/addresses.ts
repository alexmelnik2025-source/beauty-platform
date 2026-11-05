/**
 * Task 90: the API allows 10 sign-ups an hour from one address, and the e2e suite signs up more
 * accounts than that. Each sign-up comes from an address of its own (198.18.0.0/15 is reserved
 * for tests, RFC 2544), so adding a test never runs into 429. Password sign-ins too (30 in
 * 15 minutes from one address — task 153). The CI proxy passes
 * `x-forwarded-for` on to the API.
 */
const start = Math.floor(Math.random() * 60_000);
let next = 0;

/** Headers of a request from a fresh address, e.g. `{ 'x-forwarded-for': '198.18.12.34' }`. */
export function freshAddress(): Record<string, string> {
  next += 1;
  const n = (start + next) % 65_536;
  return { 'x-forwarded-for': `198.18.${n >> 8}.${n & 255}` };
}
