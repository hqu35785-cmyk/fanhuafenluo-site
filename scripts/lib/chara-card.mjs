import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

export const CATALOG_PATH = "src/data/catalog.json";
export const INTROS_PATH = "src/data/card-intros.json";
export const DETAIL_PATHS = Object.freeze({
  fanhuafenluo: "src/data/details-fanhua.json",
  public: "src/data/details-public.json",
});
export const SECTION_IDS = Object.freeze(Object.keys(DETAIL_PATHS));
export const INTRO_LENGTH = Object.freeze({ min: 120, max: 180 });

const PLACEHOLDER_TEXTS = Object.freeze([
  "开场资料整理中。",
  "性格资料整理中。",
  "设定与剧情资料整理中。",
  "资料整理中。",
]);

const DETAIL_FIELDS = Object.freeze([
  "intro",
  "opening",
  "personality",
  "setting",
  "worldbook",
  "preset",
  "sourceHash",
  "_authorId",
]);

const AI_MATERIAL_FIELDS = Object.freeze([
  "name",
  "description",
  "personality",
  "scenario",
  "first_mes",
  "mes_example",
  "creator_notes",
  "system_prompt",
  "post_history_instructions",
  "character_book",
  "alternate_greetings",
  "tags",
  "creator",
  "character_version",
]);

export const INTRO_BRIEF_PROMPT = [
  "请根据下方角色卡原始素材，写一段 120–180 个中文可见字符的站点简介。",
  "description 只是原始设定素材，不是现成简介；不要直接复制、摘抄或只做同义改写。",
  "请综合人物身份、与用户的关系、核心矛盾、场景气质和可互动钩子，写成一段独立、准确、自然的简介。",
  "不要虚构素材中不存在的关键事实，不要写制作过程，也不要提到“角色卡”“原始素材”或这些规则。",
  "最终只输出简介正文，不要标题、项目符号、引号或解释。",
].join("\n");

export function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function nonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

export function visibleLength(value) {
  return Array.from(String(value ?? "").replace(/\s/g, "")).length;
}

export async function readJsonFile(root, relativePath) {
  const absolutePath = path.join(root, ...relativePath.split("/"));
  let source;
  try {
    source = await fs.readFile(absolutePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`缺少 ${relativePath}`);
    }
    throw new Error(`${relativePath} 读取失败：${error.message}`);
  }

  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`${relativePath} 不是有效 JSON：${error.message}`);
  }
}

export function decodeRepositoryPath(value, label = "资源路径") {
  if (!nonEmptyString(value)) throw new Error(`${label} 不能为空`);
  const encoded = value.trim().replace(/^\.\//, "");
  if (encoded.includes("\\") || encoded.includes("\0")) {
    throw new Error(`${label} 非法：${value}`);
  }

  let decoded;
  try {
    decoded = decodeURIComponent(encoded);
  } catch (error) {
    throw new Error(`${label} URL 编码无效：${value}；${error.message}`);
  }

  if (
    decoded.includes("\\") ||
    decoded.includes("\0") ||
    path.posix.isAbsolute(decoded) ||
    /^[a-z]:/i.test(decoded)
  ) {
    throw new Error(`${label} 非法：${value}`);
  }

  const normalized = path.posix.normalize(decoded);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized !== decoded
  ) {
    throw new Error(`${label} 越过仓库或未经规范化：${value}`);
  }
  return normalized;
}

export function resolveRepositoryPath(root, value, label = "资源路径") {
  const relativePath = decodeRepositoryPath(value, label);
  const absolutePath = path.resolve(root, ...relativePath.split("/"));
  const resolvedRoot = path.resolve(root);
  if (absolutePath !== resolvedRoot && !absolutePath.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`${label} 越过仓库：${value}`);
  }
  return { relativePath, absolutePath };
}

function assertText(value, label) {
  if (!nonEmptyString(value)) throw new Error(`${label} 不能为空`);
}

export function detailKeyForWork(work) {
  const key = work?._detailKey || work?.image;
  assertText(key, `${work?.name || "未命名作品"} 的详情 key`);
  return key;
}

