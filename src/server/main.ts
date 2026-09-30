import { existsSync, readFileSync, statSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GmApp } from './app.ts';
import { loadConfig } from './config.ts';

/**
 * Starts the GM server. Default (npm run dev): the web app is served by Vite in middleware mode
 * with hot reload. With --serve-dist (npm start): the prebuilt bundle in dist-web/ is served.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const config = loadConfig(process.env);
const app = new GmApp({ ...config, dataDir: path.resolve(repoRoot, config.dataDir) }, repoRoot);
const serveDist = process.argv.includes('--serve-dist');

const httpServer = http.createServer();

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/** Static handler for dist-web/ with a single-page-app fallback to index.html. */
function staticHandler(root: string): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  return (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let file = path.resolve(root, `.${decodeURIComponent(url.pathname)}`);
    if (!file.startsWith(root)) {
      res.writeHead(403).end();
      return;
    }
    if (!existsSync(file) || statSync(file).isDirectory()) file = path.join(root, 'index.html');
    const type = CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream';
    const immutable = file.includes(`${path.sep}assets${path.sep}`);
    res.writeHead(200, { 'content-type': type, 'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache' });
    res.end(readFileSync(file));
  };
}

let web: (req: http.IncomingMessage, res: http.ServerResponse) => void;
let closeWeb: () => Promise<void> = async () => {};
if (serveDist) {
  const dist = path.join(repoRoot, 'dist-web');
  if (!existsSync(path.join(dist, 'index.html'))) {
    console.error('dist-web/ has no build. Run `npm run build` first (or use `npm run dev`).');
    process.exit(1);
  }
  web = staticHandler(dist);
} else {
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({
    configFile: path.join(repoRoot, 'vite.config.ts'),
    root: path.join(repoRoot, 'src/web'),
    appType: 'spa',
    server: {
      middlewareMode: true,
      hmr: { server: httpServer },
      fs: { allow: [repoRoot] },
    },
  });
  web = (req, res) => vite.middlewares(req, res);
  closeWeb = () => vite.close();
}

httpServer.on('request', (req, res) => {
  void app.handle(req, res).then((handled) => {
    if (!handled) web(req, res);
  });
});

httpServer.listen(config.port, '127.0.0.1', () => {
  const health = app.health();
  console.log(`TableTopGames GM app: http://127.0.0.1:${config.port}${serveDist ? ' (built bundle)' : ''}`);
  console.log(`Contestants: ${health.contestantProvider} (${health.contestantModel}) · saves in ${path.resolve(repoRoot, config.dataDir)}`);
});

function shutdown(): void {
  app.saveAll();
  httpServer.close();
  void closeWeb();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
