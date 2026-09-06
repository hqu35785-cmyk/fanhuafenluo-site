import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

import {
  DEFAULT_SITE_URL,
  EXPECTED_REPOSITORY,
  MIGRATION_REASON,
  acquirePublisherLock,
  createGitPublisher,
  defaultCommandRunner,
  repositorySlugFromRemote,
} from "../tools/card-publisher/git-publisher.mjs";
import { inspectCard } from "../scripts/lib/card-import.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const VALID_INTRO = "这是一段完全独立撰写的中性测试简介，用来说明一位成年角色如何在安静日常中与来访者建立信任，并通过共同处理生活难题逐渐显露性格层次。故事重点落在选择、沟通与关系变化上，既交代人物处境，也给出可以继续探索的互动方向，同时不摘录角色设定原文，也不把元数据中的说明冒充成站点简介。";

const CRC_TABLE = Array.from({ length: 256 }, (_, number) => {
  let value = number;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data = Buffer.alloc(0)) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

function makeNeutralCard(overrides = {}) {
  const data = {
    name: "发布链路中性成年角色",
    creator: "本地集成测试",
    tags: ["日常", "成年角色"],
    description: "这是一份只描述成年人物职业、性格、生活目标和日常关系的中性原始设定材料。它仅用于验证本地发布器从导入到站点构建的完整链路。",
    first_mes: "傍晚的工作室已经收拾整齐。你好，要一起确认今天的计划吗？",
    personality: "沉稳、耐心，遇到问题时会先核对事实。",
    scenario: "两位成年人在社区工作室共同完成一个长期项目。",
    character_book: null,
    system_prompt: "",
    post_history_instructions: "",
    ...overrides,
  };
  const envelope = { spec: "chara_card_v2", spec_version: "2.0", data };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(2, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const text = Buffer.from(
    `chara\0${Buffer.from(JSON.stringify(envelope), "utf8").toString("base64")}`,
    "latin1",
  );
  const pixels = Buffer.from([
    0, 80, 120, 160, 255, 80, 120, 160, 255,
    0, 80, 120, 160, 255, 80, 120, 160, 255,
  ]);
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("tEXt", text),
    pngChunk("IDAT", zlib.deflateSync(pixels)),
    pngChunk("IEND"),
  ]);
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function checked(command, args, cwd, options = {}) {
  const result = await defaultCommandRunner(command, args, { cwd, timeoutMs: 60_000, ...options });
  assert.equal(
    result.code,
    0,
    `${command} ${args.join(" ")} failed\n${result.stderr}`,
  );
  return result.stdout.trim();
}

async function writeFixtureTree(root, { ready = true } = {}) {
  await fs.mkdir(path.join(root, ".github", "workflows"), { recursive: true });
  await fs.mkdir(path.join(root, "scripts", "lib"), { recursive: true });
  await fs.mkdir(path.join(root, "src", "data"), { recursive: true });
  const packageJson = {
    name: "publisher-local-fixture",
    private: true,
    version: "1.0.0",
    scripts: {
      "validate:assets": "node -e \"\"",
      "check:details": "node -e \"\"",
      "build:pages": "node -e \"\"",
      "verify:pages-site": "node -e \"\"",
    },
  };
  await fs.writeFile(path.join(root, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);
  await fs.writeFile(
    path.join(root, "package-lock.json"),
    `${JSON.stringify({ name: packageJson.name, version: packageJson.version, lockfileVersion: 3, packages: { "": packageJson } }, null, 2)}\n`,
  );
  await fs.writeFile(
    path.join(root, ".github", "workflows", "pages.yml"),
    "steps:\n  - run: npm run build:pages\n  - uses: actions/deploy-pages@v4\n",
  );
  await fs.writeFile(path.join(root, "scripts", "add-role-card.mjs"), "// fixture\n");
  await fs.writeFile(path.join(root, "scripts", "lib", "card-import.mjs"), "// fixture\n");
  if (ready) {
    await fs.writeFile(
      path.join(root, "src", "data", "catalog.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        sections: [
          { id: "fanhuafenluo", name: "A", english: "A", avatar: "a.webp", pinnedCount: 0, works: [] },
          { id: "public", name: "B", english: "B", avatar: "b.webp", pinnedCount: 0, works: [] },
        ],
      }, null, 2)}\n`,
    );
  }
}

async function copyProjectFile(root, relativePath) {
  const destination = path.join(root, ...relativePath.split("/"));
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(path.join(PROJECT_ROOT, ...relativePath.split("/")), destination);
}

async function writeRealIntegrationFixtureTree(root) {
  const projectFiles = [
    ".gitignore",
    ".github/workflows/pages.yml",
    "package-lock.json",
    "scripts/add-role-card.mjs",
    "scripts/build_pages_site.mjs",
    "scripts/lib/card-import.mjs",
    "scripts/lib/chara-card.mjs",
    "scripts/sync-card-details.mjs",
    "scripts/validate_assets.mjs",
    "scripts/verify_pages_site.mjs",
  ];
  await Promise.all(projectFiles.map((relativePath) => copyProjectFile(root, relativePath)));

  const packageJson = JSON.parse(await fs.readFile(path.join(PROJECT_ROOT, "package.json"), "utf8"));
  packageJson.scripts.test = "node --test tests/fixture-smoke.test.mjs";
  await fs.writeFile(path.join(root, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);
  await fs.mkdir(path.join(root, "tests"), { recursive: true });
  await fs.writeFile(
    path.join(root, "tests", "fixture-smoke.test.mjs"),
    [
      'import assert from "node:assert/strict";',
      'import test from "node:test";',
      'test("neutral fixture is runnable", () => assert.equal(1 + 1, 2));',
      "",
    ].join("\n"),
  );

  const catalog = {
    schemaVersion: 1,
    sections: [
      {
        id: "fanhuafenluo",
        name: "中性测试分区甲",
        english: "NEUTRAL FIXTURE A",
        avatar: "assets/authors/fixture-a.webp",
        pinnedCount: 0,
        works: [],
      },
      {
        id: "public",
        name: "中性测试分区乙",
        english: "NEUTRAL FIXTURE B",
        avatar: "assets/authors/fixture-b.webp",
        pinnedCount: 0,
        works: [],
      },
    ],
  };
  const jsonFiles = {
    "src/data/catalog.json": catalog,
    "src/data/card-intros.json": {},
    "src/data/details-fanhua.json": {},
    "src/data/details-public.json": {},
  };
  await Promise.all(Object.entries(jsonFiles).map(async ([relativePath, value]) => {
    const destination = path.join(root, ...relativePath.split("/"));
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, `${JSON.stringify(value, null, 2)}\n`);
  }));

  const avatarCard = makeNeutralCard({ name: "中性测试头像素材" });
  const avatar = (await inspectCard(avatarCard, { filename: "fixture-avatar.png" })).previewBuffer;
  await fs.mkdir(path.join(root, "assets", "authors"), { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(root, "assets", "authors", "fixture-a.webp"), avatar),
    fs.writeFile(path.join(root, "assets", "authors", "fixture-b.webp"), avatar),
  ]);

  const textFiles = {
    "assets/css/site.css": "body { color: #222; }\n",
    "assets/css/motion.css": "* { transition: none; }\n",
    "assets/js/motion.js": "globalThis.fixtureMotion = true;\n",
    "assets/js/app.js": [
      'globalThis.fixtureCommit = "__ARCHIVE_COMMIT__";',
      'globalThis.fixtureCatalog = "src/data/catalog.json";',
      'globalThis.fixtureFanhua = "src/data/details-fanhua.json";',
      'globalThis.fixturePublic = "src/data/details-public.json";',
      "",
    ].join("\n"),
    "index.html": [
      "<!doctype html>",
      '<html lang="zh-CN"><head><meta charset="utf-8">',
      '<link rel="stylesheet" href="assets/css/site.css">',
      '<link rel="stylesheet" href="assets/css/motion.css"></head>',
      '<body><img src="assets/authors/fixture-a.webp" alt="">',
      '<script src="assets/js/motion.js"></script>',
      '<script src="assets/js/app.js"></script></body></html>',
      "",
    ].join("\n"),
  };
  await Promise.all(Object.entries(textFiles).map(async ([relativePath, value]) => {
    const destination = path.join(root, ...relativePath.split("/"));
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, value, "utf8");
  }));
}

async function createLocalRemote(t, options = {}) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "publisher-git-test-"));
  t.after(async () => {
    await fs.rm(temporary, { recursive: true, force: true });
  });
  const bare = path.join(temporary, "remote.git");
  const seed = path.join(temporary, "seed");
  const state = path.join(temporary, "state");
  await fs.mkdir(seed, { recursive: true });
  await checked("git", ["init", "--bare", "--initial-branch=main", bare], temporary);
  await checked("git", ["init", "--initial-branch=main"], seed);
  await checked("git", ["config", "user.name", "Publisher Test"], seed);
  await checked("git", ["config", "user.email", "publisher-test@example.invalid"], seed);
  await (options.treeWriter || writeFixtureTree)(seed, options);
  await checked("git", ["add", "."], seed);
  await checked("git", ["commit", "--quiet", "-m", "fixture"], seed);
  await checked("git", ["remote", "add", "origin", bare], seed);
  await checked("git", ["push", "--quiet", "-u", "origin", "main"], seed);
  return { temporary, bare, seed, state };
}

async function createDraft(directory, sha256 = "a".repeat(64)) {
  const cardPath = path.join(directory, "draft.png");
  await fs.writeFile(cardPath, Buffer.from("local test card"));
  return {
    id: `draft-${sha256.slice(0, 24)}`,
    cardPath,
    sha256,
    sourceHash: "b".repeat(64),
  };
}

function addRoleCardFixture({ suffix = "txt" } = {}) {
  return async ({ root, expectedSha256, section }) => {
    const relativePath = `published/${expectedSha256.slice(0, 20)}.${suffix}`;
    await fs.mkdir(path.join(root, "published"), { recursive: true });
    await fs.writeFile(path.join(root, ...relativePath.split("/")), `${section}\n${expectedSha256}\n`);
    return {
      detailKey: `assets/cards/${expectedSha256.slice(0, 20)}.png`,
      name: "Fixture",
      section,
      changedFiles: [relativePath],
      sha256: expectedSha256,
    };
  };
}

async function publisherFor(fixture, options = {}) {
  return createGitPublisher({
    repositoryPath: fixture.seed,
    stateDirectory: fixture.state,
    expectedRepository: null,
    allowLocalRemote: true,
    repositoryLabel: "local-test/repository",
    siteUrl: "https://example.invalid/archive/",
    installDependencies: false,
    checks: [],
    addRoleCard: addRoleCardFixture(),
    deploymentTimeoutMs: 0,
    recheckTimeoutMs: 0,
    deploymentPollMs: 1,
    ...options,
  });
}

test("recognizes only exact GitHub HTTPS, SSH URL, and SCP repository identities", () => {
  const expected = "hqu35785-cmyk/fanhuafenluo-site";
  assert.equal(EXPECTED_REPOSITORY, expected);
  assert.equal(DEFAULT_SITE_URL, "https://hqu35785-cmyk.github.io/fanhuafenluo-site/");
  assert.equal(repositorySlugFromRemote("https://github.com/hqu35785-cmyk/fanhuafenluo-site.git"), expected);
  assert.equal(repositorySlugFromRemote("ssh://git@github.com/hqu35785-cmyk/fanhuafenluo-site.git"), expected);
  assert.equal(repositorySlugFromRemote("git@github.com:hqu35785-cmyk/fanhuafenluo-site.git"), expected);
  assert.equal(repositorySlugFromRemote("https://github.com/hqu35785-cmyk/fanhuafenluo-site-extra.git"), "hqu35785-cmyk/fanhuafenluo-site-extra");
  assert.equal(repositorySlugFromRemote("http://github.com/hqu35785-cmyk/fanhuafenluo-site.git"), null);
  assert.equal(repositorySlugFromRemote("git://github.com/hqu35785-cmyk/fanhuafenluo-site.git"), null);
  assert.equal(repositorySlugFromRemote("file://github.com/hqu35785-cmyk/fanhuafenluo-site.git"), null);
  assert.equal(repositorySlugFromRemote("C:\\local\\remote.git"), null);
});

test("runs npm through npm-cli.js without a Windows command shell", async () => {
  const result = await defaultCommandRunner("npm", ["--version"], { timeoutMs: 30_000 });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+/);
});

test("a command timeout terminates descendants that inherited the output pipes", async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "publisher-runner-timeout-"));
  t.after(async () => fs.rm(temporary, { recursive: true, force: true }));
  const helperPath = path.join(temporary, "parent.cjs");
  const descendantPidPath = path.join(temporary, "descendant.pid");
  await fs.writeFile(
    helperPath,
    [
      'const { spawn } = require("node:child_process");',
      'const fs = require("node:fs");',
      'const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {',
      '  stdio: ["ignore", "inherit", "inherit"],',
      "});",
      "fs.writeFileSync(process.argv[2], String(descendant.pid));",
      "setInterval(() => {}, 1000);",
      "",
    ].join("\n"),
  );

  const started = Date.now();
  const result = await defaultCommandRunner(
    process.execPath,
    [helperPath, descendantPidPath],
    { cwd: temporary, timeoutMs: 1_500 },
  );
  const elapsed = Date.now() - started;
  assert.equal(result.timedOut, true);
  assert.ok(elapsed < 8_000, `timed-out process tree took ${elapsed}ms to terminate`);
  const descendantPid = Number(await fs.readFile(descendantPidPath, "utf8"));
  assert.equal(Number.isInteger(descendantPid) && descendantPid > 0, true);
  assert.equal(processIsAlive(descendantPid), false);
});

test("concurrent stale-lock reclaimers never remove a newly acquired live lock", async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "publisher-lock-test-"));
  t.after(async () => fs.rm(temporary, { recursive: true, force: true }));
  const lockPath = path.join(temporary, "publish.lock");
  await fs.writeFile(lockPath, `${JSON.stringify({
    id: "stale-job",
    pid: 2_147_483_647,
    nonce: "stale-owner",
  })}\n`);

  const attempts = await Promise.allSettled(Array.from({ length: 24 }, (_, index) => (
    acquirePublisherLock(lockPath, {
      id: `contender-${String(index).padStart(8, "0")}`,
      pid: process.pid,
      startedAt: new Date().toISOString(),
    })
  )));
  const acquired = attempts.filter((result) => result.status === "fulfilled");
  const rejected = attempts.filter((result) => result.status === "rejected");
  assert.equal(acquired.length, 1);
  assert.equal(rejected.length, 23);
  assert.equal(rejected.every((result) => result.reason?.code === "PUBLISH_BUSY"), true);

  const live = JSON.parse(await fs.readFile(lockPath, "utf8"));
  assert.equal(live.pid, process.pid);
  assert.match(live.nonce, /^[0-9a-f-]{36}$/i);
  assert.equal(
    await fs.access(`${lockPath}.recovery`).then(() => true, () => false),
    false,
  );
  await acquired[0].value();
  assert.equal(await fs.access(lockPath).then(() => true, () => false), false);

  await fs.writeFile(lockPath, `${JSON.stringify({
    id: "second-stale-job",
    pid: 2_147_483_647,
    nonce: "second-stale-owner",
  })}\n`);
  const recoveryPath = `${lockPath}.recovery`;
  const inheritedRecovery = `${JSON.stringify({
    pid: 2_147_483_647,
    nonce: "manual-recovery-required",
  })}\n`;
  await fs.writeFile(recoveryPath, inheritedRecovery);
  await assert.rejects(
    acquirePublisherLock(lockPath, {
      id: "blocked-contender",
      pid: process.pid,
      startedAt: new Date().toISOString(),
    }),
    (error) => error?.code === "PUBLISH_BUSY",
  );
  assert.equal(await fs.readFile(recoveryPath, "utf8"), inheritedRecovery);
  assert.equal(JSON.parse(await fs.readFile(lockPath, "utf8")).nonce, "second-stale-owner");
});

test("remote readiness remains gated until the single-repository files exist", async (t) => {
  const fixture = await createLocalRemote(t, { ready: false });
  const publisher = await publisherFor(fixture);
  const status = await publisher.getReadiness({ force: true });
  assert.deepEqual(
    { ready: status.ready, reason: status.reason },
    { ready: false, reason: MIGRATION_REASON },
  );
});

test("publishes from a fresh main clone with one normal fast-forward push and is idempotent", async (t) => {
  const fixture = await createLocalRemote(t);
  const calls = [];
  const runner = async (command, args, options) => {
    if (command === "git" && args[0] === "push") calls.push([...args]);
    return defaultCommandRunner(command, args, options);
  };
  const publisher = await publisherFor(fixture, {
    runner,
    deploymentChecker: async () => ({ deployed: true }),
  });
  assert.equal((await publisher.getReadiness({ force: true })).ready, true);
  const draft = await createDraft(fixture.temporary);
  const first = await publisher.createPublishJob({
    draft,
    section: "public",
    intro: "这是一段只用于本地发布事务测试的独立简介文字。".repeat(8).slice(0, 130),
  });
  await publisher.waitForIdle(first.jobId);
  const job = await publisher.getJob(first.jobId);
  assert.equal(job.state, "succeeded");
  assert.match(job.commit, /^[0-9a-f]{40}$/);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ["push", "--porcelain", "origin", "HEAD:refs/heads/main"]);
  assert.equal(calls[0].some((argument) => argument.includes("force")), false);

  const published = await checked(
    "git",
    ["--git-dir", fixture.bare, "show", `main:published/${draft.sha256.slice(0, 20)}.txt`],
    fixture.temporary,
  );
  assert.match(published, /^public\n/);
  const second = await publisher.createPublishJob({
    draft,
    section: "public",
    intro: "这是一段只用于本地发布事务测试的独立简介文字。".repeat(8).slice(0, 130),
  });
  assert.equal(second.jobId, first.jobId);
  assert.equal(calls.length, 1);
  assert.equal(await checked("git", ["--git-dir", fixture.bare, "rev-list", "--count", "main"], fixture.temporary), "2");
});

test("default importer and all real repository checks publish a neutral card from a clean fixture", async (t) => {
  const fixture = await createLocalRemote(t, { treeWriter: writeRealIntegrationFixtureTree });
  const npmCalls = [];
  const runner = async (command, args, options) => {
    if (command === "npm") npmCalls.push([...args]);
    return defaultCommandRunner(command, args, options);
  };
  const publisher = await createGitPublisher({
    repositoryPath: fixture.seed,
    stateDirectory: fixture.state,
    expectedRepository: null,
    allowLocalRemote: true,
    repositoryLabel: "local-test/real-integration",
    siteUrl: "https://example.invalid/archive/",
    runner,
    deploymentChecker: async () => ({ deployed: true }),
    deploymentTimeoutMs: 0,
    recheckTimeoutMs: 0,
    deploymentPollMs: 1,
  });
  assert.equal((await publisher.getReadiness({ force: true })).ready, true);

  const card = makeNeutralCard();
  const hash = sha256(card);
  const cardPath = path.join(fixture.temporary, "neutral-publisher-integration.png");
  await fs.writeFile(cardPath, card);
  const created = await publisher.createPublishJob({
    draft: {
      id: `draft-${hash.slice(0, 24)}`,
      cardPath,
      sha256: hash,
      sourceHash: "c".repeat(64),
    },
    section: "public",
    intro: VALID_INTRO,
  });
  await publisher.waitForIdle(created.jobId);
  const job = await publisher.getJob(created.jobId);
  const persistedJob = JSON.parse(
    await fs.readFile(path.join(fixture.state, "jobs", `${created.jobId}.json`), "utf8"),
  );
  assert.equal(
    job.state,
    "succeeded",
    `${persistedJob.errorCode || "unknown"}: ${job.error || ""}`,
  );
  assert.match(job.commit, /^[0-9a-f]{40}$/);
  assert.deepEqual(npmCalls, [
    ["ci"],
    ["test"],
    ["run", "validate:assets"],
    ["run", "check:details"],
    ["run", "build:pages"],
    ["run", "verify:pages-site"],
  ]);

  const identifier = hash.slice(0, 20);
  const changed = (await checked(
    "git",
    ["--git-dir", fixture.bare, "diff-tree", "--no-commit-id", "--name-only", "-r", "main"],
    fixture.temporary,
  )).split(/\r?\n/).filter(Boolean).sort();
  assert.deepEqual(changed, [
    `assets/cards/${identifier}.png`,
    `assets/previews/cards/${identifier}.webp`,
    "src/data/card-intros.json",
    "src/data/catalog.json",
    "src/data/details-public.json",
  ].sort());
  const catalog = JSON.parse(await checked(
    "git",
    ["--git-dir", fixture.bare, "show", "main:src/data/catalog.json"],
    fixture.temporary,
  ));
  const published = catalog.sections.find((section) => section.id === "public").works;
  assert.equal(published.length, 1);
  assert.equal(published[0].name, "发布链路中性成年角色");
  assert.equal(published[0].image, `assets/cards/${identifier}.png`);
  assert.equal(
    await checked("git", ["--git-dir", fixture.bare, "rev-list", "--count", "main"], fixture.temporary),
    "2",
  );
});

test("a confirmed push stays pending when deployment checking fails and never becomes retryable", async (t) => {
  const fixture = await createLocalRemote(t);
  let pushes = 0;
  const runner = async (command, args, options) => {
    if (command === "git" && args[0] === "push") pushes += 1;
    return defaultCommandRunner(command, args, options);
  };
  const publisher = await publisherFor(fixture, {
    runner,
    deploymentChecker: async () => {
      throw new Error("simulated deployment outage");
    },
  });
  const draft = await createDraft(fixture.temporary, "c".repeat(64));
  const request = {
    draft,
    section: "fanhuafenluo",
    intro: "用于验证推送成功后即使部署检查中断也绝对不能重复提交的简介。".repeat(6).slice(0, 130),
  };
  const created = await publisher.createPublishJob(request);
  await publisher.waitForIdle(created.jobId);
  assert.equal((await publisher.getJob(created.jobId)).state, "pending_deployment");
  assert.equal(pushes, 1);
  assert.equal((await publisher.createPublishJob(request)).jobId, created.jobId);
  assert.equal(pushes, 1);

  publisher.deploymentChecker = async () => ({ deployed: true });
  const checking = await publisher.checkJob(created.jobId);
  assert.equal(checking.state, "checking");
  await publisher.waitForIdle(created.jobId);
  assert.equal((await publisher.getJob(created.jobId)).state, "succeeded");
  assert.equal(pushes, 1);
});

test("an uncertain push is checked against origin before a retry can be allowed", async (t) => {
  const fixture = await createLocalRemote(t);
  let afterPush = false;
  let remoteAvailable = false;
  let pushCalls = 0;
  const runner = async (command, args, options) => {
    if (command === "git" && args[0] === "push") {
      pushCalls += 1;
      afterPush = true;
      return { code: 1, stdout: "", stderr: "simulated transport loss" };
    }
    if (afterPush && !remoteAvailable && command === "git" && args[0] === "fetch") {
      return { code: 1, stdout: "", stderr: "simulated offline" };
    }
    return defaultCommandRunner(command, args, options);
  };
  const publisher = await publisherFor(fixture, {
    runner,
    deploymentChecker: async () => ({ deployed: false }),
  });
  const draft = await createDraft(fixture.temporary, "d".repeat(64));
  const created = await publisher.createPublishJob({
    draft,
    section: "public",
    intro: "用于验证推送结果不确定时只检查远端而不会自动再次推送的简介文本。".repeat(6).slice(0, 130),
  });
  await publisher.waitForIdle(created.jobId);
  assert.equal((await publisher.getJob(created.jobId)).state, "push_uncertain");
  assert.equal(pushCalls, 1);

  remoteAvailable = true;
  assert.equal((await publisher.checkJob(created.jobId)).state, "checking");
  await publisher.waitForIdle(created.jobId);
  const checkedJob = await publisher.getJob(created.jobId);
  assert.equal(checkedJob.state, "failed");
  assert.equal(pushCalls, 1);
});

test("restart recovery exposes pushed jobs for checking instead of leaving phantom active work", async (t) => {
  const fixture = await createLocalRemote(t);
  const jobsDirectory = path.join(fixture.state, "jobs");
  await fs.mkdir(jobsDirectory, { recursive: true });
  const base = {
    idempotencyKey: "e".repeat(64),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    commit: "f".repeat(40),
    siteUrl: "https://example.invalid/archive/",
  };
  await fs.writeFile(
    path.join(jobsDirectory, "deploying-job.json"),
    `${JSON.stringify({ ...base, id: "deploying-job", state: "deploying", message: "old" })}\n`,
  );
  await fs.writeFile(
    path.join(jobsDirectory, "checking-job.json"),
    `${JSON.stringify({ ...base, id: "checking-job", state: "checking", previousState: "push_uncertain", message: "old" })}\n`,
  );
  const publisher = await publisherFor(fixture);
  assert.equal((await publisher.getJob("deploying-job")).state, "pending_deployment");
  assert.equal((await publisher.getJob("checking-job")).state, "push_uncertain");
});
