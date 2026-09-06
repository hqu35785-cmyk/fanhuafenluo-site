import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

import {
  CATALOG_PATH,
  DETAIL_PATHS,
  INTRO_BRIEF_PROMPT,
  INTROS_PATH,
  SECTION_IDS,
  assertCatalog,
  buildIntroBrief,
  decodeCharaPng,
  isRecord,
  nonEmptyString,
  readJsonFile,
  resolveRepositoryPath,
  sourceHash,
  validateIntroEntry,
} from "./chara-card.mjs";

const execFileAsync = promisify(execFile);
const MAX_PNG_BYTES = 64 * 1024 * 1024;
const MAX_INPUT_PIXELS = 64_000_000;
const PREVIEW_WIDTH = 640;
const PREVIEW_HEIGHT = 960;
const PREVIEW_QUALITY = 72;
const MAX_TAGS = 12;
const MAX_TAG_CHARACTERS = 32;
const IMPORT_LOCK = ".card-import.lock";
const DATA_FILES = Object.freeze([CATALOG_PATH, INTROS_PATH, ...Object.values(DETAIL_PATHS)]);
const SYNC_SCRIPT = fileURLToPath(new URL("../sync-card-details.mjs", import.meta.url));

export class CardImportError extends Error {
  constructor(code, message, options = undefined) {
    super(message, options);
    this.name = "CardImportError";
    this.code = code;
  }
}

function fail(code, message, cause = undefined) {
  throw new CardImportError(code, message, cause ? { cause } : undefined);
}

function normalizeSha256(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/i.test(value.trim())) {
    fail("INVALID_SHA256", `${label} 必须是 64 位 SHA-256`);
  }
  return value.trim().toLowerCase();
}

function normalizedDenyHashes(denyHashes) {
  if (denyHashes == null) return new Set();
  if (!Array.isArray(denyHashes) && !(denyHashes instanceof Set)) {
    fail("INVALID_DENYLIST", "denyHashes 必须是数组或 Set");
  }
  const result = new Set();
  for (const hash of denyHashes) result.add(normalizeSha256(hash, "denyHashes 条目"));
  return result;
}

function assertPlainText(value, label, fallback = null) {
  if (!nonEmptyString(value)) {
    if (fallback !== null) return fallback;
    fail("INVALID_CARD_METADATA", `${label} 不能为空`);
  }
  const text = value.trim();
  if (/\p{Cc}/u.test(text)) fail("INVALID_CARD_METADATA", `${label} 含控制字符`);
  return text;
}

function truncateCharacters(value, maximum) {
  return Array.from(value).slice(0, maximum).join("");
}

function safeTags(value) {
  if (!Array.isArray(value)) return [];
  const result = [];
  const seen = new Set();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const compact = item.replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/g, " ").trim();
    if (!compact) continue;
    const tag = truncateCharacters(compact, MAX_TAG_CHARACTERS);
    if (seen.has(tag)) continue;
    seen.add(tag);
    result.push(tag);
    if (result.length === MAX_TAGS) break;
  }
  return result;
}

function webpSignature(buffer) {
  return (
    Buffer.isBuffer(buffer) &&
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  );
}

async function makePreview(buffer, filename) {
  try {
    const preview = await sharp(buffer, {
      failOn: "error",
      limitInputPixels: MAX_INPUT_PIXELS,
      sequentialRead: true,
    })
      .rotate()
      .resize({
        width: PREVIEW_WIDTH,
        height: PREVIEW_HEIGHT,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: PREVIEW_QUALITY, effort: 4, smartSubsample: true })
      .toBuffer();
    if (!webpSignature(preview)) fail("PREVIEW_FAILED", `无法生成 WebP 预览：${filename}`);
    return preview;
  } catch (error) {
    if (error instanceof CardImportError) throw error;
    fail("PREVIEW_FAILED", `无法生成 WebP 预览：${filename}`, error);
  }
}

