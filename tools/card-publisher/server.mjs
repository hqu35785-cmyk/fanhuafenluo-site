import crypto from "node:crypto";
import fsSync from "node:fs";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { inspectCard as defaultInspectCard } from "../../scripts/lib/card-import.mjs";
import { createGitPublisher } from "./git-publisher.mjs";

const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPOSITORY = path.resolve(MODULE_DIRECTORY, "..", "..");
const DEFAULT_PUBLIC_ROOT = path.join(MODULE_DIRECTORY, "public");
const DEFAULT_BLOCKED_HASHES = path.join(MODULE_DIRECTORY, "blocked-card-hashes.json");
const MAX_PNG_BYTES = 64 * 1024 * 1024;
const MAX_JSON_BYTES = 256 * 1024;
const SECTIONS = new Set(["fanhuafenluo", "public"]);
const MIME_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml; charset=utf-8"],
  [".webp", "image/webp"],
]);

class ApiError extends Error {
  constructor(status, code, message, options = undefined) {
    super(message, options);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

function apiError(status, code, message, cause = undefined) {
  return new ApiError(status, code, message, cause ? { cause } : undefined);
}

function nowIso() {
  return new Date().toISOString();
}

export function defaultStateDirectory(
  environment = process.env,
  homeDirectory = os.homedir(),
) {
  const localAppData = environment.LOCALAPPDATA;
  if (localAppData) return path.join(localAppData, "FanHuaSitePublisher");
  return path.join(homeDirectory, "AppData", "Local", "FanHuaSitePublisher");
}

function safeId(value, label = "编号") {
  if (typeof value !== "string" || !/^[0-9A-Za-z-]{8,128}$/.test(value)) {
    throw apiError(400, "INVALID_ID", `${label}无效`);
  }
  return value;
}

function visibleLength(value) {
  return Array.from(String(value || "").replace(/\s/g, "")).length;
}

function normalizeIntro(value) {
  return typeof value === "string" ? value.trim() : "";
}

function introValidation(meta, intro) {
  const normalized = normalizeIntro(intro);
  const length = visibleLength(normalized);
  if (length < 120 || length > 180) {
    return {
      intro: normalized,
      canPublish: false,
      summary: `简介当前为 ${length} 个可见字符，需要保持在 120–180 个字符。`,
      code: "INVALID_INTRO_LENGTH",
    };
  }
  const description = typeof meta?.originalMaterial?.description === "string"
    ? meta.originalMaterial.description.replace(/\s/g, "")
    : "";
  const compactIntro = normalized.replace(/\s/g, "");
  if (
    description &&
    (compactIntro === description || description.includes(compactIntro) || compactIntro.includes(description))
  ) {
    return {
      intro: normalized,
      canPublish: false,
      summary: "简介不能直接复制、整段摘抄或仅包裹角色卡 description。",
      code: "INTRO_COPIES_DESCRIPTION",
    };
  }
  return {
    intro: normalized,
    canPublish: true,
    summary: `简介校验通过，共 ${length} 个可见字符；尚未提交或推送。`,
  };
}

function timingSafeToken(provided, expected) {
  if (typeof provided !== "string" || typeof expected !== "string") return false;
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

async function atomicWriteFile(filePath, data, options = {}) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, data, options);
  await fs.rename(temporary, filePath);
}

async function atomicWriteJson(filePath, value) {
  await atomicWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function regularFile(filePath) {
  try {
    const stat = await fs.lstat(filePath);
    return stat.isFile() && !stat.isSymbolicLink() ? stat : null;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function draftPublic(meta) {
  return {
    id: meta.id,
    name: meta.name,
    creator: meta.creator,
    tags: Array.isArray(meta.tags) ? meta.tags : [],
    sourceHash: meta.sourceHash,
    sha256: meta.sha256,
    prompt: meta.prompt,
    originalMaterial: meta.originalMaterial,
    intro: meta.intro || "",
    section: meta.section || null,
  };
}

function jsonHeaders() {
  return {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  };
}

function sendJson(response, status, value) {
  const body = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  response.writeHead(status, {
    ...jsonHeaders(),
    "Content-Length": body.length,
  });
  response.end(body);
}

function sendEmpty(response, status, headers = {}) {
  response.writeHead(status, { "Cache-Control": "no-store", ...headers });
  response.end();
}

function errorStatus(error) {
  if (Number.isInteger(error?.status)) return error.status;
  const mapping = {
    DENYLISTED_CARD: 403,
    DRAFT_NOT_FOUND: 404,
    FILE_TOO_LARGE: 413,
    INVALID_BUFFER: 400,
    INVALID_CARD_METADATA: 422,
    INVALID_CHARACTER_CARD: 422,
    INVALID_FILE_TYPE: 415,
    INVALID_ID: 400,
    INVALID_INTRO: 422,
    INVALID_SECTION: 400,
    JOB_NOT_CHECKABLE: 409,
    JOB_NOT_FOUND: 404,
    NOT_READY: 409,
    PREVIEW_FAILED: 422,
  };
  return mapping[error?.code] || 500;
}

function safeError(error) {
  if (error instanceof ApiError) return error;
  const status = errorStatus(error);
  if (status === 500) return apiError(500, "INTERNAL_ERROR", "本地发布工具处理失败");
  return apiError(status, error?.code || "REQUEST_FAILED", error?.message || "请求失败");
}

async function readBody(request, maximumBytes) {
  const contentLength = request.headers["content-length"];
  if (contentLength !== undefined) {
    const parsed = Number(contentLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      throw apiError(400, "INVALID_CONTENT_LENGTH", "Content-Length 无效");
    }
    if (parsed > maximumBytes) {
      throw apiError(413, "FILE_TOO_LARGE", "请求内容超过允许大小");
    }
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maximumBytes) {
      throw apiError(413, "FILE_TOO_LARGE", "请求内容超过允许大小");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, bytes);
}

async function readJsonBody(request) {
  const body = await readBody(request, MAX_JSON_BYTES);
  if (!body.length) return {};
  try {
    const value = JSON.parse(body.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not object");
    return value;
  } catch (error) {
    throw apiError(400, "INVALID_JSON", "请求 JSON 格式无效", error);
  }
}

async function loadHashFile(filePath) {
  let value;
  try {
    value = await readJson(filePath);
  } catch (error) {
    throw apiError(500, "INVALID_BLOCKLIST", "安全阻止清单无法读取", error);
  }
  if (
    value?.schemaVersion !== 1 ||
    !Array.isArray(value.sha256) ||
    value.sha256.some((hash) => typeof hash !== "string" || !/^[0-9a-f]{64}$/i.test(hash))
  ) {
    throw apiError(500, "INVALID_BLOCKLIST", "安全阻止清单格式无效");
  }
  return [...new Set(value.sha256.map((hash) => hash.toLowerCase()))];
}

function normalizeFilename(value) {
  const filename = path.basename(String(value || "")).replace(/[\p{Cc}\p{Cf}]/gu, "").trim();
  if (!filename || path.extname(filename).toLowerCase() !== ".png") {
    throw apiError(415, "INVALID_FILE_TYPE", "只接受扩展名为 .png 的角色卡");
  }
  return Array.from(filename).slice(0, 180).join("");
}

function matchRoute(pathname, expression) {
  const match = pathname.match(expression);
  if (!match) return null;
  try {
    return match.slice(1).map((value) => decodeURIComponent(value));
  } catch (error) {
    throw apiError(400, "INVALID_URL", "请求地址编码无效", error);
  }
}

export async function createPublisherServer(config = {}) {
  const stateDirectory = path.resolve(config.stateDirectory || config.stateDir || defaultStateDirectory());
  const requestedRepository = path.resolve(config.repositoryPath || config.repository || config.repo || DEFAULT_REPOSITORY);
  const repositoryStat = await regularFile(requestedRepository);
  if (repositoryStat) throw apiError(500, "INVALID_REPOSITORY", "仓库路径不能是文件");
  let repository;
  try {
    repository = await fs.realpath(requestedRepository);
  } catch (error) {
    throw apiError(500, "INVALID_REPOSITORY", "仓库目录不存在", error);
  }
  const publicRoot = path.resolve(config.publicRoot || DEFAULT_PUBLIC_ROOT);
  const token = config.token || crypto.randomBytes(32).toString("base64url");
  if (typeof token !== "string" || token.length < 24) {
    throw apiError(500, "INVALID_TOKEN", "本机访问令牌长度不足");
  }
  const inspectCard = config.inspectCard || defaultInspectCard;
  const blockedHashesPath = path.resolve(config.blockedHashesPath || DEFAULT_BLOCKED_HASHES);
  const explicitDenyHashes = config.denyHashes;
  const denyHashesProvider = async () => explicitDenyHashes === undefined
    ? loadHashFile(blockedHashesPath)
    : [...new Set(explicitDenyHashes.map((hash) => String(hash).toLowerCase()))];
  await denyHashesProvider();

  await fs.mkdir(path.join(stateDirectory, "drafts"), { recursive: true });
  const gitPublisher = config.gitPublisher || await createGitPublisher({
    ...(config.gitPublisherConfig || {}),
    repositoryPath: repository,
    stateDirectory,
    denyHashesProvider,
  });

  let baseUrl = null;
  let expectedHost = null;
  let expectedOrigin = null;
  let readiness = {
    ready: false,
    reason: "正在检查远端发布环境…",
    checking: true,
    code: "CHECKING",
    checkedAt: null,
    mode: "source",
  };
  let readinessPromise = null;
  let queuedForcedReadiness = null;
  let readinessCheckedAt = 0;
  const configuredRefreshInterval = Number(config.readinessRefreshIntervalMs ?? 15_000);
  const readinessRefreshIntervalMs = Number.isFinite(configuredRefreshInterval) && configuredRefreshInterval >= 0
    ? configuredRefreshInterval
    : 15_000;
  let importQueue = Promise.resolve();

  const startReadinessRefresh = ({ force = false } = {}) => {
    readiness = { ...readiness, checking: true };
    const operation = Promise.resolve()
      .then(() => gitPublisher.getReadiness({ force }))
      .then((value) => {
        const checkedAt = nowIso();
        readinessCheckedAt = Date.now();
        readiness = {
          ready: Boolean(value?.ready),
          reason: value?.reason || (value?.ready ? "可以发布" : "发布环境未就绪"),
          checking: false,
          code: value?.code || (value?.ready ? "READY" : "READINESS_FAILED"),
          checkedAt,
          mode: value?.mode || "source",
        };
        return readiness;
      })
      .catch(() => {
        const checkedAt = nowIso();
        readinessCheckedAt = Date.now();
        readiness = {
          ready: false,
          reason: "暂时无法检查新站远端发布环境；当前不会推送任何内容。",
          checking: false,
          code: "READINESS_CHECK_FAILED",
          checkedAt,
          mode: readiness.mode || "source",
        };
        return readiness;
      });
    readinessPromise = operation;
    void operation.then(() => {
      if (readinessPromise === operation) readinessPromise = null;
    });
    return operation;
  };

  const refreshReadiness = ({ force = false } = {}) => {
    if (!readinessPromise) return startReadinessRefresh({ force });
    if (!force) return readinessPromise;
    if (!queuedForcedReadiness) {
      const active = readinessPromise;
      queuedForcedReadiness = active
        .then(() => startReadinessRefresh({ force: true }))
        .finally(() => {
          queuedForcedReadiness = null;
        });
    }
    return queuedForcedReadiness;
  };

  function draftDirectory(id) {
    return path.join(stateDirectory, "drafts", safeId(id, "草稿编号"));
  }

  async function loadDraft(id) {
    const directory = draftDirectory(id);
    try {
      const meta = await readJson(path.join(directory, "draft.json"));
      if (meta?.id !== id) throw new Error("id mismatch");
      return {
        ...meta,
        directory,
        cardPath: path.join(directory, "card.png"),
        previewPath: path.join(directory, "preview.webp"),
      };
    } catch (error) {
      if (error?.code === "ENOENT") throw apiError(404, "DRAFT_NOT_FOUND", "找不到本地草稿");
      if (error instanceof ApiError) throw error;
      throw apiError(500, "DRAFT_CORRUPT", "本地草稿已损坏", error);
    }
  }

  async function importBuffer(buffer, filename) {
    const denyHashes = await denyHashesProvider();
    const inspection = await inspectCard(buffer, { filename, denyHashes });
    const id = `draft-${inspection.sha256.slice(0, 24)}`;
    const directory = draftDirectory(id);
    const existing = await loadDraft(id).catch((error) => {
      if (error?.code === "DRAFT_NOT_FOUND") return null;
      throw error;
    });
    const createdAt = existing?.createdAt || nowIso();
    const meta = {
      id,
      filename,
      sha256: inspection.sha256,
      sourceHash: inspection.sourceHash,
      name: inspection.name,
      creator: inspection.creator,
      tags: inspection.tags,
      prompt: inspection.prompt,
      originalMaterial: inspection.originalMaterial,
      intro: existing?.intro || "",
      section: existing?.section || null,
      createdAt,
      updatedAt: nowIso(),
    };
    await fs.mkdir(directory, { recursive: true });
    await atomicWriteFile(path.join(directory, "card.png"), buffer, { mode: 0o600 });
    await atomicWriteFile(path.join(directory, "preview.webp"), inspection.previewBuffer, { mode: 0o600 });
    await atomicWriteJson(path.join(directory, "draft.json"), meta);
    return draftPublic(meta);
  }

  function queueImport(operation) {
    const result = importQueue.then(operation, operation);
    importQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  function assertRequestSecurity(request) {
    if (!expectedHost || request.headers.host !== expectedHost) {
      throw apiError(421, "INVALID_HOST", "请求 Host 与本机服务不匹配");
    }
    const fetchSite = String(request.headers["sec-fetch-site"] || "").toLowerCase();
    if (fetchSite === "cross-site") {
      throw apiError(403, "CROSS_SITE_REQUEST", "已拒绝跨站请求");
    }
    const origin = request.headers.origin;
    if (origin && origin !== expectedOrigin) {
      throw apiError(403, "INVALID_ORIGIN", "请求 Origin 与本机服务不匹配");
    }
  }

  function assertAuthorized(request) {
    const header = request.headers.authorization;
    const match = typeof header === "string" ? header.match(/^Bearer ([A-Za-z0-9_-]+)$/) : null;
    if (!match || !timingSafeToken(match[1], token)) {
      throw apiError(401, "UNAUTHORIZED", "缺少有效的本机访问凭据");
    }
  }

  async function serveStatic(request, response, pathname) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      throw apiError(405, "METHOD_NOT_ALLOWED", "该地址不接受此请求方法");
    }
    let decoded;
    try {
      decoded = decodeURIComponent(pathname);
    } catch (error) {
      throw apiError(400, "INVALID_URL", "请求地址编码无效", error);
    }
    const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
    if (!relative || relative.includes("\\") || path.posix.normalize(relative) !== relative) {
      throw apiError(403, "INVALID_STATIC_PATH", "静态文件路径无效");
    }
    const candidate = path.resolve(publicRoot, ...relative.split("/"));
    const relativeToRoot = path.relative(publicRoot, candidate);
    if (!relativeToRoot || relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
      throw apiError(403, "INVALID_STATIC_PATH", "静态文件路径越界");
    }
    const stat = await regularFile(candidate);
    if (!stat) throw apiError(404, "NOT_FOUND", "找不到页面资源");
    const realRoot = await fs.realpath(publicRoot);
    const realCandidate = await fs.realpath(candidate);
    if (realCandidate !== realRoot && !realCandidate.startsWith(`${realRoot}${path.sep}`)) {
      throw apiError(403, "INVALID_STATIC_PATH", "静态文件真实路径越界");
    }
    const headers = {
      "Cache-Control": "no-store",
      "Content-Length": stat.size,
      "Content-Security-Policy": "default-src 'self'; base-uri 'none'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; img-src 'self' blob: data:; object-src 'none'; script-src 'self'; style-src 'self'",
      "Content-Type": MIME_TYPES.get(path.extname(candidate).toLowerCase()) || "application/octet-stream",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    };
    if (request.method === "HEAD") {
      sendEmpty(response, 200, headers);
      return;
    }
    response.writeHead(200, headers);
    fsSync.createReadStream(candidate).pipe(response);
  }

  async function handleApi(request, response, url) {
    assertAuthorized(request);
    if (request.method === "GET" && url.pathname === "/api/status") {
      const force = url.searchParams.get("refresh") === "1";
      if (force) {
        await refreshReadiness({ force: true });
      } else if (
        !readinessPromise &&
        Date.now() - readinessCheckedAt >= readinessRefreshIntervalMs
      ) {
        void refreshReadiness();
      }
      const job = await gitPublisher.getActiveJob();
      sendJson(response, 200, {
        ready: readiness.ready,
        reason: readiness.reason,
        checking: readiness.checking,
        code: readiness.code,
        checkedAt: readiness.checkedAt,
        mode: readiness.mode,
        repository,
        siteUrl: gitPublisher.siteUrl,
        ...(job ? { job } : {}),
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/import") {
      const filename = normalizeFilename(url.searchParams.get("filename"));
      const body = await readBody(request, MAX_PNG_BYTES);
      if (!body.length) throw apiError(400, "EMPTY_FILE", "PNG 文件不能为空");
      const draft = await queueImport(() => importBuffer(body, filename));
      sendJson(response, 200, draft);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/import-path") {
      const payload = await readJsonBody(request);
      if (typeof payload.path !== "string" || !path.isAbsolute(payload.path)) {
        throw apiError(400, "INVALID_CARD_PATH", "path 必须是本机 PNG 的绝对路径");
      }
      const sourcePath = path.resolve(payload.path);
      const filename = normalizeFilename(path.basename(sourcePath));
      const stat = await regularFile(sourcePath);
      if (!stat) throw apiError(400, "INVALID_CARD_PATH", "path 必须指向普通 PNG 文件，不能是链接");
      if (!stat.size || stat.size > MAX_PNG_BYTES) {
        throw apiError(413, "FILE_TOO_LARGE", "PNG 文件必须大于 0 且不超过 64 MiB");
      }
      const body = await fs.readFile(sourcePath);
      const draft = await queueImport(() => importBuffer(body, filename));
      sendJson(response, 200, draft);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/drafts") {
      const draftsRoot = path.join(stateDirectory, "drafts");
      const entries = await fs.readdir(draftsRoot, { withFileTypes: true });
      const drafts = [];
      for (const entry of entries) {
        if (!entry.isDirectory() || !/^[0-9A-Za-z-]{8,128}$/.test(entry.name)) continue;
        try {
          const meta = await readJson(path.join(draftsRoot, entry.name, "draft.json"));
          if (meta?.id !== entry.name || typeof meta?.name !== "string") continue;
          drafts.push({
            id: meta.id,
            name: meta.name,
            ...(SECTIONS.has(meta.section) ? { section: meta.section } : {}),
            updatedAt: meta.updatedAt || meta.createdAt || "",
            hasIntro: Boolean(normalizeIntro(meta.intro)),
          });
        } catch {}
      }
      drafts.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
      sendJson(response, 200, { drafts: drafts.slice(0, 20) });
      return;
    }

    const draftRoute = matchRoute(url.pathname, /^\/api\/drafts\/([^/]+)$/);
    if (request.method === "GET" && draftRoute) {
      sendJson(response, 200, draftPublic(await loadDraft(draftRoute[0])));
      return;
    }

    const previewRoute = matchRoute(url.pathname, /^\/api\/drafts\/([^/]+)\/preview$/);
    if (request.method === "GET" && previewRoute) {
      const draft = await loadDraft(previewRoute[0]);
      const stat = await regularFile(draft.previewPath);
      if (!stat) throw apiError(404, "PREVIEW_NOT_FOUND", "草稿预览不存在");
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Length": stat.size,
        "Content-Type": "image/webp",
        "X-Content-Type-Options": "nosniff",
      });
      fsSync.createReadStream(draft.previewPath).pipe(response);
      return;
    }

    const actionRoute = matchRoute(url.pathname, /^\/api\/drafts\/([^/]+)\/(prepare|publish)$/);
    if (request.method === "POST" && actionRoute) {
      const [draftId, action] = actionRoute;
      const draft = await loadDraft(draftId);
      const payload = await readJsonBody(request);
      if (!SECTIONS.has(payload.section)) {
        throw apiError(400, "INVALID_SECTION", "section 必须是 fanhuafenluo 或 public");
      }
      const denyHashes = await denyHashesProvider();
      if (denyHashes.includes(draft.sha256.toLowerCase())) {
        throw apiError(403, "DENYLISTED_CARD", "该角色卡已被安全策略阻止，不能发布");
      }
      const validation = introValidation(draft, payload.intro);
      if (action === "prepare") {
        const updated = {
          ...draft,
          intro: validation.intro,
          section: payload.section,
          updatedAt: nowIso(),
        };
        const { directory: _directory, cardPath: _cardPath, previewPath: _previewPath, ...stored } = updated;
        await atomicWriteJson(path.join(draft.directory, "draft.json"), stored);
        sendJson(response, 200, {
          id: draft.id,
          name: draft.name,
          section: payload.section,
          summary: validation.summary,
          canPublish: validation.canPublish,
        });
        return;
      }
      if (!validation.canPublish) {
        throw apiError(422, validation.code, validation.summary);
      }
      if (readiness.checking || !readiness.ready) {
        throw apiError(
          409,
          "NOT_READY",
          readiness.checking
            ? "正在检查新站远端发布环境，请稍候再发布"
            : readiness.reason || "发布环境尚未就绪",
        );
      }
      const updated = {
        ...draft,
        intro: validation.intro,
        section: payload.section,
        updatedAt: nowIso(),
      };
      const { directory: _directory, cardPath: _cardPath, previewPath: _previewPath, ...stored } = updated;
      await atomicWriteJson(path.join(draft.directory, "draft.json"), stored);
      const result = await gitPublisher.createPublishJob({
        draft: {
          id: draft.id,
          cardPath: draft.cardPath,
          sha256: draft.sha256,
          sourceHash: draft.sourceHash,
        },
        section: payload.section,
        intro: validation.intro,
      });
      sendJson(response, 202, { jobId: result.jobId });
      return;
    }

    const jobRoute = matchRoute(url.pathname, /^\/api\/jobs\/([^/]+)$/);
    if (request.method === "GET" && jobRoute) {
      sendJson(response, 200, await gitPublisher.getJob(jobRoute[0]));
      return;
    }

    const checkRoute = matchRoute(url.pathname, /^\/api\/jobs\/([^/]+)\/check$/);
    if (request.method === "POST" && checkRoute) {
      await readJsonBody(request);
      sendJson(response, 202, await gitPublisher.checkJob(checkRoute[0]));
      return;
    }

    throw apiError(404, "NOT_FOUND", "找不到 API 地址");
  }

  const server = http.createServer((request, response) => {
    void (async () => {
      try {
        assertRequestSecurity(request);
        const url = new URL(request.url || "/", baseUrl || "http://127.0.0.1/");
        if (url.pathname.startsWith("/api/")) await handleApi(request, response, url);
        else await serveStatic(request, response, url.pathname);
      } catch (caught) {
        if (response.headersSent) {
          response.destroy();
          return;
        }
        const error = safeError(caught);
        sendJson(response, error.status, { error: error.message, ...(error.code ? { code: error.code } : {}) });
      }
    })();
  });

  const app = {
    server,
    token,
    stateDirectory,
    repository,
    publicRoot,
    get baseUrl() {
      return baseUrl;
    },
    get readiness() {
      return { ...readiness };
    },
    refreshReadiness,
    async listen(options = {}) {
      const port = typeof options === "number" ? options : (options.port ?? config.port ?? 0);
      if (baseUrl) return { pid: process.pid, port: server.address().port, token, baseUrl };
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, "127.0.0.1");
      });
      const address = server.address();
      if (!address || typeof address === "string" || address.address !== "127.0.0.1") {
        await new Promise((resolve) => server.close(resolve));
        throw apiError(500, "INVALID_BIND", "本地服务未绑定到安全回环地址");
      }
      expectedHost = `127.0.0.1:${address.port}`;
      expectedOrigin = `http://${expectedHost}`;
      baseUrl = `${expectedOrigin}/`;
      void refreshReadiness({ force: true });
      return { pid: process.pid, port: address.port, token, baseUrl };
    },
    async close() {
      if (!server.listening) return;
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections?.();
      });
      baseUrl = null;
      expectedHost = null;
      expectedOrigin = null;
    },
  };
  return app;
}

