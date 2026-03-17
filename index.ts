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

  $("a[href*='/live-cricket-scores/']").each((i, el) => {
    const link = $(el).attr('href') || '';
    const parts = link.split('/');
    const matchId = parts[2];
    if (!matchId || seenIds.has(matchId)) return;
    seenIds.add(matchId);

    // Extract teams from URL slug — strip match descriptor after team code
    const slug = parts[3] || '';
    const vsIdx = slug.indexOf('-vs-');
    let team1 = '', team2 = '';
    if (vsIdx > -1) {
      // team1: everything before -vs-
      // team2: everything after -vs- but stop at first match-type word
      const rawT1 = slug.substring(0, vsIdx);
      const rawT2 = slug.substring(vsIdx + 4);
      // Strip match descriptors: -1st, -2nd, -3rd, -4th, -5th, -final, -semi, -qualifier
      const stripDesc = (s: string) => s
        .replace(/-[0-9].*$/, '')
        .replace(/-(?:final|semi|quarter|qualifier|warm|practice|tour|series|of|the|and).*$/i, '');
      team1 = stripDesc(rawT1).toUpperCase();
      team2 = stripDesc(rawT2).toUpperCase();
    }

    // Get the immediate link text — often has match status
    const linkText = $(el).text().trim();

    // Walk up carefully — only 1-2 levels to stay within this match card
    const card = $(el).parent().parent();
    const cardText = card.text().replace(/\s+/g, ' ').trim().substring(0, 500);

    // Status — check if any text indicates live
    const isLive = /live|batting|bowling|(?:[0-9]+\/[0-9]+)/i.test(cardText);

    // Score — look for cricket score patterns in TEXT nodes only
    // Valid cricket score: 3 digits max / 1-2 digits, e.g. 175/6, 107/10
    // Reject CSS dimensions like 300/250, 728/90
    const scorePattern = /([0-9]{1,3})\/([0-9]{1,2})/g;
    const scores: any[] = [];
    let sm: RegExpExecArray | null;
    const textOnly = card.find('*').map((_: number, el: any) => {
      // Only get text from leaf nodes (no children)
      if ($(el).children().length === 0) return $(el).text().trim();
      return '';
    }).get().join(' ');

    while ((sm = scorePattern.exec(textOnly)) !== null) {
      const runs = parseInt(sm[1]);
      const wkts = parseInt(sm[2]);
      // Valid cricket: runs 0-500, wickets 0-10
      if (runs <= 500 && wkts <= 10) {
        scores.push({ r: runs, w: wkts, o: '0.0', inning: '' });
        if (scores.length >= 2) break;
      }
    }

    // Venue — find short leaf-node text that looks like a ground/city
    let venue = '';
    card.find('span, p').each((_: number, el: any) => {
      if (venue || $(el).children().length > 0) return;
      const txt = $(el).text().trim();
      if (txt &&
          txt.length > 3 && txt.length < 40 &&
          !txt.includes(' vs ') &&
          !/[0-9]/.test(txt) &&
          !/log.?in|sign|menu|live|won|tied|drawn|upcoming|match|t20|odi|test/i.test(txt)) {
        venue = txt;
        return false;
      }
    });

    matches.push({
      id: matchId,
      team1: team1 || slug.split('-')[0].toUpperCase(),
      team2: team2 || (slug.split('-')[2] || '').toUpperCase(),
      teams: [team1, team2].filter(Boolean),
      status: isLive ? 'live' : 'upcoming',
      venue,
      score: scores,
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

  // Step 1: collect all match IDs and basic info from links
  const matchLinks: Array<{matchId: string, slug: string}> = [];
  $("a[href*='/live-cricket-scores/']").each((i, el) => {
    const link = $(el).attr('href') || '';
    const parts = link.split('/');
    const matchId = parts[2];
    const slug = parts[3] || '';
    if (!matchId || seenIds.has(matchId)) return;
    seenIds.add(matchId);
    matchLinks.push({ matchId, slug });
  });

  console.log(`[series] Found ${matchLinks.length} match links`);

  // Step 2: for each match, use the /score endpoint to get result
  // Process sequentially to avoid hammering Cricbuzz
  for (const { matchId, slug } of matchLinks) {
    // Extract teams from slug
    const vsIdx = slug.indexOf('-vs-');
    let teams = '';
    if (vsIdx > -1) {
      const rawT1 = slug.substring(0, vsIdx)
        .replace(/-[0-9].*$/, '')
        .replace(/-(?:tour|series|of|the|and).*$/i, '');
      const rawT2 = slug.substring(vsIdx + 4)
        .replace(/-[0-9].*$/, '')
        .replace(/-(?:tour|series|of|the|and).*$/i, '');
      teams = `${rawT1.toUpperCase()} vs ${rawT2.toUpperCase()}`;
    } else {
      // No vs in slug — use match number descriptor
      teams = slug.split('-').slice(0, 4).join(' ').toUpperCase();
    }

    // Get result from the score page (fast axios, no Puppeteer)
    let result = '';
    let venue = '';
    try {
      const scoreUrl = `https://www.cricbuzz.com/live-cricket-scores/${matchId}/${slug}`;
      const scoreHtml = await fetchHTML(scoreUrl);
      const s$ = cheerio.load(scoreHtml);

      // Result is in cb-min-stts or cb-text-complete
      result = s$('.cb-text-complete, .cb-min-stts').first().text().trim();

      // Clean result — extract just the result line
      const resultMatch = result.match(/([A-Za-z ]+(?:won by [0-9]+ (?:runs?|wickets?|wkts?)|tied|drawn|no result|abandoned))/i);
      if (resultMatch) result = resultMatch[1].trim();

      // Venue
      venue = s$('.cb-nav-subhdr .cb-font-12').last().text().trim()
        || s$('[itemprop="location"]').text().trim()
        || '';

      // Also try from the match header
      if (!venue) {
        const headerText = s$('h2.cb-nav-hdr').text();
        const venueMatch = headerText.match(/,\s*([A-Za-z ]+)$/);
        if (venueMatch) venue = venueMatch[1].trim();
      }

    } catch (e) {
      // Score page fetch failed — leave result empty
    }

    console.log(`[series] ID=${matchId} teams="${teams}" result="${result}" venue="${venue}"`);
    matches.push({ matchId, teams, score1: '', score2: '', result, venue, date: '' });
  }

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

// ── Cache for live matches — prevents Puppeteer timeout ──
let liveMatchCache: any[] = [];
let liveCacheTime = 0;
const LIVE_CACHE_TTL = 60 * 1000; // 60 seconds

// Background refresh — runs every 60s, doesn't block requests
async function refreshLiveCache() {
  try {
    const matches = await fetchLiveMatches();
    liveMatchCache = matches;
    liveCacheTime = Date.now();
    console.log(`[cache] Live matches updated: ${matches.length}`);
  } catch (err) {
    console.error('[cache] Live refresh failed:', err);
  }
}

// Start background refresh immediately and every 60s
refreshLiveCache();
setInterval(refreshLiveCache, LIVE_CACHE_TTL);

// ── Existing /live endpoint ───────────────────────────────
app.get(
  "/live",
  asyncHandler(async (req: Request, res: Response) => {
    // Always return cached data instantly — no Puppeteer wait
    const age = Math.round((Date.now() - liveCacheTime) / 1000);
    res.json({
      matches: liveMatchCache,
      cached: true,
      ageSeconds: age,
      count: liveMatchCache.length,
    });
  })
);

// ── GET /live/cricket — filtered cricket only ────────────
app.get(
  "/live/cricket",
  asyncHandler(async (req: Request, res: Response) => {
    const cricket = liveMatchCache.filter((m: any) =>
      m.matchType === 'T20' || m.matchType === 'ODI' || m.matchType === 'Test'
    );
    res.json({ matches: cricket, count: cricket.length });
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
