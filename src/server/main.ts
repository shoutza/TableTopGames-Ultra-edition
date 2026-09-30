import http from 'node:http';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import react from '@vitejs/plugin-react';
import { GmApp } from './app.ts';
import { loadConfig } from './config.ts';

const repoRoot = realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'));
const instanceId = createHash('sha256').update(repoRoot).digest('hex');
const config = loadConfig(process.env);
const app = new GmApp({ ...config, dataDir: path.resolve(repoRoot, config.dataDir) }, repoRoot);

const httpServer = http.createServer();

const vite = await createViteServer({
  configFile: false,
  root: path.join(repoRoot, 'src/web'),
  plugins: [react()],
  appType: 'spa',
  logLevel: 'warn',
  server: {
    middlewareMode: true,
    hmr: { server: httpServer },
    fs: { allow: [repoRoot] },
  },
});

httpServer.on('request', (req, res) => {
  // A second launcher can recognize this project without starting another save writer.
  if (req.url === '/api/health') res.setHeader('X-Tabletop-Instance', instanceId);
  void app.handle(req, res).then((handled) => {
    if (!handled) vite.middlewares(req, res);
  });
});

httpServer.on('error', (error: NodeJS.ErrnoException) => {
  console.error(`The studio could not start: ${error.code ?? error.message}`);
  if (process.connected) process.send?.({ type: 'ttg-start-error', code: error.code }, () => process.exit(1));
  else process.exit(1);
});

httpServer.listen(config.port, '127.0.0.1', () => {
  const health = app.health();
  console.log(`TableTopGames GM app: http://127.0.0.1:${config.port}`);
  console.log(`Contestants: ${health.contestantProvider} (${health.contestantModel}) · saves in ${path.resolve(repoRoot, config.dataDir)}`);
  if (process.connected) process.send?.({ type: 'ttg-ready' });
});

function shutdown(): void {
  app.saveAll();
  httpServer.close();
  void vite.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('message', (message: unknown) => {
  if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'ttg-shutdown') shutdown();
});
