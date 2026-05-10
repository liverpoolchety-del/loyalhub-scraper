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
  // Extract flyer identifier from URL
  // e.g. https://leaflets.kaufland.com/bg-BG/BG_bg_KDZ_3100_BG19-LFT/ar/3100
  const match = brochureUrl.match(/\/([^\/]+)\/ar\//);
  if (!match) return [];
  
  const flyerIdentifier = match[1];
  const regionId = brochureUrl.match(/\/(\d+)$/)?.[1] || "3100";
  const apiUrl = `https://endpoints.leaflets.schwarz/v4/flyer?flyer_identifier=${flyerIdentifier}&region_id=${regionId}&region_code=${regionId}`;
  
  log(`  Calling API: ${apiUrl}`);
  
  const page = await context.newPage();
  try {
    const response = await page.request.get(apiUrl, {
      headers: {
        "Accept": "application/json",
        "Referer": "https://leaflets.kaufland.com/",
        "Origin": "https://leaflets.kaufland.com",
      }
    });
    
    if (!response.ok()) {
      log(`  API failed: ${response.status()}`);
      return [];
    }
    
    const json = await response.json();
    log(`  API response received, parsing pages...`);
     // DEBUG: log the first 2000 chars of the API response
    log(`  API RAW: ${jsonStr.substring(0, 2000)}`);
    
    // Extract all page image URLs from the API response
    const pageImages = [];
    const jsonStr = JSON.stringify(json);
    
    // Find all imgproxy URLs
    const matches = jsonStr.match(/https:\\\/\\\/imgproxy\.leaflets\.schwarz\\\/[^"]+/g) || [];
    for (const raw of matches) {
      const url = raw.replace(/\\\//g, '/');
      // Only keep high-res page images
      if (url.includes('rs:fit:1200') || url.includes('rs:fit:400')) {
        const hiRes = url.replace(/rs:fit:\d+:\d+:\d+/, 'rs:fit:1200:1200:1');
        pageImages.push(hiRes);
      }
    }
    
    // Sort by page number
    const unique = [...new Set(pageImages)];
    unique.sort((a, b) => {
      const getPageNum = (url) => {
        try {
          const b64 = url.split('/g:no/')[1]?.replace('.jpg', '') || '';
          const padding = 4 - (b64.length % 4);
          const decoded = Buffer.from(b64 + '='.repeat(padding), 'base64').toString('utf8');
          const match = decoded.match(/page-?0*(\d+)/i);
          return match ? parseInt(match[1]) : 999;
        } catch { return 999; }
      };
      return getPageNum(a) - getPageNum(b);
    });
    
    log(`  Got ${unique.length} pages from API`);
    return unique;
  } catch (err) {
    log(`  API error: ${err.message}`);
    return [];
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
