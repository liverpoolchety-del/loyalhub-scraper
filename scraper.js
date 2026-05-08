const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const OUTPUT_PATH = path.join(__dirname, "brochures.json");

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ---------------------------------------------------------------------------
// Scrape all pages of a single brochure from leaflets.kaufland.com
// ---------------------------------------------------------------------------
async function scrapeKauflandBrochurePages(context, brochureUrl) {
  const page = await context.newPage();
  const pageImages = [];

  try {
    log(`  Fetching brochure: ${brochureUrl}`);

    // Intercept all image responses — brochure pages are large JPGs
    const captured = new Set();
    page.on("response", async (response) => {
      const url = response.url();
      const type = response.headers()["content-type"] || "";
      if (type.startsWith("image/") || url.match(/\.(jpg|jpeg|png|webp)(\?|$)/i)) {
        try {
          const buf = await response.body();
          if (buf.length > 80000) { // > 80KB = real brochure page
            captured.add(url);
          }
        } catch {}
      }
    });

    await page.goto(brochureUrl, { waitUntil: "networkidle", timeout: 45000 });

    // Scroll through the page to trigger lazy-loaded images
    await page.evaluate(async () => {
      for (let i = 0; i < 10; i++) {
        window.scrollBy(0, window.innerHeight);
        await new Promise(r => setTimeout(r, 500));
      }
    });

    await page.waitForTimeout(2000);

    // Also grab images from DOM
    const domImages = await page.evaluate(() =>
      Array.from(document.querySelectorAll("img"))
        .map(img => img.src || img.getAttribute("data-src") || "")
        .filter(src => src.startsWith("http"))
    );

    // Combine network-captured + DOM images, filter for large brochure pages
    const all = [...new Set([...captured, ...domImages])];

    // Filter: keep only high-res images (rs:fit:1200 in URL = Kaufland's page format)
    const brochurePages = all.filter(url =>
      url.includes("rs:fit:1200") ||
      url.includes("imgproxy.leaflets") ||
      url.match(/page-\d+/i)
    );

    // Fallback: if no filtered results, use all large images
    const finalPages = brochurePages.length > 0 ? brochurePages : all.filter(u => captured.has(u));
    finalPages.sort(); // Sort so pages are in order

    pageImages.push(...finalPages);
    log(`  Got ${pageImages.length} pages`);
  } catch (err) {
    log(`  Error: ${err.message}`);
  } finally {
    await page.close();
  }

  return pageImages;
}

