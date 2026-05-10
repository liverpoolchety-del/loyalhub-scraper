const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const OUTPUT_PATH = path.join(__dirname, "brochures.json");

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ---------------------------------------------------------------------------
// Sort brochure page URLs by page number decoded from base64
// ---------------------------------------------------------------------------
function sortPagesByNumber(urls) {
  return [...new Set(urls)].sort((a, b) => {
    const getNum = (url) => {
      try {
        const b64 = url.split("/g:no/")[1]?.replace(/\.[a-z]+$/, "") || "";
        const padding = 4 - (b64.length % 4);
        const decoded = Buffer.from(b64 + "=".repeat(padding % 4), "base64url").toString("utf8");
        const match = decoded.match(/page-?0*(\d+)/i);
        return match ? parseInt(match[1]) : 999;
      } catch { return 999; }
    };
    return getNum(a) - getNum(b);
  });
}

// ---------------------------------------------------------------------------
// Get all pages for a brochure using network interception
// ---------------------------------------------------------------------------
async function getAllBrochurePages(context, brochureUrl, storeName) {
  const page = await context.newPage();
  const pageImages = [];
  const seen = new Set();

  try {
    log(`  Opening: ${brochureUrl}`);

    // Capture ALL imgproxy image responses
    page.on("response", async (response) => {
      const url = response.url();
      if (!url.includes("imgproxy.leaflets.schwarz")) return;
      if (seen.has(url)) return;
      try {
        const buf = await response.body();
        if (buf.length > 30000) {
          seen.add(url);
          // Upgrade to 1200px
          const hiRes = url
            .replace(/rs:fit:\d+:\d+:\d+/, "rs:fit:1200:1200:1")
            .replace(/rs:fit:\d+:0:\d+/, "rs:fit:1200:1200:1")
            .replace(/rs:fill:\d+:\d+:\d+/, "rs:fit:1200:1200:1");
          pageImages.push(hiRes);
        }
      } catch {}
    });

    await page.goto(brochureUrl, { waitUntil: "networkidle", timeout: 45000 });
    await page.waitForTimeout(3000);

    // Get total page count from viewer UI
    const totalPages = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll("*"));
      for (const el of all) {
        const text = el.textContent?.trim() || "";
        if (/^\d+\s*\/\s*\d+$/.test(text)) {
          const m = text.match(/\d+\s*\/\s*(\d+)/);
          if (m) return parseInt(m[1]);
        }
      }
      return 60; // default max
    });

    log(`  Detected ${totalPages} pages, clicking through...`);

    // Click through ALL pages with adequate wait time
    const totalClicks = totalPages + 5; // a few extra clicks to catch last pages
    for (let p = 0; p < totalClicks; p++) {
      // Try clicking next button first, fall back to ArrowRight
      const clicked = await page.evaluate(() => {
        const selectors = [
          '[aria-label*="next" i]',
          '[aria-label*="Next" i]',
          '[class*="next-page"]',
          '[class*="nextPage"]',
          '[class*="arrow-right"]',
          '[class*="btn-next"]',
          'button[class*="right"]',
        ];
        for (const sel of selectors) {
          const btn = document.querySelector(sel);
          if (btn) { btn.click(); return true; }
        }
        return false;
      });

      if (!clicked) await page.keyboard.press("ArrowRight");
      await page.waitForTimeout(1200);

      // Extra pause every 10 pages
      if (p > 0 && p % 10 === 0) await page.waitForTimeout(800);
    }

    // Final wait to catch any remaining lazy loads
    await page.waitForTimeout(4000);

    const sorted = sortPagesByNumber(pageImages);
    log(`  Captured ${sorted.length} pages`);
    return sorted;

  } catch (err) {
    log(`  Error: ${err.message}`);
    return sortPagesByNumber(pageImages);
  } finally {
    await page.close();
  }
}

// ---------------------------------------------------------------------------
// Scrape Kaufland listing
// ---------------------------------------------------------------------------
async function scrapeKauflandListing(context) {
  const page = await context.newPage();
  try {
    log("Scraping Kaufland listing...");
    await page.goto("https://www.kaufland.bg/broshuri.html", {
      waitUntil: "networkidle",
      timeout: 45000,
    });
    await page.waitForTimeout(3000);

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
          thumbnail: img?.src || "",
          title: img?.alt || "Kaufland брошура",
          validFrom: dateMatch?.[1] || "",
          validTo: dateMatch?.[2] || "",
        });
      });
      return results;
    });

    log(`Kaufland: ${brochures.length} brochures found`);
    return brochures.slice(0, 6);
  } catch (err) {
    log(`Kaufland listing error: ${err.message}`);
    return [];
  } finally {
    await page.close();
  }
}

// ---------------------------------------------------------------------------
// Scrape Lidl listing
// ---------------------------------------------------------------------------
async function scrapeLidlListing(context) {
  const page = await context.newPage();
  try {
    log("Scraping Lidl listing...");
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

    const brochures = await page.evaluate(() => {
      const results = [];
      const seen = new Set();
      document.querySelectorAll("a[href]").forEach(link => {
        const href = link.href || "";
        if (
          !href.includes("leaflets.schwarz") &&
          !href.includes("lidl.bg/c/broshura") &&
          !href.match(/broshura|leaflet/i)
        ) return;
        if (seen.has(href) || href === window.location.href || href.includes("#")) return;
        if (href.length < 30) return;
        seen.add(href);
        const img = link.querySelector("img") ||
          link.closest("article, li, [class*='item']")?.querySelector("img");
        const container = link.closest("article, li, [class*='item'], [class*='card']") || link.parentElement;
        const text = container?.innerText || "";
        const dateMatch = text.match(/(\d{2}\.\d{2}\.\d{4})\s*[–\-—]\s*(\d{2}\.\d{2}\.\d{4})/);
        results.push({
          url: href,
          thumbnail: img?.src || "",
          title: img?.alt || "Lidl брошура",
          validFrom: dateMatch?.[1] || "",
          validTo: dateMatch?.[2] || "",
        });
      });
      return results;
    });

    log(`Lidl: ${brochures.length} brochures found`);
    return brochures.filter(b => b.url.length > 30).slice(0, 4);
  } catch (err) {
    log(`Lidl listing error: ${err.message}`);
    return [];
  } finally {
    await page.close();
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
    const [kauflandList, lidlList] = await Promise.all([
      scrapeKauflandListing(context),
      scrapeLidlListing(context),
    ]);

    const processStore = async (brochures, storeName) => {
      const enriched = [];
      for (const b of brochures) {
        const pages = await getAllBrochurePages(context, b.url, storeName);
        enriched.push({
          store: storeName,
          title: b.title,
          thumbnail: b.thumbnail || pages[0] || "",
          url: b.url,
          validFrom: b.validFrom,
          validTo: b.validTo,
          pages,
        });
      }
      return enriched;
    };

    const kaufland = await processStore(kauflandList, "Kaufland");
    const lidl = await processStore(lidlList, "Lidl");

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

    log("✅ Done!");
    result.stores.kaufland.forEach((b, i) =>
      log(`  Kaufland[${i + 1}] "${b.title}": ${b.pages.length} pages`)
    );
    result.stores.lidl.forEach((b, i) =>
      log(`  Lidl[${i + 1}] "${b.title}": ${b.pages.length} pages`)
    );
  } finally {
    await browser.close();
  }
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