export function assertCatalog(catalog) {
  if (!isRecord(catalog) || catalog.schemaVersion !== 1 || !Array.isArray(catalog.sections)) {
    throw new Error("catalog.json 必须是 schemaVersion 1，且 sections 必须是数组");
  }
  if (catalog.sections.length !== SECTION_IDS.length) {
    throw new Error(`catalog.json 必须且只能包含分区：${SECTION_IDS.join("、")}`);
  }

  const seenSections = new Set();
  const seenPairs = new Set();
  const seenImages = new Set();
  const seenPreviews = new Set();
  const seenDetailKeys = new Set();

  for (const [sectionIndex, section] of catalog.sections.entries()) {
    const sectionLabel = `第 ${sectionIndex + 1} 个分区`;
    if (!isRecord(section)) throw new Error(`${sectionLabel} 必须是对象`);
    assertText(section.id, `${sectionLabel} id`);
    if (!SECTION_IDS.includes(section.id)) throw new Error(`未知分区：${section.id}`);
    if (seenSections.has(section.id)) throw new Error(`分区重复：${section.id}`);
    seenSections.add(section.id);
    assertText(section.name, `${section.id}.name`);
    assertText(section.english, `${section.id}.english`);
    assertText(section.avatar, `${section.id}.avatar`);
    if (!Array.isArray(section.works)) throw new Error(`${section.id}.works 必须是数组`);
    if (
      !Number.isInteger(section.pinnedCount) ||
      section.pinnedCount < 0 ||
      section.pinnedCount > section.works.length
    ) {
      throw new Error(`${section.id}.pinnedCount 必须是 0 到 works.length 之间的整数`);
    }

    for (const [workIndex, work] of section.works.entries()) {
      const label = `${section.id} 第 ${workIndex + 1} 张卡`;
      if (!isRecord(work)) throw new Error(`${label} 必须是对象`);
      assertText(work.name, `${label}.name`);
      assertText(work.alias, `${label}.alias`);
      assertText(work.creator, `${label}.creator`);
      assertText(work.image, `${label}.image`);
      assertText(work.preview, `${label}.preview`);
      const decodedImage = decodeRepositoryPath(work.image, `${label}.image`);
      const decodedPreview = decodeRepositoryPath(work.preview, `${label}.preview`);
      if (!decodedImage.startsWith("assets/") || !decodedImage.toLowerCase().endsWith(".png")) {
        throw new Error(`${label}.image 必须是 assets/ 下的 PNG`);
      }
      if (
        !decodedPreview.startsWith("assets/previews/") ||
        !decodedPreview.toLowerCase().endsWith(".webp")
      ) {
        throw new Error(`${label}.preview 必须是 assets/previews/ 下的 WebP`);
      }

      for (const field of DETAIL_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(work, field)) {
          throw new Error(`${label} 不应内嵌运行时/详情字段 ${field}`);
        }
      }
      for (const field of Object.keys(work)) {
        if (field.startsWith("_") && field !== "_detailKey") {
          throw new Error(`${label} 含未知运行时字段 ${field}`);
        }
      }

      const pair = `${work.name}\0${work.alias}`;
      if (seenPairs.has(pair)) throw new Error(`作品 name/alias 重复：${work.name} · ${work.alias}`);
      seenPairs.add(pair);
      if (seenImages.has(decodedImage)) throw new Error(`作品 PNG 路径重复：${work.image}`);
      seenImages.add(decodedImage);
      if (seenPreviews.has(decodedPreview)) throw new Error(`作品预览路径重复：${work.preview}`);
      seenPreviews.add(decodedPreview);

      const detailKey = detailKeyForWork(work);
      if (detailKey !== work.image) {
        throw new Error(`${label} 的 _detailKey 必须与 image 完全一致`);
      }
      if (seenDetailKeys.has(detailKey)) throw new Error(`详情 key 重复：${detailKey}`);
      seenDetailKeys.add(detailKey);
    }
  }

  const missing = SECTION_IDS.filter((id) => !seenSections.has(id));
  if (missing.length) throw new Error(`catalog.json 缺少分区：${missing.join("、")}`);
  return catalog;
}

