import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, "..");
const catalogPath = path.join(repositoryRoot, "src", "data", "catalog.json");
const productionCatalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
const productionSections = productionCatalog.sections;
const productionIsEmpty = productionSections.every((section) => section.works.length === 0);
const emptyCatalog = {
  ...productionCatalog,
  sections: productionSections.map((section) => ({ ...section, pinnedCount: 0, works: [] })),
};

const CATALOG_REQUEST = /\/src\/data\/catalog(?:\.[0-9a-f]{16})?\.json$/i;
const FANHUA_DETAILS_REQUEST = /\/src\/data\/details-fanhua(?:\.[0-9a-f]{16})?\.json$/i;
const PUBLIC_DETAILS_REQUEST = /\/src\/data\/details-public(?:\.[0-9a-f]{16})?\.json$/i;
const ORIGINAL_FIXTURE_REQUEST = /\/assets\/cards\/fixtures\/neutral-[ab]\.png$/i;
const PREVIEW_FIXTURE_REQUEST = /\/assets\/previews\/fixtures\/neutral-[ab]\.webp$/i;

const NEUTRAL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const NEUTRAL_INTRO =
  "这是一段完全独立撰写的中性测试简介，用来说明一位成年角色如何在安静日常中与来访者建立信任，并通过共同处理生活难题逐渐显露性格层次。故事重点落在选择、沟通与关系变化上，既交代人物处境，也给出可以继续探索的互动方向，同时不摘录任何既有角色内容，只服务于浏览器回归测试。";

if (visibleLength(NEUTRAL_INTRO) < 120 || visibleLength(NEUTRAL_INTRO) > 180) {
  throw new Error("Neutral introduction fixture must contain 120–180 visible characters.");
}

function neutralWork(suffix, name) {
  const lower = suffix.toLowerCase();
  const image = `assets/cards/fixtures/neutral-${lower}.png`;
  return {
    name,
    alias: `NEUTRAL · ${suffix}`,
    creator: "中性测试作者",
    image,
    preview: `assets/previews/fixtures/neutral-${lower}.webp`,
    _detailKey: image,
    role: "成年协作者",
    tags: ["中性测试", "日常互动"],
    cardLabel: `FIXTURE ${suffix}`,
    previewPosition: "50% 50%",
  };
}

const neutralWorks = {
  fanhuafenluo: neutralWork("A", "中性成年测试角色甲"),
  public: neutralWork("B", "中性成年测试角色乙"),
};

const neutralCatalog = {
  schemaVersion: 1,
  sections: [
    {
      id: "fanhuafenluo",
      name: "中性测试分区甲",
      english: "NEUTRAL FIXTURE A",
      avatar: "assets/authors/fanhuafenluo-avatar.webp",
      pinnedCount: 0,
      works: [neutralWorks.fanhuafenluo],
    },
    {
      id: "public",
      name: "中性测试分区乙",
      english: "NEUTRAL FIXTURE B",
      avatar: "assets/authors/public.webp",
      pinnedCount: 0,
      works: [neutralWorks.public],
    },
  ],
};

function neutralDetail(label) {
  return {
    intro: NEUTRAL_INTRO,
    opening: `${label}在明亮的共享工作室里整理今日清单，并邀请另一位成年人一起核对下一步安排。`,
    personality: "沉稳、坦率，习惯在行动前确认彼此的边界与目标。",
    setting: "两位成年人正在共同完成一个没有现实人物映射的中性测试项目。",
    worldbook: "【中性测试空间】\n一个只用于自动化回归的虚构共享工作室。",
    preset: "【测试约定】\n保持叙述中性，只验证界面交互和文本呈现。",
  };
}

const neutralDetails = {
  fanhuafenluo: {
    [neutralWorks.fanhuafenluo.image]: neutralDetail("角色甲"),
  },
  public: {
    [neutralWorks.public.image]: neutralDetail("角色乙"),
  },
};

function visibleLength(value) {
  return Array.from(String(value || "").replace(/\s/gu, "")).length;
}

