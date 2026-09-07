import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  appendFile,
  mkdir,
  open,
  readFile,
  realpath,
  stat,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIRECTORY = path.dirname(SCRIPT_PATH);
const DEFAULT_REPOSITORY = path.resolve(SCRIPT_DIRECTORY, '..', '..');
const SERVER_PATH = path.join(SCRIPT_DIRECTORY, 'server.mjs');
const STATE_DIRECTORY_NAME = 'FanHuaSitePublisher';
const RUNTIME_FILE_NAME = 'runtime.json';
const LAUNCHER_LOCK_NAME = '.launcher.lock';
const SERVER_LOG_NAME = 'server.log';
const LAUNCHER_LOG_NAME = 'launcher.log';
const STATUS_TIMEOUT_MS = 1_200;
const STARTUP_TIMEOUT_MS = 15_000;
const LOCK_TIMEOUT_MS = 20_000;
const MAX_PNG_BYTES = 64 * 1024 * 1024;
const ALLOWED_SECTIONS = new Set(['fanhuafenluo', 'public']);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const ERROR_MESSAGES = {
  ARGUMENTS: '启动参数无效。请重新创建快捷方式后再试。',
  LOCAL_APP_DATA: '无法访问当前用户的 LocalAppData。',
  REPOSITORY: '发布工具所在的仓库不存在或无法访问。',
  SERVER_FILE: '发布工具服务端文件不存在。',
  LOCK_TIMEOUT: '发布工具正在启动，请稍后再试。',
  SERVER_CONFLICT: '另一个仓库的快捷发布工具正在运行，请先关闭它再重试。',
  SERVER_START: '本地发布工具未能启动。',
  PNG_REQUIRED: '请拖入一个 PNG 角色卡文件。',
  PNG_INVALID: '拖入的文件不是有效的 PNG。',
  IMPORT_FAILED: '角色卡自动解码失败，请稍后重试。',
  BROWSER_OPEN: '无法打开默认浏览器。',
};

class LauncherError extends Error {
  constructor(code, cause) {
    super(ERROR_MESSAGES[code] || '快捷发布工具启动失败。', { cause });
    this.name = 'LauncherError';
    this.code = code;
  }
}

function fail(code, cause) {
  if (cause instanceof LauncherError) return cause;
  return new LauncherError(code, cause);
}

function parseArguments(argv) {
  const result = {
    help: false,
    pngPath: null,
    repoPath: DEFAULT_REPOSITORY,
    section: null,
  };
  const positional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === '--help' || argument === '-h') {
      result.help = true;
      continue;
    }

    if (argument === '--section' || argument === '--repo') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw fail('ARGUMENTS');
      index += 1;
      if (argument === '--section') result.section = value;
      else result.repoPath = value;
      continue;
    }

    if (argument.startsWith('--section=')) {
      result.section = argument.slice('--section='.length);
      continue;
    }

    if (argument.startsWith('--repo=')) {
      result.repoPath = argument.slice('--repo='.length);
      continue;
    }

    if (argument === '--') {
      positional.push(...argv.slice(index + 1));
      break;
    }

    if (argument.startsWith('--')) throw fail('ARGUMENTS');
    positional.push(argument);
  }

  if (result.section !== null && !ALLOWED_SECTIONS.has(result.section)) {
    throw fail('ARGUMENTS');
  }
  if (positional.length > 1) throw fail('PNG_REQUIRED');
  result.pngPath = positional[0] || null;
  return result;
}

function usage() {
  return [
    '用法：node launcher.mjs [--section fanhuafenluo|public] [角色卡.png]',
    '',
    '不指定分区时，页面会先让你选择“繁花·纷落”或“公开”。',
  ].join('\n');
}

function stateRootFromEnvironment(environment = process.env) {
  const localAppData = environment.LOCALAPPDATA;
  if (!localAppData || !path.isAbsolute(localAppData)) throw fail('LOCAL_APP_DATA');
  return path.join(localAppData, STATE_DIRECTORY_NAME);
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function validateRuntime(value) {
  if (!isPlainObject(value)) return null;
  const { baseUrl, pid, port, token } = value;
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) return null;
  if (
    typeof token !== 'string' ||
    token.length < 32 ||
    token.length > 512 ||
    /[\u0000-\u0020\u007f]/u.test(token)
  ) {
    return null;
  }

  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== 'http:' ||
    parsed.hostname !== '127.0.0.1' ||
    parsed.port !== String(port) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    return null;
  }

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    pid,
    port,
    token,
  };
}

async function readRuntime(stateRoot) {
  try {
    const source = await readFile(path.join(stateRoot, RUNTIME_FILE_NAME), 'utf8');
    return validateRuntime(JSON.parse(source));
  } catch {
    return null;
  }
}

