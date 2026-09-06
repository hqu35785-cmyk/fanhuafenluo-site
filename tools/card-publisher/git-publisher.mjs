import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { addRoleCard as defaultAddRoleCard } from "../../scripts/lib/card-import.mjs";

export const EXPECTED_REPOSITORY = "hqu35785-cmyk/fanhuafenluo-site";
export const DEFAULT_SITE_URL = "https://hqu35785-cmyk.github.io/fanhuafenluo-site/";
export const MIGRATION_REASON = "新站远端尚未具备发布所需结构";

const SECTION_IDS = new Set(["fanhuafenluo", "public"]);
const REUSABLE_JOB_STATES = new Set([
  "queued",
  "preparing",
  "pushing",
  "deploying",
  "checking",
  "pending_deployment",
  "push_uncertain",
  "succeeded",
]);
const CHECKABLE_JOB_STATES = new Set([
  "checking",
  "deploying",
  "pending_deployment",
  "push_uncertain",
  "succeeded",
]);
const REQUIRED_REMOTE_FILES = Object.freeze([
  "src/data/catalog.json",
  "scripts/add-role-card.mjs",
  "scripts/lib/card-import.mjs",
  ".github/workflows/pages.yml",
  "package.json",
  "package-lock.json",
]);
const DEFAULT_CHECKS = Object.freeze([
  ["npm", ["test"]],
  ["npm", ["run", "validate:assets"]],
  ["npm", ["run", "check:details"]],
  ["npm", ["run", "build:pages"]],
  ["npm", ["run", "verify:pages-site"]],
]);

class PublisherError extends Error {
  constructor(code, message, options = undefined) {
    super(message, options);
    this.name = "PublisherError";
    this.code = code;
  }
}

class CommandError extends Error {
  constructor(command, code, result, options = undefined) {
    super(`${command} exited with status ${code}`, options);
    this.name = "CommandError";
    this.command = command;
    this.exitCode = code;
    this.result = result;
  }
}

function publisherError(code, message, cause = undefined) {
  return new PublisherError(code, message, cause ? { cause } : undefined);
}

function nowIso() {
  return new Date().toISOString();
}

function hashJson(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function safeIdentifier(value, label) {
  if (typeof value !== "string" || !/^[0-9A-Za-z-]{8,128}$/.test(value)) {
    throw publisherError("INVALID_ID", `${label} 无效`);
  }
  return value;
}

function normalizeSha256(value, label = "SHA-256") {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/i.test(value.trim())) {
    throw publisherError("INVALID_SHA256", `${label} 无效`);
  }
  return value.trim().toLowerCase();
}

function normalizeCommit(value) {
  const commit = String(value || "").trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw publisherError("INVALID_COMMIT", "Git 返回了无效提交编号");
  }
  return commit;
}

function normalizeRelativePath(value) {
  if (typeof value !== "string" || !value || value.includes("\0") || value.includes("\\")) {
    throw publisherError("INVALID_CHANGED_FILES", "导入器返回了无效文件路径");
  }
  const normalized = path.posix.normalize(value);
  if (
    normalized !== value ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    path.posix.isAbsolute(normalized)
  ) {
    throw publisherError("INVALID_CHANGED_FILES", "导入器返回了越界文件路径");
  }
  return normalized;
}

function publicFailure(error) {
  const messages = {
    ASSET_COLLISION: "目标资源位置发生冲突，未发布任何内容。",
    AUTH_FAILED: "GitHub 登录已失效，请先重新登录后重试。",
    CARD_READ_FAILED: "草稿中的 PNG 已无法读取，请重新拖入。",
    DENYLISTED_CARD: "该角色卡已被安全策略阻止，不能发布。",
    DUPLICATE_CARD: "同一张角色卡已经存在，未重复发布。",
    IMPORT_BUSY: "另一个导入事务仍在执行，请稍后重试。",
    INCOMPLETE_REPOSITORY: MIGRATION_REASON,
    INVALID_SECTION: "发布分区无效。",
    MIGRATION_REQUIRED: MIGRATION_REASON,
    PUBLISH_BUSY: "另一项发布仍在执行，请稍后重试。",
    REMOTE_ADVANCED: "远端 main 在检查期间发生了变化，请重新发布草稿。",
    REMOTE_MISMATCH: "远端仓库不是指定的繁花纷落仓库，已禁止发布。",
    SHA256_MISMATCH: "草稿 PNG 在检查后发生变化，请重新拖入。",
  };
  return messages[error?.code] || "发布失败；草稿已保留，可在确认环境后重试。";
}

function commandInvocation(command, args) {
  if (process.platform === "win32" && command === "npm") {
    const candidates = [
      path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
      ...(process.env.ProgramFiles
        ? [path.join(process.env.ProgramFiles, "nodejs", "node_modules", "npm", "bin", "npm-cli.js")]
        : []),
    ];
    const npmCli = candidates.find((candidate) => fsSync.existsSync(candidate));
    if (!npmCli) throw publisherError("NPM_NOT_FOUND", "找不到与当前 Node 配套的 npm-cli.js");
    return { command: process.execPath, args: [npmCli, ...args] };
  }
  return { command, args };
}