function parseCliArgs(argv) {
  const result = { stateDirectory: defaultStateDirectory(), repository: DEFAULT_REPOSITORY, port: 0 };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--state-dir" && value) {
      result.stateDirectory = path.resolve(value);
      index += 1;
    } else if (argument === "--repo" && value) {
      result.repository = path.resolve(value);
      index += 1;
    } else if (argument === "--port" && value && /^\d+$/.test(value)) {
      result.port = Number(value);
      index += 1;
    } else {
      throw new Error(`未知或不完整参数：${argument}`);
    }
  }
  if (!Number.isInteger(result.port) || result.port < 0 || result.port > 65_535) {
    throw new Error("--port 必须是 0–65535 的整数");
  }
  return result;
}

function pidAlive(pid) {
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

async function reclaimDeadServerLock(lockPath) {
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
        throw new Error("另一进程正在恢复单实例锁；为安全起见本次不自动清理");
      }
      throw error;
    }
    await recoveryHandle.writeFile(`${JSON.stringify(recoveryOwner)}\n`, "utf8");

    let current;
    try {
      current = await readJson(lockPath);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw new Error("单实例锁状态无法安全确认；请人工检查", { cause: error });
    }
    const currentPid = Number(current?.pid);
    if (!Number.isInteger(currentPid) || currentPid < 1) {
      throw new Error("单实例锁状态无法安全确认；请人工检查");
    }
    if (pidAlive(currentPid)) {
      throw new Error(`本地发布服务已经运行（PID ${currentPid}）`);
    }
    await fs.rm(lockPath);
  } finally {
    await releaseOwnedLock(recoveryPath, recoveryHandle, recoveryOwner.nonce);
  }
}

