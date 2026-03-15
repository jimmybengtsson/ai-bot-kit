import { clampResults, config } from "./config.js";
import { withCloakPage } from "./scraper.js";

const asTrimmed = (value) => (value === undefined || value === null ? "" : String(value).trim());

const requireSearch = (search) => {
  if (!search) {
    const error = new Error("Missing required query parameter: search");
    error.status = 400;
    throw error;
  }
};

const ensureHttpUrl = (value) => {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
};

const collectXTweets = async (page, results) => {
  const tweets = [];
  const seen = new Set();

  for (let i = 0; i < config.maxScrolls && tweets.length < results; i += 1) {
    const batch = await page.evaluate((limit) => {
      const rows = Array.from(document.querySelectorAll("article[data-testid='tweet']"));

      return rows.slice(0, limit).map((tweet) => {
        const statusAnchor = tweet.querySelector("a[href*='/status/']");
        const href = statusAnchor ? statusAnchor.getAttribute("href") : "";
        const statusUrl = href && href.startsWith("http") ? href : href ? `https://x.com${href}` : "";
        const timeEl = tweet.querySelector("time");

        let user = "";
        if (href) {
          const match = href.match(/^\/([^\/]+)\/status\//);
          user = match ? match[1] : "";
        }

        return {
          id: statusUrl || tweet.innerText.slice(0, 120),
          url: statusUrl,
          user,
          text: tweet.innerText,
          postedAt: timeEl ? timeEl.getAttribute("datetime") : null
        };
      });
    }, results);

    for (const tweet of batch) {
      if (!tweet.id || seen.has(tweet.id)) {
        continue;
      }
      seen.add(tweet.id);
      tweets.push(tweet);

      if (tweets.length >= results) {
        break;
      }
    }

    if (tweets.length >= results) {
      break;
    }

    await page.mouse.wheel(0, 1700);
    await new Promise((resolve) => setTimeout(resolve, config.scrollDelayMs));
  }

  return tweets.slice(0, results);
};

const collectGoogleResults = async (page, results) => {
  return page.evaluate((limit) => {
    const blocks = Array.from(document.querySelectorAll("#search .g, div[data-sokoban-container]"));

    const out = [];
    for (const block of blocks) {
      const anchor = block.querySelector("a[href]");
      const titleEl = block.querySelector("h3");
      if (!anchor || !titleEl) {
        continue;
      }

      const snippetEl = block.querySelector("div.VwiC3b, span.aCOpRe, div[data-sncf]");
      out.push({
        title: titleEl.textContent?.trim() || "",
        url: anchor.getAttribute("href") || "",
        snippet: snippetEl?.textContent?.trim() || ""
      });

      if (out.length >= limit) {
        break;
      }
    }

    return out;
  }, results);
};

const collectDuckDuckGoResults = async (page, results) => {
  return page.evaluate((limit) => {
    const blocks = Array.from(document.querySelectorAll("article[data-testid='result'], .result"));
    const out = [];

    for (const block of blocks) {
      const anchor = block.querySelector("a[data-testid='result-title-a'], a.result__a, h2 a");
      if (!anchor) {
        continue;
      }

      const snippetEl = block.querySelector("[data-result='snippet'], .result__snippet");
      out.push({
        title: anchor.textContent?.trim() || "",
        url: anchor.getAttribute("href") || "",
        snippet: snippetEl?.textContent?.trim() || ""
      });

      if (out.length >= limit) {
        break;
      }
    }

    return out;
  }, results);
};

const collectHeadings = async (page, results) => {
  return page.evaluate((limit) => {
    const headings = Array.from(document.querySelectorAll("h1, h2, h3"));
    return headings.slice(0, limit).map((node) => ({
      tag: node.tagName.toLowerCase(),
      text: node.textContent?.trim() || ""
    }));
  }, results);
};

const collectBySelector = async (page, selector, results) => {
  return page.evaluate(
    ({ cssSelector, limit }) => {
      const nodes = Array.from(document.querySelectorAll(cssSelector));
      return nodes.slice(0, limit).map((node) => {
        const asElement = node;
        return {
          text: node.textContent?.trim() || "",
          html: (node.innerHTML || "").slice(0, 800),
          href: asElement.getAttribute ? asElement.getAttribute("href") : null
        };
      });
    },
    { cssSelector: selector, limit: results }
  );
};

export const registerRoutes = (app, requestQueue) => {
  app.get("/", (_req, res) => {
    res.json({
      ok: true,
      service: "cloak-scraper",
      endpoints: ["/health", "/x", "/google", "/duckduckgo", "/headlines", "/webpage"],
      authEnabled: Boolean(config.apiPassword)
    });
  });

  app.get("/health", (_req, res) => {
    const queue = requestQueue?.stats ? requestQueue.stats() : null;
    res.json({ ok: true, uptimeSec: Math.round(process.uptime()), queue });
  });

  app.get("/x", async (req, res, next) => {
    try {
      const search = asTrimmed(req.query.search);
      const user = asTrimmed(req.query.user).replace(/^@/, "");
      const results = clampResults(req.query.results);
      requireSearch(search);

      const query = user ? `${search} from:${user}` : search;
      const encodedQuery = encodeURIComponent(query);
      const url = `https://x.com/search?q=${encodedQuery}&src=typed_query&f=live`;

      const tweets = await withCloakPage(async (page, sleep) => {
        await page.goto(url, { waitUntil: "domcontentloaded" });
        await sleep(3500);
        return collectXTweets(page, results);
      });

      res.json({
        ok: true,
        source: "x",
        query: search,
        user: user || null,
        resolvedQuery: query,
        count: tweets.length,
        results: tweets
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/google", async (req, res, next) => {
    try {
      const search = asTrimmed(req.query.search);
      const results = clampResults(req.query.results);
      requireSearch(search);

      const url = `https://www.google.com/search?q=${encodeURIComponent(search)}&num=${results}`;

      const items = await withCloakPage(async (page, sleep) => {
        await page.goto(url, { waitUntil: "domcontentloaded" });
        await sleep(2500);
        return collectGoogleResults(page, results);
      });

      res.json({
        ok: true,
        source: "google",
        query: search,
        count: items.length,
        results: items
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/duckduckgo", async (req, res, next) => {
    try {
      const search = asTrimmed(req.query.search);
      const results = clampResults(req.query.results);
      requireSearch(search);

      const url = `https://duckduckgo.com/?q=${encodeURIComponent(search)}`;

      const items = await withCloakPage(async (page, sleep) => {
        await page.goto(url, { waitUntil: "domcontentloaded" });
        await sleep(2500);
        return collectDuckDuckGoResults(page, results);
      });

      res.json({
        ok: true,
        source: "duckduckgo",
        query: search,
        count: items.length,
        results: items
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/headlines", async (req, res, next) => {
    try {
      const rawUrl = asTrimmed(req.query.url);
      const results = clampResults(req.query.results);
      const parsed = ensureHttpUrl(rawUrl);

      if (!parsed) {
        const error = new Error("Missing or invalid url parameter. Example: /headlines?url=https://example.com");
        error.status = 400;
        throw error;
      }

      const items = await withCloakPage(async (page, sleep) => {
        await page.goto(parsed.toString(), { waitUntil: "domcontentloaded" });
        await sleep(2000);
        return collectHeadings(page, results);
      });

      res.json({
        ok: true,
        source: "headlines",
        url: parsed.toString(),
        count: items.length,
        results: items
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/webpage", async (req, res, next) => {
    try {
      const rawUrl = asTrimmed(req.query.url);
      const selector = asTrimmed(req.query.selector) || "body";
      const results = clampResults(req.query.results);
      const parsed = ensureHttpUrl(rawUrl);

      if (!parsed) {
        const error = new Error("Missing or invalid url parameter. Example: /webpage?url=https://example.com");
        error.status = 400;
        throw error;
      }

      const items = await withCloakPage(async (page, sleep) => {
        await page.goto(parsed.toString(), { waitUntil: "domcontentloaded" });
        await sleep(1500);
        return collectBySelector(page, selector, results);
      });

      res.json({
        ok: true,
        source: "webpage",
        url: parsed.toString(),
        selector,
        count: items.length,
        results: items
      });
    } catch (error) {
      next(error);
    }
  });
};
