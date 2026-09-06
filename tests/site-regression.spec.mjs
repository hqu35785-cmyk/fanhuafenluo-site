import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, "..");
const catalogPath = path.join(repositoryRoot, "src", "data", "catalog.json");
const detailPaths = {
  fanhuafenluo: path.join(repositoryRoot, "src", "data", "details-fanhua.json"),
  public: path.join(repositoryRoot, "src", "data", "details-public.json"),
};

function readCatalog() {
  const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  if (catalog?.schemaVersion !== 1 || !Array.isArray(catalog?.sections)) {
    throw new Error("src/data/catalog.json does not match schemaVersion 1");
  }
  return catalog;
}

const catalog = readCatalog();
const sections = catalog.sections;
const sectionById = new Map(sections.map((section) => [section.id, section]));
const detailsBySection = new Map(
  Object.entries(detailPaths).map(([sectionId, detailPath]) => [
    sectionId,
    JSON.parse(fs.readFileSync(detailPath, "utf8")),
  ]),
);

function visibleLength(value) {
  return Array.from(String(value || "").replace(/\s/g, "")).length;
}

function originalCardPath(work) {
  const relativePath = decodeURIComponent(
    new URL(String(work.image || ""), "http://test.local/").pathname,
  )
    .replace(/^\/+/, "")
    .replaceAll("/", path.sep);
  const assetsRoot = path.join(repositoryRoot, "assets");
  const absolutePath = path.resolve(repositoryRoot, relativePath);
  const relativeToAssets = path.relative(assetsRoot, absolutePath);
  if (
    relativeToAssets.startsWith("..") ||
    path.isAbsolute(relativeToAssets) ||
    path.extname(absolutePath).toLowerCase() !== ".png"
  ) {
    throw new Error("Catalog image is not a repository PNG asset");
  }
  return absolutePath;
}

function expectedDetailText(work, key) {
  if (key === "intro") return work.intro || "该角色卡暂未提供简介。";
  if (key === "opening") return work.opening || "该角色卡未提供开场白。";
  if (key === "worldbook") return work.worldbook || "该角色卡未附带世界书。";
  if (key === "preset") return work.preset || "该角色卡未附带预设。";
  if (key === "setting") {
    const parts = [];
    if (work.personality) parts.push(`【性格设定】\n${work.personality}`);
    if (work.setting) parts.push(`【场景设定】\n${work.setting}`);
    return parts.join("\n\n") || "该角色卡未提供人物设定。";
  }
  throw new Error(`Unsupported detail key: ${key}`);
}

