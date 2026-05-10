const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const OUTPUT_PATH = path.join(__dirname, "brochures.json");
const PDFS_DIR = path.join(__dirname, "pdfs");
const PAGES_DIR = path.join(__dirname, "pages");

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ---------------------------------------------------------------------------
// Convert PDF to images using pdftoppm (poppler-utils, available on Ubuntu)
// ---------------------------------------------------------------------------
function pdfToImages(pdfPath, outputDir) {
  ensureDir(outputDir);
  try {
    // pdftoppm converts each PDF page to a PPM/JPG image
    execSync(`pdftoppm -jpeg -r 150 "${pdfPath}" "${outputDir}/page"`, {
      timeout: 120000,
    });
    // List generated images sorted by page number
    const files = fs.readdirSync(outputDir)
      .filter(f => f.endsWith(".jpg") || f.endsWith(".ppm") || f.endsWith(".jpeg"))
      .sort()
      .map(f => path.join(outputDir, f));
    log(`  PDF converted: ${files.length} pages`);
    return files;
  } catch (err) {
    log(`  PDF conversion error: ${err.message}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Download PDF via Playwright (handles auth/cookies automatically)
// ---------------------------------------------------------------------------
async function downloadPDF(context, brochureUrl, outputPath) {
  const page = await context.newPage();
  try {
    log(`  Opening brochure viewer: ${brochureUrl}`);
    await page.goto(brochureUrl, { waitUntil: "networkidle", timeout: 45000 });
    await page.waitForTimeout(3000);

    // Try to find and click the download/PDF button
    const downloadSelectors = [
      '[aria-label*="download" i]',
      '[aria-label*="Download" i]',
      '[aria-label*="PDF" i]',
      '[title*="download" i]',
      '[title*="PDF" i]',
      'a[href*=".pdf"]',
      'button[class*="download"]',
      '[class*="download-btn"]',
      '[data-action="download"]',
    ];

    let downloadUrl = null;

    // Method 1: Intercept the download request
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 10000 }).catch(() => null),
      (async () => {
        for (const sel of downloadSelectors) {
          const btn = await page.$(sel);
          if (btn) {
            log(`  Clicking download button: ${sel}`);
            await btn.click();
            return;
          }
        }
        // No button found - try keyboard shortcut
        log("  No download button found, trying Ctrl+P trick");
      })(),
    ]);

    if (download) {
      log(`  Download triggered: ${download.suggestedFilename()}`);
      await download.saveAs(outputPath);
      return true;
    }

    // Method 2: Look for PDF links in the page source
    const pdfLinks = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('a[href]'))
        .map(a => a.href)
        .filter(href => href.includes('.pdf') || href.includes('download') || href.includes('/pdf'));
    });

    if (pdfLinks.length > 0) {
      log(`  Found PDF link: ${pdfLinks[0]}`);
      downloadUrl = pdfLinks[0];
    }

    // Method 3: Intercept network requests for PDF
    if (!downloadUrl) {
      const pdfRequests = [];
      page.on('request', req => {
        const url = req.url();
        if (url.includes('.pdf') || url.includes('/pdf') || url.includes('download')) {
          pdfRequests.push(url);
        }
      });

      // Reload and wait
      await page.reload({ waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(2000);

      if (pdfRequests.length > 0) {
        downloadUrl = pdfRequests[0];
        log(`  Intercepted PDF request: ${downloadUrl}`);
      }
    }

    if (downloadUrl) {
      // Download using the page's cookies/session
      const response = await page.request.get(downloadUrl);
      if (response.ok()) {
        const buffer = await response.body();
        fs.writeFileSync(outputPath, buffer);
        log(`  PDF saved: ${outputPath} (${buffer.length} bytes)`);
        return true;
      }
    }

    log(`  Could not download PDF for ${brochureUrl}`);
    return false;
  } catch (err) {
    log(`  Download error: ${err.message}`);
    return false;
  } finally {
    await page.close();
  }
}

// ---------------------------------------------------------------------------
// Upload page images to a public location
// Since we can't host images directly, we commit them to the repo
// and reference them via raw.githubusercontent.com
// ---------------------------------------------------------------------------
function getImageUrl(repoUser, repoName, relPath) {
  return `https://raw.githubusercontent.com/${repoUser}/${repoName}/main/${relPath}`;
}

// ---------------------------------------------------------------------------
// Scrape Kaufland brochure listing
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

    log(`Kaufland: found ${brochures.length} brochures`);
    return brochures.slice(0, 6);
  } catch (err) {
    log(`Kaufland listing error: ${err.message}`);
    return [];
  } finally {
    await page.close();
  }
}

// ---------------------------------------------------------------------------
// Scrape Lidl brochure listing
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
        if (!href.includes("leaflets.schwarz") && !href.includes("lidl.bg/c/broshura")) return;
        if (seen.has(href) || href === window.location.href) return;
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

    log(`Lidl: found ${brochures.length} brochures`);
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
  log("=== LoyalHub Brochure Scraper (PDF mode) ===");

// Install poppler-utils for PDF conversion if not available
  try {
    execSync("which pdftoppm", { stdio: "ignore" });
    log("pdftoppm available");
  } catch {
    log("Installing poppler-utils...");
    execSync("apt-get install -y poppler-utils", { stdio: "inherit" });
  }

  ensureDir(PDFS_DIR);
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
    acceptDownloads: true,
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    window.chrome = { runtime: {} };
  });

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
        const pdfPath = path.join(PDFS_DIR, `${slug}.pdf`);
        const pagesDir = path.join(PAGES_DIR, slug);

        log(`Processing ${storeName} brochure ${i + 1}: ${b.url}`);

        // Try to download PDF
        const downloaded = await downloadPDF(context, b.url, pdfPath);

        let pageUrls = [];
        if (downloaded && fs.existsSync(pdfPath)) {
          // Convert PDF pages to images
          const imageFiles = pdfToImages(pdfPath, pagesDir);
          // Reference images via raw.githubusercontent.com
          pageUrls = imageFiles.map(f => {
            const relPath = path.relative(__dirname, f).replace(/\\/g, "/");
            return getImageUrl(REPO_USER, REPO_NAME, relPath);
          });
          log(`  ${storeName}[${i}]: ${pageUrls.length} pages from PDF`);
        } else {
          log(`  ${storeName}[${i}]: PDF download failed, using thumbnail only`);
          pageUrls = b.thumbnail ? [b.thumbnail] : [];
        }

        enriched.push({
          store: storeName,
          title: b.title,
          thumbnail: b.thumbnail || pageUrls[0] || "",
          url: b.url,
          validFrom: b.validFrom,
          validTo: b.validTo,
          pages: pageUrls,
        });
      }
      return enriched;
    };

    const kaufland = await processStore(kauflandList, "Kaufland");
    const lidl = await processStore(lidlList, "Lidl");

    // Load existing if nothing found
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
