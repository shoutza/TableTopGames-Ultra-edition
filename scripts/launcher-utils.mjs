import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants, copyFileSync, existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export function supportedNode(version) {
  const [major, minor] = version.replace(/^v/, '').split('.').map(Number);
  return major > 22 || (major === 22 && minor >= 18);
}

export function launchPort(value) {
  const port = value?.trim() ? Number(value) : 5173;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('TTG_PORT must be a whole number from 1 to 65535. Correct it in .env, then launch again.');
  }
  return port;
}

export function instanceId(root) {
  return createHash('sha256').update(realpathSync(root)).digest('hex');
}

/** Create the optional settings file once; never replace an existing key or settings. */
export function ensureEnv(root) {
  try {
    copyFileSync(path.join(root, '.env.example'), path.join(root, '.env'), constants.COPYFILE_EXCL);
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
}

export function dependencyStamp(root) {
  return createHash('sha256')
    .update(readFileSync(path.join(root, 'package-lock.json')))
    .update(`${process.platform}/${process.arch}/node${process.versions.node.split('.')[0]}`)
    .digest('hex');
}

function hasDirectDependencies(root) {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  return Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).every((name) =>
    existsSync(path.join(root, 'node_modules', name, 'package.json')),
  );
}

export function runNpm(root, args, quiet = false) {
  return new Promise((resolve, reject) => {
    // npm.cmd needs the Windows command interpreter. Arguments here are fixed literals.
    const child = spawn('npm', args, {
      cwd: root,
      shell: process.platform === 'win32',
      stdio: quiet ? 'ignore' : 'inherit',
    });
    child.once('error', () => reject(new Error('npm could not run. Reinstall Node.js with the default installer options.')));
    child.once('exit', (code) => resolve(code ?? 1));
  });
}

/** A changed lockfile/runtime triggers installation; a healthy existing install can be adopted. */
export async function ensureDependencies(root, run = runNpm, report = console.log) {
  const stampFile = path.join(root, 'node_modules', '.ttg-launcher-stamp');
  const stamp = dependencyStamp(root);
  const previous = existsSync(stampFile) ? readFileSync(stampFile, 'utf8') : null;
  if (previous === stamp && hasDirectDependencies(root)) return;

  report('Checking the studio setup…');
  if (previous === null && hasDirectDependencies(root) && (await run(root, ['ls', '--depth=0'], true)) === 0) {
    writeFileSync(stampFile, stamp);
    return;
  }
  report('Installing the studio dependencies. The first launch needs an internet connection…');
  if ((await run(root, ['ci', '--include=dev'])) !== 0 || !hasDirectDependencies(root)) {
    throw new Error('Setup did not finish. Check your internet connection and launch again. Your saves and .env settings are unchanged.');
  }
  writeFileSync(stampFile, stamp);
}

export function browserCommand(url, platform = process.platform) {
  if (platform === 'win32') return ['rundll32.exe', ['url.dll,FileProtocolHandler', url]];
  if (platform === 'darwin') return ['open', [url]];
  return ['xdg-open', [url]];
}

export function openBrowser(url) {
  const [command, args] = browserCommand(url);
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  const fallback = () => console.log(`Open this address in your browser: ${url}`);
  child.once('error', fallback);
  child.once('exit', (code) => { if (code) fallback(); });
  child.unref();
}
