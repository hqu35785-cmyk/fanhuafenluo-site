import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  createPublisherServer,
  defaultStateDirectory,
} from "../tools/card-publisher/server.mjs";
import { stateRootFromEnvironment } from "../tools/card-publisher/launcher.mjs";

const TOKEN = "x".repeat(32);
const SITE_URL = "https://example.invalid/fanhuafenluo-site/";
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PREVIEW = Buffer.from("RIFF-test-WEBP-preview", "ascii");
const DESCRIPTION = "角色卡原始描述".repeat(20);
const VALID_INTRO = "这是一段独立撰写且已经人工审核的角色简介".repeat(8);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fakeInspection(buffer, filename) {
  const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
  return {
    sha256,
    name: `测试角色-${filename}`,
    creator: "测试作者",
    tags: ["成年", "测试"],
    previewBuffer: PREVIEW,
    originalMaterial: {
      name: `测试角色-${filename}`,
      description: DESCRIPTION,
      personality: "仅保存在认证草稿详情中的测试素材",
    },
    prompt: "请根据原始素材独立撰写简介，不得照抄 description。",
    sourceHash: crypto.createHash("sha256").update(`source:${sha256}`).digest("hex"),
  };
}

function makeFakeGit(overrides = {}) {
  const calls = {
    readiness: [],
    active: 0,
    publish: [],
    getJob: [],
    checkJob: [],
  };
  const fake = {
    siteUrl: SITE_URL,
    async getReadiness(options) {
      calls.readiness.push(options);
      return { ready: true, reason: "可以发布" };
    },
    async getActiveJob() {
      calls.active += 1;
      return null;
    },
    async createPublishJob(input) {
      calls.publish.push(input);
      return { jobId: "job-12345678" };
    },
    async getJob(id) {
      calls.getJob.push(id);
      return { state: "pending_deployment", commit: "a".repeat(40), siteUrl: SITE_URL };
    },
    async checkJob(id) {
      calls.checkJob.push(id);
      return { state: "checking", siteUrl: SITE_URL };
    },
    ...overrides,
  };
  return { fake, calls };
}

test("server and launcher defaults isolate the new-site runtime state", () => {
  const localAppData = path.resolve("test-local-app-data");
  const expected = path.join(localAppData, "FanHuaSitePublisher");
  assert.equal(defaultStateDirectory({ LOCALAPPDATA: localAppData }), expected);
  assert.equal(stateRootFromEnvironment({ LOCALAPPDATA: localAppData }), expected);
  assert.equal(
    defaultStateDirectory({}, path.resolve("test-home")),
    path.join(path.resolve("test-home"), "AppData", "Local", "FanHuaSitePublisher"),
  );
  assert.notEqual(expected, path.join(localAppData, "FanHuaPublisher"));
});

test("shortcut definitions use only the three exact new-site names and the isolated log path", async () => {
  const publisherRoot = path.join(PROJECT_ROOT, "tools", "card-publisher");
  const installer = await fs.readFile(path.join(publisherRoot, "install-shortcuts.ps1"), "utf8");
  const launchVbs = await fs.readFile(path.join(publisherRoot, "launch.vbs"), "utf8");
  const definitions = Object.fromEntries(
    [...installer.matchAll(
      /\$(quickPublish|publishFanhua|publishPublic) = ConvertFrom-CodePoints @\(([^)]+)\)/gu,
    )].map((match) => [
      match[1],
      match[2]
        .split(",")
        .map((value) => Number(value.trim()))
        .map((codePoint) => String.fromCodePoint(codePoint))
        .join(""),
    ]),
  );
  assert.deepEqual(definitions, {
    quickPublish: "新站快捷发布卡片",
    publishFanhua: "新站发布到繁花·纷落",
    publishPublic: "新站发布到公开",
  });
  assert.equal(
    (launchVbs.match(/%LOCALAPPDATA%\\FanHuaSitePublisher\\launcher\.log/gu) || []).length,
    2,
  );
  assert.doesNotMatch(launchVbs, /%LOCALAPPDATA%\\FanHuaPublisher\\/u);
});

