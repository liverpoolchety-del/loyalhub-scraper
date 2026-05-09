const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const OUTPUT_PATH = path.join(__dirname, "brochures.json");

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ---------------------------------------------------------------------------
// Scrape all pages of a Kaufland brochure by clicking through the viewer
// ---------------------------------------------------------------------------
async function scrapeKauflandPages(context, brochureUrl) {
  const page = await context.newPage();
  const pageImages = [];
  const seen = new Set();

  try {
    log(`  Opening brochure: ${brochureUrl}`);

    // Capture all high-res brochure page images from network
    page.on("response", async (response) => {
      const url = response.url();
      if (
        url.includes("imgproxy.leaflets.schwarz") &&
        url.includes("rs:fit:1200") &&
        !seen.has(url)
      ) {
        try {
          const buf = await response.body();
          if (buf.length > 80000) {
            seen.add(url);
            pageImages.push(url);
            log(`    Captured page image ${pageImages.length}: ${url.substring(0, 80)}...`);
          }
        } catch {}
      }
    });

    await page.goto(brochureUrl, { waitUntil: "networkidle", timeout: 45000 });
    await page.waitForTimeout(3000);

    // Find the total page count from the viewer
    const totalPages = await page.evaluate(() => {
      // Look for page counter text like "1 / 24"
      const counters = Array.from(document.querySelectorAll("*"))
        .filter(el => el.childElementCount === 0 && /^\d+\s*\/\s*\d+$/.test(el.textContent?.trim() || ""));
      if (counters.length > 0) {
        const match = counters[0].textContent.match(/\d+\s*\/\s*(\d+)/);
        return match ? parseInt(match[1]) : 0;
      }
      return 0;
    });

    log(`  Total pages detected: ${totalPages}`);

    // Click through pages using the next button or arrow key
    const maxPages = totalPages > 0 ? Math.min(totalPages, 40) : 30;

    for (let p = 0; p < maxPages; p++) {
      // Try multiple ways to go to next page
      const advanced = await page.evaluate(() => {
        // Try clicking next button
        const nextSelectors = [
          '[aria-label*="next" i]',
          '[aria-label*="Next" i]',
          '[class*="next"]',
          '[class*="arrow-right"]',
          '[class*="arrow_right"]',
          'button[class*="right"]',
          '.flipbook-next',
          '[data-direction="right"]',
        ];
        for (const sel of nextSelectors) {
          const btn = document.querySelector(sel);
          if (btn) {
            btn.click();
            return true;
          }
        }
        return false;
      });

      if (!advanced) {
        // Fall back to pressing ArrowRight
        await page.keyboard.press("ArrowRight");
      }

      await page.waitForTimeout(1500); // Wait for next page image to load
    }

    // After clicking through, also scroll the page to trigger any remaining lazy loads
    await page.evaluate(async () => {
      for (let i = 0; i < 5; i++) {
        window.scrollBy(0, window.innerHeight);
        await new Promise(r => setTimeout(r, 400));
      }
    });

    await page.waitForTimeout(2000);

    log(`  Got ${pageImages.length} pages from ${brochureUrl}`);
  } catch (err) {
    log(`  Error scraping pages: ${err.message}`);
  } finally {
    await page.close();
  }

  return pageImages;
}

// ---------------------------------------------------------------------------
// Scrape Lidl brochure pages using same click-through approach
// ---------------------------------------------------------------------------
async function scrapeLidlPages(context, brochureUrl) {
  const page = await context.newPage();
  const pageImages = [];
  const seen = new Set();

  try {
    log(`  Opening Lidl brochure: ${brochureUrl}`);

    page.on("response", async (response) => {
      const url = response.url();
      if (
        url.includes("imgproxy.leaflets.schwarz") &&
        (url.includes("rs:fit:1200") || url.includes("rs:fit:400")) &&
        !seen.has(url)
      ) {
        try {
          const buf = await response.body();
          if (buf.length > 50000) {
            seen.add(url);
            // Upgrade 400px to 1200px if possible
            const hiRes = url.replace("rs:fit:400:400", "rs:fit:1200:1200");
            pageImages.push(hiRes !== url ? hiRes : url);
          }
        } catch {}
      }
    });

    await page.goto(brochureUrl, { waitUntil: "networkidle", timeout: 45000 });
    await page.waitForTimeout(3000);

    for (let p = 0; p < 40; p++) {
      await page.keyboard.press("ArrowRight");
      await page.waitForTimeout(1200);
    }

    await page.waitForTimeout(2000);
    log(`  Got ${pageImages.length} Lidl pages`);
  } catch (err) {
    log(`  Lidl page error: ${err.message}`);
  } finally {
    await page.close();
  }

  return pageImages;
}