export function flattenCatalog(catalog) {
  assertCatalog(catalog);
  return catalog.sections.flatMap((section) =>
    section.works.map((work, index) => ({
      section,
      sectionId: section.id,
      index,
      work,
      detailKey: detailKeyForWork(work),
    })),
  );
}

function decodeBase64Json(encoded, relativePath) {
  const compact = encoded.replace(/\s/g, "");
  if (!compact || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    throw new Error(`chara 元数据不是有效 Base64：${relativePath}`);
  }
  try {
    const parsed = JSON.parse(Buffer.from(compact, "base64").toString("utf8"));
    if (!isRecord(parsed)) throw new Error("顶层不是对象");
    const data = isRecord(parsed.data) ? parsed.data : parsed;
    if (!isRecord(data)) throw new Error("缺少角色数据对象");
    return { envelope: parsed, data };
  } catch (error) {
    throw new Error(`chara 元数据无法解析：${relativePath}；${error.message}`);
  }
}

export function decodeCharaPng(buffer, relativePath = "PNG") {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!Buffer.isBuffer(buffer) || !buffer.subarray(0, 8).equals(signature)) {
    throw new Error(`不是有效 PNG：${relativePath}`);
  }

  let offset = 8;
  let reachedEnd = false;
  const payloads = [];
  while (offset < buffer.length) {
    if (offset + 12 > buffer.length) throw new Error(`PNG chunk 头不完整：${relativePath}`);
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (chunkEnd > buffer.length) throw new Error(`PNG chunk 越过文件末尾：${relativePath}`);

    if (type === "tEXt") {
      const data = buffer.subarray(dataStart, dataEnd);
      const separator = data.indexOf(0);
      if (separator >= 0 && data.subarray(0, separator).toString("latin1") === "chara") {
        payloads.push(data.subarray(separator + 1).toString("latin1"));
      }
    }

    offset = chunkEnd;
    if (type === "IEND") {
      reachedEnd = true;
      break;
    }
  }

  if (!reachedEnd || offset !== buffer.length) {
    throw new Error(`PNG 缺少完整 IEND 或含尾随数据：${relativePath}`);
  }
  if (payloads.length !== 1) {
    throw new Error(`PNG 必须恰有一个 chara tEXt 块：${relativePath}；实际 ${payloads.length}`);
  }
  return decodeBase64Json(payloads[0], relativePath);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isRecord(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

export function canonicalSourceData(data) {
  return stableValue({
    description: data.description ?? "",
    first_mes: data.first_mes ?? "",
    personality: data.personality ?? "",
    scenario: data.scenario ?? "",
    character_book: data.character_book ?? null,
    system_prompt: data.system_prompt ?? "",
    post_history_instructions: data.post_history_instructions ?? "",
  });
}

export function sourceHash(data) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalSourceData(data)), "utf8")
    .digest("hex");
}

function formatPreset(data) {
  const sections = [];
  if (nonEmptyString(data.system_prompt)) sections.push(`【系统提示词】\n${data.system_prompt}`);
  if (nonEmptyString(data.post_history_instructions)) {
    sections.push(`【历史后指令】\n${data.post_history_instructions}`);
  }
  return sections.length ? sections.join("\n\n") : null;
}

function formatWorldbook(book, relativePath) {
  if (!isRecord(book)) return null;
  const entries = Array.isArray(book.entries)
    ? book.entries
    : isRecord(book.entries)
      ? Object.values(book.entries)
      : [];
  if (!entries.some((entry) => nonEmptyString(entry?.content))) return null;

  const blocks = [];
  if (nonEmptyString(book.name)) blocks.push(`【世界书】\n${book.name}`);
  entries.forEach((entry, index) => {
    if (!isRecord(entry)) throw new Error(`世界书条目不是对象：${relativePath} · ${index + 1}`);
    const title = nonEmptyString(entry.name)
      ? entry.name
      : nonEmptyString(entry.comment)
        ? entry.comment
        : `条目 ${String(index + 1).padStart(2, "0")}`;
    const lines = [`【${title}】`];
    if (nonEmptyString(entry.comment) && entry.comment !== title) lines.push(`备注：${entry.comment}`);
    if (Array.isArray(entry.keys) && entry.keys.length) lines.push(`关键词：${entry.keys.join("、")}`);
    if (typeof entry.enabled === "boolean") lines.push(`状态：${entry.enabled ? "启用" : "停用"}`);
    if (nonEmptyString(entry.position)) lines.push(`位置：${entry.position}`);
    if (nonEmptyString(entry.content)) lines.push(entry.content);
    blocks.push(lines.join("\n"));
  });
  return blocks.join("\n\n");
}

