import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';
import { browserCommand, dependencyStamp, ensureDependencies, ensureEnv, runNpm, supportedNode } from './launcher-utils.mjs';

const scripts = path.dirname(fileURLToPath(import.meta.url));
const roots = [];
const children = [];
const sockets = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.connected) {
      child.send({ type: 'ttg-shutdown' });
      await Promise.race([child.done, new Promise((resolve) => setTimeout(resolve, 2000))]);
      if (child.exitCode === null) child.kill();
    }
  }
  for (const socket of sockets.splice(0)) {
    for (const client of socket.clients) client.destroy();
    await new Promise((resolve) => socket.close(resolve));
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(deps = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'ttg launcher & spaces '));
  roots.push(root);
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'launcher-fixture', version: '1.0.0', dependencies: deps }));
  writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ name: 'launcher-fixture', version: '1.0.0', lockfileVersion: 3, packages: { '': { name: 'launcher-fixture', version: '1.0.0', dependencies: deps } } }));
  writeFileSync(path.join(root, '.env.example'), 'OPENAI_API_KEY=\nTTG_PORT=5173\n');
  return root;
}

function installFakeDependency(root) {
  mkdirSync(path.join(root, 'node_modules', 'fixture-dep'), { recursive: true });
  writeFileSync(path.join(root, 'node_modules', 'fixture-dep', 'package.json'), '{"name":"fixture-dep","version":"1.0.0"}');
}

test('old Node versions get rejected before TypeScript or dependency imports', () => {
  for (const version of ['18.20.0', '20.19.0', '22.17.1']) assert.equal(supportedNode(version), false);
  for (const version of ['22.18.0', 'v24.0.0', '26.0.0']) assert.equal(supportedNode(version), true);
});

test('first-run settings preserve an existing key and saved games', () => {
  const root = fixture();
  mkdirSync(path.join(root, 'data'));
  writeFileSync(path.join(root, 'data', 'saved.json'), '{"keep":true}');
  assert.equal(ensureEnv(root), true);
  const settings = 'OPENAI_API_KEY=test-placeholder\nTTG_PORT=6000\n';
  writeFileSync(path.join(root, '.env'), settings);
  assert.equal(ensureEnv(root), false);
  assert.equal(readFileSync(path.join(root, '.env'), 'utf8'), settings);
  assert.equal(readFileSync(path.join(root, 'data', 'saved.json'), 'utf8'), '{"keep":true}');
});

test('first installation uses the lockfile; repeat launches skip installation', async () => {
  const root = fixture({ 'fixture-dep': '1.0.0' });
  const calls = [];
  const run = async (_, args) => { calls.push(args); installFakeDependency(root); return 0; };
  await ensureDependencies(root, run, () => {});
  await ensureDependencies(root, run, () => {});
  assert.deepEqual(calls, [['ci', '--include=dev']]);
  assert.equal(readFileSync(path.join(root, 'node_modules', '.ttg-launcher-stamp'), 'utf8'), dependencyStamp(root));
});

test('a healthy manual install is adopted without a download', async () => {
  const root = fixture({ 'fixture-dep': '1.0.0' });
  installFakeDependency(root);
  const calls = [];
  await ensureDependencies(root, async (_, args) => { calls.push(args); return 0; }, () => {});
  assert.deepEqual(calls, [['ls', '--depth=0']]);
});

test('changed lockfiles and missing packages trigger a repair', async () => {
  const root = fixture({ 'fixture-dep': '1.0.0' });
  const calls = [];
  const run = async (_, args) => { calls.push(args); installFakeDependency(root); return 0; };
  await ensureDependencies(root, run, () => {});
  writeFileSync(path.join(root, 'package-lock.json'), readFileSync(path.join(root, 'package-lock.json'), 'utf8') + '\n');
  await ensureDependencies(root, run, () => {});
  rmSync(path.join(root, 'node_modules', 'fixture-dep'), { recursive: true });
  await ensureDependencies(root, run, () => {});
  assert.equal(calls.filter((args) => args[0] === 'ci').length, 3);
});

test('failed setup can be retried and does not erase settings or saves', async () => {
  const root = fixture({ 'fixture-dep': '1.0.0' });
  ensureEnv(root);
  mkdirSync(path.join(root, 'data'));
  writeFileSync(path.join(root, 'data', 'saved.json'), 'saved');
  const before = readFileSync(path.join(root, '.env'), 'utf8');
  await assert.rejects(ensureDependencies(root, async () => 1, () => {}), /Setup did not finish/);
  assert.equal(existsSync(path.join(root, 'node_modules', '.ttg-launcher-stamp')), false);
  assert.equal(readFileSync(path.join(root, '.env'), 'utf8'), before);
  assert.equal(readFileSync(path.join(root, 'data', 'saved.json'), 'utf8'), 'saved');
  await ensureDependencies(root, async () => { installFakeDependency(root); return 0; }, () => {});
});

test('npm runs in a path containing spaces and shell characters', async () => {
  const root = fixture();
  assert.equal(await runNpm(root, ['ci', '--include=dev'], true), 0);
});

