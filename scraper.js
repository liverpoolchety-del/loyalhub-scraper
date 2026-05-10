const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const { execSync, spawnSync } = require("child_process");
const https = require("https");
const http = require("http");

const OUTPUT_PATH = path.join(__dirname, "brochures.json");
const PAGES_DIR = path.join(__dirname, "pages");

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ---------------------------------------------------------------------------
// Download a file from URL to local path
// ---------------------------------------------------------------------------
function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith("https") ? https : http;
    const file = fs.createWriteStream(destPath);
    proto.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "Referer": "https://leaflets.kaufland.com/",
      }
    }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        fs.unlinkSync(destPath);
        return downloadFile(res.headers.location, destPath).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      res.pipe(file);
      file.on("finish", () => file.close(() => resolve()));
      file.on("error", reject);
    }).on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Convert PDF to JPG images using pdftoppm
// Returns array of image file paths
// ---------------------------------------------------------------------------
function convertPdfToImages(pdfPath, outputDir) {
  ensureDir(outputDir);
  const result = spawnSync("/usr/bin/pdftoppm", [
    "-jpeg",
    "-r", "150",    // 150 DPI — good quality, reasonable file size
    "-jpegopt", "quality=85",
    pdfPath,
    path.join(outputDir, "page"),
  ], { timeout: 120000 });

  if (result.error) {
    log(`  pdftoppm error: ${result.error.message}`);
    return [];
  }

  const files = fs.readdirSync(outputDir)
    .filter(f => f.match(/\.(jpg|jpeg|ppm)$/i))
    .sort()
    .map(f => path.join(outputDir, f));

  log(`  Converted ${files.length} pages from PDF`);
  return files;
}

// ---------------------------------------------------------------------------
// Call the Schwarz leaflets API to get flyer info including PDF URL
// ---------------------------------------------------------------------------
async function getFlyerInfo(page, flyerIdentifier, regionId) {
  const apiUrl = `https://endpoints.leaflets.schwarz/v4/flyer?flyer_identifier=${flyerIdentifier}&region_id=${regionId}`;
  try {
    const response = await page.request.get(apiUrl, {
      headers: {
        "Accept": "application/json",
        "Referer": "https://leaflets.kaufland.com/",
        "Origin": "https://leaflets.kaufland.com",
      }
    });
    if (!response.ok()) return null;
    const json = await response.json();
    if (!json.success || !json.flyer) return null;
    return json.flyer;
  } catch (err) {
    log(`  API error: ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Process a single brochure: download PDF, convert to images
// ---------------------------------------------------------------------------
async function processBrochure(page, brochure, slug) {
  const match = brochure.url.match(/\/([^\/]+)\/ar\//);
  if (!match) {
    log(`  Could not extract identifier from: ${brochure.url}`);
    return [];
  }

  const flyerIdentifier = match[1];
  const regionId = brochure.url.match(/\/(\d+)$/)?.[1] || "3100";

  log(`  Getting flyer info for: ${flyerIdentifier}`);
  const flyerInfo = await getFlyerInfo(page, flyerIdentifier, regionId);

  if (!flyerInfo) {
    log(`  No flyer info found`);
    return [];
  }

  const pdfUrl = flyerInfo.pdfUrl || flyerInfo.hiResPdfUrl;
  if (!pdfUrl) {
    log(`  No PDF URL in flyer info`);
    return [];
  }

  log(`  PDF URL: ${pdfUrl}`);

  // Download PDF
  const pdfPath = path.join(__dirname, `${slug}.pdf`);
  try {
    await downloadFile(pdfUrl, pdfPath);
    const stats = fs.statSync(pdfPath);
    log(`  PDF downloaded: ${(stats.size / 1024).toFixed(0)} KB`);
  } catch (err) {
    log(`  PDF download failed: ${err.message}`);
    return [];
  }

  // Convert to images
  const pagesDir = path.join(PAGES_DIR, slug);
  const imageFiles = convertPdfToImages(pdfPath, pagesDir);

  // Clean up PDF
  try { fs.unlinkSync(pdfPath); } catch {}

  // Return relative paths (will be served from GitHub raw)
  return imageFiles.map(f => path.relative(__dirname, f).replace(/\\/g, "/"));
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

    // Intercept the Lidl leaflets API call
    const lidlBrochures = [];
    const apiResponses = [];

    page.on("response", async (response) => {
      const url = response.url();
      if (url.includes("endpoints.leaflets.schwarz") && url.includes("flyer")) {
        try {
          const json = await response.json();
          if (json.success && json.flyer) {
            apiResponses.push(json.flyer);
          }
        } catch {}
      }
    });

    // Also look for brochure links
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
  log("=== LoyalHub Brochure Scraper (PDF mode) ===");

  ensureDir(PAGES_DIR);

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

  // Shared page for API calls
  const apiPage = await context.newPage();

  const REPO_USER = "liverpoolchety-del";
  const REPO_NAME = "loyalhub-scraper";

  try {
    const [kauflandList, lidlList] = await Promise.all([
      scrapeKauflandListing(context),
      scrapeLidlListing(context),
    ]);

    const processStore = async (brochures, storeName) => {
      const enriched = [];
      for (let i = 0; i < brochures.length; i++) {
        const b = brochures[i];
        const slug = `${storeName.toLowerCase()}_${i}`;
        log(`Processing ${storeName}[${i + 1}]: ${b.url}`);

        const relPaths = await processBrochure(apiPage, b, slug);
        const pageUrls = relPaths.map(p =>
          `https://raw.githubusercontent.com/${REPO_USER}/${REPO_NAME}/main/${p}`
        );

        // Update title from API if available
        const flyerMatch = b.url.match(/\/([^\/]+)\/ar\//);
        let title = b.title;
        let validFrom = b.validFrom;
        let validTo = b.validTo;

        if (flyerMatch) {
          const info = await getFlyerInfo(apiPage, flyerMatch[1], "3100");
          if (info) {
            title = info.name || title;
            if (info.title) {
              const dates = info.title.match(/(\d{2}\.\d{2}\.\d{4})\s*-\s*(\d{2}\.\d{2}\.\d{4})/);
              if (dates) { validFrom = dates[1]; validTo = dates[2]; }
            }
          }
        }

        enriched.push({
          store: storeName,
          title: `${title} брошура`,
          thumbnail: b.thumbnail || pageUrls[0] || "",
          url: b.url,
          validFrom,
          validTo,
          pages: pageUrls,
        });

        log(`  ${storeName}[${i + 1}]: ${pageUrls.length} pages`);
      }
      return enriched;
    };

    const kaufland = await processStore(kauflandList, "Kaufland");
    const lidl = await processStore(lidlList, "Lidl");

    // Keep existing if nothing found
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
    await apiPage.close();
    await browser.close();
  }
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
