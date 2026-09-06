import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import {
  DETAIL_PATHS,
  INTRO_BRIEF_PROMPT,
  SECTION_IDS,
  assertCatalog,
  assertExactKeySet,
  assertIntroCoverage,
  buildExpectedDetails,
  buildIntroBrief,
  collectCatalogRecords,
  decodeRepositoryPath,
  loadIntros,
  readJsonFile,
  sourceHash,
  validateIntroEntry,
} from "../scripts/lib/chara-card.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LEGACY_DATA_FILES = [
  "src/data/works.js",
  "src/data/details-fanhua.js",
  "src/data/details-public.js",
  "src/data/details-shark.js",
  "src/data/details-wa.js",
];
const INLINE_DETAIL_FIELDS = [
  "intro",
  "opening",
  "personality",
  "setting",
  "worldbook",
  "preset",
  "sourceHash",
  "_authorId",
];

let fixture;
let intros;
let details;

before(async () => {
  fixture = await collectCatalogRecords(ROOT);
  intros = await loadIntros(ROOT);
  details = Object.fromEntries(
    await Promise.all(
      SECTION_IDS.map(async (sectionId) => [
        sectionId,
        await readJsonFile(ROOT, DETAIL_PATHS[sectionId]),
      ]),
    ),
  );
});

test("catalog schema is complete and every count comes from its works array", () => {
  const catalog = assertCatalog(fixture.catalog);
  assert.deepEqual(
    catalog.sections.map((section) => section.id),
    SECTION_IDS,
  );
  assert.equal(
    fixture.records.length,
    catalog.sections.reduce((sum, section) => sum + section.works.length, 0),
  );
  for (const section of catalog.sections) {
    assert.equal(fixture.groups.find((group) => group.sectionId === section.id).records.length, section.works.length);
    assert.ok(Number.isInteger(section.pinnedCount));
    assert.ok(section.pinnedCount >= 0 && section.pinnedCount <= section.works.length);
  }
});

test("catalog preserves source metadata without embedding detail or runtime state", () => {
  const decodedImages = new Set();
  const decodedPreviews = new Set();
  for (const record of fixture.records) {
    const work = record.work;
    assert.equal(work._detailKey, work.image);
    assert.equal(typeof work.name, "string");
    assert.equal(typeof work.creator, "string");
    assert.equal(typeof work.alias, "string");
    for (const field of INLINE_DETAIL_FIELDS) {
      assert.equal(Object.hasOwn(work, field), false, `${work.alias} unexpectedly contains ${field}`);
    }
    const image = decodeRepositoryPath(work.image);
    const preview = decodeRepositoryPath(work.preview);
    assert.equal(decodedImages.has(image), false, `decoded PNG path is duplicated: ${image}`);
    assert.equal(decodedPreviews.has(preview), false, `decoded preview path is duplicated: ${preview}`);
    decodedImages.add(image);
    decodedPreviews.add(preview);
  }
});

test("independent introductions cover the catalog and never fall back to description", () => {
  assertIntroCoverage(fixture.records, intros);
  for (const record of fixture.records) {
    const intro = intros[record.detailKey].intro.replace(/\s/g, "");
    const description = record.data.description.replace(/\s/g, "");
    assert.ok(intro !== description, 'Introduction must be independently written.');
    assert.equal(description.includes(intro), false, `${record.work.alias} intro is a description excerpt`);
  }
});

test("detail JSON is a deterministic projection of PNG data plus handwritten intros", () => {
  for (const group of fixture.groups) {
    const expected = buildExpectedDetails(group.records, intros);
    const actual = details[group.sectionId];
    assertExactKeySet(
      DETAIL_PATHS[group.sectionId],
      actual,
      group.records.map((record) => record.detailKey),
    );
    assert.ok(isDeepStrictEqual(actual, expected), 'Generated details differ from their source.');
  }
});

test("AI copy pack includes original fields and a prompt that forbids treating description as the intro", () => {
  const data = {
    description: "这是只用于验证字段映射的中性合成说明，不来自站点目录或任何卡片。",
    first_mes: "这是中性合成开场文本。",
    personality: "",
    scenario: "",
    character_book: null,
    system_prompt: "",
    post_history_instructions: "",
  };
  const record = {
    sectionId: "fanhuafenluo",
    detailKey: "assets/synthetic-copy-pack-contract.png",
    work: {
      name: "中性合成记录",
      alias: "SYNTHETIC CONTRACT RECORD",
      creator: "test-fixture",
    },
    data,
    sourceHash: sourceHash(data),
  };
  const brief = buildIntroBrief([record], {}, { all: true });
  assert.equal(brief.cards.length, 1);
  assert.equal(brief.prompt, INTRO_BRIEF_PROMPT);
  assert.equal(brief.constraints.descriptionIsReferenceOnly, true);
  assert.equal(brief.cards[0].sourceHash, record.sourceHash);
  assert.ok(brief.cards[0].originalMaterial.description === record.data.description, 'Description is missing from the copy pack.');
  assert.ok(brief.cards[0].originalMaterial.first_mes === record.data.first_mes, 'Opening is missing from the copy pack.');
  assert.equal(Object.hasOwn(brief.cards[0], "intro"), false);
  assert.match(brief.prompt, /不要直接复制、摘抄或只做同义改写/);
});

test("intro validator rejects a whitespace-only copy of description", () => {
  const data = {
    description: "甲".repeat(60) + "\n" + "乙".repeat(60),
    first_mes: "开场",
    personality: "",
    scenario: "",
    character_book: null,
    system_prompt: "",
    post_history_instructions: "",
  };
  const record = {
    detailKey: "assets/example.png",
    work: { name: "测试卡" },
    data,
    sourceHash: sourceHash(data),
  };
  assert.throws(
    () =>
      validateIntroEntry(record, {
        intro: `${"甲 ".repeat(60)}${"乙 ".repeat(60)}`,
        sourceHash: record.sourceHash,
      }),
    /不能复制 description 原文或整段摘抄/,
  );
});

test("legacy executable data files are absent", async () => {
  for (const relativePath of LEGACY_DATA_FILES) {
    await assert.rejects(fs.access(path.join(ROOT, ...relativePath.split("/"))), { code: "ENOENT" });
  }
});