test('browser commands use platform launchers with the URL as one argument', () => {
  const url = 'http://127.0.0.1:5173';
  assert.deepEqual(browserCommand(url, 'win32'), ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]);
  assert.deepEqual(browserCommand(url, 'darwin'), ['open', [url]]);
  assert.deepEqual(browserCommand(url, 'linux'), ['xdg-open', [url]]);
});

async function reservePort() {
  const socket = net.createServer();
  socket.clients = new Set();
  socket.on('connection', (client) => {
    socket.clients.add(client);
    client.once('close', () => socket.clients.delete(client));
  });
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', resolve);
  });
  sockets.push(socket);
  return { socket, port: socket.address().port };
}

function prepareServer(root) {
  mkdirSync(path.join(root, 'scripts'));
  mkdirSync(path.join(root, 'src', 'server'), { recursive: true });
  mkdirSync(path.join(root, 'node_modules'), { recursive: true });
  for (const name of ['launch.mjs', 'launcher-utils.mjs']) copyFileSync(path.join(scripts, name), path.join(root, 'scripts', name));
  writeFileSync(path.join(root, 'node_modules', '.ttg-launcher-stamp'), dependencyStamp(root));
  writeFileSync(path.join(root, 'src', 'server', 'main.ts'), `
    import http from 'node:http';
    import { createHash } from 'node:crypto';
    import { realpathSync, appendFileSync, writeFileSync } from 'node:fs';
    const id = createHash('sha256').update(realpathSync(process.cwd())).digest('hex');
    appendFileSync('boots.txt', 'boot\\n');
    const server = http.createServer((req, res) => {
      res.setHeader('X-Tabletop-Instance', id);
      res.end('{"ok":true}');
    });
    server.listen(Number(process.env.TTG_PORT), '127.0.0.1', () => process.send({ type: 'ttg-ready' }));
    process.on('message', (msg) => {
      if (msg.type === 'ttg-shutdown') { writeFileSync('stopped.txt', 'saved'); server.close(() => process.exit(0)); }
    });
  `);
}

function launch(root, port, env = {}) {
  const child = spawn(process.execPath, [path.join(root, 'scripts', 'launch.mjs'), '--no-browser'], {
    cwd: tmpdir(),
    env: { ...process.env, TTG_PORT: String(port), ...env },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.output = '';
  child.stdout.on('data', (chunk) => { child.output += chunk; });
  child.stderr.on('data', (chunk) => { child.output += chunk; });
  child.done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code));
  });
  children.push(child);
  return child;
}

async function ready(child) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const match = child.output.match(/Your studio is ready: (http:\/\/127\.0\.0\.1:\d+)/);
    if (match) return match[1];
    if (child.exitCode !== null) assert.fail(child.output);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  assert.fail('Launcher readiness timed out: ' + child.output);
}

test('busy port fallback, repeat launch, stale lock recovery and safe shutdown', { timeout: 25_000 }, async () => {
  const root = fixture();
  prepareServer(root);
  const { port } = await reservePort();
  // Pick an impossible process ID to represent an interrupted previous launch.
  writeFileSync(path.join(root, '.ttg-launch.lock'), '{"pid":2147483647}');
  const first = launch(root, port);
  const url = await ready(first);
  assert.notEqual(url, `http://127.0.0.1:${port}`);
  assert.match(first.output, /was busy/);
  assert.equal((await fetch(url + '/api/health')).status, 200);
  assert.equal(existsSync(path.join(root, '.ttg-launch.lock')), false);

  const second = launch(root, port);
  assert.equal(await second.done, 0);
  assert.ok(second.output.includes(`already running: ${url}`));
  assert.equal(readFileSync(path.join(root, 'boots.txt'), 'utf8'), 'boot\n');
  first.send({ type: 'ttg-shutdown' });
  assert.equal(await first.done, 0);
  assert.equal(readFileSync(path.join(root, 'stopped.txt'), 'utf8'), 'saved');
});

test('simultaneous launches share one server', { timeout: 25_000 }, async () => {
  const root = fixture();
  prepareServer(root);
  const { socket, port } = await reservePort();
  await new Promise((resolve) => socket.close(resolve));
  sockets.splice(sockets.indexOf(socket), 1);
  const first = launch(root, port);
  const second = launch(root, port);
  const deadline = Date.now() + 15_000;
  while (first.exitCode === null && second.exitCode === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  const owner = first.exitCode === null ? first : second;
  const reused = owner === first ? second : first;
  assert.equal(await reused.done, 0);
  assert.match(reused.output, /already running/);
  await ready(owner);
  assert.equal(readFileSync(path.join(root, 'boots.txt'), 'utf8'), 'boot\n');
  owner.send({ type: 'ttg-shutdown' });
  assert.equal(await owner.done, 0);
});

test('invalid port settings show an actionable error and release setup lock', { timeout: 15_000 }, async () => {
  const root = fixture();
  prepareServer(root);
  const child = launch(root, 'bad-port');
  assert.equal(await child.done, 1);
  assert.match(child.output, /TTG_PORT must be a whole number/);
  assert.equal(existsSync(path.join(root, '.ttg-launch.lock')), false);
  assert.equal(existsSync(path.join(root, 'boots.txt')), false);
});
