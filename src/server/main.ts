import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import react from '@vitejs/plugin-react';
import { loadConfig } from './config.ts';
import { ENGINE_VERSION, RULES_LANGUAGE_VERSION } from '../schema/versions.ts';
import type { HealthResponse } from '../shared/api.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const config = loadConfig(process.env);

const httpServer = http.createServer();

const vite = await createViteServer({
  configFile: false,
  root: path.join(repoRoot, 'src/web'),
  plugins: [react()],
  appType: 'spa',
  server: {
    middlewareMode: true,
    hmr: { server: httpServer },
    fs: { allow: [repoRoot] },
  },
});

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

httpServer.on('request', (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/api/health') {
    const body: HealthResponse = {
      ok: true,
      engineVersion: ENGINE_VERSION,
      rulesLanguageVersion: RULES_LANGUAGE_VERSION,
      contestantProvider: config.openaiApiKey ? 'openai' : 'offline',
      contestantModel: config.contestantModel,
    };
    sendJson(res, 200, body);
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    sendJson(res, 404, { error: 'not found' });
    return;
  }
  vite.middlewares(req, res);
});

httpServer.listen(config.port, '127.0.0.1', () => {
  console.log(`TableTopGames GM app: http://127.0.0.1:${config.port}`);
  if (!config.openaiApiKey) console.log('No OPENAI_API_KEY set: contestants use the offline controller.');
});