export function buildDirectDetail(data, relativePath) {
  if (!nonEmptyString(data.first_mes)) throw new Error(`first_mes 为空：${relativePath}`);
  const detail = { opening: data.first_mes };
  if (nonEmptyString(data.personality)) detail.personality = data.personality;
  if (nonEmptyString(data.scenario)) detail.setting = data.scenario;
  const worldbook = formatWorldbook(data.character_book, relativePath);
  if (worldbook) detail.worldbook = worldbook;
  const preset = formatPreset(data);
  if (preset) detail.preset = preset;
  return detail;
}

export async function readCharaCard(root, record) {
  const { relativePath, absolutePath } = resolveRepositoryPath(
    root,
    record.work.image,
    `${record.work.name}.image`,
  );
  let buffer;
  try {
    buffer = await fs.readFile(absolutePath);
  } catch (error) {
    throw new Error(`${record.work.name} · PNG 读取失败：${relativePath}；${error.message}`);
  }
  const decoded = decodeCharaPng(buffer, relativePath);
  if (!nonEmptyString(decoded.data.name)) throw new Error(`${relativePath} 的嵌入角色名为空`);
  if (!nonEmptyString(decoded.data.description)) throw new Error(`${relativePath} 的 description 为空`);
  return {
    ...record,
    sourceRelativePath: relativePath,
    sourceAbsolutePath: absolutePath,
    sourceBytes: buffer.length,
    envelope: decoded.envelope,
    data: decoded.data,
    sourceHash: sourceHash(decoded.data),
    directDetail: buildDirectDetail(decoded.data, relativePath),
  };
}

export async function collectCatalogRecords(root) {
  const catalog = assertCatalog(await readJsonFile(root, CATALOG_PATH));
  const bareRecords = flattenCatalog(catalog);
  const records = [];
  for (const record of bareRecords) records.push(await readCharaCard(root, record));
  const groups = catalog.sections.map((section) => ({
    section,
    sectionId: section.id,
    records: records.filter((record) => record.sectionId === section.id),
  }));
  return { catalog, groups, records };
}

export async function loadIntros(root, { allowMissing = false } = {}) {
  try {
    const intros = await readJsonFile(root, INTROS_PATH);
    if (!isRecord(intros)) throw new Error(`${INTROS_PATH} 顶层必须是对象`);
    return intros;
  } catch (error) {
    if (allowMissing && error.message === `缺少 ${INTROS_PATH}`) return {};
    throw error;
  }
}

export function validateIntroEntry(record, entry) {
  if (!isRecord(entry)) throw new Error(`${record.detailKey} 缺少简介对象`);
  if (!nonEmptyString(entry.intro)) throw new Error(`${record.work.name} · 简介为空`);
  const length = visibleLength(entry.intro);
  if (length < INTRO_LENGTH.min || length > INTRO_LENGTH.max) {
    throw new Error(
      `${record.work.name} · 简介长度 ${length}，必须为 ${INTRO_LENGTH.min}–${INTRO_LENGTH.max}`,
    );
  }
  const normalizedIntro = entry.intro.replace(/\s/g, "");
  const normalizedDescription = record.data.description.replace(/\s/g, "");
  if (
    normalizedIntro === normalizedDescription ||
    normalizedDescription.includes(normalizedIntro) ||
    normalizedIntro.includes(normalizedDescription)
  ) {
    throw new Error(`${record.work.name} · 简介不能复制 description 原文或整段摘抄`);
  }
  if (entry.sourceHash !== record.sourceHash) {
    throw new Error(`${record.work.name} · sourceHash 过期，应为 ${record.sourceHash}`);
  }
  for (const placeholder of PLACEHOLDER_TEXTS) {
    if (entry.intro.includes(placeholder)) {
      throw new Error(`${record.work.name} · 简介包含占位文案：${placeholder}`);
    }
  }
}

