import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

import {
  DETAIL_PATHS,
  INTRO_BRIEF_PROMPT,
  buildDirectDetail,
  decodeCharaPng,
  sourceHash,
} from "../scripts/lib/chara-card.mjs";
import { addRoleCard, inspectCard } from "../scripts/lib/card-import.mjs";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const execFileAsync = promisify(execFile);
const ADD_ROLE_CARD_SCRIPT = fileURLToPath(new URL("../scripts/add-role-card.mjs", import.meta.url));
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
    name: "中性成年角色",
    creator: "测试作者",
    tags: ["日常", "成年角色"],
    description: "这是一份只描述成年人物职业、性格、生活目标和日常关系的中性原始设定材料。它用于验证导入工具，不是站点简介，也不包含需要展示给访客的成品文案。",
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

async function writeJson(root, relativePath, value) {
  const absolutePath = path.join(root, ...relativePath.split("/"));
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function makeFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fanhuafenluo-card-import-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const existingBuffer = makeNeutralCard({ name: "已置顶成年角色" });
  const existingInspection = await inspectCard(existingBuffer, { filename: "existing.png" });
  const existingImage = "assets/cards/existing.png";
  const existingPreview = "assets/previews/cards/existing.webp";
  await fs.mkdir(path.join(root, "assets", "cards"), { recursive: true });
  await fs.mkdir(path.join(root, "assets", "previews", "cards"), { recursive: true });
  await fs.writeFile(path.join(root, ...existingImage.split("/")), existingBuffer);
  await fs.writeFile(path.join(root, ...existingPreview.split("/")), existingInspection.previewBuffer);

  const existingWork = {
    name: existingInspection.name,
    alias: "FIXTURE · PINNED",
    collectionLabel: "FIXTURE ROLE CARD",
    image: existingImage,
    createdAt: "2026-01-01",
    preview: existingPreview,
    previewPosition: "50% 8%",
    role: "",
    tags: existingInspection.tags,
    cardLabel: "PINNED",
    creator: existingInspection.creator,
    sensitive: true,
    sensitiveSetting: false,
    sensitiveLabel: "敏感卡面",
    sensitiveSettingLabel: "敏感设定",
    _detailKey: existingImage,
  };
  const catalog = {
    schemaVersion: 1,
    sections: [
      {
        id: "fanhuafenluo",
        name: "繁花·纷落",
        english: "FANHUA ARCHIVE",
        avatar: "assets/authors/fanhuafenluo-avatar.webp",
        pinnedCount: 1,
        works: [existingWork],
      },
      {
        id: "public",
        name: "公开",
        english: "PUBLIC ARCHIVE",
        avatar: "assets/authors/public.webp",
        pinnedCount: 0,
        works: [],
      },
    ],
  };
  const existingData = decodeCharaPng(existingBuffer, existingImage).data;
  const intros = {
    [existingImage]: { intro: VALID_INTRO, sourceHash: sourceHash(existingData) },
  };
  const fanhuaDetails = {
    [existingImage]: { intro: VALID_INTRO, ...buildDirectDetail(existingData, existingImage) },
  };
  await writeJson(root, "src/data/catalog.json", catalog);
  await writeJson(root, "src/data/card-intros.json", intros);
  await writeJson(root, DETAIL_PATHS.fanhuafenluo, fanhuaDetails);
  await writeJson(root, DETAIL_PATHS.public, {});
  return root;
}

async function candidateFile(root, buffer, name = "candidate.png") {
  const file = path.join(root, name);
  await fs.writeFile(file, buffer);
  return file;
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function readJson(root, relativePath) {
  return JSON.parse(await fs.readFile(path.join(root, ...relativePath.split("/")), "utf8"));
}

async function treeSnapshot(root) {
  const result = {};
  async function visit(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolutePath);
      else if (entry.isFile()) {
        const relativePath = path.relative(root, absolutePath).split(path.sep).join("/");
        result[relativePath] = sha256(await fs.readFile(absolutePath));
      }
    }
  }
  await visit(root);
  return result;
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error?.code, code);
    return true;
  });
}

