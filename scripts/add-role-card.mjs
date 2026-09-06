import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";
import { fileURLToPath } from "node:url";

import { addRoleCard } from "./lib/card-import.mjs";

const BLOCKED_HASHES_PATH = "tools/card-publisher/blocked-card-hashes.json";

function cliError(code, message, cause = undefined) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function usage(message) {
  const command = [
    "用法：node scripts/add-role-card.mjs",
    "  --section <fanhuafenluo|public>",
    "  --card <card.png>",
    "  --intro-file <intro.txt>",
    "  --result-file <result.json>",
    "  [--root <repository>]",
  ].join(" ");
  throw new Error(message ? `${message}\n${command}` : command);
}

function parseArgs(argv) {
  const options = {};
  const known = new Map([
    ["--section", "section"],
    ["--card", "cardPath"],
    ["--intro-file", "introFile"],
    ["--result-file", "resultFile"],
    ["--root", "root"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const field = known.get(argument);
    if (!field) usage(`未知参数：${argument}`);
    if (Object.hasOwn(options, field)) usage(`参数重复：${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) usage(`${argument} 后面缺少值`);
    options[field] = value;
    index += 1;
  }
  for (const field of ["section", "cardPath", "introFile", "resultFile"]) {
    if (!options[field]) usage(`缺少参数：${field}`);
  }
  return options;
}

async function strictUtf8File(absolutePath) {
  const buffer = await fs.readFile(absolutePath);
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch (error) {
    throw new Error(`简介文件不是有效 UTF-8：${error.message}`);
  }
  return text.replace(/^\uFEFF/, "");
}

async function sha256File(absolutePath) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of createReadStream(absolutePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function readBlockedHashes(root) {
  const absolutePath = path.join(root, ...BLOCKED_HASHES_PATH.split("/"));
  let payload;
  try {
    payload = JSON.parse(await fs.readFile(absolutePath, "utf8"));
  } catch (error) {
    throw cliError("DENYLIST_READ_FAILED", `无法读取安全阻止清单：${BLOCKED_HASHES_PATH}`, error);
  }
  if (payload?.schemaVersion !== 1 || !Array.isArray(payload?.sha256)) {
    throw cliError("DENYLIST_INVALID", `${BLOCKED_HASHES_PATH} 格式无效`);
  }
  const hashes = payload.sha256.map((value) => {
    if (typeof value !== "string" || !/^[0-9a-f]{64}$/i.test(value)) {
      throw cliError("DENYLIST_INVALID", `${BLOCKED_HASHES_PATH} 含无效 SHA-256`);
    }
    return value.toLowerCase();
  });
  if (new Set(hashes).size !== hashes.length) {
    throw cliError("DENYLIST_INVALID", `${BLOCKED_HASHES_PATH} 含重复 SHA-256`);
  }
  return hashes;
}

async function writeResult(resultFile, value) {
  const absolutePath = path.resolve(resultFile);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }

  const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const root = path.resolve(options.root || defaultRoot);
  const cardPath = path.resolve(options.cardPath);
  const introFile = path.resolve(options.introFile);

  try {
    const [intro, expectedSha256, denyHashes] = await Promise.all([
      strictUtf8File(introFile),
      sha256File(cardPath),
      readBlockedHashes(root),
    ]);
    const result = await addRoleCard({
      root,
      cardPath,
      intro,
      section: options.section,
      expectedSha256,
      denyHashes,
    });
    const payload = { ok: true, ...result };
    await writeResult(options.resultFile, payload);
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  } catch (error) {
    const payload = {
      ok: false,
      error: {
        code: error?.code || "CLI_FAILED",
        message: error?.message || String(error),
      },
    };
    try {
      await writeResult(options.resultFile, payload);
    } catch (resultError) {
      console.error(`结果文件写入失败：${resultError.message}`);
    }
    console.error(JSON.stringify(payload));
    process.exitCode = 1;
  }
}

main();