// ---------------------------------------------------------------------------
// Scrape Kaufland brochure listing page
// ---------------------------------------------------------------------------
async function scrapeKaufland(context) {
  log("Scraping Kaufland BG listing...");
  const page = await context.newPage();

  try {
    await page.goto("https://www.kaufland.bg/broshuri.html", {
      waitUntil: "networkidle",
      timeout: 45000,
    });

    await page.waitForTimeout(3000);

    // Scroll to load all brochures
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight));
      await page.waitForTimeout(600);
    }
    await page.waitForTimeout(2000);

    const brochures = await page.evaluate(() => {
      const results = [];
      const seen = new Set();

      document.querySelectorAll("a[href]").forEach(link => {
        const href = link.href || "";
        if (!href.includes("leaflets.kaufland.com")) return;
        if (seen.has(href)) return;
        seen.add(href);

        const img = link.querySelector("img") ||
          link.closest("[class*='leaflet'], [class*='brochure'], article, li")?.querySelector("img");
        const container = link.closest("[class*='leaflet'], [class*='brochure'], [class*='item'], article, li") || link.parentElement;
        const text = container?.innerText || "";
        const dateMatch = text.match(/(\d{2}\.\d{2}\.\d{4})\s*[–\-—]\s*(\d{2}\.\d{2}\.\d{4})/);

        results.push({
          url: href,
          thumbnail: img?.src || img?.getAttribute("data-src") || "",
          title: img?.alt || container?.querySelector("h2,h3,h4,[class*='title']")?.innerText?.trim() || "Kaufland брошура",
          validFrom: dateMatch?.[1] || "",
          validTo: dateMatch?.[2] || "",
        });
      });

      return results;
    });

    log(`Kaufland: found ${brochures.length} brochures on listing page`);
    await page.close();

    // Scrape pages for each brochure
    const enriched = [];
    for (const b of brochures.slice(0, 6)) {
      const pages = await scrapeKauflandPages(context, b.url);
      enriched.push({
        store: "Kaufland",
        title: b.title,
        thumbnail: b.thumbnail || pages[0] || "",
        url: b.url,
        validFrom: b.validFrom,
        validTo: b.validTo,
        pages,
      });
    }

    return enriched;
  } catch (err) {
    log(`Kaufland listing error: ${err.message}`);
    await page.close().catch(() => {});
    return [];
  }
}

// ---------------------------------------------------------------------------
// Scrape Lidl BG listing
// ---------------------------------------------------------------------------
async function scrapeLidl(context) {
  log("Scraping Lidl BG listing...");
  const page = await context.newPage();

  try {
    await page.goto("https://www.lidl.bg/c/broshurite-na-lidl/s10017542", {
      waitUntil: "networkidle",
      timeout: 45000,
    });

    await page.waitForTimeout(3000);

    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight));
      await page.waitForTimeout(600);
    }
    await page.waitForTimeout(2000);

    // Find Lidl brochure links — they link to leaflets.schwarz or lidl.bg brochure pages
    const brochures = await page.evaluate(() => {
      const results = [];
      const seen = new Set();

      document.querySelectorAll("a[href]").forEach(link => {
        const href = link.href || "";
        if (
          !href.includes("leaflets.schwarz") &&
          !href.includes("lidl.bg/c/broshura") &&
          !href.includes("lidl.bg/p/")
        ) return;
        if (seen.has(href) || href === window.location.href) return;
        seen.add(href);

        const img = link.querySelector("img") ||
          link.closest("article, li, [class*='item'], [class*='card']")?.querySelector("img");
        const container = link.closest("article, li, [class*='item'], [class*='card']") || link.parentElement;
        const text = container?.innerText || "";
        const dateMatch = text.match(/(\d{2}\.\d{2}\.\d{4})\s*[–\-—]\s*(\d{2}\.\d{2}\.\d{4})/);

        results.push({
          url: href,
          thumbnail: img?.src || img?.getAttribute("data-src") || "",
          title: img?.alt || container?.querySelector("h2,h3,[class*='title']")?.innerText?.trim() || "Lidl брошура",
          validFrom: dateMatch?.[1] || "",
          validTo: dateMatch?.[2] || "",
        });
      });

      return results;
    });

    log(`Lidl: found ${brochures.length} brochures on listing page`);
    await page.close();

    const enriched = [];
    for (const b of brochures.slice(0, 4)) {
      const pages = await scrapeLidlPages(context, b.url);
      enriched.push({
        store: "Lidl",
        title: b.title,
        thumbnail: b.thumbnail || pages[0] || "",
        url: b.url,
        validFrom: b.validFrom,
        validTo: b.validTo,
        pages,
      });
    }

    return enriched;
  } catch (err) {
    log(`Lidl listing error: ${err.message}`);
    await page.close().catch(() => {});
    return [];
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  log("=== LoyalHub Brochure Scraper ===");

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
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    locale: "bg-BG",
    viewport: { width: 1440, height: 900 },
    extraHTTPHeaders: { "Accept-Language": "bg-BG,bg;q=0.9,en-US;q=0.8" },
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    window.chrome = { runtime: {} };
  });

  try {
    const [kauflandResult, lidlResult] = await Promise.allSettled([
      scrapeKaufland(context),
      scrapeLidl(context),
    ]);

    const kaufland = kauflandResult.status === "fulfilled" ? kauflandResult.value : [];
    const lidl = lidlResult.status === "fulfilled" ? lidlResult.value : [];

    // Keep existing data if scrape found nothing new
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

    log(`✅ Done!`);
    log(`Kaufland: ${result.stores.kaufland.length} brochures`);
    result.stores.kaufland.forEach((b, i) =>
      log(`  [${i + 1}] "${b.title}" — ${b.pages.length} pages`)
    );
    log(`Lidl: ${result.stores.lidl.length} brochures`);
    result.stores.lidl.forEach((b, i) =>
      log(`  [${i + 1}] "${b.title}" — ${b.pages.length} pages`)
    );
  } finally {
    await browser.close();
  }
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});