function terminateProcessTree(child) {
  const pid = Number(child.pid);
  if (!Number.isInteger(pid) || pid < 1) {
    child.kill();
    return null;
  }
  if (process.platform === "win32") {
    const systemRoot = [process.env.SystemRoot, process.env.windir]
      .find((candidate) => candidate && path.isAbsolute(candidate));
    const taskkill = systemRoot
      ? path.join(systemRoot, "System32", "taskkill.exe")
      : "taskkill.exe";
    try {
      const killer = spawn(taskkill, ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      killer.once("error", () => child.kill());
      killer.once("close", (code) => {
        if (code !== 0) child.kill();
      });
    } catch {
      child.kill();
    }
    return null;
  }

  const signalGroup = (signal) => {
    try {
      process.kill(-pid, signal);
    } catch {
      child.kill(signal);
    }
  };
  signalGroup("SIGTERM");
  const forceTimer = setTimeout(() => signalGroup("SIGKILL"), 2_000);
  forceTimer.unref?.();
  return forceTimer;
}

export function defaultCommandRunner(command, args, options = {}) {
  const maximumOutput = options.maximumOutput ?? 2 * 1024 * 1024;
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
  return new Promise((resolve, reject) => {
    let invocation;
    try {
      invocation = commandInvocation(command, args);
    } catch (error) {
      reject(error);
      return;
    }
    const child = spawn(invocation.command, invocation.args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let outputExceeded = false;
    let timedOut = false;
    const append = (current, chunk) => {
      if (current.length >= maximumOutput) {
        outputExceeded = true;
        return current;
      }
      const remaining = maximumOutput - current.length;
      if (chunk.length > remaining) outputExceeded = true;
      return Buffer.concat([current, chunk.subarray(0, remaining)]);
    };
    child.stdout.on("data", (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = append(stderr, chunk);
    });
    child.once("error", reject);
    let forceKillTimer = null;
    const timer = setTimeout(() => {
      timedOut = true;
      forceKillTimer = terminateProcessTree(child);
    }, timeoutMs);
    timer.unref?.();
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      resolve({
        code: Number.isInteger(code) ? code : 1,
        signal,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        outputExceeded,
        timedOut,
      });
    });
  });
}

async function atomicWriteJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.rename(temporary, filePath);
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function pathIsFile(filePath) {
  try {
    const stat = await fs.lstat(filePath);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export function repositorySlugFromRemote(remoteUrl) {
  const value = String(remoteUrl || "").trim();
  let host;
  let pathname;
  if (value.includes("://")) {
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== "https:" && parsed.protocol !== "ssh:") return null;
      host = parsed.hostname;
      pathname = parsed.pathname;
    } catch {
      return null;
    }
  } else {
    const scp = value.match(/^(?:[^@/]+@)?([^:/]+):(.+)$/);
    if (!scp || /^[a-z]:/i.test(value)) return null;
    host = scp[1];
    pathname = scp[2];
  }
  if (String(host).toLowerCase() !== "github.com") return null;
  const clean = String(pathname).replace(/^\/+/, "").replace(/\.git$/i, "").replace(/\/+$/, "");
  return /^[^/]+\/[^/]+$/.test(clean) ? clean.toLowerCase() : null;
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function releaseOwnedLock(lockPath, handle, nonce) {
  await handle?.close().catch(() => {});
  let current = null;
  try {
    current = await readJson(lockPath);
  } catch {}
  if (current?.nonce === nonce) await fs.rm(lockPath, { force: true });
}

async function reclaimDeadLock(lockPath) {
  const recoveryPath = `${lockPath}.recovery`;
  const recoveryOwner = {
    pid: process.pid,
    nonce: crypto.randomUUID(),
    startedAt: nowIso(),
  };
  let recoveryHandle;
  try {
    try {
      recoveryHandle = await fs.open(recoveryPath, "wx", 0o600);
    } catch (error) {
      if (error?.code === "EEXIST") {
        throw publisherError("PUBLISH_BUSY", "另一进程正在恢复发布锁；为安全起见本次不自动清理");
      }
      throw error;
    }
    await recoveryHandle.writeFile(`${JSON.stringify(recoveryOwner)}\n`, "utf8");

    let current;
    try {
      current = await readJson(lockPath);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw publisherError("PUBLISH_BUSY", "发布锁状态无法安全确认；请人工检查", error);
    }
    const currentPid = Number(current?.pid);
    if (!Number.isInteger(currentPid) || currentPid < 1) {
      throw publisherError("PUBLISH_BUSY", "发布锁状态无法安全确认；请人工检查");
    }
    if (isPidAlive(currentPid)) {
      throw publisherError("PUBLISH_BUSY", "另一项发布仍在执行");
    }
    await fs.rm(lockPath);
  } finally {
    await releaseOwnedLock(recoveryPath, recoveryHandle, recoveryOwner.nonce);
  }
}

export async function acquirePublisherLock(lockPath, payload) {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    let handle;
    const owner = { ...payload, nonce: crypto.randomUUID() };
    try {
      handle = await fs.open(lockPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
      return () => releaseOwnedLock(lockPath, handle, owner.nonce);
    } catch (error) {
      await handle?.close().catch(() => {});
      if (error?.code !== "EEXIST") throw error;
      await reclaimDeadLock(lockPath);
    }
  }
  throw publisherError("PUBLISH_BUSY", "无法取得发布锁");
}

function publicJob(job) {
  const result = {
    state: job.state,
    message: job.message,
  };
  if (job.commit) result.commit = job.commit;
  if (job.siteUrl) result.siteUrl = job.siteUrl;
  if (job.error) result.error = job.error;
  return result;
}

function parseStatusPaths(output) {
  const records = String(output || "").split("\0").filter(Boolean);
  const paths = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const status = record.slice(0, 2);
    if (record.length < 4) throw publisherError("UNEXPECTED_CHANGES", "无法解析 Git 工作区状态");
    paths.push(normalizeRelativePath(record.slice(3)));
    if (status.includes("R") || status.includes("C")) {
      index += 1;
      if (index >= records.length) throw publisherError("UNEXPECTED_CHANGES", "Git 重命名状态不完整");
      paths.push(normalizeRelativePath(records[index]));
    }
  }
  return paths;
}

