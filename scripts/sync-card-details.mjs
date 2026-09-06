import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";

import {
  DETAIL_PATHS,
  assertExactKeySet,
  assertIntroCoverage,
  buildExpectedDetails,
  buildIntroBrief,
  collectCatalogRecords,
  loadIntros,
  readJsonFile,
  summarizeRecords,
} from "./lib/chara-card.mjs";

const LEGACY_DATA_FILES = Object.freeze([
  "src/data/works.js",
  "src/data/details-fanhua.js",
  "src/data/details-public.js",
  "src/data/details-shark.js",
  "src/data/details-wa.js",
]);

function usage(message) {
  const suffix = [
    "用法：",
    "  node scripts/sync-card-details.mjs --write [--root <repo>]",
    "  node scripts/sync-card-details.mjs --check [--root <repo>]",
    "  node scripts/sync-card-details.mjs --intro-brief [--all | --key <detail-key> ...] [--root <repo>]",
  ].join("\n");
  throw new Error(message ? `${message}\n${suffix}` : suffix);
}

function parseArgs(argv) {
  const result = { mode: null, root: null, all: false, keys: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (["--write", "--check", "--intro-brief"].includes(argument)) {
      if (result.mode) usage("必须且只能指定一个运行模式");
      result.mode = argument.slice(2);
    } else if (argument === "--root") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) usage("--root 后面缺少目录");
      result.root = value;
      index += 1;
    } else if (argument === "--all") {
      result.all = true;
    } else if (argument === "--key") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) usage("--key 后面缺少详情 key");
      result.keys.push(value);
      index += 1;
    } else {
      usage(`未知参数：${argument}`);
    }
  }

  if (!result.mode) usage("缺少运行模式");
  if (result.mode !== "intro-brief" && (result.all || result.keys.length)) {
    usage("--all/--key 只能与 --intro-brief 一起使用");
  }
  if (result.all && result.keys.length) usage("--all 与 --key 不能同时使用");
  return result;
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

async function writeJson(root, relativePath, value) {
  const absolutePath = path.join(root, ...relativePath.split("/"));
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function expectedBySection(groups, intros) {
  return Object.fromEntries(
    groups.map((group) => [group.sectionId, buildExpectedDetails(group.records, intros)]),
  );
}

async function verifyDetails(root, groups, intros) {
  const expected = expectedBySection(groups, intros);
  for (const group of groups) {
    const relativePath = DETAIL_PATHS[group.sectionId];
    const actual = await readJsonFile(root, relativePath);
    assertExactKeySet(relativePath, actual, group.records.map((record) => record.detailKey));
    if (!isDeepStrictEqual(actual, expected[group.sectionId])) {
      throw new Error(`${relativePath} 与当前 PNG 和独立简介源的确定性生成结果不一致`);
    }
  }
  return expected;
}

function detailFieldCounts(expected) {
  const details = Object.values(expected).flatMap((group) => Object.values(group));
  const count = (field) => details.filter((detail) => typeof detail[field] === "string" && detail[field]).length;
  return {
    intro: count("intro"),
    opening: count("opening"),
    personality: count("personality"),
    setting: count("setting"),
    worldbook: count("worldbook"),
    preset: count("preset"),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const root = path.resolve(options.root || defaultRoot);
  const { groups, records } = await collectCatalogRecords(root);

  if (options.mode === "intro-brief") {
    const intros = await loadIntros(root, { allowMissing: true });
    const brief = buildIntroBrief(records, intros, {
      all: options.all,
      keys: options.keys,
    });
    process.stdout.write(`${JSON.stringify(brief, null, 2)}\n`);
    return;
  }

  await assertLegacyDataAbsent(root);
  const intros = await loadIntros(root);
  assertIntroCoverage(records, intros);
  const expected = expectedBySection(groups, intros);

  if (options.mode === "write") {
    for (const group of groups) {
      await writeJson(root, DETAIL_PATHS[group.sectionId], expected[group.sectionId]);
    }
  } else {
    await verifyDetails(root, groups, intros);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        mode: options.mode,
        ...summarizeRecords(groups, records),
        details: detailFieldCounts(expected),
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error?.message || String(error));
  process.exitCode = 1;
});