function expectedDetailText(detail, key) {
  if (key === "intro") return detail.intro;
  if (key === "opening") return detail.opening;
  if (key === "worldbook") return detail.worldbook;
  if (key === "preset") return detail.preset;
  if (key === "setting") {
    return `【性格设定】\n${detail.personality}\n\n【场景设定】\n${detail.setting}`;
  }
  throw new Error(`Unsupported detail key: ${key}`);
}

function observeClientErrors(page) {
  let count = 0;
  page.on("pageerror", () => {
    count += 1;
  });
  page.on("console", (message) => {
    if (message.type() === "error") count += 1;
  });
  return () => count;
}

async function fulfillJson(route, value) {
  await route.fulfill({
    status: 200,
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify(value),
  });
}

async function installNeutralFixture(page, options = {}) {
  const originalMode = options.originalMode || "local";
  const originalRequests = options.originalRequests || [];

  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const pathname = url.pathname;

    if (CATALOG_REQUEST.test(pathname)) {
      await fulfillJson(route, neutralCatalog);
      return;
    }
    if (FANHUA_DETAILS_REQUEST.test(pathname)) {
      await fulfillJson(route, neutralDetails.fanhuafenluo);
      return;
    }
    if (PUBLIC_DETAILS_REQUEST.test(pathname)) {
      await fulfillJson(route, neutralDetails.public);
      return;
    }
    if (PREVIEW_FIXTURE_REQUEST.test(pathname)) {
      await route.fulfill({ status: 200, contentType: "image/png", body: NEUTRAL_PNG });
      return;
    }
    if (ORIGINAL_FIXTURE_REQUEST.test(pathname)) {
      const external = url.hostname === "cdn.jsdelivr.net" || url.hostname === "raw.githubusercontent.com";
      originalRequests.push({ external, url: url.href });
      if (originalMode === "fallback" && !external) {
        await route.fulfill({ status: 503, contentType: "text/plain", body: "synthetic local failure" });
      } else {
        await route.fulfill({ status: 200, contentType: "image/png", body: NEUTRAL_PNG });
      }
      return;
    }

    await route.continue();
  });
}

async function installEmptyFixture(page) {
  await page.route("**/*", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (CATALOG_REQUEST.test(pathname)) {
      await fulfillJson(route, emptyCatalog);
      return;
    }
    await route.continue();
  });
}

async function openProductionSite(page) {
  await page.goto("./", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#archiveGallery")).toHaveAttribute("aria-busy", "false");
}

async function openProductionEmptyState(page) {
  await openProductionSite(page);
  await expect(page.locator("#archiveEmptyState")).toBeVisible();
}

async function openNeutralSite(page, options = {}) {
  await installNeutralFixture(page, options);
  await page.goto("./", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#archiveGallery")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator(".archive-card.is-loaded").first()).toBeVisible();
  await expect(page.locator("#archiveEmptyState")).toBeHidden();
}

async function selectSection(page, section) {
  const button = page.locator(`.author-filter[data-author="${section.id}"]`);
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#headerAuthorName")).toHaveText(section.name);
  await expect(page.locator("#headerArchiveCount")).toHaveText(String(section.works.length));
  await expect(page.locator("#archiveGallery")).not.toHaveClass(/author-switch-(?:in|out)/);
  await expect(
    page.locator(`.archive-card[data-author="${section.id}"]:not([hidden])`),
  ).toHaveCount(section.works.length);
}

async function expectSectionAvatar(page, section) {
  const avatar = page.locator("#headerAuthorAvatar");
  await expect(avatar).toHaveAttribute("alt", `${section.name}头像`);
  await expect
    .poll(() =>
      avatar.evaluate((image, expectedPath) => {
        const current = new URL(image.currentSrc || image.src, document.baseURI);
        return (
          decodeURIComponent(current.pathname).endsWith(`/${expectedPath}`) &&
          image.complete &&
          image.naturalWidth > 0 &&
          image.naturalHeight > 0
        );
      }, section.avatar),
    )
    .toBe(true);
}

async function openNeutralCard(page, section) {
  await selectSection(page, section);
  const card = page.locator(
    `.archive-card[data-author="${section.id}"][data-work-index="0"]`,
  );
  await expect(card).toBeVisible();
  await expect(card).toHaveClass(/\bis-loaded\b/);
  const trigger = card.locator(".detail-action");
  await expect(trigger).toBeEnabled();
  await trigger.click();
  await expect(page.locator("#archiveModal")).toHaveAttribute("aria-hidden", "false");
  await expect(page.locator("#detailName")).toHaveText(section.works[0].name);
  return { card, trigger };
}

function walkFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(directory, entry.name);
    return entry.isDirectory() ? walkFiles(absolutePath) : [absolutePath];
  });
}

