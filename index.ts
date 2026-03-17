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
  const html = await fetchHTML(url);
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
  console.log(`[series] Fetching URL: ${url}`);

  let html: string;
  try {
    html = await fetchHTMLWithBrowser(url);
    console.log(`[series] HTML fetched, length: ${html.length}`);
  } catch (err) {
    console.error(`[series] Error fetching HTML:`, err);
    return [];
  }

  const $ = cheerio.load(html);
  const matches: any[] = [];

  // Find all links to match scorecards
  $("a[href*='/live-cricket-scores/']").each((i, el) => {
    const link = $(el).attr('href');
    const matchId = link ? link.split('/')[2] : null;
    if (!matchId) return;

    // Walk up to find the card container
    const cardDiv = $(el).parent().parent();

    // Extract team names
    const teamDivs = cardDiv.find('div.font-semibold, span.font-semibold');
    const team1 = teamDivs.first().text().trim();
    const team2 = teamDivs.length > 1 ? teamDivs.eq(1).text().trim() : '';
    const teams = team1 && team2 && team1 !== team2 ? `${team1} vs ${team2}` : '';

    // Extract scores
    const scoreDivs = cardDiv.find('div.text-gray-700');
    const score1 = scoreDivs.first().text().trim();
    const score2 = scoreDivs.length > 1 ? scoreDivs.eq(1).text().trim() : '';

    // Extract result — scan ALL text nodes for match result keywords
    let result = '';

    // Method 1: look for keyword-matching text in any element
    cardDiv.find('*').each((_i: number, resEl: any) => {
      if (result) return false;
      const txt = $(resEl).text().trim();
      if (txt && /won by|tied|no result|drawn|abandoned/i.test(txt) && txt.length < 200) {
        result = txt;
        return false;
      }
    });

    // Method 2: any element whose class contains color hints (amber, orange = result text on cricbuzz)
    if (!result) {
      cardDiv.find('[class]').each((_i: number, resEl: any) => {
        if (result) return false;
        const cls = $(resEl).attr('class') || '';
        if (cls.includes('a365') || cls.includes('amber') || cls.includes('orange') || cls.includes('yellow')) {
          const txt = $(resEl).text().trim();
          if (txt && txt.length > 5) { result = txt; return false; }
        }
      });
    }

    // Method 3: get inner HTML and use regex to find result text between tags
    if (!result) {
      const rawHtml = cardDiv.html() || '';
      const match = rawHtml.match(/won by[^<]{3,80}|tied|no result|drawn/i);
      if (match) result = match[0].replace(/<[^>]+>/g, '').trim();
    }

    // Extract venue — look for location-style short text
    let venue = '';
    cardDiv.find('span[class*="gray"], span[class*="text-xs"]').each((_i: number, venEl: any) => {
      if (venue) return false;
      const txt = $(venEl).text().trim();
      if (txt && txt.length > 3 && txt.length < 50 && !/\d{1,2}:\d{2}/.test(txt)) {
        venue = txt; return false;
      }
    });

    console.log(`[series] Match ID=${matchId} teams=${teams} result="${result}" venue=${venue}`);

    if (matchId) {
      matches.push({ matchId, teams: teams || `${team1} vs ${team2}`, score1, score2, result, venue, date: '' });
    }
  });

  console.log(`[series] Total matches extracted: ${matches.length}`);
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

// 404 handler
app.use((req: Request, res: Response) => {
  res.status(404).json({ error: 'Resource not found' });
});

app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`Server PORT: ${PORT}`);
});