test("inspectCard returns the stable copy-pack contract and a real generated WebP", async () => {
  const longTag = "很长的标签".repeat(12);
  const buffer = makeNeutralCard({
    creator: "",
    tags: ["日常", "日常", longTag, "含\u0000控制符", 42],
  });
  const result = await inspectCard(buffer, { filename: "neutral.PNG" });
  assert.deepEqual(Object.keys(result), [
    "sha256",
    "name",
    "creator",
    "tags",
    "previewBuffer",
    "originalMaterial",
    "prompt",
    "sourceHash",
  ]);
  assert.equal(result.sha256, sha256(buffer));
  assert.equal(result.creator, "未署名");
  assert.deepEqual(result.tags.slice(0, 2), ["日常", Array.from(longTag).slice(0, 32).join("")]);
  assert.ok(Buffer.isBuffer(result.previewBuffer));
  assert.equal(result.previewBuffer.toString("ascii", 0, 4), "RIFF");
  assert.equal(result.previewBuffer.toString("ascii", 8, 12), "WEBP");
  assert.equal(result.previewBuffer.equals(buffer), false);
  assert.equal(result.originalMaterial.description, decodeCharaPng(buffer).data.description);
  assert.equal(result.prompt, INTRO_BRIEF_PROMPT);
  await expectCode(
    inspectCard(buffer, { filename: "neutral.png", denyHashes: [result.sha256] }),
    "DENYLISTED_CARD",
  );
});

test("addRoleCard inserts after pinned works and preserves original PNG bytes", async (t) => {
  const root = await makeFixture(t);
  const buffer = makeNeutralCard({ name: "新成年角色", tags: ["长期项目", "日常"] });
  const cardPath = await candidateFile(root, buffer);
  const hash = sha256(buffer);
  const result = await addRoleCard({
    root,
    cardPath,
    intro: VALID_INTRO.replace("一位成年角色", "这位新成年角色"),
    section: "fanhuafenluo",
    expectedSha256: hash,
  });

  assert.equal(result.detailKey, `assets/cards/${hash.slice(0, 20)}.png`);
  assert.equal(result.name, "新成年角色");
  assert.equal(result.section, "fanhuafenluo");
  assert.equal(result.sha256, hash);
  assert.ok(result.changedFiles.every((item) => !path.isAbsolute(item) && !item.includes("\\")));
  assert.deepEqual(result.changedFiles, [
    result.detailKey,
    `assets/previews/cards/${hash.slice(0, 20)}.webp`,
    "src/data/catalog.json",
    "src/data/card-intros.json",
    "src/data/details-fanhua.json",
  ]);

  const written = await fs.readFile(path.join(root, ...result.detailKey.split("/")));
  assert.equal(written.equals(buffer), true);
  assert.equal(sha256(written), hash);
  const catalog = await readJson(root, "src/data/catalog.json");
  const section = catalog.sections.find((item) => item.id === "fanhuafenluo");
  assert.equal(section.pinnedCount, 1);
  assert.equal(section.works[0].alias, "FIXTURE · PINNED");
  assert.equal(section.works[1].alias, `CARD · ${hash.slice(0, 8).toUpperCase()}`);
  assert.equal(section.works[1].cardLabel, hash.slice(0, 8).toUpperCase());
  assert.equal(section.works[1].role, "");
  assert.equal(section.works[1].previewPosition, "50% 8%");
  assert.equal(Object.hasOwn(section.works[1], "createdAt"), false);
  assert.equal(Object.hasOwn(section.works[1], "importedAt"), false);
  assert.equal(section.works[1].name, "新成年角色");
  assert.equal(section.works[1].creator, "测试作者");
  assert.equal(Object.hasOwn(section.works[1], "intro"), false);
  const intros = await readJson(root, "src/data/card-intros.json");
  assert.equal(intros[result.detailKey].intro.includes("这位新成年角色"), true);
  assert.notEqual(intros[result.detailKey].intro, decodeCharaPng(buffer).data.description);
  const details = await readJson(root, "src/data/details-fanhua.json");
  assert.equal(details[result.detailKey].intro, intros[result.detailKey].intro);
});

test("a second import of the same PNG is rejected without changing the repository", async (t) => {
  const root = await makeFixture(t);
  const buffer = makeNeutralCard({ name: "重复检查角色" });
  const cardPath = await candidateFile(root, buffer);
  const options = {
    root,
    cardPath,
    intro: VALID_INTRO.replace("一位成年角色", "重复检查角色"),
    section: "public",
    expectedSha256: sha256(buffer),
  };
  await addRoleCard(options);
  const before = await treeSnapshot(root);
  await expectCode(addRoleCard(options), "DUPLICATE_CARD");
  assert.deepEqual(await treeSnapshot(root), before);
});

test("an untracked hash-path collision is never overwritten or removed", async (t) => {
  const root = await makeFixture(t);
  const buffer = makeNeutralCard({ name: "碰撞检查角色" });
  const cardPath = await candidateFile(root, buffer);
  const hash = sha256(buffer);
  const collisionPath = path.join(root, "assets", "cards", `${hash.slice(0, 20)}.png`);
  const sentinel = Buffer.from("pre-existing concurrent file", "utf8");
  await fs.writeFile(collisionPath, sentinel, { flag: "wx" });
  const before = await treeSnapshot(root);
  await expectCode(
    addRoleCard({
      root,
      cardPath,
      intro: VALID_INTRO.replace("一位成年角色", "碰撞检查角色"),
      section: "public",
      expectedSha256: hash,
    }),
    "ASSET_COLLISION",
  );
  assert.deepEqual(await treeSnapshot(root), before);
  assert.equal((await fs.readFile(collisionPath)).equals(sentinel), true);
});

