import express, { Application, Request, Response, NextFunction } from "express";
import axios from "axios";
import * as cheerio from "cheerio";
import path from 'path';
import puppeteer from 'puppeteer';
import errorHandler from './utils/error';
import { setSecureHeaders } from "./utils/secureHeaders";

const app: Application = express();
const PORT = process.env.PORT || 6020;

app.use(express.json());
app.use(
  express.urlencoded({
    extended: true,
  })
);
app.use(setSecureHeaders);
app.disable("x-powered-by");

app.use(express.static(path.join(__dirname, '.', 'public')));
app.get('/', (req: Request, res: Response) => {
  res.sendFile(path.join(__dirname, '.', 'public', 'index.html'));
});

// Simple axios fetch for endpoints that don't trigger Cloudflare
const fetchHTML = async (url: string): Promise<string> => {
  try {
    const response = await axios.get(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36" },
    });
    return response.data;
  } catch (error) {
    throw new Error("Failed to fetch the HTML content");
  }
};

// Puppeteer-based fetch for Cloudflare‑protected pages
const fetchHTMLWithBrowser = async (url: string): Promise<string> => {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'], // required for Railway
  });
  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForSelector('.cb-col', { timeout: 10000 }).catch(() => {});
    const html = await page.content();
    return html;
  } finally {
    await browser.close();
  }
};

// ── Fetch live matches (still uses axios, seems fine) ─────
const fetchLiveMatches = async (): Promise<any[]> => {
  const url = "https://www.cricbuzz.com/cricket-match/live-scores";
  const html = await fetchHTMLWithBrowser(url);
  const $ = cheerio.load(html);

  const matches: any[] = [];

  $(".cb-mtch-lst.cb-col.cb-col-100").each((index, element) => {
    const matchElement = $(element);
    const link = matchElement.find("a.cb-lv-scrs-well").attr("href");
    const id = link ? link.split("/")[2] : null;

    const teams: string[] = [];
    matchElement.find(".cb-ovr-flo .cb-hmscg-tm-nm").each((i, el) => {
      teams.push($(el).text().trim());
    });

    const status = matchElement.find(".cb-text-live, .cb-text-complete, .cb-text-rain, .cb-text-abandon")
      .first().text().trim() || "Upcoming";

    const venue = matchElement.find(".cb-venue").text().trim();

    const scores: string[] = [];
    matchElement.find(".cb-ovr-flo .cb-scrs-wrp").each((i, el) => {
      scores.push($(el).text().trim());
    });

    if (id && teams.length >= 2) {
      matches.push({
        id,
        team1: teams[0],
        team2: teams[1],
        status,
        venue,
        score: scores,
        matchType: "T20",
      });
    }
  });

  return matches;
};

// ── Fetch series matches (uses Puppeteer) ─────────────────

