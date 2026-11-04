#!/usr/bin/env node
// Starts one phone app in Expo for testing on a real iPhone or Android phone:
//   pnpm mobile:client      (client app, Metro on port 8081)
//   pnpm mobile:business    (business app, Metro on port 8082)
// Extra arguments go to Expo, e.g. `pnpm mobile:client --tunnel`.
// The phone cannot reach "localhost" of the Mac, so the apps get the Mac's address in the
// local network (EXPO_PUBLIC_API_URL / EXPO_PUBLIC_WEB_URL). API and web must already run:
// `pnpm dev` (or ./scripts/dev.sh) in another Terminal window.
import { spawn } from 'node:child_process';
import { networkInterfaces } from 'node:os';

const APPS = {
  client: { filter: '@beauty/mobile-client', port: 8081 },
  business: { filter: '@beauty/mobile-business', port: 8082 },
};

const [which, ...expoArgs] = process.argv.slice(2);
const app = APPS[which];
if (!app) {
  console.error('Usage: node scripts/mobile.mjs client|business [expo options]');
  process.exit(1);
}

/** The Mac's IPv4 address in the local network: Wi-Fi (en0) first, then any other. */
function lanAddress() {
  const all = networkInterfaces();
  const candidates = [];
  for (const [name, list] of Object.entries(all)) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal) candidates.push({ name, address: a.address });
    }
  }
  const rank = (c) => (c.name === 'en0' ? 0 : c.name.startsWith('en') ? 1 : 2);
  candidates.sort((a, b) => rank(a) - rank(b));
  return candidates[0]?.address;
}

const ip = process.env.MOBILE_HOST ?? lanAddress();
if (!ip) {
  console.error('No network address found: connect the Mac to Wi-Fi (or set MOBILE_HOST=…).');
  process.exit(1);
}
const env = {
  ...process.env,
  EXPO_PUBLIC_API_URL: process.env.EXPO_PUBLIC_API_URL ?? `http://${ip}:4000`,
  EXPO_PUBLIC_WEB_URL: process.env.EXPO_PUBLIC_WEB_URL ?? `http://${ip}:3000`,
};
console.log(`API for the phone: ${env.EXPO_PUBLIC_API_URL}`);
console.log(`Web for the phone: ${env.EXPO_PUBLIC_WEB_URL}`);
console.log(`Check on the phone in Safari: ${env.EXPO_PUBLIC_API_URL}/v1/health — it must open.`);

const child = spawn(
  'pnpm',
  ['--filter', app.filter, 'exec', 'expo', 'start', '--port', String(app.port), ...expoArgs],
  { stdio: 'inherit', env },
);
child.on('exit', (code) => process.exit(code ?? 0));
