import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import react from '@vitejs/plugin-react';
import { GmApp } from './app.ts';
import { loadConfig } from './config.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
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
  void app.handle(req, res).then((handled) => {
    if (!handled) vite.middlewares(req, res);
  });
});

httpServer.listen(config.port, '127.0.0.1', () => {
  const health = app.health();
  console.log(`TableTopGames GM app: http://127.0.0.1:${config.port}`);
  console.log(`Contestants: ${health.contestantProvider} (${health.contestantModel}) · saves in ${path.resolve(repoRoot, config.dataDir)}`);
});

function shutdown(): void {
  app.saveAll();
  httpServer.close();
  void vite.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