function inspectionMaterial(data, name, creator, tags, hash) {
  const source = sourceHash(data);
  const [card] = buildIntroBrief(
    [
      {
        sectionId: "",
        detailKey: hash,
        work: {
          name,
          alias: `CARD · ${hash.slice(0, 8).toUpperCase()}`,
          creator,
          role: "",
          tags,
          cardLabel: hash.slice(0, 8).toUpperCase(),
        },
        data,
        sourceHash: source,
      },
    ],
    {},
    { all: true },
  ).cards;
  return { originalMaterial: card.originalMaterial, sourceHash: source };
}

/**
 * Decode and inspect a candidate character-card PNG without writing any files.
 */
export async function inspectCard(buffer, { filename, denyHashes = [] } = {}) {
  if (!Buffer.isBuffer(buffer)) fail("INVALID_BUFFER", "角色卡内容必须是 Buffer");
  if (!nonEmptyString(filename) || path.extname(filename).toLowerCase() !== ".png") {
    fail("INVALID_FILE_TYPE", "只接受扩展名为 .png 的角色卡");
  }
  if (buffer.length === 0 || buffer.length > MAX_PNG_BYTES) {
    fail("FILE_TOO_LARGE", "角色卡 PNG 必须大于 0 字节且不超过 64 MiB");
  }

  const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
  if (normalizedDenyHashes(denyHashes).has(sha256)) {
    fail("DENYLISTED_CARD", "该角色卡已被安全策略阻止，不能重新导入");
  }

  let decoded;
  try {
    decoded = decodeCharaPng(buffer, path.basename(filename));
  } catch (error) {
    fail("INVALID_CHARACTER_CARD", "PNG 不是可用的角色卡，或其 chara 元数据无效", error);
  }
  const { data } = decoded;
  const name = assertPlainText(data.name, "角色名");
  const creator = assertPlainText(data.creator, "创作者", "未署名");
  if (!nonEmptyString(data.description)) {
    fail("INVALID_CARD_METADATA", "角色卡 description 不能为空");
  }
  if (!nonEmptyString(data.first_mes)) {
    fail("INVALID_CARD_METADATA", "角色卡 first_mes 不能为空");
  }
  const tags = safeTags(data.tags);
  const previewBuffer = await makePreview(buffer, path.basename(filename));
  const { originalMaterial, sourceHash: materialHash } = inspectionMaterial(
    data,
    name,
    creator,
    tags,
    sha256,
  );

  return {
    sha256,
    name,
    creator,
    tags,
    previewBuffer,
    originalMaterial,
    prompt: INTRO_BRIEF_PROMPT,
    sourceHash: materialHash,
  };
}