function firstSafeWork(section) {
  const index = section.works.findIndex((work) => work.sensitive !== true);
  const safeIndex = index >= 0 ? index : 0;
  const catalogWork = section.works[safeIndex];
  const detailKey = catalogWork._detailKey || catalogWork.image;
  const work = {
    ...catalogWork,
    ...(detailsBySection.get(section.id)?.[detailKey] || {}),
  };
  return { index: safeIndex, work };
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

async function openSite(page) {
  await page.goto("./", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#archiveGallery")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator(".archive-card.is-loaded").first()).toBeVisible();
}

async function selectSection(page, section) {
  const button = page.locator(`.author-filter[data-author="${section.id}"]`);
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");

  const visibleCards = page.locator(
    `.archive-card[data-author="${section.id}"]:not([hidden])`,
  );
  await expect(visibleCards).toHaveCount(section.works.length);
  await expect(page.locator("#archiveGallery")).not.toHaveClass(/author-switch-(?:in|out)/);

  const headerMatches = await page.locator("#headerAuthorName").evaluate(
    (element, expected) => element.textContent.trim() === expected,
    section.name,
  );
  expect(headerMatches).toBe(true);

  const countMatches = await page.locator("#headerArchiveCount").evaluate(
    (element, expected) => element.textContent.trim() === String(expected),
    section.works.length,
  );
  expect(countMatches).toBe(true);
}

async function openValidationWork(page, section) {
  await selectSection(page, section);
  const { index, work } = firstSafeWork(section);
  const card = page.locator(
    `.archive-card[data-author="${section.id}"][data-work-index="${index}"]`,
  );
  await expect(card).toBeVisible();
  await expect(card).toHaveClass(/\bis-loaded\b/);

  const trigger = card.locator(".detail-action");
  await expect(trigger).toBeEnabled();
  await trigger.click();
  await expect(page.locator("#archiveModal")).toHaveAttribute("aria-hidden", "false");

  const nameMatches = await page.locator("#detailName").evaluate(
    (element, expected) => element.textContent === expected,
    work.name,
  );
  expect(nameMatches).toBe(true);

  return { card, trigger, work };
}

test("renders both catalog sections with data-derived counts", async ({ page }) => {
  expect(sections.map((section) => section.id)).toEqual(["fanhuafenluo", "public"]);
  expect(sections.every((section) => section.works.length > 0)).toBe(true);

  const errorCount = observeClientErrors(page);
  await openSite(page);
  await expect(page.locator(".author-filter")).toHaveCount(2);

  for (const section of sections) {
    await selectSection(page, section);
    await expect(
      page.locator(
        `.archive-card[data-author="${section.id}"]:not([hidden]).is-loaded`,
      ).first(),
    ).toBeVisible();
  }

  expect(errorCount()).toBe(0);
});

test("loads all five detail views and closes without exposing fixture text", async ({ page }) => {
  const errorCount = observeClientErrors(page);
  await openSite(page);

  for (const section of sections) {
    const { trigger, work } = await openValidationWork(page, section);
    const detailImage = page.locator("#detailImage");
    await expect(detailImage).toHaveClass(/\bis-ready\b/);

    const previewIsLocal = await detailImage.evaluate((image) => {
      const url = new URL(image.currentSrc || image.src, window.location.href);
      return url.origin === window.location.origin && /\.webp(?:$|\?)/i.test(url.href);
    });
    expect(previewIsLocal).toBe(true);

    for (const key of ["intro", "opening", "setting", "worldbook", "preset"]) {
      const tab = page.locator(`[data-detail-tab="${key}"]`);
      await tab.click();
      await expect(tab).toHaveAttribute("aria-selected", "true");

      const expected = expectedDetailText(work, key);
      await expect
        .poll(() =>
          page.locator("#detailPanelBody").evaluate(
            (element, expectedText) => element.textContent === expectedText,
            expected,
          ),
        )
        .toBe(true);

      if (key === "intro") {
        const actualLength = await page.locator("#detailPanelBody").evaluate(
          (element) => Array.from(element.textContent.replace(/\s/g, "")).length,
        );
        expect(actualLength === visibleLength(expected)).toBe(true);
        expect(actualLength >= 120 && actualLength <= 180).toBe(true);
      }
    }

    await page.locator("#archiveModalClose").click();
    await expect(page.locator("#archiveModal")).toHaveAttribute("aria-hidden", "true");
    await expect(trigger).toBeFocused();
  }

  expect(errorCount()).toBe(0);
});

test("loads previews from this Pages origin and has no legacy repository dependency", async ({ page }) => {
  const applicationUrls = [];
  page.on("request", (request) => {
    const url = request.url();
    if (
      /^https?:/i.test(url) &&
      (/\/src\/data\//i.test(url) ||
        /\/assets\/js\//i.test(url) ||
        /\/assets\/previews\//i.test(url))
    ) {
      applicationUrls.push(url);
    }
  });

  await openSite(page);
  await expect(page.locator(".archive-card.is-loaded .loaded-card-image").first()).toBeVisible();

  const currentOrigin = new URL(page.url()).origin;
  expect(applicationUrls.length > 0).toBe(true);
  expect(applicationUrls.every((url) => new URL(url).origin === currentOrigin)).toBe(true);
  expect(applicationUrls.every((url) => !url.includes("fanhuafenluo-pages"))).toBe(true);

  const previewSourcesAreLocal = await page
    .locator(".archive-card:not([hidden]) .loaded-card-image[src]")
    .evaluateAll((images) =>
      images.every((image) => {
        const url = new URL(image.currentSrc || image.src, window.location.href);
        return url.origin === window.location.origin;
      }),
    );
  expect(previewSourcesAreLocal).toBe(true);

  const repositorySourceText = [
    fs.readFileSync(path.join(repositoryRoot, "index.html"), "utf8"),
    fs.readFileSync(path.join(repositoryRoot, "assets", "js", "app.js"), "utf8"),
    fs.readFileSync(catalogPath, "utf8"),
  ].join("\n");
  expect(repositorySourceText.includes("fanhuafenluo-pages")).toBe(false);

  const buildInfo = JSON.parse(
    fs.readFileSync(path.join(repositoryRoot, "_site", "build-info.json"), "utf8"),
  );
  const builtAppRelativePath = buildInfo.files?.["assets/js/app.js"];
  expect(typeof builtAppRelativePath === "string").toBe(true);
  const builtAppSource = fs.readFileSync(
    path.join(repositoryRoot, "_site", builtAppRelativePath),
    "utf8",
  );
  expect(builtAppSource.includes("fanhuafenluo-pages")).toBe(false);
  expect(builtAppSource.includes("hqu35785-cmyk/fanhuafenluo")).toBe(true);
  expect(/fanhuafenluo@main\//i.test(builtAppSource)).toBe(false);
  expect(
    /const\s+[A-Z_]*(?:COMMIT|REVISION)[A-Z_]*\s*=\s*["'][0-9a-f]{40}["']/i.test(
      builtAppSource,
    ),
  ).toBe(true);

  for (const section of sections) {
    const { work } = firstSafeWork(section);
    const pngUrl = new URL(work.image, page.url());
    expect(pngUrl.origin === currentOrigin).toBe(true);
    expect(pngUrl.pathname.startsWith("/assets/") && pngUrl.pathname.endsWith(".png")).toBe(true);
  }
});

test("uses an immutable single-repository fallback for PNG download", async ({ page }) => {
  await openSite(page);
  const section = sectionById.get("fanhuafenluo");
  await selectSection(page, section);
  const { index, work } = firstSafeWork(section);
  const card = page.locator(
    `.archive-card[data-author="${section.id}"][data-work-index="${index}"]`,
  );
  await expect(card).toHaveClass(/\bis-loaded\b/);

  const localOrigin = new URL(page.url()).origin;
  const originalPathname = new URL(work.image, page.url()).pathname;
  let fallbackUrl = "";
  const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  await page.route("**/*", async (route) => {
    const requestUrl = new URL(route.request().url());
    if (!requestUrl.pathname.endsWith(originalPathname)) {
      await route.continue();
      return;
    }
    if (requestUrl.origin === localOrigin) {
      await route.fulfill({ status: 503, body: "local test failure" });
      return;
    }
    fallbackUrl = requestUrl.href;
    await route.fulfill({
      status: 200,
      contentType: "image/png",
      body: pngSignature,
    });
  });

  await card.locator(".download-action").click();
  await expect(page.locator("#saveSheet")).toHaveAttribute("aria-hidden", "false");
  await expect(page.locator("#saveSheet")).toHaveClass(/\bis-ready\b/);

  expect(
    /^https:\/\/cdn\.jsdelivr\.net\/gh\/hqu35785-cmyk\/fanhuafenluo@[0-9a-f]{40}\/assets\/.+\.png$/i.test(
      fallbackUrl,
    ),
  ).toBe(true);
  expect(fallbackUrl.includes("fanhuafenluo-pages")).toBe(false);

  await page.locator("#saveSheetClose").click();
  await expect(page.locator("#saveSheet")).toHaveAttribute("aria-hidden", "true");
});

test("preserves the exact original PNG in the local save flow", async ({ page }) => {
  const externalPngRequests = [];
  page.on("request", (request) => {
    const url = request.url();
    if (/^https?:/i.test(url) && /\.png(?:$|\?)/i.test(url)) {
      if (new URL(url).origin !== new URL(page.url()).origin) {
        externalPngRequests.push(url);
      }
    }
  });

  await openSite(page);
  const section = sectionById.get("fanhuafenluo");
  await selectSection(page, section);
  const { index, work } = firstSafeWork(section);
  const card = page.locator(
    `.archive-card[data-author="${section.id}"][data-work-index="${index}"]`,
  );
  await expect(card).toHaveClass(/\bis-loaded\b/);

  const sourceBytes = fs.readFileSync(originalCardPath(work));
  const expectedHash = createHash("sha256").update(sourceBytes).digest("hex");

  await card.locator(".download-action").click();
  await expect(page.locator("#saveSheet")).toHaveAttribute("aria-hidden", "false");
  const saveLink = page.locator("#saveSheetLink");
  await expect(saveLink).toHaveAttribute("href", /^blob:/);

  const saved = await saveLink.evaluate(async (link) => {
    const response = await fetch(link.href);
    const bytes = await response.arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return {
      bytes: bytes.byteLength,
      sha256: [...new Uint8Array(digest)]
        .map((value) => value.toString(16).padStart(2, "0"))
        .join(""),
    };
  });

  expect(saved.bytes === sourceBytes.length).toBe(true);
  expect(saved.sha256 === expectedHash).toBe(true);
  expect(externalPngRequests.length).toBe(0);

  await page.locator("#saveSheetClose").click();
  await expect(page.locator("#saveSheet")).toHaveAttribute("aria-hidden", "true");
});

test("keeps the mobile gallery and detail reader inside the viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openSite(page);

  for (const section of sections) {
    await selectSection(page, section);
    const pageFits = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    );
    expect(pageFits).toBe(true);
  }

  const section = sectionById.get("fanhuafenluo");
  const { work } = await openValidationWork(page, section);
  const modalFits = await page.locator(".archive-modal-panel").evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return rect.left >= -1 && rect.right <= window.innerWidth + 1;
  });
  expect(modalFits).toBe(true);

  const presetTab = page.locator('[data-detail-tab="preset"]');
  await presetTab.click();
  await expect(presetTab).toHaveAttribute("aria-selected", "true");
  await expect(presetTab).toBeInViewport();
  await expect
    .poll(() =>
      page.locator("#detailPanelBody").evaluate(
        (element, expectedText) => element.textContent === expectedText,
        expectedDetailText(work, "preset"),
      ),
    )
    .toBe(true);

  const modalStillFits = await page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth + 1,
  );
  expect(modalStillFits).toBe(true);

  await page.keyboard.press("Escape");
  await expect(page.locator("#archiveModal")).toHaveAttribute("aria-hidden", "true");
});