// ---------------------------------------------------------------------------
// Scrape Kaufland BG — get ALL brochures
// ---------------------------------------------------------------------------
async function scrapeKaufland(context) {
  log("Scraping Kaufland BG...");
  const page = await context.newPage();

  try {
    await page.goto("https://www.kaufland.bg/broshuri.html", {
      waitUntil: "networkidle",
      timeout: 45000,
    });

    // Wait for brochure cards to render
    await page.waitForTimeout(3000);

    // Scroll to load all brochures
    await page.evaluate(async () => {
      for (let i = 0; i < 5; i++) {
        window.scrollBy(0, window.innerHeight);
        await new Promise(r => setTimeout(r, 800));
      }
    });

    await page.waitForTimeout(2000);

    // Extract ALL brochure links and metadata
    const brochures = await page.evaluate(() => {
      const results = [];
      const seen = new Set();

      // Kaufland renders brochures as links to leaflets.kaufland.com
      const allLinks = Array.from(document.querySelectorAll("a[href]"));
      for (const link of allLinks) {
        const href = link.href || "";
        if (!href.includes("leaflets.kaufland.com") && !href.includes("kaufland.com/bg")) continue;
        if (seen.has(href)) continue;
        seen.add(href);

        // Find the thumbnail image
        const img = link.querySelector("img") ||
                    link.closest("[class*='leaflet'], [class*='brochure'], article")?.querySelector("img");

        // Find validity dates in surrounding text
        const container = link.closest("[class*='leaflet'], [class*='brochure'], [class*='item'], article, li") || link.parentElement;
        const text = container?.innerText || "";
        const dateMatch = text.match(/(\d{2}\.\d{2}\.\d{4})\s*[–\-—]\s*(\d{2}\.\d{2}\.\d{4})/);
        const titleMatch = text.match(/[A-ZАÁБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЬЮЯA-z]{3,}/);

        results.push({
          url: href,
          thumbnail: img?.src || img?.getAttribute("data-src") || "",
          title: img?.alt || container?.querySelector("h2, h3, h4, [class*='title']")?.innerText || "Kaufland брошура",
          validFrom: dateMatch?.[1] || "",
          validTo: dateMatch?.[2] || "",
        });
      }

      // Also check for data attributes with brochure info
      document.querySelectorAll("[data-href], [data-url]").forEach(el => {
        const href = el.getAttribute("data-href") || el.getAttribute("data-url") || "";
        if (href.includes("leaflets") && !seen.has(href)) {
          seen.add(href);
          const img = el.querySelector("img");
          results.push({
            url: href,
            thumbnail: img?.src || "",
            title: img?.alt || "Kaufland брошура",
            validFrom: "",
            validTo: "",
          });
        }
      });

      return results;
    });

    log(`Kaufland: found ${brochures.length} brochures on listing page`);
    await page.close();

    // Now scrape pages for each brochure (limit to 6 brochures max)
    const enriched = [];
    for (const b of brochures.slice(0, 6)) {
      const pages = await scrapeKauflandBrochurePages(context, b.url);
      enriched.push({
        store: "Kaufland",
        title: b.title,
        thumbnail: b.thumbnail || (pages[0] || ""),
        url: b.url,
        validFrom: b.validFrom,
        validTo: b.validTo,
        pages,
      });
    }

    log(`Kaufland: enriched ${enriched.length} brochures with pages`);
    return enriched;
  } catch (err) {
    log(`Kaufland error: ${err.message}`);
    await page.close().catch(() => {});
    return [];
  }
}

// ---------------------------------------------------------------------------
// Scrape Lidl BG
// ---------------------------------------------------------------------------
async function scrapeLidl(context) {
  log("Scraping Lidl BG...");
  const page = await context.newPage();

  try {
    await page.goto("https://www.lidl.bg/c/broshurite-na-lidl/s10017542", {
      waitUntil: "networkidle",
      timeout: 45000,
    });

    await page.waitForTimeout(3000);

    await page.evaluate(async () => {
      for (let i = 0; i < 5; i++) {
        window.scrollBy(0, window.innerHeight);
        await new Promise(r => setTimeout(r, 800));
      }
    });

    await page.waitForTimeout(2000);

    const brochures = await page.evaluate(() => {
      const results = [];
      const seen = new Set();

      const allLinks = Array.from(document.querySelectorAll("a[href]"));
      for (const link of allLinks) {
        const href = link.href || "";
        // Lidl brochure links typically include these patterns
        if (!href.match(/leaflet|brochure|broshu|flyer|katalog|folder/i) && !href.includes("lidl.bg/p")) continue;
        if (seen.has(href) || href === window.location.href) continue;
        seen.add(href);

        const img = link.querySelector("img") ||
                    link.closest("article, li, [class*='item']")?.querySelector("img");
        const container = link.closest("article, li, [class*='item'], [class*='card']") || link.parentElement;
        const text = container?.innerText || "";
        const dateMatch = text.match(/(\d{2}\.\d{2}\.\d{4})\s*[–\-—]\s*(\d{2}\.\d{2}\.\d{4})/);

        results.push({
          url: href,
          thumbnail: img?.src || img?.getAttribute("data-src") || "",
          title: img?.alt || container?.querySelector("h2,h3,[class*='title']")?.innerText || "Lidl брошура",
          validFrom: dateMatch?.[1] || "",
          validTo: dateMatch?.[2] || "",
        });
      }

      return results;
    });

    log(`Lidl: found ${brochures.length} brochures on listing page`);
    await page.close();

    const enriched = [];
    for (const b of brochures.slice(0, 4)) {
      const pages = await scrapeLidlBrochurePages(context, b.url);
      enriched.push({
        store: "Lidl",
        title: b.title,
        thumbnail: b.thumbnail || (pages[0] || ""),
        url: b.url,
        validFrom: b.validFrom,
        validTo: b.validTo,
        pages,
      });
    }

    log(`Lidl: enriched ${enriched.length} brochures`);
    return enriched;
  } catch (err) {
    log(`Lidl error: ${err.message}`);
    await page.close().catch(() => {});
    return [];
  }
}