test("an empty catalog renders both zero-work sections without fake cards", async ({ page }) => {
  if (!productionIsEmpty) await installEmptyFixture(page);
  const emptySections = emptyCatalog.sections;
  expect(emptyCatalog.schemaVersion).toBe(1);
  expect(emptySections.map((section) => section.id)).toEqual(["fanhuafenluo", "public"]);
  expect(emptySections.every((section) => section.pinnedCount === 0)).toBe(true);
  expect(emptySections.every((section) => section.works.length === 0)).toBe(true);

  const cardFaceRequests = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (/\/assets\/previews\//i.test(url.pathname) || /\.png$/i.test(url.pathname)) {
      cardFaceRequests.push(url.href);
    }
  });
  const errorCount = observeClientErrors(page);

  await openProductionEmptyState(page);
  await expect(page.locator(".author-filter")).toHaveCount(2);
  await expect(page.locator("#archiveEmptyState h2")).toHaveText("故事尚未开始");
  await expect(page.locator("#archiveEmptyState p")).toHaveText(
    "这里暂时没有作品，新的故事会在准备好后出现",
  );
  await expect(page.locator("#status span")).toHaveText("READY · 0");

  for (const section of emptySections) {
    await selectSection(page, section);
    await expect(page.locator("#archiveEmptyState")).toBeVisible();
    await expect(page.locator(".archive-card:not([hidden])")).toHaveCount(0);
  }

  expect(cardFaceRequests).toEqual([]);
  expect(errorCount()).toBe(0);
});

