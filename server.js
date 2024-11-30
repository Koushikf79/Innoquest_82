const express = require('express');
const puppeteer = require('puppeteer');
const axeCore = require('axe-core');
const cors = require('cors');
const urlParser = require('url');
const { promisify } = require('util');

const app = express();
const port = 3001;

app.use(cors());

const MAX_DEPTH = 3;  // Limit depth of crawling
const MAX_PAGES = 50; // Limit number of pages to check for performance

// Utility function to handle concurrency
const wait = promisify(setTimeout);

// Run accessibility check on a page
async function runAccessibilityCheck(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Inject axe-core into the page
    await page.evaluate(axeCore.source);

    // Run axe-core accessibility checks
    return await page.evaluate(async () => {
      return await axe.run();
    });
  } catch (error) {
    console.error(`Error checking accessibility for ${url}:`, error);
    return null;  // Return null on error
  }
}

// Function to crawl a website recursively with depth limit
async function crawlWebsite(baseUrl) {
  const visitedLinks = new Set();
  const pages = [];
  const toVisit = [{ url: baseUrl, depth: 0 }];

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();

  while (toVisit.length > 0 && pages.length < MAX_PAGES) {
    const { url, depth } = toVisit.pop();

    // Skip if we've already visited this link
    if (visitedLinks.has(url)) {
      continue;
    }

    // Mark as visited
    visitedLinks.add(url);

    // Check accessibility
    const results = await runAccessibilityCheck(page, url);
    if (results) {
      pages.push({ url, results });
    }

    // Don't crawl beyond the specified depth
    if (depth < MAX_DEPTH) {
      // Crawl links on the current page
      const links = await page.evaluate(() => {
        const anchorTags = Array.from(document.querySelectorAll('a'));
        return anchorTags.map(anchor => anchor.href);
      });

      // Add links to the queue (resolve relative URLs)
      links.forEach(link => {
        const absoluteUrl = urlParser.resolve(url, link);
        if (!visitedLinks.has(absoluteUrl) && absoluteUrl.startsWith(baseUrl)) {
          toVisit.push({ url: absoluteUrl, depth: depth + 1 });
        }
      });
    }

    // To avoid overwhelming the server, add a small delay
    await wait(200);  // 200 ms delay between requests
  }

  await browser.close();
  return pages;
}

// Endpoint to check the entire website
app.get('/accessibility-check', async (req, res) => {
  const url = decodeURIComponent(req.query.url);

  if (!url) {
    return res.status(400).json({ error: 'URL parameter is required' });
  }

  try {
    const pages = await crawlWebsite(url);

    // Aggregate results for all pages
    const aggregatedResults = pages.map(page => ({
      url: page.url,
      score: calculateAccessibilityScore(page.results.violations),
      violations: page.results.violations.length,
      suggestions: page.results.violations.map(violation => ({
        description: violation.description,
        help: violation.help,
        helpUrl: violation.helpUrl,
      })),
    }));

    res.json({ aggregatedResults });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'An error occurred while running the accessibility check' });
  }
});

// Function to calculate an accessibility score based on violations
function calculateAccessibilityScore(violations) {
  let score = 100;  // Start with a perfect score

  violations.forEach(violation => {
    switch (violation.impact) {
      case 'serious':
        score -= 30;  // Deduct points for serious issues
        break;
      case 'moderate':
        score -= 15;  // Deduct points for moderate issues
        break;
      case 'minor':
        score -= 5;   // Deduct points for minor issues
        break;
      default:
        break;
    }
  });

  // Ensure the score is between 0 and 100
  return Math.max(0, Math.min(100, score));
}


// Start the server
app.listen(port, () => {
  console.log(`Accessibility Checker running on http://localhost:${port}`);
});