async function startFixture(t, options = {}) {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "publisher-server-test-"));
  const repository = path.join(temporaryRoot, "repository");
  const stateDirectory = path.join(temporaryRoot, "state");
  await fs.mkdir(repository, { recursive: true });
  const git = options.git || makeFakeGit();
  const inspections = [];
  const inspectCard = options.inspectCard || (async (buffer, inspectionOptions) => {
    inspections.push({ buffer: Buffer.from(buffer), options: inspectionOptions });
    return fakeInspection(buffer, inspectionOptions.filename);
  });
  const app = await createPublisherServer({
    stateDirectory,
    repository: options.repository || repository,
    token: TOKEN,
    denyHashes: options.denyHashes || [],
    inspectCard,
    gitPublisher: git.fake,
    ...(options.publicRoot ? { publicRoot: options.publicRoot } : {}),
  });
  const runtime = await app.listen(0);
  t.after(async () => {
    await app.close().catch(() => {});
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  });
  return {
    app,
    runtime,
    repository,
    stateDirectory,
    git,
    inspections,
    temporaryRoot,
  };
}

function request(runtime, {
  pathname = "/api/status",
  method = "GET",
  body,
  headers = {},
  authorized = true,
  host = `127.0.0.1:${runtime.port}`,
} = {}) {
  let payload = body;
  const requestHeaders = { Host: host, ...headers };
  if (authorized) requestHeaders.Authorization = `Bearer ${runtime.token}`;
  if (body && !Buffer.isBuffer(body) && typeof body !== "string") {
    payload = Buffer.from(JSON.stringify(body), "utf8");
    requestHeaders["Content-Type"] ||= "application/json";
  } else if (typeof body === "string") {
    payload = Buffer.from(body, "utf8");
  }
  if (payload !== undefined) requestHeaders["Content-Length"] = Buffer.byteLength(payload);

  return new Promise((resolve, reject) => {
    const outgoing = http.request({
      hostname: "127.0.0.1",
      port: runtime.port,
      path: pathname,
      method,
      headers: requestHeaders,
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const responseBody = Buffer.concat(chunks);
        const contentType = String(response.headers["content-type"] || "");
        let json = null;
        if (contentType.includes("application/json") && responseBody.length) {
          try {
            json = JSON.parse(responseBody.toString("utf8"));
          } catch (error) {
            reject(error);
            return;
          }
        }
        resolve({ status: response.statusCode, headers: response.headers, body: responseBody, json });
      });
    });
    outgoing.setTimeout(3_000, () => outgoing.destroy(new Error("local test request timed out")));
    outgoing.once("error", reject);
    if (payload !== undefined) outgoing.end(payload);
    else outgoing.end();
  });
}

async function importDraft(fixture, body = Buffer.from("synthetic-png", "utf8"), filename = "card.png") {
  const response = await request(fixture.runtime, {
    pathname: `/api/import?filename=${encodeURIComponent(filename)}`,
    method: "POST",
    body,
    headers: { "Content-Type": "image/png" },
  });
  assert.equal(response.status, 200);
  assert.equal(typeof response.json?.id, "string");
  return response.json;
}

test("status responds immediately with the repository realpath while readiness is still running", async (t) => {
  const readiness = deferred();
  const git = makeFakeGit({
    getReadiness: async (options) => {
      git.calls.readiness.push(options);
      return readiness.promise;
    },
  });
  const fixture = await startFixture(t, { git });
  const response = await Promise.race([
    request(fixture.runtime),
    new Promise((_, reject) => setTimeout(() => reject(new Error("status waited for readiness")), 1_000)),
  ]);
  assert.equal(response.status, 200);
  assert.equal(response.json.ready, false);
  assert.equal(response.json.checking, true);
  assert.equal(response.json.repository, await fs.realpath(fixture.repository));
  assert.equal(response.json.siteUrl, SITE_URL);
  assert.equal(git.calls.active, 1);
  readiness.resolve({ ready: true, reason: "可以发布" });
  await fixture.app.refreshReadiness();
});

