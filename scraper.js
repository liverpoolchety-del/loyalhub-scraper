const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const OUTPUT_PATH = path.join(__dirname, "brochures.json");

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ---------------------------------------------------------------------------
// Intercept ALL API responses from the brochure viewer to find page image URLs
// ---------------------------------------------------------------------------
async function getAllBrochurePages(context, brochureUrl, storeName) {
  const page = await context.newPage();
  const pageImages = [];
  const seen = new Set();
  const apiResponses = [];

  try {
    log(`  Opening ${storeName} brochure: ${brochureUrl}`);

    // Intercept ALL responses — JSON, images, everything
    page.on("response", async (response) => {
      const url = response.url();
      const contentType = response.headers()["content-type"] || "";

      // Capture high-res brochure page images
      if (
        url.includes("imgproxy.leaflets.schwarz") &&
        !seen.has(url)
      ) {
        try {
          const buf = await response.body();
          if (buf.length > 30000) {
            seen.add(url);
            // Upgrade low-res to high-res
            const hiRes = url
              .replace(/rs:fit:\d+:\d+:\d+/, "rs:fit:1200:1200:1")
              .replace(/rs:fit:\d+:0:\d+/, "rs:fit:1200:1200:1");
            pageImages.push(hiRes);
          }
        } catch {}
      }

      // Capture JSON API responses that might contain page data
      if (contentType.includes("application/json") || contentType.includes("text/javascript")) {
        try {
          const text = await response.text();
          if (
            text.includes("imgproxy") ||
            text.includes("page-0") ||
            text.includes("leaflets/images") ||
            (text.includes("pages") && text.length > 500)
          ) {
            apiResponses.push({ url, text: text.substring(0, 5000) });
            log(`    Captured API response: ${url.substring(0, 100)}`);
          }
        } catch {}
      }
    });

    // Navigate to brochure
    await page.goto(brochureUrl, { waitUntil: "networkidle", timeout: 45000 });
    await page.waitForTimeout(4000);

    // Log what API calls were made
    if (apiResponses.length > 0) {
      log(`  Found ${apiResponses.length} API responses with page data`);
      for (const r of apiResponses) {
        log(`    ${r.url}`);
        // Try to parse JSON and extract image URLs
        try {
          const json = JSON.parse(r.text);
          const jsonStr = JSON.stringify(json);
          const imgMatches = jsonStr.match(/https:\/\/imgproxy\.leaflets\.schwarz\/[^"]+/g) || [];
          for (const img of imgMatches) {
            if (!seen.has(img)) {
              seen.add(img);
              const hiRes = img.replace(/rs:fit:\d+:\d+:\d+/, "rs:fit:1200:1200:1")
                              .replace(/rs:fit:\d+:0:\d+/, "rs:fit:1200:1200:1");
              pageImages.push(hiRes);
            }
          }
        } catch {}
      }
    }

    // Also try clicking through pages to trigger lazy loading
    // Get page count from viewer UI
    const totalPages = await page.evaluate(() => {
      const text = document.body.innerText;
      const match = text.match(/\b(\d+)\s*\/\s*(\d+)\b/);
      return match ? parseInt(match[2]) : 20;
    });

    log(`  Detected ${totalPages} total pages, clicking through...`);

    for (let p = 0; p < Math.min(totalPages, 50); p++) {
      await page.keyboard.press("ArrowRight");
      await page.waitForTimeout(800);
    }

    await page.waitForTimeout(3000);

// Deduplicate and sort by page number extracted from URL
    const unique = [...new Set(pageImages)];
    unique.sort((a, b) => {
      // Decode base64 part to get page number
      const getPageNum = (url) => {
        try {
          const b64 = url.split('/g:no/')[1]?.replace('.jpg', '') || '';
          const padding = 4 - (b64.length % 4);
          const decoded = Buffer.from(b64 + '='.repeat(padding), 'base64').toString('utf8');
          const match = decoded.match(/page-(\d+)/);
          return match ? parseInt(match[1]) : 999;
        } catch { return 999; }
      };
      return getPageNum(a) - getPageNum(b);
    });
    log(`  Total pages captured: ${unique.length}`);
    return unique;

  } catch (err) {
    log(`  Error: ${err.message}`);
    return [...new Set(pageImages)].sort();
  } finally {
    await page.close();
  }
}

// ---------------------------------------------------------------------------
// Scrape Kaufland listing page
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
// Scrape Lidl listing page
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

    // Capture brochure links from the listing page network responses
    // Lidl brochures link to leaflets.schwarz viewer
    const brochures = await page.evaluate(() => {
      const results = [];
      const seen = new Set();

      // Look for links to the brochure viewer
      document.querySelectorAll("a[href]").forEach(link => {
        const href = link.href || "";
        if (
          !href.includes("leaflets.schwarz") &&
          !href.includes("lidl.bg/c/broshura") &&
          !href.includes("/p/") &&
          !href.match(/broshura|leaflet|broshu/i)
        ) return;
        if (seen.has(href) || href === window.location.href) return;
        seen.add(href);

        const img = link.querySelector("img") ||
          link.closest("article, li, [class*='item'], [class*='card']")?.querySelector("img");
        const container = link.closest("article, li, [class*='item'], [class*='card']") || link.parentElement;
        const text = container?.innerText || "";
        const dateMatch = text.match(/(\d{2}\.\d{2}\.\d{4})\s*[–\-—]\s*(\d{2}\.\d{2}\.\d{4})/);

        // Filter out navigation links
        if (href.includes("#") || href.length < 30) return;

        results.push({
          url: href,
          thumbnail: img?.src || "",
          title: img?.alt || container?.querySelector("h2,h3,[class*='title']")?.innerText?.trim() || "Lidl брошура",
          validFrom: dateMatch?.[1] || "",
          validTo: dateMatch?.[2] || "",
        });
      });

      return results;
    });

    log(`Lidl: ${brochures.length} brochures found`);
    return brochures.slice(0, 4);
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
    // Get listings first
    const [kauflandList, lidlList] = await Promise.all([
      scrapeKauflandListing(context),
      scrapeLidlListing(context),
    ]);

    // Process each brochure — get all pages
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

    // Keep existing data if nothing found
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