async function acquireServerLock(stateDirectory) {
  const lockPath = path.join(stateDirectory, ".server.lock");
  await fs.mkdir(stateDirectory, { recursive: true });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    let handle;
    const owner = { pid: process.pid, nonce: crypto.randomUUID(), startedAt: nowIso() };
    try {
      handle = await fs.open(lockPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(owner)}\n`);
      return () => releaseOwnedLock(lockPath, handle, owner.nonce);
    } catch (error) {
      await handle?.close().catch(() => {});
      if (error?.code !== "EEXIST") throw error;
      await reclaimDeadServerLock(lockPath);
    }
  }
  throw new Error("无法取得本地发布服务单实例锁");
}

async function runCli() {
  const options = parseCliArgs(process.argv.slice(2));
  const releaseLock = await acquireServerLock(options.stateDirectory);
  let app;
  let runtime;
  const runtimePath = path.join(options.stateDirectory, "runtime.json");
  const shutdown = async () => {
    await app?.close().catch(() => {});
    let current = null;
    try {
      current = await readJson(runtimePath);
    } catch {}
    if (current?.pid === process.pid && current?.token === runtime?.token) {
      await fs.rm(runtimePath, { force: true }).catch(() => {});
    }
    await releaseLock().catch(() => {});
  };
  try {
    app = await createPublisherServer({
      stateDirectory: options.stateDirectory,
      repository: options.repository,
      port: options.port,
    });
    runtime = await app.listen();
    await atomicWriteJson(runtimePath, runtime);
    process.stdout.write(`publisher server ready: ${runtime.baseUrl} pid=${runtime.pid}\n`);
    process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
    process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
  } catch (error) {
    await shutdown();
    throw error;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  runCli().catch((error) => {
    process.stderr.write(`publisher server failed: ${error?.message || "unknown error"}\n`);
    process.exitCode = 1;
  });
}