test("API requests require the bearer token and exact loopback Host, Origin, and fetch site", async (t) => {
  const fixture = await startFixture(t);
  const missingBearer = await request(fixture.runtime, { authorized: false });
  assert.equal(missingBearer.status, 401);
  assert.equal(missingBearer.json.code, "UNAUTHORIZED");

  const wrongHost = await request(fixture.runtime, { host: "localhost:1" });
  assert.equal(wrongHost.status, 421);
  assert.equal(wrongHost.json.code, "INVALID_HOST");

  const wrongOrigin = await request(fixture.runtime, {
    headers: { Origin: "http://attacker.invalid" },
  });
  assert.equal(wrongOrigin.status, 403);
  assert.equal(wrongOrigin.json.code, "INVALID_ORIGIN");

  const crossSite = await request(fixture.runtime, {
    headers: { "Sec-Fetch-Site": "cross-site" },
  });
  assert.equal(crossSite.status, 403);
  assert.equal(crossSite.json.code, "CROSS_SITE_REQUEST");

  const accepted = await request(fixture.runtime, {
    headers: {
      Origin: fixture.runtime.baseUrl.replace(/\/$/, ""),
      "Sec-Fetch-Site": "same-origin",
    },
  });
  assert.equal(accepted.status, 200);
});

test("raw import returns a top-level draft and authenticated draft and preview reads round-trip", async (t) => {
  const fixture = await startFixture(t, { denyHashes: ["f".repeat(64)] });
  const source = Buffer.from("synthetic-role-card-png", "utf8");
  const imported = await importDraft(fixture, source, "成年角色.png");
  assert.equal(Object.hasOwn(imported, "draft"), false);
  assert.equal(imported.name, "测试角色-成年角色.png");
  assert.equal(imported.intro, "");
  assert.equal(fixture.inspections.length, 1);
  assert.equal(fixture.inspections[0].buffer.equals(source), true);
  assert.deepEqual(fixture.inspections[0].options, {
    filename: "成年角色.png",
    denyHashes: ["f".repeat(64)],
  });

  const restored = await request(fixture.runtime, {
    pathname: `/api/drafts/${encodeURIComponent(imported.id)}`,
  });
  assert.equal(restored.status, 200);
  assert.equal(restored.json.id, imported.id);
  assert.equal(restored.json.sha256, crypto.createHash("sha256").update(source).digest("hex"));
  assert.equal(restored.json.originalMaterial.description, DESCRIPTION);

  const preview = await request(fixture.runtime, {
    pathname: `/api/drafts/${encodeURIComponent(imported.id)}/preview`,
  });
  assert.equal(preview.status, 200);
  assert.equal(preview.headers["content-type"], "image/webp");
  assert.equal(preview.body.equals(PREVIEW), true);
});

test("draft listing is bounded metadata and reflects a prepared introduction without leaking copy material", async (t) => {
  const fixture = await startFixture(t);
  const first = await importDraft(fixture, Buffer.from("first-card"), "first.png");
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = await importDraft(fixture, Buffer.from("second-card"), "second.png");

  const prepared = await request(fixture.runtime, {
    pathname: `/api/drafts/${encodeURIComponent(first.id)}/prepare`,
    method: "POST",
    body: { section: "public", intro: VALID_INTRO },
  });
  assert.equal(prepared.status, 200);
  assert.equal(prepared.json.canPublish, true);

  const listed = await request(fixture.runtime, { pathname: "/api/drafts" });
  assert.equal(listed.status, 200);
  assert.equal(Array.isArray(listed.json.drafts), true);
  assert.equal(listed.json.drafts.length, 2);
  const firstSummary = listed.json.drafts.find((draft) => draft.id === first.id);
  const secondSummary = listed.json.drafts.find((draft) => draft.id === second.id);
  assert.deepEqual(Object.keys(firstSummary).sort(), ["hasIntro", "id", "name", "section", "updatedAt"]);
  assert.equal(firstSummary.section, "public");
  assert.equal(firstSummary.hasIntro, true);
  assert.deepEqual(Object.keys(secondSummary).sort(), ["hasIntro", "id", "name", "updatedAt"]);
  assert.equal(secondSummary.hasIntro, false);
  assert.equal(JSON.stringify(listed.json).includes("originalMaterial"), false);
  assert.equal(JSON.stringify(listed.json).includes("description"), false);
  assert.equal(JSON.stringify(listed.json).includes("prompt"), false);
});