test.describe("reduced motion", () => {
  test.use({ reducedMotion: "reduce" });

  test("honors the operating-system preference without breaking interaction", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openSite(page);
    expect(
      await page.evaluate(() =>
        window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      ),
    ).toBe(true);

    const supportIsLoaded = await page.evaluate(() =>
      [...document.styleSheets].some((sheet) => {
        try {
          return [...sheet.cssRules].some(
            (rule) =>
              rule instanceof CSSMediaRule &&
              rule.conditionText.includes("prefers-reduced-motion") &&
              rule.conditionText.includes("reduce"),
          );
        } catch {
          return false;
        }
      }),
    );
    expect(supportIsLoaded).toBe(true);

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

    const section = sectionById.get("fanhuafenluo");
    await openValidationWork(page, section);
    await page.keyboard.press("Escape");
    await expect(page.locator("#archiveModal")).toHaveAttribute("aria-hidden", "true");
  });
});

test("offers a working retry after the catalog request fails", async ({ page }) => {
  let catalogRequests = 0;
  await page.route(/\/src\/data\/catalog(?:\.[0-9a-f]{16})?\.json(?:\?.*)?$/i, async (route) => {
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
  await page.locator("#statusRetry").click();

  await expect(page.locator("#archiveGallery")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator(".archive-card.is-loaded").first()).toBeVisible();
  expect(catalogRequests).toBe(2);
});
