import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize } from 'node:path';

/**
 * Serves the web preview of a phone app (`expo export --platform web` → apps/<app>/dist)
 * and passes /v1 on to the API, like the web app does — so the app talks to the real API
 * from the same address. Screenshots of the preview show the owner what the app looks like.
 */
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ttf': 'font/ttf',
  '.ico': 'image/x-icon',
};

export async function serveApp(app: string): Promise<{ url: string; server: Server }> {
  const root = join(process.cwd(), '..', app, 'dist');
  if (!existsSync(join(root, 'index.html'))) throw new Error(`${root} is not built`);
  const api = new URL(process.env.API_URL ?? 'http://localhost:4000');

  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]!;
    if (path.startsWith('/v1/')) {
      const upstream = request(
        {
          host: api.hostname,
          port: api.port,
          path: req.url,
          method: req.method,
          headers: { ...req.headers, host: api.host },
        },
        (answer) => {
          res.writeHead(answer.statusCode ?? 502, answer.headers);
          answer.pipe(res);
        },
      );
      upstream.on('error', () => res.writeHead(502).end());
      req.pipe(upstream);
      return;
    }
    let file = normalize(join(root, decodeURIComponent(path)));
    if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) {
      file = join(root, 'index.html');
    }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}