test("prepare records invalid drafts without publishing, while publish enforces readiness and creates one job", async (t) => {
  let ready = false;
  const git = makeFakeGit({
    getReadiness: async (options) => {
      git.calls.readiness.push(options);
      return { ready, reason: ready ? "可以发布" : "迁移未完成" };
    },
  });
  const fixture = await startFixture(t, { git });
  await fixture.app.refreshReadiness();
  const draft = await importDraft(fixture);

  const empty = await request(fixture.runtime, {
    pathname: `/api/drafts/${draft.id}/prepare`,
    method: "POST",
    body: { section: "fanhuafenluo", intro: "" },
  });
  assert.equal(empty.status, 200);
  assert.equal(empty.json.canPublish, false);
  assert.equal(git.calls.publish.length, 0);

  const copied = await request(fixture.runtime, {
    pathname: `/api/drafts/${draft.id}/prepare`,
    method: "POST",
    body: { section: "public", intro: Array.from(DESCRIPTION).join(" ") },
  });
  assert.equal(copied.status, 200);
  assert.equal(copied.json.canPublish, false);
  assert.equal(git.calls.publish.length, 0);

  const gated = await request(fixture.runtime, {
    pathname: `/api/drafts/${draft.id}/publish`,
    method: "POST",
    body: { section: "public", intro: VALID_INTRO },
  });
  assert.equal(gated.status, 409);
  assert.equal(gated.json.code, "NOT_READY");
  assert.equal(git.calls.publish.length, 0);

  ready = true;
  await fixture.app.refreshReadiness({ force: true });
  const published = await request(fixture.runtime, {
    pathname: `/api/drafts/${draft.id}/publish`,
    method: "POST",
    body: { section: "public", intro: VALID_INTRO },
  });
  assert.equal(published.status, 202);
  assert.equal(published.json.jobId, "job-12345678");
  assert.equal(git.calls.publish.length, 1);
  assert.equal(git.calls.publish[0].section, "public");
  assert.equal(git.calls.publish[0].intro, VALID_INTRO);
  assert.equal(git.calls.publish[0].draft.id, draft.id);
  assert.equal(path.isAbsolute(git.calls.publish[0].draft.cardPath), true);
  assert.equal(
    git.calls.publish[0].draft.cardPath,
    path.join(fixture.stateDirectory, "drafts", draft.id, "card.png"),
  );
});

test("import-path rejects relative paths and symbolic links before inspection", async (t) => {
  const fixture = await startFixture(t);
  const relative = await request(fixture.runtime, {
    pathname: "/api/import-path",
    method: "POST",
    body: { path: "relative-card.png" },
  });
  assert.equal(relative.status, 400);
  assert.equal(relative.json.code, "INVALID_CARD_PATH");

  const sourcePath = path.join(fixture.temporaryRoot, "source.png");
  const linkPath = path.join(fixture.temporaryRoot, "linked.png");
  await fs.writeFile(sourcePath, Buffer.from("synthetic-card"));
  try {
    await fs.symlink(sourcePath, linkPath, "file");
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      // Windows permits directory junctions without Developer Mode. Naming the
      // final junction like a PNG still exercises the endpoint's no-links rule.
      const linkedDirectory = path.join(fixture.temporaryRoot, "linked-source");
      await fs.mkdir(linkedDirectory);
      await fs.symlink(linkedDirectory, linkPath, "junction");
    } else {
      throw error;
    }
  }
  const linked = await request(fixture.runtime, {
    pathname: "/api/import-path",
    method: "POST",
    body: { path: linkPath },
  });
  assert.equal(linked.status, 400);
  assert.equal(linked.json.code, "INVALID_CARD_PATH");
  assert.equal(fixture.inspections.length, 0);
});
