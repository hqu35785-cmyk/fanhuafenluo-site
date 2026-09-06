import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

import {
  DETAIL_PATHS,
  assertExactKeySet,
  assertIntroCoverage,
  buildExpectedDetails,
  collectCatalogRecords,
  decodeRepositoryPath,
  loadIntros,
  readJsonFile,
  resolveRepositoryPath,
  summarizeRecords,
} from "./lib/chara-card.mjs";

const MAX_PREVIEW_BYTES = 1024 * 1024;
const MAX_PREVIEW_EDGE = 2048;
const LEGACY_DATA_FILES = Object.freeze([
  "src/data/works.js",
  "src/data/details-fanhua.js",
  "src/data/details-public.js",
  "src/data/details-shark.js",
  "src/data/details-wa.js",
]);

function parseRoot(argv, fallback) {
  if (!argv.length) return fallback;
  if (argv.length === 2 && argv[0] === "--root" && argv[1]) return path.resolve(argv[1]);
  throw new Error("用法：node scripts/validate_assets.mjs [--root <repo>]");
}

function portable(root, absolutePath) {
  return path.relative(root, absolutePath).split(path.sep).join("/");
}

async function assertRegularFile(root, absolutePath, label) {
  let info;
  try {
    info = await fs.lstat(absolutePath);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`缺少 ${label}：${portable(root, absolutePath)}`);
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`${label} 必须是仓库内普通文件：${portable(root, absolutePath)}`);
  }
  const realRoot = await fs.realpath(root);
  const realFile = await fs.realpath(absolutePath);
  if (realFile !== realRoot && !realFile.startsWith(`${realRoot}${path.sep}`)) {
    throw new Error(`${label} 的真实路径越过仓库：${portable(root, absolutePath)}`);
  }
  return info;
}

async function walkFiles(directory) {
  const result = [];
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return result;
    throw error;
  }
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`资源目录不能含符号链接：${absolutePath}`);
    if (entry.isDirectory()) result.push(...(await walkFiles(absolutePath)));
    else if (entry.isFile()) result.push(path.resolve(absolutePath));
  }
  return result;
}

function assertSameFileSet(label, actualFiles, expectedFiles) {
  const actual = new Set(actualFiles.map((file) => path.resolve(file)));
  const expected = new Set(expectedFiles.map((file) => path.resolve(file)));
  const missing = [...expected].filter((file) => !actual.has(file));
  const extra = [...actual].filter((file) => !expected.has(file));
  if (missing.length || extra.length) {
    throw new Error(
      `${label} 文件集合不一致；缺少 ${missing.length}，多出 ${extra.length}` +
        `${missing.length ? `；缺少示例：${missing.slice(0, 3).join("、")}` : ""}` +
        `${extra.length ? `；多出示例：${extra.slice(0, 3).join("、")}` : ""}`,
    );
  }
}

async function validateWebp(root, absolutePath, label) {
  const info = await assertRegularFile(root, absolutePath, label);
  if (info.size > MAX_PREVIEW_BYTES) {
    throw new Error(`${label} 超过 ${MAX_PREVIEW_BYTES / 1024} KiB：${portable(root, absolutePath)}`);
  }
  let metadata;
  try {
    metadata = await sharp(absolutePath).metadata();
  } catch (error) {
    throw new Error(`${label} 无法解码：${portable(root, absolutePath)}；${error.message}`);
  }
  if (metadata.format !== "webp" || !metadata.width || !metadata.height) {
    throw new Error(`${label} 必须是可解码 WebP：${portable(root, absolutePath)}`);
  }
  if (metadata.width > MAX_PREVIEW_EDGE || metadata.height > MAX_PREVIEW_EDGE) {
    throw new Error(
      `${label} 尺寸超过 ${MAX_PREVIEW_EDGE}px：${portable(root, absolutePath)} ` +
        `(${metadata.width}x${metadata.height})`,
    );
  }
  return { bytes: info.size, width: metadata.width, height: metadata.height };
}