async function fileSha256(absolutePath) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of createReadStream(absolutePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function pathExists(absolutePath) {
  try {
    await fs.lstat(absolutePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function acquireLock(root) {
  const lockPath = path.join(root, IMPORT_LOCK);
  let handle;
  try {
    handle = await fs.open(lockPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`);
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error?.code === "EEXIST") fail("IMPORT_BUSY", "另一个角色卡导入正在进行，请稍后重试");
    fail("LOCK_FAILED", "无法获取角色卡导入锁", error);
  }
  return async () => {
    await handle.close();
    await fs.rm(lockPath, { force: true });
  };
}

async function readSnapshots(root) {
  const snapshots = new Map();
  for (const relativePath of DATA_FILES) {
    const absolutePath = path.join(root, ...relativePath.split("/"));
    try {
      snapshots.set(relativePath, await fs.readFile(absolutePath));
    } catch (error) {
      fail("INCOMPLETE_REPOSITORY", `仓库缺少事务文件：${relativePath}`, error);
    }
  }
  return snapshots;
}

async function restoreSnapshots(root, snapshots) {
  for (const [relativePath, buffer] of snapshots) {
    await fs.writeFile(path.join(root, ...relativePath.split("/")), buffer);
  }
}

async function writeJson(root, relativePath, value) {
  await fs.writeFile(
    path.join(root, ...relativePath.split("/")),
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );
}

async function assertNoDuplicatePng(root, catalog, candidateHash) {
  for (const section of catalog.sections) {
    for (const work of section.works) {
      const { absolutePath } = resolveRepositoryPath(root, work.image, `${work.name}.image`);
      let existingHash;
      try {
        existingHash = await fileSha256(absolutePath);
      } catch (error) {
        fail("INCOMPLETE_REPOSITORY", `无法读取目录中的现有 PNG：${work.image}`, error);
      }
      if (existingHash === candidateHash) {
        fail("DUPLICATE_CARD", `同一张 PNG 已存在于目录：${work.alias}`);
      }
    }
  }
}

async function runDetailSync(root) {
  try {
    await execFileAsync(process.execPath, [SYNC_SCRIPT, "--write", "--root", root], {
      cwd: root,
      windowsHide: true,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    fail("DETAIL_SYNC_FAILED", "详情同步失败，导入已取消", error);
  }
}

function importedWork(inspection, detailKey, previewPath) {
  const shortHash = inspection.sha256.slice(0, 8).toUpperCase();
  return {
    name: inspection.name,
    alias: `CARD · ${shortHash}`,
    collectionLabel: "IMPORTED ROLE CARD",
    image: detailKey,
    preview: previewPath,
    previewPosition: "50% 8%",
    role: "",
    tags: inspection.tags,
    cardLabel: shortHash,
    creator: inspection.creator,
    sensitive: true,
    sensitiveSetting: false,
    sensitiveLabel: "敏感卡面",
    sensitiveSettingLabel: "敏感设定",
    _detailKey: detailKey,
  };
}

function asImportError(error) {
  if (error instanceof CardImportError) return error;
  return new CardImportError("IMPORT_FAILED", "角色卡导入失败", { cause: error });
}

/**
 * Add one inspected role card to the local archive as a rollback-safe transaction.
 */
export async function addRoleCard({
  root,
  cardPath,
  intro,
  section,
  expectedSha256,
  denyHashes = [],
} = {}) {
  if (!nonEmptyString(root)) fail("INVALID_ROOT", "root 不能为空");
  if (!nonEmptyString(cardPath)) fail("INVALID_CARD_PATH", "cardPath 不能为空");
  if (!SECTION_IDS.includes(section)) {
    fail("INVALID_SECTION", `section 必须是 ${SECTION_IDS.join(" 或 ")}`);
  }
  const expectedHash = normalizeSha256(expectedSha256, "expectedSha256");
  const repositoryRoot = path.resolve(root);
  const sourcePath = path.resolve(cardPath);

  let stat;
  try {
    stat = await fs.lstat(sourcePath);
  } catch (error) {
    fail("CARD_READ_FAILED", "无法读取待导入角色卡", error);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    fail("INVALID_CARD_PATH", "待导入角色卡必须是普通文件，不能是目录或符号链接");
  }
  if (stat.size === 0 || stat.size > MAX_PNG_BYTES) {
    fail("FILE_TOO_LARGE", "角色卡 PNG 必须大于 0 字节且不超过 64 MiB");
  }

  let originalBuffer;
  try {
    originalBuffer = await fs.readFile(sourcePath);
  } catch (error) {
    fail("CARD_READ_FAILED", "无法读取待导入角色卡", error);
  }
  const inspection = await inspectCard(originalBuffer, {
    filename: path.basename(sourcePath),
    denyHashes,
  });
  if (inspection.sha256 !== expectedHash) {
    fail("SHA256_MISMATCH", "角色卡内容在检查后发生了变化，请重新检查");
  }

  const normalizedIntro = typeof intro === "string" ? intro.trim() : "";
  try {
    validateIntroEntry(
      {
        detailKey: `assets/cards/${inspection.sha256.slice(0, 20)}.png`,
        work: { name: inspection.name },
        data: { description: inspection.originalMaterial.description ?? "" },
        sourceHash: inspection.sourceHash,
      },
      { intro: normalizedIntro, sourceHash: inspection.sourceHash },
    );
  } catch (error) {
    fail("INVALID_INTRO", error.message, error);
  }

  const releaseLock = await acquireLock(repositoryRoot);
  try {
    const catalog = assertCatalog(await readJsonFile(repositoryRoot, CATALOG_PATH));
    const intros = await readJsonFile(repositoryRoot, INTROS_PATH);
    if (!isRecord(intros)) fail("INVALID_INTROS", `${INTROS_PATH} 顶层必须是对象`);
    await assertNoDuplicatePng(repositoryRoot, catalog, inspection.sha256);

    const identifier = inspection.sha256.slice(0, 20);
    const detailKey = `assets/cards/${identifier}.png`;
    const previewPath = `assets/previews/cards/${identifier}.webp`;
    const pngAbsolutePath = path.join(repositoryRoot, ...detailKey.split("/"));
    const previewAbsolutePath = path.join(repositoryRoot, ...previewPath.split("/"));
    if ((await pathExists(pngAbsolutePath)) || (await pathExists(previewAbsolutePath))) {
      fail("ASSET_COLLISION", "目标哈希资源路径已经存在，但目录中没有对应记录");
    }

    const targetSection = catalog.sections.find((item) => item.id === section);
    const work = importedWork(inspection, detailKey, previewPath);
    targetSection.works.splice(targetSection.pinnedCount, 0, work);
    intros[detailKey] = { intro: normalizedIntro, sourceHash: inspection.sourceHash };
    assertCatalog(catalog);

    const snapshots = await readSnapshots(repositoryRoot);
    const pngDirectory = path.dirname(pngAbsolutePath);
    const previewDirectory = path.dirname(previewAbsolutePath);
    let mutationStarted = false;
    let pngCreated = false;
    let previewCreated = false;
    let pngDirectoryCreated = false;
    let previewDirectoryCreated = false;
    try {
      mutationStarted = true;
      pngDirectoryCreated = (await fs.mkdir(pngDirectory, { recursive: true })) !== undefined;
      previewDirectoryCreated = (await fs.mkdir(previewDirectory, { recursive: true })) !== undefined;
      let pngHandle;
      try {
        pngHandle = await fs.open(pngAbsolutePath, "wx");
        pngCreated = true;
        await pngHandle.writeFile(originalBuffer);
      } finally {
        await pngHandle?.close().catch(() => {});
      }
      let previewHandle;
      try {
        previewHandle = await fs.open(previewAbsolutePath, "wx");
        previewCreated = true;
        await previewHandle.writeFile(inspection.previewBuffer);
      } finally {
        await previewHandle?.close().catch(() => {});
      }
      await writeJson(repositoryRoot, CATALOG_PATH, catalog);
      await writeJson(repositoryRoot, INTROS_PATH, intros);
      await runDetailSync(repositoryRoot);

      if ((await fileSha256(pngAbsolutePath)) !== inspection.sha256) {
        fail("SOURCE_INTEGRITY_FAILED", "写入后的原始 PNG 哈希不一致");
      }

      const changedFiles = [detailKey, previewPath, CATALOG_PATH, INTROS_PATH];
      for (const relativePath of Object.values(DETAIL_PATHS)) {
        const after = await fs.readFile(path.join(repositoryRoot, ...relativePath.split("/")));
        if (!after.equals(snapshots.get(relativePath))) changedFiles.push(relativePath);
      }
      return {
        detailKey,
        name: inspection.name,
        section,
        changedFiles,
        sha256: inspection.sha256,
      };
    } catch (error) {
      if (mutationStarted) {
        try {
          await restoreSnapshots(repositoryRoot, snapshots);
          if (pngCreated) await fs.rm(pngAbsolutePath, { force: true });
          if (previewCreated) await fs.rm(previewAbsolutePath, { force: true });
          if (pngDirectoryCreated) await fs.rmdir(pngDirectory).catch((item) => {
            if (item?.code !== "ENOTEMPTY" && item?.code !== "ENOENT") throw item;
          });
          if (previewDirectoryCreated) await fs.rmdir(previewDirectory).catch((item) => {
            if (item?.code !== "ENOTEMPTY" && item?.code !== "ENOENT") throw item;
          });
        } catch (rollbackError) {
          fail(
            "ROLLBACK_FAILED",
            "导入失败，且自动回滚未能完整完成；请保留现场并人工检查",
            new AggregateError([error, rollbackError]),
          );
        }
      }
      throw asImportError(error);
    }
  } catch (error) {
    throw asImportError(error);
  } finally {
    await releaseLock();
  }
}