function sameRepository(left, right) {
  if (typeof left !== 'string' || !path.isAbsolute(left)) return false;
  const normalizedLeft = path.resolve(left).replace(/[\\/]+$/u, '');
  const normalizedRight = path.resolve(right).replace(/[\\/]+$/u, '');
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

async function readRuntimeStatus(runtime) {
  if (!runtime) return false;
  try {
    const response = await fetch(new URL('/api/status', runtime.baseUrl), {
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${runtime.token}`,
      },
      redirect: 'error',
      signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const payload = await response.json();
    return isPlainObject(payload) && typeof payload.ready === 'boolean' ? payload : null;
  } catch {
    return null;
  }
}

async function probeRuntime(runtime, repoPath) {
  const payload = await readRuntimeStatus(runtime);
  return Boolean(payload && sameRepository(payload.repository, repoPath));
}

async function healthyRuntime(stateRoot, repoPath) {
  const runtime = await readRuntime(stateRoot);
  const payload = await readRuntimeStatus(runtime);
  if (!payload) return null;
  if (!sameRepository(payload.repository, repoPath)) throw fail('SERVER_CONFLICT');
  return runtime;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function validateLockOwner(value) {
  if (
    !isPlainObject(value) ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    typeof value.nonce !== 'string' ||
    value.nonce.length < 16 ||
    value.nonce.length > 128 ||
    typeof value.startedAt !== 'string'
  ) {
    return null;
  }
  return {
    nonce: value.nonce,
    pid: value.pid,
    startedAt: value.startedAt,
  };
}

async function readLockOwner(lockPath) {
  try {
    return validateLockOwner(JSON.parse(await readFile(lockPath, 'utf8')));
  } catch {
    return null;
  }
}

function processState(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return 'unknown';
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    if (error?.code === 'ESRCH') return 'dead';
    if (error?.code === 'EPERM') return 'alive';
    return 'unknown';
  }
}

function sameLockOwner(left, right) {
  return Boolean(
    left &&
    right &&
    left.pid === right.pid &&
    left.nonce === right.nonce
  );
}

async function releaseOwnedLock(lock) {
  if (!lock) return;
  await lock.handle.close();
  const current = await readLockOwner(lock.lockPath);
  if (!sameLockOwner(current, lock)) return;
  try {
    await unlink(lock.lockPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function createOwnedLock(lockPath) {
  const lock = {
    handle: await open(lockPath, 'wx', 0o600),
    lockPath,
    nonce: randomUUID(),
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  try {
    await lock.handle.writeFile(
      `${JSON.stringify({
        pid: lock.pid,
        nonce: lock.nonce,
        startedAt: lock.startedAt,
      })}\n`,
    );
    return lock;
  } catch (error) {
    await releaseOwnedLock(lock).catch(() => {});
    throw error;
  }
}

async function tryRecoverLauncherLock(lockPath) {
  const recoveryPath = `${lockPath}.recovery`;
  let recoveryLock;
  try {
    recoveryLock = await createOwnedLock(recoveryPath);
  } catch (error) {
    if (error?.code === 'EEXIST') return false;
    throw error;
  }

  try {
    const owner = await readLockOwner(lockPath);
    if (!owner || processState(owner.pid) !== 'dead') return false;

    const confirmedOwner = await readLockOwner(lockPath);
    if (
      !sameLockOwner(owner, confirmedOwner) ||
      processState(confirmedOwner.pid) !== 'dead'
    ) {
      return false;
    }

    try {
      await unlink(lockPath);
      return true;
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
  } finally {
    await releaseOwnedLock(recoveryLock);
  }
}

async function acquireLauncherLock(stateRoot) {
  const lockPath = path.join(stateRoot, LAUNCHER_LOCK_NAME);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      return await createOwnedLock(lockPath);
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        throw fail('SERVER_START', error);
      }
      try {
        if (await tryRecoverLauncherLock(lockPath)) continue;
      } catch (recoveryError) {
        throw fail('SERVER_START', recoveryError);
      }
      await delay(120);
    }
  }

  throw fail('LOCK_TIMEOUT');
}

async function releaseLauncherLock(lock) {
  await releaseOwnedLock(lock);
}

async function startServer({ repoPath, stateRoot }) {
  try {
    const info = await stat(SERVER_PATH);
    if (!info.isFile()) throw new Error('not-file');
  } catch (error) {
    throw fail('SERVER_FILE', error);
  }

  const logHandle = await open(path.join(stateRoot, SERVER_LOG_NAME), 'a', 0o600);
  let child;
  try {
    child = spawn(
      process.execPath,
      [SERVER_PATH, '--state-dir', stateRoot, '--repo', repoPath],
      {
        cwd: repoPath,
        detached: true,
        stdio: ['ignore', logHandle.fd, logHandle.fd],
        windowsHide: true,
      },
    );
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        child.off('spawn', onSpawn);
        reject(error);
      };
      const onSpawn = () => {
        child.off('error', onError);
        resolve();
      };
      child.once('error', onError);
      child.once('spawn', onSpawn);
    });
    child.unref();
  } catch (error) {
    throw fail('SERVER_START', error);
  } finally {
    await logHandle.close();
  }
}

async function waitForServer(stateRoot, repoPath) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const runtime = await healthyRuntime(stateRoot, repoPath);
    if (runtime) return runtime;
    await delay(120);
  }
  throw fail('SERVER_START');
}

async function ensureServer({ repoPath, stateRoot }) {
  const existing = await healthyRuntime(stateRoot, repoPath);
  if (existing) return { runtime: existing, reused: true };

  const lock = await acquireLauncherLock(stateRoot);
  try {
    const afterLock = await healthyRuntime(stateRoot, repoPath);
    if (afterLock) return { runtime: afterLock, reused: true };

    try {
      await unlink(path.join(stateRoot, RUNTIME_FILE_NAME));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw fail('SERVER_START', error);
    }

    await startServer({ repoPath, stateRoot });
    return { runtime: await waitForServer(stateRoot, repoPath), reused: false };
  } finally {
    await releaseLauncherLock(lock);
  }
}

async function readPng(pngPath) {
  if (!pngPath || path.extname(pngPath).toLowerCase() !== '.png') {
    throw fail('PNG_REQUIRED');
  }

  let resolvedPath;
  let source;
  try {
    resolvedPath = await realpath(path.resolve(pngPath));
    const info = await stat(resolvedPath);
    if (!info.isFile() || info.size <= 0 || info.size > MAX_PNG_BYTES) {
      throw new Error('invalid-size');
    }
    source = await readFile(resolvedPath);
    if (source.length <= 0 || source.length > MAX_PNG_BYTES) {
      throw new Error('invalid-size-after-read');
    }
  } catch (error) {
    throw fail('PNG_INVALID', error);
  }

  if (source.length < PNG_SIGNATURE.length || !source.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw fail('PNG_INVALID');
  }
  return { filename: path.basename(resolvedPath), source };
}

async function importPng({ pngPath, runtime, section }) {
  const png = await readPng(pngPath);
  const endpoint = new URL('/api/import', runtime.baseUrl);
  endpoint.searchParams.set('filename', png.filename);
  if (section) endpoint.searchParams.set('section', section);

  let response;
  try {
    response = await fetch(endpoint, {
      body: png.source,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${runtime.token}`,
        'Content-Type': 'image/png',
      },
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    throw fail('IMPORT_FAILED', error);
  }
  if (!response.ok) throw fail('IMPORT_FAILED');

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    throw fail('IMPORT_FAILED', error);
  }
  if (
    !isPlainObject(payload) ||
    typeof payload.id !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(payload.id)
  ) {
    throw fail('IMPORT_FAILED');
  }
  return payload.id;
}

function publisherUrl({ draftId, runtime, section }) {
  const fragment = new URLSearchParams();
  fragment.set('token', runtime.token);
  if (section) fragment.set('section', section);
  if (draftId) fragment.set('draft', draftId);
  return `${runtime.baseUrl}/#${fragment.toString()}`;
}

async function openDefaultBrowser(url) {
  if (process.platform !== 'win32') throw fail('BROWSER_OPEN');
  try {
    const child = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        child.off('spawn', onSpawn);
        reject(error);
      };
      const onSpawn = () => {
        child.off('error', onError);
        resolve();
      };
      child.once('error', onError);
      child.once('spawn', onSpawn);
    });
    child.unref();
  } catch (error) {
    throw fail('BROWSER_OPEN', error);
  }
}

