import { fork } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDependencies, ensureEnv, instanceId, launchPort, openBrowser, supportedNode } from './launcher-utils.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const lockFile = path.join(root, '.ttg-launch.lock');
let ownsLock = false;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function releaseLock() {
  if (!ownsLock) return;
  ownsLock = false;
  try { unlinkSync(lockFile); } catch { /* Already removed during shutdown. */ }
}
process.once('exit', releaseLock);

async function portAvailable(port) {
  return new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.once('error', (error) => {
      if (error.code === 'EADDRINUSE' || error.code === 'EACCES') resolve(false);
      else reject(error);
    });
    socket.listen(port, '127.0.0.1', () => socket.close(() => resolve(true)));
  });
}

async function studioAt(port, id) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(800) });
    const matches = response.ok && response.headers.get('x-tabletop-instance') === id;
    await response.body?.cancel();
    return matches;
  } catch { return false; }
}

async function choosePort(preferred, id) {
  let available = null;
  for (let port = preferred; port <= Math.min(preferred + 20, 65535); port++) {
    if (await portAvailable(port)) {
      available ??= port;
    } else if (await studioAt(port, id)) {
      return { port, running: true };
    }
  }
  if (available === null) throw new Error(`No free local port was found near ${preferred}. Close other local apps or change TTG_PORT in .env.`);
  return { port: available, running: false };
}

/** Serialize first-run setup. A crashed launcher leaves a lock that the next launch can recover. */
async function acquireLock() {
  let announced = false;
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    try {
      writeFileSync(lockFile, JSON.stringify({ pid: process.pid }), { flag: 'wx' });
      ownsLock = true;
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner;
      try { owner = JSON.parse(readFileSync(lockFile, 'utf8')).pid; } catch { /* Owner may still be writing. */ }
      if (Number.isInteger(owner) && owner > 0) {
        try { process.kill(owner, 0); } catch (error) {
          if (error.code === 'ESRCH') {
            try { unlinkSync(lockFile); } catch { /* Another launcher recovered it. */ }
            continue;
          }
        }
      }
      if (!announced) {
        console.log('Another launch is preparing the studio. Waiting for it to finish…');
        announced = true;
      }
      await delay(1000);
    }
  }
  throw new Error('Another launch is still setting up. Check its window, then try again.');
}

function startServer(port) {
  const child = fork(path.join(root, 'src/server/main.ts'), [], {
    cwd: root,
    env: { ...process.env, TTG_PORT: String(port) },
    execArgv: ['--experimental-strip-types'],
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
  });
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code ?? 1)));
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('The studio did not start within 45 seconds. Check the messages above and try again.'));
    }, 45_000);
    const cleanup = () => clearTimeout(timer);
    child.once('error', (error) => { cleanup(); reject(error); });
    child.once('exit', () => { cleanup(); reject(new Error('The server stopped before it was ready. Check the messages above and your .env settings.')); });
    child.on('message', (message) => {
      if (message?.type === 'ttg-ready') { cleanup(); resolve(); }
      if (message?.type === 'ttg-start-error') {
        cleanup();
        reject(Object.assign(new Error('The studio could not open its local port.'), { code: message.code }));
      }
    });
  });
  return { child, ready, exited };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('Start the studio: npm start\nKeep the browser closed: npm start -- --no-browser\nStop and save: press Ctrl+C in the launcher window.');
    return;
  }
  if (args.some((arg) => arg !== '--no-browser')) throw new Error('Unknown launch option. Use --help for launch instructions.');
  if (!supportedNode(process.versions.node)) {
    throw new Error(`Node.js ${process.versions.node} is too old. Install Node.js LTS (22.18 or newer) from https://nodejs.org/en/download, then launch again.`);
  }
  console.log('\nTableTopGames Studio\n');
  await acquireLock();
  if (ensureEnv(root)) console.log('Settings are ready. You can play offline immediately; an API key is optional.');
  process.loadEnvFile(path.join(root, '.env'));
  const preferred = launchPort(process.env.TTG_PORT);
  const id = instanceId(root);
  let selected = await choosePort(preferred, id);
  const browse = !args.includes('--no-browser');
  if (selected.running) {
    releaseLock();
    const url = `http://127.0.0.1:${selected.port}`;
    console.log(`The studio is already running: ${url}\nKeep the original launcher window open.`);
    if (browse) openBrowser(url);
    return;
  }
  await ensureDependencies(root);
  // Another process can claim a port during setup, so check again before starting.
  selected = await choosePort(preferred, id);
  if (selected.running) {
    releaseLock();
    const url = `http://127.0.0.1:${selected.port}`;
    console.log(`The studio is already running: ${url}`);
    if (browse) openBrowser(url);
    return;
  }
  let server;
  for (let attempt = 0; attempt < 3; attempt++) {
    server = startServer(selected.port);
    try { await server.ready; break; } catch (error) {
      if (error.code !== 'EADDRINUSE' || attempt === 2) throw error;
      await server.exited;
      selected = await choosePort(preferred, id);
      if (selected.running) {
        releaseLock();
        const url = `http://127.0.0.1:${selected.port}`;
        console.log(`The studio is already running: ${url}`);
        if (browse) openBrowser(url);
        return;
      }
    }
  }
  releaseLock();
  let stopping = false;
  function stop() {
    if (stopping) return;
    stopping = true;
    console.log('\nSaving your tables and stopping the studio…');
    if (server.child.connected) server.child.send({ type: 'ttg-shutdown' });
    else server.child.kill();
    const timer = setTimeout(() => server.child.kill(), 5000);
    timer.unref();
  }
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  // Allows a supervising process to stop safely on Windows as well as POSIX systems.
  process.on('message', (message) => { if (message?.type === 'ttg-shutdown') stop(); });
  const url = `http://127.0.0.1:${selected.port}`;
  if (selected.port !== preferred) console.log(`Port ${preferred} was busy; using ${selected.port} instead.`);
  console.log(`\nYour studio is ready: ${url}\nKeep this window open while playing. Press Ctrl+C here to save and stop.\n`);
  if (browse) openBrowser(url);
  const code = await server.exited;
  if (code !== 0) throw new Error('The studio stopped unexpectedly. Check the messages above, then launch again.');
}

main()
  .catch((error) => {
    releaseLock();
    console.error(`\n${error.message}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    if (process.connected) process.disconnect();
  });
