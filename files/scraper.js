const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const OUTPUT_PATH = path.join(__dirname, "brochures.json");

function today() {
  return new Date().toISOString().split("T")[0];
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ---------------------------------------------------------------------------
// Scrape individual brochure pages
// ---------------------------------------------------------------------------
async function scrapeBrochurePages(context, url, store) {
  const page = await context.newPage();
  const pageImages = [];
  try {
    log(`  Scraping pages from: ${url}`);
    const imageUrls = new Set();

    page.on("response", async (response) => {
      const reqUrl = response.url();
      const contentType = response.headers()["content-type"] || "";
      if (
        contentType.startsWith("image/") &&
        (reqUrl.includes("page") ||
          reqUrl.includes("broshur") ||
          reqUrl.includes("leaflet") ||
          reqUrl.includes("flyer") ||
          /\/\d+\.(jpg|jpeg|png|webp)/i.test(reqUrl))
      ) {
        try {
          const buffer = await response.body();
          if (buffer.length > 50000) imageUrls.add(reqUrl);
        } catch {}
      }
    });

    await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });

    const domImages = await page.evaluate(() =>
      Array.from(document.querySelectorAll("img"))
        .filter((img) => img.naturalWidth > 400 && img.naturalHeight > 400)
        .map((img) => img.src)
        .filter((src) => src && src.startsWith("http"))
    );

    const allImages = [...new Set([...imageUrls, ...domImages])];
    allImages.sort();
    pageImages.push(...allImages.slice(0, 20));
    log(`  Found ${pageImages.length} pages`);
  } catch (err) {
    log(`  Page scrape error: ${err.message}`);
  } finally {
    await page.close();
  }
  return pageImages;
}

// ---------------------------------------------------------------------------
// Scrape a store's brochure listing page
// ---------------------------------------------------------------------------
async function scrapeStore(context, url, storeName, linkSelectors) {
  log(`Scraping ${storeName}...`);
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
    await page
      .waitForSelector(linkSelectors[0], { timeout: 15000 })
      .catch(() => log(`${storeName}: selector timeout, continuing anyway`));

    const brochures = await page.evaluate((selectors) => {
      const results = [];
      for (const sel of selectors) {
        const els = document.querySelectorAll(sel);
        if (els.length > 0) {
          els.forEach((el) => {
            const img = el.querySelector("img");
            const href = el.href || el.getAttribute("data-href") || "";
            const parent =
              el.closest("article, li, [class*='item'], [class*='card']") ||
              el.parentElement;
            const text = parent ? parent.innerText : "";
            const dateMatch = text.match(
              /(\d{2}\.\d{2}\.\d{4})\s*[–-]\s*(\d{2}\.\d{2}\.\d{4})/
            );
            if (img && img.src) {
              results.push({
                thumbnail: img.src,
                url: href || window.location.href,
                title: img.alt || "",
                validFrom: dateMatch ? dateMatch[1] : "",
                validTo: dateMatch ? dateMatch[2] : "",
              });
            }
          });
          if (results.length > 0) break;
        }
      }
      return results;
    }, linkSelectors);

    const enriched = [];
    for (const b of brochures.slice(0, 3)) {
      const pages =
        b.url && b.url !== url
          ? await scrapeBrochurePages(context, b.url, storeName)
          : [b.thumbnail].filter(Boolean);
      enriched.push({
        store: storeName,
        title: b.title || `${storeName} брошура`,
        thumbnail: b.thumbnail,
        url: b.url || url,
        validFrom: b.validFrom,
        validTo: b.validTo,
        pages,
      });
    }

    log(`${storeName}: found ${enriched.length} brochures`);
    return enriched;
  } catch (err) {
    log(`${storeName} error: ${err.message}`);
    return [];
  } finally {
    await page.close();
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  log("Starting brochure scraper...");

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
    viewport: { width: 1280, height: 800 },
    extraHTTPHeaders: {
      "Accept-Language": "bg-BG,bg;q=0.9,en-US;q=0.8,en;q=0.7",
    },
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  try {
    const [kauflandResult, lidlResult] = await Promise.allSettled([
      scrapeStore(
        context,
        "https://www.kaufland.bg/broshuri.html",
        "Kaufland",
        ["a[href*='broshur']", "a[href*='leaflet']", ".m-leaflet__link", "[class*='leaflet'] a"]
      ),
      scrapeStore(
        context,
        "https://www.lidl.bg/c/broshurite-na-lidl/s10017542",
        "Lidl",
        ["a[href*='broshur']", "a[href*='leaflet']", ".n-leaflet__link", "[class*='leaflet'] a"]
      ),
    ]);

    const result = {
      updatedAt: new Date().toISOString(),
      date: today(),
      stores: {
        kaufland: kauflandResult.status === "fulfilled" ? kauflandResult.value : [],
        lidl: lidlResult.status === "fulfilled" ? lidlResult.value : [],
      },
    };

    let existing = { stores: { kaufland: [], lidl: [] } };
    if (fs.existsSync(OUTPUT_PATH)) {
      try {
        existing = JSON.parse(fs.readFileSync(OUTPUT_PATH, "utf8"));
      } catch {}
    }

    const hasNewData =
      result.stores.kaufland.length > 0 || result.stores.lidl.length > 0;

    if (hasNewData) {
      fs.writeFileSync(OUTPUT_PATH, JSON.stringify(result, null, 2));
      log(
        `✅ Updated — Kaufland: ${result.stores.kaufland.length}, Lidl: ${result.stores.lidl.length}`
      );
    } else {
      existing.checkedAt = new Date().toISOString();
      fs.writeFileSync(OUTPUT_PATH, JSON.stringify(existing, null, 2));
      log("⚠️  No new brochures found — keeping existing data");
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
