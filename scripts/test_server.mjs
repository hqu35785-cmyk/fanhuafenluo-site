import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const siteRoot = path.resolve(
  process.env.TEST_SERVER_ROOT || path.join(repositoryRoot, "_site"),
);
const host = "127.0.0.1";
const port = Number.parseInt(process.env.PORT || "4173", 10);

const mimeTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml; charset=utf-8"],
  [".webp", "image/webp"],
]);

function normalizeCatalogAssetPath(value) {
  const pathname = new URL(String(value || ""), "http://test.local/").pathname;
  return decodeURIComponent(pathname).replace(/^\/+/, "").replaceAll("\\", "/");
}

function loadAllowedOriginalPngPaths() {
  const catalogPath = path.join(repositoryRoot, "src", "data", "catalog.json");
  const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  if (catalog?.schemaVersion !== 1 || !Array.isArray(catalog?.sections)) {
    throw new Error("src/data/catalog.json does not match schemaVersion 1");
  }

  const paths = new Set();
  for (const section of catalog.sections) {
    if (!Array.isArray(section?.works)) continue;
    for (const work of section.works) {
      const relativePath = normalizeCatalogAssetPath(work?.image);
      if (/^assets\/.+\.png$/i.test(relativePath)) paths.add(relativePath);
    }
  }
  return paths;
}

const allowedOriginalPngPaths = loadAllowedOriginalPngPaths();

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error(`Invalid PORT: ${process.env.PORT}`);
}

if (!fs.existsSync(siteRoot) || !fs.statSync(siteRoot).isDirectory()) {
  throw new Error(
    `Test site root does not exist: ${siteRoot}. Run npm run build:pages first.`,
  );
}

function requestRelativePath(rawUrl) {
  const url = new URL(rawUrl || "/", `http://${host}:${port}`);
  const decodedPath = decodeURIComponent(url.pathname);
  return decodedPath === "/" ? "index.html" : decodedPath.slice(1);
}

function resolveInside(root, relativePath) {
  const candidate = path.resolve(root, relativePath);
  const relativeToRoot = path.relative(root, candidate);

  if (
    relativeToRoot.startsWith("..") ||
    path.isAbsolute(relativeToRoot)
  ) {
    return null;
  }

  return candidate;
}

function resolveRequestPath(rawUrl) {
  const relativePath = requestRelativePath(rawUrl);
  const normalized = relativePath.replaceAll("\\", "/");
  if (allowedOriginalPngPaths.has(normalized)) {
    return resolveInside(
      path.join(repositoryRoot, "assets"),
      normalized.slice("assets/".length),
    );
  }
  return resolveInside(siteRoot, relativePath);
}

function sendText(response, statusCode, message) {
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Type": "text/plain; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(message);
}

const server = http.createServer((request, response) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendText(response, 405, "Method Not Allowed");
    return;
  }

  let filePath;
  try {
    if (new URL(request.url || "/", `http://${host}:${port}`).pathname === "/__health") {
      sendText(response, 200, "ok");
      return;
    }
    filePath = resolveRequestPath(request.url);
  } catch {
    sendText(response, 400, "Bad Request");
    return;
  }

  if (!filePath) {
    sendText(response, 403, "Forbidden");
    return;
  }

  let stat;
  try {
    stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      filePath = path.join(filePath, "index.html");
      stat = fs.statSync(filePath);
    }
  } catch {
    sendText(response, 404, "Not Found");
    return;
  }

  if (!stat.isFile()) {
    sendText(response, 404, "Not Found");
    return;
  }

  // A catalog entry is a file allowlist, not permission to follow a link outside it.
  try {
    const originalRoot = path.join(repositoryRoot, "assets");
    const allowedRoot = filePath.startsWith(originalRoot + path.sep) ? originalRoot : siteRoot;
    const realRelative = path.relative(fs.realpathSync(allowedRoot), fs.realpathSync(filePath));
    if (
      fs.lstatSync(allowedRoot).isSymbolicLink() ||
      fs.lstatSync(filePath).isSymbolicLink() ||
      realRelative.startsWith("..") ||
      path.isAbsolute(realRelative)
    ) {
      sendText(response, 403, "Forbidden");
      return;
    }
  } catch {
    sendText(response, 404, "Not Found");
    return;
  }

  response.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Length": stat.size,
    "Content-Type": mimeTypes.get(path.extname(filePath).toLowerCase()) || "application/octet-stream",
    "X-Content-Type-Options": "nosniff",
  });

  if (request.method === "HEAD") {
    response.end();
    return;
  }

  const stream = fs.createReadStream(filePath);
  stream.on("error", () => {
    if (!response.headersSent) sendText(response, 500, "Read Error");
    else response.destroy();
  });
  stream.pipe(response);
});

server.listen(port, host, () => {
  process.stdout.write(`test server: http://${host}:${port} root=${siteRoot}\n`);
});

function closeServer() {
  server.close((error) => {
    if (error) {
      process.stderr.write(`${error.stack || error.message}\n`);
      process.exitCode = 1;
    }
  });
}

process.on("SIGINT", closeServer);
process.on("SIGTERM", closeServer);