const fetchSeriesMatches = async (seriesId: string): Promise<any[]> => {
  const url = `https://www.cricbuzz.com/cricket-series/${seriesId}/matches`;
  console.log(`[series] Fetching: ${url}`);

  let html: string;
  try {
    html = await fetchHTMLWithBrowser(url);
  } catch (err) {
    console.error(`[series] Browser fetch failed:`, err);
    return [];
  }

  const $ = cheerio.load(html);

  // Detect login wall — if page has login form, Cricbuzz blocked us
  const isLoginWall = $('input[type="password"]').length > 0 ||
    $('*:contains("Log In")').length > 5 ||
    html.includes('cb-login') ||
    html.length < 5000;

  if (isLoginWall) {
    console.log(`[series] Login wall detected — HTML length: ${html.length}`);
    // Try alternate URL format
    try {
      html = await fetchHTMLWithBrowser(`https://www.cricbuzz.com/cricket-series/${seriesId}/`);
    } catch (e) {
      return [];
    }
  }

  const matches: any[] = [];
  const seenIds = new Set<string>();

  // Strategy 1: Find match links with /live-cricket-scores/
  $("a[href*='/live-cricket-scores/']").each((i, el) => {
    const link = $(el).attr('href') || '';
    const parts = link.split('/');
    const matchId = parts[2];
    if (!matchId || seenIds.has(matchId)) return;
    seenIds.add(matchId);

    // Get the full text content of the nearest substantial parent
    let container = $(el);
    for (let depth = 0; depth < 6; depth++) {
      container = container.parent();
      if (container.text().trim().length > 30) break;
    }

    const fullText = container.text().trim();

    // Extract teams from URL slug (most reliable)
    let teams = '';
    const slug = parts[3] || '';
    const vsIdx = slug.indexOf('-vs-');
    if (vsIdx > -1) {
      const t1 = slug.substring(0, vsIdx).split('-').map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      const t2 = slug.substring(vsIdx + 4).split('-')[0].split('-').map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      teams = `${t1} vs ${t2}`;
    }

    // Extract result from full text using regex
    let result = '';
    const resultMatch = fullText.match(/([A-Z][a-zA-Z\s]+(?:won by \d+[^,
]{0,40}|tied|drawn|no result|abandoned))/);
    if (resultMatch) {
      result = resultMatch[1].trim();
    }

    // Extract venue — look for city names or ground names
    // Venue is usually a short text NOT containing result keywords
    let venue = '';
    container.find('span, div, p').each((_i: number, el: any) => {
      if (venue) return false;
      const children = $(el).children().length;
      if (children > 2) return; // skip containers
      const txt = $(el).text().trim();
      // Venue: short, no digits, not a login/nav element, not result text
      if (txt &&
          txt.length > 3 &&
          txt.length < 40 &&
          !/\d/.test(txt) &&
          !/log in|sign|register|name:|live|qualifier|upcoming|completed/i.test(txt) &&
          !/won by|tied|drawn|no result/i.test(txt)) {
        venue = txt;
        return false;
      }
    });

    // Extract date
    let date = '';
    const dateMatch = fullText.match(/(\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{4}|\d{4}-\d{2}-\d{2})/i);
    if (dateMatch) date = dateMatch[1];

    console.log(`[series] ID=${matchId} teams="${teams}" result="${result}" venue="${venue}"`);
    matches.push({ matchId, teams, score1: '', score2: '', result, venue, date });
  });

  // Strategy 2: if no matches found via links, try cb-series-matches class
  if (matches.length === 0) {
    console.log('[series] No matches via links — trying cb selectors');
    $('.cb-series-matches, .cb-col-100.cb-series-brdr').each((i, el) => {
      const link = $(el).find('a[href*="/live-cricket-scores/"]').first().attr('href') || '';
      const matchId = link.split('/')[2];
      if (!matchId || seenIds.has(matchId)) return;
      seenIds.add(matchId);

      const teams = $(el).find('.cb-hmscg-tm-nm').map((_: number, t: any) => $(t).text().trim()).get().join(' vs ');
      const result = $(el).find('.cb-text-complete, .cb-text-live').first().text().trim();
      const venue = $(el).find('.cb-venue').first().text().trim();
      matches.push({ matchId, teams, score1: '', score2: '', result, venue, date: '' });
    });
  }

  console.log(`[series] Total: ${matches.length} matches`);
  return matches;
};





// ── Fetch full scorecard for a match ─────────────────
const fetchScorecard = async (matchId: string): Promise<any> => {
  const url = `https://www.cricbuzz.com/live-cricket-scorecard/${matchId}/nz-vs-sa`;
  const html = await fetchHTMLWithBrowser(url);
  const $ = cheerio.load(html);

  const matchName = $("h1.cb-nav-hdr").text().trim();
  const venue = $(".cb-col.cb-col-100.cb-venue-it").text().trim();
  const result = $(".cb-col.cb-col-100.cb-font-12.cb-text-gray").first().text().trim();

  const innings: any[] = [];
  $(".cb-col.cb-col-100.cb-ltst-wgt-hdr").each((i, innEl) => {
    const innTitle = $(innEl).find(".cb-col.cb-col-100.cb-bg-gray").text().trim();
    const batting: any[] = [];
    $(innEl).find(".cb-col.cb-col-100.cb-scrd-itms").each((j, row) => {
      const batsman = $(row).find(".cb-col.cb-col-27").text().trim();
      const runs = $(row).find(".cb-col.cb-col-8.text-bold").text().trim();
      const balls = $(row).find(".cb-col.cb-col-8").eq(1).text().trim();
      const fours = $(row).find(".cb-col.cb-col-8").eq(2).text().trim();
      const sixes = $(row).find(".cb-col.cb-col-8").eq(3).text().trim();
      if (batsman && runs) {
        batting.push({ batsman, runs, balls, fours, sixes });
      }
    });
    innings.push({ title: innTitle, batting });
  });

  return { matchName, venue, result, innings };
};

