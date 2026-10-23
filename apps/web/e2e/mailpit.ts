/** Reads emails caught by Mailpit (http://localhost:8025) during the test. */
const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025';

interface Summary {
  ID: string;
  To: { Address: string }[];
  Subject: string;
}

export async function listTo(address: string): Promise<Summary[]> {
  const res = await fetch(`${MAILPIT}/api/v1/messages?limit=200`);
  const body = (await res.json()) as { messages: Summary[] };
  return body.messages.filter((m) => m.To.some((to) => to.Address === address));
}

export async function textOf(id: string): Promise<string> {
  const res = await fetch(`${MAILPIT}/api/v1/message/${id}`);
  return ((await res.json()) as { Text: string }).Text;
}

/** Waits until an email to `address` whose subject matches arrives; returns its text. */
export async function waitForEmail(
  address: string,
  subject: RegExp,
  timeoutMs = 20_000,
): Promise<{ subject: string; text: string }> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const found = (await listTo(address)).find((m) => subject.test(m.Subject));
    if (found) return { subject: found.Subject, text: await textOf(found.ID) };
    if (Date.now() > until) throw new Error(`No email to ${address} matching ${subject}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

export async function clearMailbox(): Promise<void> {
  await fetch(`${MAILPIT}/api/v1/messages`, { method: 'DELETE' });
}