test("real section avatars load and the header avatar cycles both sections", async ({ page }) => {
  expect(productionSections.map((section) => section.avatar)).toEqual([
    "assets/authors/fanhuafenluo-avatar.webp",
    "assets/authors/public.webp",
  ]);
  await openProductionSite(page);

  for (const section of productionSections) {
    await selectSection(page, section);
    await expectSectionAvatar(page, section);
  }

  const [firstSection, secondSection] = productionSections;
  await selectSection(page, firstSection);
  await page.locator("#headerAuthorCycle").click();
  await expect(
    page.locator(`.author-filter[data-author="${secondSection.id}"]`),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#headerAuthorName")).toHaveText(secondSection.name);
  await expect(page.locator("#headerArchiveCount")).toHaveText(String(secondSection.works.length));
  await expectSectionAvatar(page, secondSection);

  await page.locator("#headerAuthorCycle").click();
  await expect(
    page.locator(`.author-filter[data-author="${firstSection.id}"]`),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#headerAuthorName")).toHaveText(firstSection.name);
  await expect(page.locator("#headerArchiveCount")).toHaveText(String(firstSection.works.length));
  await expectSectionAvatar(page, firstSection);
});

test("the Pages artifact and every public repository target point at fanhuafenluo-site", async ({
  page,
}) => {
  await openProductionSite(page);

  const sourceHtml = fs.readFileSync(path.join(repositoryRoot, "index.html"), "utf8");
  const sourceApp = fs.readFileSync(path.join(repositoryRoot, "assets", "js", "app.js"), "utf8");
  expect(sourceHtml).toContain("https://hqu35785-cmyk.github.io/fanhuafenluo-site/");
  expect(sourceHtml).toContain("assets/authors/fanhuafenluo-avatar.webp");
  expect(sourceHtml).not.toMatch(/github\.io\/fanhuafenluo\//i);
  expect(sourceApp).toContain("hqu35785-cmyk/fanhuafenluo-site@");
  expect(sourceApp).toContain("hqu35785-cmyk/fanhuafenluo-site/");
  expect(sourceApp).not.toMatch(/hqu35785-cmyk\/fanhuafenluo@/i);

  const siteDirectory = path.join(repositoryRoot, "_site");
  const buildInfo = JSON.parse(fs.readFileSync(path.join(siteDirectory, "build-info.json"), "utf8"));
  const builtApp = fs.readFileSync(path.join(siteDirectory, buildInfo.files["assets/js/app.js"]), "utf8");
  const builtHtml = fs.readFileSync(path.join(siteDirectory, "index.html"), "utf8");
  expect(buildInfo.sections).toEqual(
    Object.fromEntries(productionSections.map((section) => [section.id, section.works.length])),
  );
  expect(builtApp).toContain(`ARCHIVE_COMMIT='${buildInfo.commit}'`);
  expect(builtApp).toContain("fanhuafenluo-site@${ARCHIVE_REF}/");
  expect(builtApp).toContain("fanhuafenluo-site/${ARCHIVE_REF}/");
  expect(builtHtml).toContain("https://hqu35785-cmyk.github.io/fanhuafenluo-site/");
  expect(walkFiles(siteDirectory).some((file) => /\.png$/i.test(file))).toBe(false);
});

test("a neutral routed catalog preserves both sections and all five detail views", async ({
  page,
}) => {
  const errorCount = observeClientErrors(page);
  await openNeutralSite(page);

  for (const section of neutralCatalog.sections) {
    const { trigger } = await openNeutralCard(page, section);
    const work = section.works[0];
    const detail = neutralDetails[section.id][work.image];
    await expect(page.locator("#detailImage")).toHaveClass(/\bis-ready\b/);

    for (const key of ["intro", "opening", "setting", "worldbook", "preset"]) {
      const tab = page.locator(`[data-detail-tab="${key}"]`);
      await tab.click();
      await expect(tab).toHaveAttribute("aria-selected", "true");
      await expect(page.locator("#detailPanelBody")).toHaveText(expectedDetailText(detail, key));
    }

    const introLength = visibleLength(detail.intro);
    expect(introLength).toBeGreaterThanOrEqual(120);
    expect(introLength).toBeLessThanOrEqual(180);
    await page.locator("#archiveModalClose").click();
    await expect(page.locator("#archiveModal")).toHaveAttribute("aria-hidden", "true");
    await expect(trigger).toBeFocused();
  }

  expect(errorCount()).toBe(0);
});

test("neutral previews stay on the Pages origin", async ({ page }) => {
  const applicationUrls = [];
  page.on("request", (request) => {
    const url = request.url();
    if (/\/src\/data\/|\/assets\/previews\//i.test(url)) applicationUrls.push(url);
  });

  await openNeutralSite(page);
  for (const section of neutralCatalog.sections) await selectSection(page, section);

  const origin = new URL(page.url()).origin;
  expect(applicationUrls.length).toBeGreaterThan(0);
  expect(applicationUrls.every((url) => new URL(url).origin === origin)).toBe(true);
  expect(applicationUrls.every((url) => !/fanhuafenluo-pages/i.test(url))).toBe(true);
});

test("PNG fallback uses the new repository at the immutable deployed commit", async ({ page }) => {
  const originalRequests = [];
  await openNeutralSite(page, { originalMode: "fallback", originalRequests });
  const section = neutralCatalog.sections[0];
  await selectSection(page, section);

  await page.locator(".archive-card:not([hidden]) .download-action").click();
  const saveLink = page.locator("#saveSheetLink");
  await expect(saveLink).toHaveAttribute("href", /^blob:/);

  const external = originalRequests.find((request) => request.external);
  expect(originalRequests.some((request) => !request.external)).toBe(true);
  expect(external?.url).toMatch(
    /^https:\/\/cdn\.jsdelivr\.net\/gh\/hqu35785-cmyk\/fanhuafenluo-site@[0-9a-f]{40}\/assets\/cards\/fixtures\/neutral-a\.png$/i,
  );
  expect(external?.url).not.toContain("fanhuafenluo-pages");

  await page.locator("#saveSheetClose").click();
  await expect(page.locator("#saveSheet")).toHaveAttribute("aria-hidden", "true");
});

test("local save preserves the exact neutral PNG bytes", async ({ page }) => {
  const originalRequests = [];
  await openNeutralSite(page, { originalRequests });
  await selectSection(page, neutralCatalog.sections[0]);

  await page.locator(".archive-card:not([hidden]) .download-action").click();
  const saveLink = page.locator("#saveSheetLink");
  await expect(saveLink).toHaveAttribute("href", /^blob:/);
  const saved = await saveLink.evaluate(async (link) => {
    const bytes = await (await fetch(link.href)).arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return {
      bytes: bytes.byteLength,
      sha256: [...new Uint8Array(digest)]
        .map((value) => value.toString(16).padStart(2, "0"))
        .join(""),
    };
  });

  expect(saved.bytes).toBe(NEUTRAL_PNG.length);
  expect(saved.sha256).toBe(createHash("sha256").update(NEUTRAL_PNG).digest("hex"));
  expect(originalRequests.filter((request) => request.external)).toEqual([]);

  await page.locator("#saveSheetClose").click();
  await expect(page.locator("#saveSheet")).toHaveAttribute("aria-hidden", "true");
});

test("the empty state and neutral detail reader stay inside a mobile viewport", async ({ page }) => {
  test.skip(!productionIsEmpty, "The production catalog now has cards; mobile card layout is covered by the neutral fixture.");
  await page.setViewportSize({ width: 390, height: 844 });
  await openProductionEmptyState(page);
  const emptyRect = await page.locator("#archiveEmptyState").boundingBox();
  expect(emptyRect.x).toBeGreaterThanOrEqual(-1);
  expect(emptyRect.x + emptyRect.width).toBeLessThanOrEqual(391);

  await installNeutralFixture(page);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator(".archive-card.is-loaded").first()).toBeVisible();
  await openNeutralCard(page, neutralCatalog.sections[0]);
  const modalFits = await page.locator(".archive-modal-panel").evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return rect.left >= -1 && rect.right <= window.innerWidth + 1;
  });
  expect(modalFits).toBe(true);

  const presetTab = page.locator('[data-detail-tab="preset"]');
  await presetTab.click();
  await expect(presetTab).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});

test.describe("reduced motion", () => {
  test.use({ reducedMotion: "reduce" });

  test("keeps the empty and neutral-card interactions functional", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openProductionSite(page);
    expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
    if (productionIsEmpty) await expect(page.locator("#archiveEmptyState")).toBeVisible();

    await installNeutralFixture(page);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator(".archive-card.is-loaded").first()).toBeVisible();
    await page.waitForTimeout(250);
    const infiniteAnimations = await page.evaluate(() =>
      document
        .getAnimations()
        .filter(
          (animation) =>
            animation.playState === "running" &&
            animation.effect?.getTiming().iterations === Infinity,
        ).length,
    );
    expect(infiniteAnimations).toBe(0);

    await openNeutralCard(page, neutralCatalog.sections[0]);
    await page.keyboard.press("Escape");
    await expect(page.locator("#archiveModal")).toHaveAttribute("aria-hidden", "true");
  });
});

test("retry recovers from a catalog failure into the real empty state", async ({ page }) => {
  let catalogRequests = 0;
  await page.route("**/*", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (!CATALOG_REQUEST.test(pathname)) {
      await route.continue();
      return;
    }
    catalogRequests += 1;
    if (catalogRequests === 1) {
      await route.fulfill({
        status: 503,
        contentType: "text/plain; charset=utf-8",
        body: "temporarily unavailable",
      });
      return;
    }
    await route.continue();
  });

  await page.goto("./", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#statusRetry")).toBeVisible();
  await expect(page.locator("#status")).toHaveClass(/\bis-error\b/);
  await expect(page.locator("#archiveEmptyState")).toBeHidden();
  await page.locator("#statusRetry").click();

  await expect(page.locator("#archiveGallery")).toHaveAttribute("aria-busy", "false");
  if (productionIsEmpty) {
    await expect(page.locator("#archiveEmptyState")).toBeVisible();
    await expect(page.locator(".archive-card:not([hidden])")).toHaveCount(0);
  } else {
    await expect(page.locator(".archive-card.is-loaded").first()).toBeVisible();
  }
  expect(catalogRequests).toBe(2);
});