// ---------------------------------------------------------------------------
// Scrape Lidl brochure pages
// ---------------------------------------------------------------------------
async function scrapeLidlBrochurePages(context, brochureUrl) {
  const page = await context.newPage();
  const pageImages = [];

  try {
    log(`  Fetching Lidl brochure: ${brochureUrl}`);
    const captured = new Set();

    page.on("response", async (response) => {
      const url = response.url();
      const type = response.headers()["content-type"] || "";
      if (type.startsWith("image/")) {
        try {
          const buf = await response.body();
          if (buf.length > 80000) captured.add(url);
        } catch {}
      }
    });

    await page.goto(brochureUrl, { waitUntil: "networkidle", timeout: 45000 });
    await page.waitForTimeout(2000);

    await page.evaluate(async () => {
      for (let i = 0; i < 8; i++) {
        window.scrollBy(0, window.innerHeight);
        await new Promise(r => setTimeout(r, 600));
      }
    });

    await page.waitForTimeout(2000);

    const domImages = await page.evaluate(() =>
      Array.from(document.querySelectorAll("img"))
        .map(img => img.src || img.getAttribute("data-src") || "")
        .filter(src => src.startsWith("http"))
    );

    const all = [...new Set([...captured, ...domImages])];
    all.sort();
    pageImages.push(...all.slice(0, 30));
    log(`  Got ${pageImages.length} Lidl pages`);
  } catch (err) {
    log(`  Lidl page error: ${err.message}`);
  } finally {
    await page.close();
  }

  return pageImages;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  log("=== Starting LoyalHub Brochure Scraper ===");

  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
    ],
  });

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    locale: "bg-BG",
    viewport: { width: 1440, height: 900 },
    extraHTTPHeaders: {
      "Accept-Language": "bg-BG,bg;q=0.9,en-US;q=0.8",
    },
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    window.chrome = { runtime: {} };
  });

  try {
    // Run both scrapers
    const [kauflandResult, lidlResult] = await Promise.allSettled([
      scrapeKaufland(context),
      scrapeLidl(context),
    ]);

    const kaufland = kauflandResult.status === "fulfilled" ? kauflandResult.value : [];
    const lidl = lidlResult.status === "fulfilled" ? lidlResult.value : [];

    // Load existing data to merge/keep if scrape found nothing
    let existing = { stores: { kaufland: [], lidl: [] } };
    if (fs.existsSync(OUTPUT_PATH)) {
      try { existing = JSON.parse(fs.readFileSync(OUTPUT_PATH, "utf8")); } catch {}
    }

    const result = {
      updatedAt: new Date().toISOString(),
      date: new Date().toISOString().split("T")[0],
      stores: {
        kaufland: kaufland.length > 0 ? kaufland : existing.stores.kaufland,
        lidl: lidl.length > 0 ? lidl : existing.stores.lidl,
      },
    };

    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(result, null, 2));
    log(`✅ Done — Kaufland: ${result.stores.kaufland.length} brochures, Lidl: ${result.stores.lidl.length} brochures`);

    // Log page counts
    result.stores.kaufland.forEach((b, i) => log(`  Kaufland[${i}] "${b.title}": ${b.pages.length} pages`));
    result.stores.lidl.forEach((b, i) => log(`  Lidl[${i}] "${b.title}": ${b.pages.length} pages`));
  } finally {
    await browser.close();
  }
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});