async function assertLegacyDataAbsent(root) {
  for (const relativePath of LEGACY_DATA_FILES) {
    try {
      await fs.access(path.join(root, ...relativePath.split("/")));
      throw new Error(`旧数据文件仍然存在：${relativePath}`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

async function validateDetails(root, groups, records, intros) {
  assertIntroCoverage(records, intros);
  for (const [key, value] of Object.entries(intros)) {
    const fields = Object.keys(value).sort();
    if (!isDeepStrictEqual(fields, ["intro", "sourceHash"])) {
      throw new Error(`简介 ${key} 只能包含 intro 与 sourceHash`);
    }
  }

  for (const group of groups) {
    const relativePath = DETAIL_PATHS[group.sectionId];
    const actual = await readJsonFile(root, relativePath);
    const expected = buildExpectedDetails(group.records, intros);
    assertExactKeySet(relativePath, actual, group.records.map((record) => record.detailKey));
    if (!isDeepStrictEqual(actual, expected)) {
      throw new Error(`${relativePath} 与 PNG/简介源的确定性结果不一致；请运行 npm run sync:details`);
    }
  }
}

async function main() {
  const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const root = parseRoot(process.argv.slice(2), scriptRoot);
  await assertLegacyDataAbsent(root);
  const { catalog, groups, records } = await collectCatalogRecords(root);
  const intros = await loadIntros(root);
  await validateDetails(root, groups, records, intros);

  const expectedPngs = [];
  const expectedPreviews = [];
  const previewStats = [];
  for (const record of records) {
    const image = resolveRepositoryPath(root, record.work.image, `${record.work.name}.image`);
    const preview = resolveRepositoryPath(root, record.work.preview, `${record.work.name}.preview`);
    await assertRegularFile(root, image.absolutePath, "角色卡 PNG");
    expectedPngs.push(image.absolutePath);
    expectedPreviews.push(preview.absolutePath);
    if (
      path.basename(image.relativePath, path.extname(image.relativePath)) !==
      path.basename(preview.relativePath, path.extname(preview.relativePath))
    ) {
      throw new Error(`${record.work.name} 的 PNG 与预览文件名不对应`);
    }
    previewStats.push(await validateWebp(root, preview.absolutePath, "角色卡预览"));
  }

  const expectedAvatars = [];
  const avatarStats = [];
  for (const section of catalog.sections) {
    const decoded = decodeRepositoryPath(section.avatar, `${section.id}.avatar`);
    if (!decoded.startsWith("assets/authors/") || !decoded.toLowerCase().endsWith(".webp")) {
      throw new Error(`${section.id}.avatar 必须是 assets/authors/ 下的 WebP`);
    }
    const avatar = resolveRepositoryPath(root, section.avatar, `${section.id}.avatar`);
    expectedAvatars.push(avatar.absolutePath);
    avatarStats.push(await validateWebp(root, avatar.absolutePath, "分区头像"));
  }

  const assetFiles = await walkFiles(path.join(root, "assets"));
  const actualPngs = assetFiles.filter((file) => file.toLowerCase().endsWith(".png"));
  const actualPreviews = await walkFiles(path.join(root, "assets", "previews"));
  const actualAvatars = await walkFiles(path.join(root, "assets", "authors"));
  assertSameFileSet("原始 PNG", actualPngs, expectedPngs);
  assertSameFileSet("预览 WebP", actualPreviews, expectedPreviews);
  assertSameFileSet("分区头像", actualAvatars, expectedAvatars);

  const previewBytes = previewStats.reduce((sum, item) => sum + item.bytes, 0);
  const avatarBytes = avatarStats.reduce((sum, item) => sum + item.bytes, 0);
  console.log(
    JSON.stringify(
      {
        ok: true,
        ...summarizeRecords(groups, records),
        pngs: expectedPngs.length,
        previews: expectedPreviews.length,
        previewMiB: Number((previewBytes / 1024 / 1024).toFixed(2)),
        avatars: expectedAvatars.length,
        avatarKiB: Number((avatarBytes / 1024).toFixed(2)),
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error?.stack || String(error));
  process.exitCode = 1;
});