// ── Existing parseCricketScore (unchanged) ────────────────
const parseCricketScore = ($: cheerio.CheerioAPI): Record<string, string> => {
  const getText = (selector: string): string =>
    $(selector).first().text().trim() || "Match Stats will Update Soon";

  const matchStatuses: string[] = [
    ".cb-col.cb-col-100.cb-min-stts.cb-text-complete",
    ".cb-text-inprogress",
    ".cb-col.cb-col-100.cb-font-18.cb-toss-sts.cb-text-abandon",
    ".cb-text-stumps",
    ".cb-text-lunch",
    ".cb-text-inningsbreak",
    ".cb-text-tea",
    ".cb-text-rain",
    ".cb-text-wetoutfield",
    ".cb-text-delay",
    ".cb-col.cb-col-100.cb-font-18.cb-toss-sts.cb-text-",
  ];

  const matchUpdate = matchStatuses
    .map((selector) => $(selector).first().text().trim())
    .find((status) => status) || "Match Stats will Update Soon";

  const matchDateElement = $('span[itemprop="startDate"]').attr("content");
  const matchDate =
    matchDateElement &&
    new Date(matchDateElement).toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
      hour12: true,
    });

  return {
    title: getText("h1.cb-nav-hdr").replace(" - Live Cricket Score, Commentary", "").trim(),
    update: matchUpdate,
    matchDate: matchDate ? `Date: ${matchDate}` : "Match Stats will Update Soon",
    livescore: getText(".cb-font-20.text-bold"),
    runrate: `${getText(".cb-font-12.cb-text-gray")}`,
  };
};

const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };

// ── Existing /score endpoint ──────────────────────────────
app.get(
  "/score",
  asyncHandler(async (req: Request, res: Response) => {
    const id = req.query.id as string;
    if (!id) {
      res.status(400).json({ error: "Match ID is required" });
      return;
    }
    const url = `https://www.cricbuzz.com/live-cricket-scores/${id}`;
    const html = await fetchHTML(url);
    const $ = cheerio.load(html);
    const matchData = parseCricketScore($);
    res.json(matchData);
  })
);

// ── Existing /live endpoint ───────────────────────────────
app.get(
  "/live",
  asyncHandler(async (req: Request, res: Response) => {
    try {
      const liveMatches = await fetchLiveMatches();
      res.json(liveMatches);
    } catch (err) {
      console.error("Error fetching live matches:", err);
      res.status(500).json({ error: "Failed to fetch live matches" });
    }
  })
);

// ── NEW: /series/:seriesId/matches endpoint ───────────────
app.get(
  "/series/:seriesId/matches",
  asyncHandler(async (req: Request, res: Response) => {
    const seriesId = req.params.seriesId;
    try {
      const matches = await fetchSeriesMatches(seriesId);
      res.json(matches);
    } catch (err) {
      console.error("Error fetching series matches:", err);
      res.status(500).json({ error: "Failed to fetch series matches" });
    }
  })
);

// ── NEW: /scorecard/:matchId endpoint ─────────────────────
app.get(
  "/scorecard/:matchId",
  asyncHandler(async (req: Request, res: Response) => {
    const matchId = req.params.matchId;
    try {
      const scorecard = await fetchScorecard(matchId);
      res.json(scorecard);
    } catch (err) {
      console.error("Error fetching scorecard:", err);
      res.status(500).json({ error: "Failed to fetch scorecard" });
    }
  })
);

// ── Debug endpoint to view raw HTML ───────────────────────
app.get(
  "/debug/series/:seriesId/html",
  asyncHandler(async (req: Request, res: Response) => {
    const seriesId = req.params.seriesId;
    const url = `https://www.cricbuzz.com/cricket-series/${seriesId}/matches`;
    try {
      const html = await fetchHTMLWithBrowser(url);
      res.setHeader('Content-Type', 'text/html');
      res.send(html);
    } catch (err) {
      console.error("[debug] Error fetching HTML:", err);
      res.status(500).send("Error fetching HTML: " + (err instanceof Error ? err.message : String(err)));
    }
  })
);

// ── Debug: view raw live scores HTML ─────────────────────
app.get(
  "/debug/live/html",
  asyncHandler(async (req: Request, res: Response) => {
    try {
      const html = await fetchHTMLWithBrowser("https://www.cricbuzz.com/cricket-match/live-scores");
      res.setHeader('Content-Type', 'text/html');
      res.send(html);
    } catch (err) {
      res.status(500).send("Error: " + (err instanceof Error ? err.message : String(err)));
    }
  })
);

// ── Debug: check what selectors are matched ───────────────
app.get(
  "/debug/live/selectors",
  asyncHandler(async (req: Request, res: Response) => {
    try {
      const html = await fetchHTMLWithBrowser("https://www.cricbuzz.com/cricket-match/live-scores");
      const $ = cheerio.load(html);
      const debug = {
        total_cb_mtch: $(".cb-mtch-lst").length,
        total_cb_col_100: $(".cb-col-100").length,
        total_links: $("a[href*='/live-cricket-scores/']").length,
        total_live_well: $("a.cb-lv-scrs-well").length,
        sample_html: $("body").html()?.substring(0, 2000) || 'empty',
      };
      res.json(debug);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  })
);

// 404 handler
app.use((req: Request, res: Response) => {
  res.status(404).json({ error: 'Resource not found' });
});

app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`Server PORT: ${PORT}`);
});