export function buildExpectedDetails(records, intros) {
  const details = {};
  const seenIntros = new Map();
  for (const record of records) {
    const introEntry = intros[record.detailKey];
    validateIntroEntry(record, introEntry);
    const normalizedIntro = introEntry.intro.trim();
    if (seenIntros.has(normalizedIntro)) {
      throw new Error(`简介重复：${record.work.name} 与 ${seenIntros.get(normalizedIntro)}`);
    }
    seenIntros.set(normalizedIntro, record.work.name);
    details[record.detailKey] = {
      intro: introEntry.intro,
      ...record.directDetail,
    };
  }
  return details;
}

export function assertExactKeySet(label, actualObject, expectedKeys) {
  if (!isRecord(actualObject)) throw new Error(`${label} 顶层必须是对象`);
  const actual = Object.keys(actualObject).sort();
  const expected = [...expectedKeys].sort();
  if (!isDeepStrictEqual(actual, expected)) {
    const actualSet = new Set(actual);
    const expectedSet = new Set(expected);
    const missing = expected.filter((key) => !actualSet.has(key));
    const extra = actual.filter((key) => !expectedSet.has(key));
    throw new Error(
      `${label} key 不一致；缺少 ${missing.length}，多出 ${extra.length}` +
        `${missing.length ? `；缺少示例：${missing.slice(0, 3).join("、")}` : ""}` +
        `${extra.length ? `；多出示例：${extra.slice(0, 3).join("、")}` : ""}`,
    );
  }
}

export function assertIntroCoverage(records, intros) {
  assertExactKeySet(INTROS_PATH, intros, records.map((record) => record.detailKey));
  for (const record of records) validateIntroEntry(record, intros[record.detailKey]);
}

function aiMaterial(data) {
  return Object.fromEntries(
    AI_MATERIAL_FIELDS
      .filter((field) => Object.prototype.hasOwnProperty.call(data, field))
      .map((field) => [field, stableValue(data[field])]),
  );
}

export function buildIntroBrief(records, intros = {}, { all = false, keys = [] } = {}) {
  const requestedKeys = new Set(keys);
  const unknownKeys = [...requestedKeys].filter(
    (key) => !records.some((record) => record.detailKey === key),
  );
  if (unknownKeys.length) throw new Error(`--key 未匹配目录：${unknownKeys.join("、")}`);

  const selected = records.filter((record) => {
    if (requestedKeys.size) return requestedKeys.has(record.detailKey);
    if (all) return true;
    const intro = intros[record.detailKey];
    return !isRecord(intro) || intro.sourceHash !== record.sourceHash || !nonEmptyString(intro.intro);
  });

  return {
    schemaVersion: 1,
    purpose: "write-card-introduction",
    prompt: INTRO_BRIEF_PROMPT,
    constraints: {
      language: "zh-CN",
      visibleCharacters: INTRO_LENGTH,
      output: "仅简介正文",
      descriptionIsReferenceOnly: true,
    },
    cards: selected.map((record) => ({
      sectionId: record.sectionId,
      key: record.detailKey,
      name: record.work.name,
      alias: record.work.alias,
      creator: record.work.creator,
      role: record.work.role ?? "",
      tags: Array.isArray(record.work.tags) ? record.work.tags : [],
      cardLabel: record.work.cardLabel ?? "",
      sourceHash: record.sourceHash,
      originalMaterial: aiMaterial(record.data),
    })),
  };
}

export function summarizeRecords(groups, records) {
  return {
    sections: Object.fromEntries(groups.map((group) => [group.sectionId, group.records.length])),
    total: records.length,
    sourceMiB: Number(
      (records.reduce((sum, record) => sum + record.sourceBytes, 0) / 1024 / 1024).toFixed(2),
    ),
  };
}