async function recordEvent(stateRoot, event) {
  try {
    await appendFile(
      path.join(stateRoot, LAUNCHER_LOG_NAME),
      `${new Date().toISOString()} ${event}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
  } catch {
    // Logging must never block the publisher or reveal runtime data elsewhere.
  }
}

async function resolveRepository(repoPath) {
  try {
    const resolved = await realpath(path.resolve(repoPath));
    const info = await stat(resolved);
    if (!info.isDirectory()) throw new Error('not-directory');
    return resolved;
  } catch (error) {
    throw fail('REPOSITORY', error);
  }
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const stateRoot = stateRootFromEnvironment();
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });

  try {
    const repoPath = await resolveRepository(options.repoPath);
    const server = await ensureServer({ repoPath, stateRoot });
    await recordEvent(stateRoot, server.reused ? 'server-reused' : 'server-started');

    const draftId = options.pngPath
      ? await importPng({
          pngPath: options.pngPath,
          runtime: server.runtime,
          section: options.section,
        })
      : null;
    if (draftId) await recordEvent(stateRoot, 'draft-imported');

    await openDefaultBrowser(
      publisherUrl({ draftId, runtime: server.runtime, section: options.section }),
    );
    await recordEvent(stateRoot, 'browser-opened');
  } catch (error) {
    const launcherError = error instanceof LauncherError ? error : fail('SERVER_START', error);
    await recordEvent(stateRoot, `failed-${launcherError.code.toLowerCase()}`);
    throw launcherError;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH;
if (isMain) {
  main().catch((error) => {
    const launcherError = error instanceof LauncherError ? error : fail('SERVER_START', error);
    process.stderr.write(`[${launcherError.code}] ${launcherError.message}\n`);
    process.exitCode = 1;
  });
}

export {
  LauncherError,
  acquireLauncherLock,
  ensureServer,
  importPng,
  main,
  parseArguments,
  processState,
  probeRuntime,
  publisherUrl,
  readPng,
  releaseLauncherLock,
  stateRootFromEnvironment,
  tryRecoverLauncherLock,
  validateRuntime,
};
