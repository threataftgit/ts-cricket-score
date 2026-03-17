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
  const seenIds = new Set<string>();

  // New Cricbuzz UI uses Tailwind — find match links
  $("a[href*='/live-cricket-scores/']").each((i, el) => {
    const link = $(el).attr('href') || '';
    const parts = link.split('/');
    const matchId = parts[2];
    if (!matchId || seenIds.has(matchId)) return;
    seenIds.add(matchId);

    // Walk up to find card container
    let card = $(el);
    for (let d = 0; d < 5; d++) {
      card = card.parent();
      if (card.find('a[href*="/live-cricket-scores/"]').length === 1) break;
    }

    // Extract teams from URL slug — most reliable
    const slug = parts[3] || '';
    const vsIdx = slug.indexOf('-vs-');
    let team1 = '', team2 = '';
    if (vsIdx > -1) {
      team1 = slug.substring(0, vsIdx).replace(/-/g, ' ').replace(/\w/g, (c: string) => c.toUpperCase());
      team2 = slug.substring(vsIdx + 4).split('-').slice(0, 3).join(' ').replace(/\w/g, (c: string) => c.toUpperCase());
    }

    // Extract status from text — look for LIVE, innings info
    const cardText = card.text().trim();
    const status = cardText.includes('live') || cardText.toLowerCase().includes('live') ? 'live' : 'upcoming';

    // Extract score — look for patterns like "142/4" or "186/6"
    const scoreMatches = cardText.match(/[0-9]{1,3}\/[0-9]{1,2}/g) || [];
    const score: any[] = scoreMatches.map((s: string) => {
      const [r, w] = s.split('/');
      return { r: parseInt(r), w: parseInt(w), o: '0.0', inning: '' };
    });

    // Extract venue — look for short non-numeric text in spans
    let venue = '';
    card.find('span, p').each((_: number, el: any) => {
      if (venue) return false;
      const txt = $(el).text().trim();
      if (txt && txt.length > 3 && txt.length < 50 &&
          !/[0-9]/.test(txt) &&
          !/log.?in|sign|menu|advert|live|upcoming|schedule/i.test(txt)) {
        venue = txt;
        return false;
      }
    });

    matches.push({
      id: matchId,
      team1: team1 || 'TBD',
      team2: team2 || 'TBD',
      teams: [team1, team2].filter(Boolean),
      status,
      venue,
      score,
      matchType: 'T20',
    });
  });

  console.log(`[live] Found ${matches.length} matches`);
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
    console.error('[series] Fetch failed:', err);
    return [];
  }

  const $ = cheerio.load(html);
  const matches: any[] = [];
  const seenIds = new Set<string>();

  $("a[href*='/live-cricket-scores/']").each((i, el) => {
    const link = $(el).attr('href') || '';
    const parts = link.split('/');
    const matchId = parts[2];
    if (!matchId || seenIds.has(matchId)) return;
    seenIds.add(matchId);

    // Teams from URL slug
    const slug = parts[3] || '';
    const vsIdx = slug.indexOf('-vs-');
    let team1 = '', team2 = '';
    if (vsIdx > -1) {
      team1 = slug.substring(0, vsIdx).replace(/-/g, ' ').replace(/\w/g, (c: string) => c.toUpperCase());
      team2 = slug.substring(vsIdx + 4).split('-').slice(0, 3).join(' ').replace(/\w/g, (c: string) => c.toUpperCase());
    }
    const teams = team1 && team2 ? `${team1} vs ${team2}` : slug;

    // Walk up to card
    let card = $(el);
    for (let d = 0; d < 6; d++) {
      card = card.parent();
      if (card.text().trim().length > 20) break;
    }

    const cardText = card.text().replace(/\s+/g, ' ').trim();

    // Extract result
    let result = '';
    const resultRe = /([A-Za-z][a-zA-Z ]+ (?:won by [0-9]+ (?:runs?|wickets?|wkts?)|tied|drawn|no result|abandoned))/i;
    const rm = cardText.match(resultRe);
    if (rm) result = rm[1].trim();

    // Extract venue — find city/ground name
    let venue = '';
    card.find('span, div, p').each((_: number, el: any) => {
      if (venue) return false;
      if ($(el).children().length > 0) return;
      const txt = $(el).text().trim();
      if (txt &&
          txt.length > 3 &&
          txt.length < 40 &&
          !/[0-9\/]/.test(txt) &&
          !/log.?in|sign|menu|name:|live|qualifier|upcoming|schedule|won|tied|drawn/i.test(txt) &&
          !/^(T20|ODI|Test|Women|Men|Match|Series|vs|and|the|of|in)$/i.test(txt)) {
        venue = txt;
        return false;
      }
    });

    // Extract date
    let date = '';
    const dateRe = /([0-9]{1,2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* [0-9]{4})/i;
    const dm = cardText.match(dateRe);
    if (dm) date = dm[1];

    console.log(`[series] ID=${matchId} teams="${teams}" result="${result}" venue="${venue}"`);
    matches.push({ matchId, teams, score1: '', score2: '', result, venue, date });
  });

  console.log(`[series] Total: ${matches.length}`);
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