test("wrong section and malformed PNG fail before any repository write", async (t) => {
  const root = await makeFixture(t);
  const valid = makeNeutralCard();
  const validPath = await candidateFile(root, valid, "valid.png");
  const beforeSection = await treeSnapshot(root);
  await expectCode(
    addRoleCard({
      root,
      cardPath: validPath,
      intro: VALID_INTRO,
      section: "unknown",
      expectedSha256: sha256(valid),
    }),
    "INVALID_SECTION",
  );
  assert.deepEqual(await treeSnapshot(root), beforeSection);

  const malformed = Buffer.from("not a png", "utf8");
  const malformedPath = await candidateFile(root, malformed, "malformed.png");
  const beforePng = await treeSnapshot(root);
  await expectCode(
    addRoleCard({
      root,
      cardPath: malformedPath,
      intro: VALID_INTRO,
      section: "public",
      expectedSha256: sha256(malformed),
    }),
    "INVALID_CHARACTER_CARD",
  );
  assert.deepEqual(await treeSnapshot(root), beforePng);
});

test("description cannot be pasted as the introduction even with whitespace changes", async (t) => {
  const root = await makeFixture(t);
  const description = `${"甲".repeat(60)}${"乙".repeat(60)}`;
  const buffer = makeNeutralCard({ name: "简介独立性角色", description });
  const cardPath = await candidateFile(root, buffer);
  const before = await treeSnapshot(root);
  await expectCode(
    addRoleCard({
      root,
      cardPath,
      intro: `${"甲 ".repeat(60)}${"乙 ".repeat(60)}`,
      section: "fanhuafenluo",
      expectedSha256: sha256(buffer),
    }),
    "INVALID_INTRO",
  );
  assert.deepEqual(await treeSnapshot(root), before);
});

test("a post-write sync failure restores every prior file and removes new assets", async (t) => {
  const root = await makeFixture(t);
  const intros = await readJson(root, "src/data/card-intros.json");
  intros["assets/cards/orphan.png"] = {
    intro: VALID_INTRO,
    sourceHash: "0".repeat(64),
  };
  await writeJson(root, "src/data/card-intros.json", intros);
  const buffer = makeNeutralCard({ name: "回滚验证角色" });
  const cardPath = await candidateFile(root, buffer);
  const before = await treeSnapshot(root);
  await expectCode(
    addRoleCard({
      root,
      cardPath,
      intro: VALID_INTRO.replace("一位成年角色", "回滚验证角色"),
      section: "public",
      expectedSha256: sha256(buffer),
    }),
    "DETAIL_SYNC_FAILED",
  );
  assert.deepEqual(await treeSnapshot(root), before);
  assert.equal(await fs.access(path.join(root, ".card-import.lock")).then(() => true, () => false), false);
});

test("CLI loads the repository denylist and blocks its synthetic PNG hash", async (t) => {
  const root = await makeFixture(t);
  const buffer = makeNeutralCard({ name: "CLI 阻止清单角色" });
  const hash = sha256(buffer);
  const cardPath = await candidateFile(root, buffer, "blocked-candidate.png");
  const introFile = path.join(root, "intro.txt");
  const resultFile = path.join(root, "result.json");
  await fs.writeFile(introFile, VALID_INTRO, "utf8");
  await writeJson(root, "tools/card-publisher/blocked-card-hashes.json", {
    schemaVersion: 1,
    sha256: [hash],
  });
  const catalogBefore = await fs.readFile(path.join(root, "src", "data", "catalog.json"));

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        ADD_ROLE_CARD_SCRIPT,
        "--root",
        root,
        "--section",
        "public",
        "--card",
        cardPath,
        "--intro-file",
        introFile,
        "--result-file",
        resultFile,
      ],
      { cwd: root, windowsHide: true, encoding: "utf8" },
    ),
  );
  const result = JSON.parse(await fs.readFile(resultFile, "utf8"));
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "DENYLISTED_CARD");
  assert.equal(
    (await fs.readFile(path.join(root, "src", "data", "catalog.json"))).equals(catalogBefore),
    true,
  );
  assert.equal(
    await fs
      .access(path.join(root, "assets", "cards", `${hash.slice(0, 20)}.png`))
      .then(() => true, () => false),
    false,
  );
});