function sameStringSet(left, right) {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

async function defaultDeploymentChecker({ commit, detailKey, section, siteUrl, fetchImpl = fetch }) {
  const baseUrl = new URL(siteUrl);
  const requestJson = async (relativePath) => {
    const target = new URL(relativePath, baseUrl);
    if (target.origin !== baseUrl.origin) throw new Error("deployment path changed origin");
    const response = await fetchImpl(target, {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return null;
    return response.json();
  };
  const suffix = `?publisher-check=${encodeURIComponent(commit)}-${Date.now()}`;
  const build = await requestJson(`build-info.json${suffix}`);
  if (!build || String(build.commit).toLowerCase() !== commit) return { deployed: false };
  const emittedCatalog = build.files?.["src/data/catalog.json"];
  if (
    typeof emittedCatalog !== "string" ||
    emittedCatalog.includes("\\") ||
    emittedCatalog.startsWith("/") ||
    emittedCatalog.includes("..")
  ) {
    return { deployed: false };
  }
  const catalog = await requestJson(`${emittedCatalog}${suffix}`);
  const targetSection = catalog?.schemaVersion === 1
    ? catalog.sections?.find((item) => item?.id === section)
    : null;
  const present = targetSection?.works?.some(
    (work) => work?.image === detailKey || work?._detailKey === detailKey,
  );
  return { deployed: Boolean(present) };
}

export class GitPublisher {
  constructor(config = {}) {
    this.repositoryPath = path.resolve(config.repositoryPath || config.repository || process.cwd());
    this.stateDirectory = path.resolve(config.stateDirectory || config.stateDir || ".publisher-state");
    this.jobsDirectory = path.join(this.stateDirectory, "jobs");
    this.temporaryRoot = path.join(this.stateDirectory, "tmp");
    this.publishLockPath = path.join(this.stateDirectory, "publish.lock");
    this.expectedRepository = config.expectedRepository === undefined
      ? EXPECTED_REPOSITORY
      : config.expectedRepository;
    this.repositoryLabel = config.repositoryLabel || this.expectedRepository || "local-test/repository";
    this.allowLocalRemote = Boolean(config.allowLocalRemote);
    this.siteUrl = config.siteUrl || DEFAULT_SITE_URL;
    this.runner = config.runner || defaultCommandRunner;
    this.addRoleCard = config.addRoleCard || defaultAddRoleCard;
    this.deploymentChecker = config.deploymentChecker || defaultDeploymentChecker;
    this.fetchImpl = config.fetchImpl || fetch;
    this.denyHashes = [...(config.denyHashes || [])];
    this.denyHashesProvider = config.denyHashesProvider || null;
    this.readinessTtlMs = config.readinessTtlMs ?? 15_000;
    this.deploymentTimeoutMs = config.deploymentTimeoutMs ?? 10 * 60 * 1000;
    this.recheckTimeoutMs = config.recheckTimeoutMs ?? 60_000;
    this.deploymentPollMs = config.deploymentPollMs ?? 5_000;
    this.checks = config.checks || DEFAULT_CHECKS;
    this.installDependencies = config.installDependencies !== false;
    this.runningTasks = new Map();
    this.readinessCache = null;
    this.readinessPromise = null;
    this.creationQueue = Promise.resolve();
  }

  async initialize() {
    await fs.mkdir(this.jobsDirectory, { recursive: true });
    await fs.mkdir(this.temporaryRoot, { recursive: true });
    const entries = await fs.readdir(this.jobsDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const filePath = path.join(this.jobsDirectory, entry.name);
      let job;
      try {
        job = await readJson(filePath);
      } catch {
        continue;
      }
      if (["queued", "preparing", "pushing"].includes(job.state)) {
        const uncertain = Boolean(job.commit);
        await this.#writeJob({
          ...job,
          state: uncertain ? "push_uncertain" : "failed",
          message: uncertain
            ? "服务曾在推送阶段中断；只会核查远端，不会自动重复推送。"
            : "服务重启前发布未完成；草稿仍保留，可重新发布。",
          error: uncertain ? undefined : "发布进程曾意外中断。",
          updatedAt: nowIso(),
        });
      } else if (job.state === "deploying") {
        await this.#writeJob({
          ...job,
          state: "pending_deployment",
          message: "提交已推送；服务重启后需要重新检查网站状态。",
          updatedAt: nowIso(),
        });
      } else if (job.state === "checking") {
        const uncertain = job.previousState === "push_uncertain";
        await this.#writeJob({
          ...job,
          state: uncertain ? "push_uncertain" : "pending_deployment",
          message: uncertain
            ? "推送结果仍需重新检查；不会自动重复推送。"
            : "提交已推送；上次检查被服务重启中断。",
          updatedAt: nowIso(),
        });
      }
    }
    return this;
  }

  async #run(command, args, options = {}) {
    const result = await this.runner(command, args, options);
    if (!result || !Number.isInteger(result.code)) {
      throw publisherError("RUNNER_FAILED", "命令执行器返回了无效结果");
    }
    return result;
  }

  async #checked(command, args, options, code, message) {
    let result;
    try {
      result = await this.#run(command, args, options);
    } catch (error) {
      throw publisherError(code, message, error);
    }
    if (result.code !== 0 || result.timedOut || result.outputExceeded) {
      throw publisherError(code, message, new CommandError(command, result.code, result));
    }
    return result;
  }

  async #remoteContext() {
    const fetchResult = await this.#checked(
      "git",
      ["remote", "get-url", "origin"],
      { cwd: this.repositoryPath, timeoutMs: 30_000 },
      "REMOTE_UNAVAILABLE",
      "无法读取 origin 远端",
    );
    const pushResult = await this.#checked(
      "git",
      ["remote", "get-url", "--push", "origin"],
      { cwd: this.repositoryPath, timeoutMs: 30_000 },
      "REMOTE_UNAVAILABLE",
      "无法读取 origin 推送地址",
    );
    const fetchUrl = fetchResult.stdout.trim();
    const pushUrl = pushResult.stdout.trim();
    if (this.expectedRepository !== null) {
      const expected = String(this.expectedRepository).toLowerCase();
      if (repositorySlugFromRemote(fetchUrl) !== expected || repositorySlugFromRemote(pushUrl) !== expected) {
        throw publisherError("REMOTE_MISMATCH", "origin 不是指定仓库");
      }
    } else if (!this.allowLocalRemote) {
      throw publisherError("REMOTE_MISMATCH", "测试远端未显式获准");
    }
    return { fetchUrl, pushUrl };
  }

  async #makeClone(prefix, remote) {
    const directory = await fs.mkdtemp(path.join(this.temporaryRoot, `${prefix}-`));
    try {
      await this.#checked(
        "git",
        ["clone", "--quiet", "--no-tags", "--single-branch", "--branch", "main", remote.fetchUrl, directory],
        { cwd: this.temporaryRoot, timeoutMs: 5 * 60 * 1000 },
        "REMOTE_UNAVAILABLE",
        "无法取得最新 origin/main",
      );
      if (remote.pushUrl !== remote.fetchUrl) {
        await this.#checked(
          "git",
          ["remote", "set-url", "--push", "origin", remote.pushUrl],
          { cwd: directory, timeoutMs: 30_000 },
          "REMOTE_UNAVAILABLE",
          "无法配置安全推送地址",
        );
      }
      return directory;
    } catch (error) {
      await this.#removeTemporary(directory).catch(() => {});
      throw error;
    }
  }

  async #makeReadinessProbe(remote) {
    const directory = await fs.mkdtemp(path.join(this.temporaryRoot, "readiness-"));
    try {
      await this.#checked(
        "git",
        [
          "clone",
          "--quiet",
          "--filter=blob:none",
          "--no-checkout",
          "--depth=1",
          "--no-tags",
          "--single-branch",
          "--branch",
          "main",
          remote.fetchUrl,
          directory,
        ],
        { cwd: this.temporaryRoot, timeoutMs: 2 * 60 * 1000 },
        "REMOTE_UNAVAILABLE",
        "无法检查最新 origin/main",
      );
      return directory;
    } catch (error) {
      await this.#removeTemporary(directory).catch(() => {});
      throw error;
    }
  }

  async #removeTemporary(directory) {
    const relative = path.relative(this.temporaryRoot, directory);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw publisherError("TEMP_PATH_INVALID", "拒绝清理越界临时目录");
    }
    await fs.rm(directory, { recursive: true, force: true });
  }

  async #assertPrerequisites(root) {
    for (const relativePath of REQUIRED_REMOTE_FILES) {
      if (!(await pathIsFile(path.join(root, ...relativePath.split("/"))))) {
        throw publisherError("MIGRATION_REQUIRED", MIGRATION_REASON);
      }
    }
    let catalog;
    let packageJson;
    let workflow;
    try {
      catalog = await readJson(path.join(root, "src", "data", "catalog.json"));
      packageJson = await readJson(path.join(root, "package.json"));
      workflow = await fs.readFile(path.join(root, ".github", "workflows", "pages.yml"), "utf8");
    } catch (error) {
      throw publisherError("MIGRATION_REQUIRED", MIGRATION_REASON, error);
    }
    this.#assertPrerequisiteData(catalog, packageJson, workflow);
  }

  #assertPrerequisiteData(catalog, packageJson, workflow) {
    const sectionIds = Array.isArray(catalog?.sections)
      ? catalog.sections.map((section) => section?.id).sort()
      : [];
    const scripts = packageJson?.scripts || {};
    if (
      catalog?.schemaVersion !== 1 ||
      sectionIds.join(",") !== "fanhuafenluo,public" ||
      !scripts["validate:assets"] ||
      !scripts["check:details"] ||
      !scripts["build:pages"] ||
      !scripts["verify:pages-site"]
    ) {
      throw publisherError("MIGRATION_REQUIRED", MIGRATION_REASON);
    }
    if (!workflow.includes("deploy-pages") || !workflow.includes("build:pages")) {
      throw publisherError("MIGRATION_REQUIRED", MIGRATION_REASON);
    }
  }

  async #assertProbePrerequisites(root) {
    const contents = new Map();
    for (const relativePath of REQUIRED_REMOTE_FILES) {
      let result;
      try {
        result = await this.#run(
          "git",
          ["show", `HEAD:${relativePath}`],
          { cwd: root, timeoutMs: 60_000, maximumOutput: 4 * 1024 * 1024 },
        );
      } catch (error) {
        throw publisherError("REMOTE_UNAVAILABLE", "无法读取新站远端发布结构状态", error);
      }
      if (result.code !== 0 || result.timedOut || result.outputExceeded) {
        throw publisherError("MIGRATION_REQUIRED", MIGRATION_REASON);
      }
      contents.set(relativePath, result.stdout);
    }
    let catalog;
    let packageJson;
    try {
      catalog = JSON.parse(contents.get("src/data/catalog.json"));
      packageJson = JSON.parse(contents.get("package.json"));
    } catch (error) {
      throw publisherError("MIGRATION_REQUIRED", MIGRATION_REASON, error);
    }
    this.#assertPrerequisiteData(
      catalog,
      packageJson,
      contents.get(".github/workflows/pages.yml"),
    );
  }

  async getReadiness({ force = false } = {}) {
    if (
      !force &&
      this.readinessCache &&
      Date.now() - this.readinessCache.checkedAt < this.readinessTtlMs
    ) {
      return { ...this.readinessCache.value };
    }
    if (this.readinessPromise) return { ...(await this.readinessPromise) };
    this.readinessPromise = this.#refreshReadiness();
    try {
      return { ...(await this.readinessPromise) };
    } finally {
      this.readinessPromise = null;
    }
  }

  async #refreshReadiness() {
    let cloneDirectory = null;
    let value;
    try {
      const remote = await this.#remoteContext();
      cloneDirectory = await this.#makeReadinessProbe(remote);
      await this.#assertProbePrerequisites(cloneDirectory);
      value = {
        ready: true,
        reason: "可以发布",
        repository: this.repositoryLabel,
        siteUrl: this.siteUrl,
      };
    } catch (error) {
      const code = error?.code;
      const reason = code === "MIGRATION_REQUIRED" || code === "INCOMPLETE_REPOSITORY"
        ? MIGRATION_REASON
        : publicFailure(error);
      value = {
        ready: false,
        reason,
        repository: this.repositoryLabel,
        siteUrl: this.siteUrl,
      };
    } finally {
      if (cloneDirectory) await this.#removeTemporary(cloneDirectory).catch(() => {});
    }
    this.readinessCache = { checkedAt: Date.now(), value };
    return { ...value };
  }

  #jobPath(id) {
    return path.join(this.jobsDirectory, `${safeIdentifier(id, "任务编号")}.json`);
  }

  async #writeJob(job) {
    await atomicWriteJson(this.#jobPath(job.id), job);
    return job;
  }

  async #readJob(id) {
    try {
      return await readJson(this.#jobPath(id));
    } catch (error) {
      if (error?.code === "ENOENT") throw publisherError("JOB_NOT_FOUND", "找不到发布任务");
      throw error;
    }
  }

  async #updateJob(id, patch) {
    const current = await this.#readJob(id);
    return this.#writeJob({ ...current, ...patch, updatedAt: nowIso() });
  }

  async #allJobs() {
    const entries = await fs.readdir(this.jobsDirectory, { withFileTypes: true });
    const jobs = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        jobs.push(await readJson(path.join(this.jobsDirectory, entry.name)));
      } catch {}
    }
    return jobs;
  }

  async getJob(id) {
    return publicJob(await this.#readJob(id));
  }

  async getActiveJob() {
    const jobs = await this.#allJobs();
    const active = jobs
      .filter((job) => REUSABLE_JOB_STATES.has(job.state) && job.state !== "succeeded")
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
    return active ? { id: active.id, ...publicJob(active) } : null;
  }

  async createPublishJob({ draft, section, intro }) {
    const operation = async () => {
      if (!SECTION_IDS.has(section)) throw publisherError("INVALID_SECTION", "发布分区无效");
      const normalizedIntro = typeof intro === "string" ? intro.trim() : "";
      if (!normalizedIntro) throw publisherError("INVALID_INTRO", "简介不能为空");
      const sha256 = normalizeSha256(draft?.sha256, "草稿 SHA-256");
      const draftId = safeIdentifier(draft?.id, "草稿编号");
      if (!(await pathIsFile(draft.cardPath))) {
        throw publisherError("CARD_READ_FAILED", "草稿 PNG 不存在");
      }
      const idempotencyKey = hashJson({ draftId, sha256, section, intro: normalizedIntro });
      const existing = (await this.#allJobs())
        .filter((job) => job.idempotencyKey === idempotencyKey && REUSABLE_JOB_STATES.has(job.state))
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
      if (existing) return { jobId: existing.id };

      const id = crypto.randomUUID();
      const job = {
        id,
        idempotencyKey,
        state: "queued",
        message: "发布任务已排队。",
        createdAt: nowIso(),
        updatedAt: nowIso(),
        draft: {
          id: draftId,
          cardPath: path.resolve(draft.cardPath),
          sha256,
          sourceHash: draft.sourceHash || "",
        },
        section,
        intro: normalizedIntro,
        siteUrl: this.siteUrl,
      };
      await this.#writeJob(job);
      const task = this.#executePublish(id).finally(() => this.runningTasks.delete(id));
      this.runningTasks.set(id, task);
      return { jobId: id };
    };
    const result = this.creationQueue.then(operation, operation);
    this.creationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  async #installAndCheck(root) {
    if (this.installDependencies) {
      await this.#checked(
        "npm",
        ["ci"],
        { cwd: root, timeoutMs: 10 * 60 * 1000 },
        "CHECKS_FAILED",
        "依赖安装失败",
      );
    }
    for (const [command, args] of this.checks) {
      await this.#checked(
        command,
        args,
        { cwd: root, timeoutMs: 10 * 60 * 1000 },
        "CHECKS_FAILED",
        "发布前检查未通过",
      );
    }
  }

  async #commitImportedCard(root, changedFiles) {
    const expected = [...new Set(changedFiles.map(normalizeRelativePath))];
    if (!expected.length) throw publisherError("NO_CHANGES", "导入器没有产生文件变更");
    const expectedSet = new Set(expected);
    const status = await this.#checked(
      "git",
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      { cwd: root, timeoutMs: 30_000 },
      "GIT_STATUS_FAILED",
      "无法核对待发布文件",
    );
    const statusPaths = parseStatusPaths(status.stdout);
    if (statusPaths.some((relativePath) => !expectedSet.has(relativePath))) {
      throw publisherError("UNEXPECTED_CHANGES", "临时工作区出现了导入范围之外的变更");
    }

    const trackedExpected = await this.#checked(
      "git",
      ["ls-files", "-z", "--", ...expected],
      { cwd: root, timeoutMs: 30_000 },
      "GIT_STATUS_FAILED",
      "无法核对导入清单中的已跟踪文件",
    );
    const trackedExpectedSet = new Set(
      trackedExpected.stdout.split("\0").filter(Boolean).map(normalizeRelativePath),
    );
    const statusSet = new Set(statusPaths);
    if (expected.some((relativePath) => !statusSet.has(relativePath) && !trackedExpectedSet.has(relativePath))) {
      throw publisherError("UNEXPECTED_CHANGES", "导入清单包含未写入或被忽略的新文件");
    }

    const [trackedChanges, untrackedChanges, preStaged] = await Promise.all([
      this.#checked(
        "git",
        ["diff", "--name-only", "-z", "--"],
        { cwd: root, timeoutMs: 30_000 },
        "GIT_STATUS_FAILED",
        "无法核对已跟踪文件变更",
      ),
      this.#checked(
        "git",
        ["ls-files", "--others", "--exclude-standard", "-z", "--"],
        { cwd: root, timeoutMs: 30_000 },
        "GIT_STATUS_FAILED",
        "无法核对新增文件",
      ),
      this.#checked(
        "git",
        ["diff", "--cached", "--name-only", "-z", "--"],
        { cwd: root, timeoutMs: 30_000 },
        "GIT_STATUS_FAILED",
        "无法核对导入前暂存区",
      ),
    ]);
    if (preStaged.stdout.split("\0").filter(Boolean).length) {
      throw publisherError("UNEXPECTED_CHANGES", "导入器不应自行修改暂存区");
    }
    const substantive = [...new Set([
      ...trackedChanges.stdout.split("\0").filter(Boolean).map(normalizeRelativePath),
      ...untrackedChanges.stdout.split("\0").filter(Boolean).map(normalizeRelativePath),
    ])];
    if (!substantive.length) throw publisherError("NO_CHANGES", "导入器没有产生实质文件变更");
    if (substantive.some((relativePath) => !expectedSet.has(relativePath))) {
      throw publisherError("UNEXPECTED_CHANGES", "实质文件变更越过了导入清单");
    }
    await this.#checked(
      "git",
      ["add", "--", ...substantive],
      { cwd: root, timeoutMs: 30_000 },
      "GIT_STAGE_FAILED",
      "无法暂存待发布文件",
    );
    const staged = await this.#checked(
      "git",
      ["diff", "--cached", "--name-only", "-z"],
      { cwd: root, timeoutMs: 30_000 },
      "GIT_STATUS_FAILED",
      "无法核对已暂存文件",
    );
    const stagedPaths = staged.stdout.split("\0").filter(Boolean).map(normalizeRelativePath);
    if (!sameStringSet(stagedPaths, substantive)) {
      throw publisherError("UNEXPECTED_CHANGES", "已暂存文件与导入清单不一致");
    }
    const commitEnvironment = {
      GIT_AUTHOR_NAME: "FanHua Publisher",
      GIT_AUTHOR_EMAIL: "fanhuafenluo-publisher@users.noreply.github.com",
      GIT_COMMITTER_NAME: "FanHua Publisher",
      GIT_COMMITTER_EMAIL: "fanhuafenluo-publisher@users.noreply.github.com",
    };
    await this.#checked(
      "git",
      ["commit", "--quiet", "-m", "Publish role card"],
      { cwd: root, env: commitEnvironment, timeoutMs: 60_000 },
      "GIT_COMMIT_FAILED",
      "无法创建发布提交",
    );
    const result = await this.#checked(
      "git",
      ["rev-parse", "HEAD"],
      { cwd: root, timeoutMs: 30_000 },
      "GIT_COMMIT_FAILED",
      "无法读取发布提交",
    );
    return normalizeCommit(result.stdout);
  }

  async #remoteMain(root) {
    await this.#checked(
      "git",
      ["fetch", "--quiet", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"],
      { cwd: root, timeoutMs: 5 * 60 * 1000 },
      "REMOTE_UNAVAILABLE",
      "无法重新核对 origin/main",
    );
    const result = await this.#checked(
      "git",
      ["rev-parse", "refs/remotes/origin/main"],
      { cwd: root, timeoutMs: 30_000 },
      "REMOTE_UNAVAILABLE",
      "无法读取 origin/main",
    );
    return normalizeCommit(result.stdout);
  }

  async #remoteContainsCommit(root, commit) {
    try {
      await this.#remoteMain(root);
      const exists = await this.#run(
        "git",
        ["cat-file", "-e", `${commit}^{commit}`],
        { cwd: root, timeoutMs: 30_000 },
      );
      if (exists.code === 1 || exists.code === 128) return false;
      if (exists.code !== 0) return null;
      const result = await this.#run(
        "git",
        ["merge-base", "--is-ancestor", commit, "refs/remotes/origin/main"],
        { cwd: root, timeoutMs: 30_000 },
      );
      if (result.code === 0) return true;
      if (result.code === 1) return false;
      return null;
    } catch {
      return null;
    }
  }

  async #pollDeployment(jobId, timeoutMs) {
    const started = Date.now();
    do {
      const job = await this.#readJob(jobId);
      let result = { deployed: false };
      try {
        result = await this.deploymentChecker({
          commit: job.commit,
          detailKey: job.detailKey,
          section: job.section,
          siteUrl: this.siteUrl,
          fetchImpl: this.fetchImpl,
        });
      } catch {}
      if (result === true || result?.deployed) {
        await this.#updateJob(jobId, {
          state: "succeeded",
          message: "角色卡已发布并在线可见。",
          error: undefined,
          siteUrl: this.siteUrl,
        });
        return;
      }
      if (Date.now() - started >= timeoutMs) break;
      await new Promise((resolve) => setTimeout(resolve, this.deploymentPollMs));
    } while (true);
    await this.#updateJob(jobId, {
      state: "pending_deployment",
      message: "提交已推送，网站仍在部署；可稍后点击重新检查。",
      error: undefined,
      siteUrl: this.siteUrl,
    });
  }

  async #executePublish(jobId) {
    let cloneDirectory = null;
    let releaseLock = null;
    let pushAttempted = false;
    let pushConfirmed = false;
    try {
      releaseLock = await acquirePublisherLock(this.publishLockPath, {
        id: jobId,
        pid: process.pid,
        startedAt: nowIso(),
      });
      await this.#updateJob(jobId, { state: "preparing", message: "正在检查远端并准备发布。" });
      const readiness = await this.getReadiness({ force: true });
      if (!readiness.ready) {
        throw publisherError(
          readiness.reason === MIGRATION_REASON ? "MIGRATION_REQUIRED" : "REMOTE_UNAVAILABLE",
          readiness.reason,
        );
      }
      const remote = await this.#remoteContext();
      cloneDirectory = await this.#makeClone("publish", remote);
      await this.#assertPrerequisites(cloneDirectory);
      const baseCommitResult = await this.#checked(
        "git",
        ["rev-parse", "HEAD"],
        { cwd: cloneDirectory, timeoutMs: 30_000 },
        "REMOTE_UNAVAILABLE",
        "无法读取 origin/main 基线",
      );
      const baseCommit = normalizeCommit(baseCommitResult.stdout);
      await this.#updateJob(jobId, { message: "正在安装依赖并检查角色卡。" });
      if (this.installDependencies) {
        await this.#checked(
          "npm",
          ["ci"],
          { cwd: cloneDirectory, timeoutMs: 10 * 60 * 1000 },
          "CHECKS_FAILED",
          "依赖安装失败",
        );
      }
      const job = await this.#readJob(jobId);
      const denyHashes = this.denyHashesProvider
        ? await this.denyHashesProvider()
        : this.denyHashes;
      const imported = await this.addRoleCard({
        root: cloneDirectory,
        cardPath: job.draft.cardPath,
        intro: job.intro,
        section: job.section,
        expectedSha256: job.draft.sha256,
        denyHashes,
      });
      if (normalizeSha256(imported?.sha256) !== job.draft.sha256) {
        throw publisherError("SHA256_MISMATCH", "导入结果与草稿哈希不一致");
      }
      await this.#updateJob(jobId, {
        detailKey: imported.detailKey,
        message: "正在运行发布前完整检查。",
      });
      for (const [command, args] of this.checks) {
        await this.#checked(
          command,
          args,
          { cwd: cloneDirectory, timeoutMs: 10 * 60 * 1000 },
          "CHECKS_FAILED",
          "发布前检查未通过",
        );
      }
      const commit = await this.#commitImportedCard(cloneDirectory, imported.changedFiles || []);
      await this.#updateJob(jobId, {
        commit,
        state: "pushing",
        message: "检查已通过，正在执行一次普通快进推送。",
      });
      const freshRemoteCommit = await this.#remoteMain(cloneDirectory);
      if (freshRemoteCommit !== baseCommit) {
        throw publisherError("REMOTE_ADVANCED", "origin/main 已发生变化");
      }
      let pushed = false;
      try {
        pushAttempted = true;
        await this.#checked(
          "git",
          ["push", "--porcelain", "origin", "HEAD:refs/heads/main"],
          { cwd: cloneDirectory, timeoutMs: 10 * 60 * 1000 },
          "PUSH_FAILED",
          "Git 推送失败",
        );
        pushed = true;
        pushConfirmed = true;
      } catch (error) {
        const contains = await this.#remoteContainsCommit(cloneDirectory, commit);
        if (contains === true) {
          pushed = true;
          pushConfirmed = true;
        } else if (contains === null) {
          await this.#updateJob(jobId, {
            state: "push_uncertain",
            message: "推送结果暂时无法确认；只允许重新检查，不会重复推送。",
            error: "GitHub 当前不可达，尚不能确认提交状态。",
          });
          return;
        } else {
          pushAttempted = false;
          throw error;
        }
      }
      if (pushed) {
        await this.#updateJob(jobId, {
          state: "deploying",
          message: "提交已推送，正在等待网站部署。",
          error: undefined,
          siteUrl: this.siteUrl,
        });
        await this.#pollDeployment(jobId, this.deploymentTimeoutMs);
      }
    } catch (error) {
      const current = await this.#readJob(jobId).catch(() => null);
      if (current?.state === "push_uncertain") {
        // The uncertainty is deliberately sticky: another click may only check it.
      } else if (pushConfirmed) {
        await this.#updateJob(jobId, {
          state: "pending_deployment",
          message: "提交已推送，但本地上线检查中断；不会重复推送。",
          error: "请稍后重新检查网站状态。",
        }).catch(() => {});
      } else if (pushAttempted) {
        await this.#updateJob(jobId, {
          state: "push_uncertain",
          message: "推送结果暂时无法确认；只允许重新检查，不会重复推送。",
          error: "请重新检查远端状态。",
        }).catch(() => {});
      } else {
        await this.#updateJob(jobId, {
          state: "failed",
          message: "发布没有完成，草稿仍保留。",
          error: publicFailure(error),
          errorCode: error?.code || "PUBLISH_FAILED",
        }).catch(() => {});
      }
    } finally {
      if (cloneDirectory) await this.#removeTemporary(cloneDirectory).catch(() => {});
      await releaseLock?.().catch(() => {});
    }
  }

  async checkJob(id) {
    const job = await this.#readJob(id);
    if (!CHECKABLE_JOB_STATES.has(job.state)) {
      throw publisherError("JOB_NOT_CHECKABLE", "该任务尚未推送，不能只检查上线状态");
    }
    if (job.state === "succeeded" || job.state === "checking") return publicJob(job);
    await this.#updateJob(id, {
      previousState: job.state,
      state: "checking",
      message: "正在重新检查远端与网站状态。",
    });
    const task = this.#executeCheck(id).finally(() => this.runningTasks.delete(`check:${id}`));
    this.runningTasks.set(`check:${id}`, task);
    return publicJob(await this.#readJob(id));
  }

  async #executeCheck(id) {
    let cloneDirectory = null;
    try {
      let job = await this.#readJob(id);
      if (job.commit && job.previousState === "push_uncertain") {
        const remote = await this.#remoteContext();
        cloneDirectory = await this.#makeClone("check", remote);
        const contains = await this.#remoteContainsCommit(cloneDirectory, job.commit);
        if (contains === null) {
          await this.#updateJob(id, {
            state: "push_uncertain",
            message: "仍无法确认推送结果；不会自动重复推送。",
            error: "GitHub 当前不可达。",
          });
          return;
        }
        if (contains === false) {
          await this.#updateJob(id, {
            state: "failed",
            message: "远端没有发现该提交，草稿仍可重新发布。",
            error: "先前推送没有生效。",
          });
          return;
        }
        job = await this.#updateJob(id, {
          state: "deploying",
          message: "已确认提交存在于远端，正在检查网站。",
          error: undefined,
        });
      }
      await this.#pollDeployment(id, this.recheckTimeoutMs);
    } catch {
      const job = await this.#readJob(id).catch(() => null);
      if (job) {
        await this.#updateJob(id, {
          state: job.previousState === "push_uncertain" ? "push_uncertain" : "pending_deployment",
          message: "暂时无法完成检查；不会重复推送。",
          error: "远端检查暂时失败。",
        }).catch(() => {});
      }
    } finally {
      if (cloneDirectory) await this.#removeTemporary(cloneDirectory).catch(() => {});
    }
  }

  async waitForIdle(id = null) {
    const tasks = id
      ? [...this.runningTasks.entries()].filter(([key]) => key === id || key === `check:${id}`).map(([, task]) => task)
      : [...this.runningTasks.values()];
    await Promise.allSettled(tasks);
  }
}

export async function createGitPublisher(config = {}) {
  return new GitPublisher(config).initialize();
}
