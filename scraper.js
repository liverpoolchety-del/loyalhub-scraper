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
        // Extract the base64 part after /g:no/
        const b64Part = url.split("/g:no/")[1]?.replace(/\.[^.]+$/, "") || "";
        // Try URL-safe base64 decode
        const padded = b64Part + "=".repeat((4 - b64Part.length % 4) % 4);
        const decoded = Buffer.from(padded, "base64").toString("utf8");
        // Match page-01, page-02, page-1, page-2 etc
        const match = decoded.match(/page[-_]?0*(\d+)/i);
        if (match) return parseInt(match[1], 10);
        return 999;
      } catch {
        return 999;
      }
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
     await page.keyboard.press("ArrowRight");
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
  const pageImages = [];
  const seen = new Set();
  let pdfUrl = null;

  try {
    log("Scraping Lidl brochure viewer...");

    // Capture page images AND any PDF url
    page.on("response", async (response) => {
      const url = response.url();

      // Capture brochure page images from any leaflets CDN
      if (
        (url.includes("imgproxy") || url.includes("leaflets") || url.includes("flyer")) &&
        url.match(/\.(jpg|jpeg|png|webp)/i) &&
        !seen.has(url)
      ) {
        try {
          const buf = await response.body();
          if (buf.length > 30000) {
            seen.add(url);
            pageImages.push(url);
          }
        } catch {}
      }

      // Capture PDF url
      if (url.includes(".pdf") && url.includes("storage")) {
        pdfUrl = url;
        log(`  Found Lidl PDF: ${url}`);
      }
    });

    // Navigate directly to the brochure VIEWER url (the /l/bg/ format)
    const viewerUrl = "https://www.lidl.bg/l/bg/broshura/01-06-07-06-e5de04/view/menu/page/1";
    log(`  Opening viewer: ${viewerUrl}`);
    await page.goto(viewerUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(6000);

    // Click through pages to load all images
    for (let p = 0; p < 60; p++) {
      await page.keyboard.press("ArrowRight");
      await page.waitForTimeout(700);
    }
    await page.waitForTimeout(4000);

    log(`  Lidl: captured ${pageImages.length} page images, PDF: ${pdfUrl ? "yes" : "no"}`);

    if (pageImages.length > 0) {
      // Sort and return as a brochure
      const sorted = sortPagesByNumber(pageImages);
      return [{
        store: "Lidl",
        title: "Lidl брошура",
        thumbnail: sorted[0] || "",
        url: viewerUrl,
        validFrom: "01.06.2026",
        validTo: "07.06.2026",
        pages: sorted,
        _alreadyHasPages: true,  // flag so processStore doesn't re-scrape
      }];
    }

    return [];
  } catch (err) {
    log(`Lidl error: ${err.message}`);
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
    javaScriptEnabled: true,
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, "languages", { get: () => ["bg-BG", "bg", "en-US", "en"] });
    window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {}, app: {} };
    // Remove headless indicators
    delete window.navigator.__proto__.webdriver;
  });

  try {
    const [kauflandList, lidlList] = await Promise.all([
      scrapeKauflandListing(context),
      scrapeLidlListing(context),
    ]);

    const processStore = async (brochures, storeName) => {
      const enriched = [];
      for (const b of brochures) {
        const pages = b.pdfUrl
          ? await getAllBrochurePages(context, b.pdfUrl, storeName)
          : await getAllBrochurePages(context, b.url, storeName);
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
