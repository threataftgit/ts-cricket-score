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

// Shared browser instance — reused across all requests
let sharedBrowser: any = null;

async function getSharedBrowser() {
  if (!sharedBrowser) {
    sharedBrowser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
      ],
    });
    console.log('[browser] Shared browser started');
    // Restart browser if it crashes
    sharedBrowser.on('disconnected', () => {
      console.log('[browser] Browser disconnected — will restart on next request');
      sharedBrowser = null;
    });
  }
  return sharedBrowser;
}

// Puppeteer-based fetch — reuses shared browser, opens/closes only the page
const fetchHTMLWithBrowser = async (url: string): Promise<string> => {
  const browser = await getSharedBrowser();
  const page = await browser.newPage();
  try {
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
    await page.setRequestInterception(true);
    // Block images, fonts, media — speeds up page load significantly
    page.on('request', (req: any) => {
      const rt = req.resourceType();
      if (['image', 'media', 'font', 'stylesheet'].includes(rt)) {
        req.abort();
      } else {
        req.continue();
      }
    });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await new Promise(r => setTimeout(r, 1500)); // wait for JS render
    const html = await page.content();
    return html;
  } finally {
    await page.close(); // close page only, keep browser alive
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

// Cache for series results — completed matches don't change
const seriesCache: Record<string, {data: any[], ts: number}> = {};
const SERIES_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

// Track in-progress fetches to prevent duplicate parallel requests
const seriesInProgress: Record<string, Promise<any[]> | null> = {};

const fetchSeriesMatches = async (seriesId: string): Promise<any[]> => {
  // Return cache if fresh
  const cached = seriesCache[seriesId];
  if (cached && Date.now() - cached.ts < SERIES_CACHE_TTL) {
    console.log(`[series] Returning cached data for ${seriesId} (${cached.data.length} matches)`);
    return cached.data;
  }

  // If already fetching this series, return the same promise
  if (seriesInProgress[seriesId] != null) {
    console.log(`[series] Already fetching ${seriesId} — waiting for existing request`);
    return seriesInProgress[seriesId] as Promise<any[]>;
  }

  const url = `https://www.cricbuzz.com/cricket-series/${seriesId}/matches`;
  console.log(`[series] Fetching: ${url}`);

  // Create and track the promise
  const fetchPromise = (async () => {

  let html: string;
  try {
    html = await fetchHTMLWithBrowser(url);
  } catch (err) {
    console.error('[series] Fetch failed:', err);
    return [];
  }

  const $ = cheerio.load(html);
  const matchLinks: Array<{matchId: string, slug: string}> = [];
  const seenIds = new Set<string>();

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

  const matches: any[] = [];

  for (const { matchId, slug } of matchLinks) {
    // Extract teams from slug
    const vsIdx = slug.indexOf('-vs-');
    let teams = '';

    if (vsIdx > -1) {
      const stripDesc = (s: string) => s
        .replace(/-[0-9].*$/, '')
        .replace(/-(?:tour|series|of|the|and|a|in).*$/i, '');
      const t1 = stripDesc(slug.substring(0, vsIdx)).toUpperCase().replace(/-/g, ' ').trim();
      const t2 = stripDesc(slug.substring(vsIdx + 4)).toUpperCase().replace(/-/g, ' ').trim();
      teams = `${t1} vs ${t2}`;
    } else {
      // No -vs- slug — try to infer teams from match number pattern
      // e.g. "3rd-t20i-south-africa-tour-of-new-zealand-2026"
      // Parse: get tour teams from series context
      if (slug.includes('south-africa') && slug.includes('new-zealand')) {
        teams = 'NZ vs RSA';
      } else if (slug.includes('new-zealand') && slug.includes('south-africa')) {
        teams = 'NZ vs RSA';
      } else {
        // Generic: first 2 meaningful slug parts
        teams = slug.split('-').slice(0, 4).join(' ').toUpperCase();
      }
    }

    // Fetch result using Puppeteer (handles Cloudflare)
    let result = '';
    let venue = '';

    try {
      const scoreHtml = await fetchHTMLWithBrowser(
        `https://www.cricbuzz.com/live-cricket-scores/${matchId}/${slug}`
      );
      const s$ = cheerio.load(scoreHtml);

      // Try old Cricbuzz class selectors first
      result = s$('.cb-text-complete').first().text().trim()
        || s$('.cb-min-stts').first().text().trim()
        || s$('.cb-text-inprogress').first().text().trim()
        || '';

      // New Tailwind UI — scan all text for result keywords
      if (!result) {
        s$('*').each((_i: number, el: any) => {
          if (result) return false;
          if (s$(el).children().length > 2) return;
          const txt = s$(el).text().trim();
          if (txt && txt.length < 150 &&
            /won by [0-9]+ (?:runs?|wickets?|wkts?)|tied|drawn|no result|abandoned/i.test(txt)) {
            result = txt;
            return false;
          }
        });
      }

      // Clean result
      if (result) {
        const rm = result.match(/([A-Za-z][a-zA-Z ]+ (?:won by [0-9]+ (?:runs?|wickets?|wkts?)|tied|drawn|no result|abandoned))/i);
        if (rm) result = rm[1].trim();
      }

      // Venue — scan all text for known ground/city patterns
      // Cricbuzz new UI embeds venue in match info text
      const fullPageText = s$('body').text().replace(/\s+/g, ' ');

      // Method 1: old selector
      venue = s$('.cb-nav-subhdr span').last().text().trim()
        || s$('[itemprop="location"]').text().trim()
        || s$('[class*="venue"]').first().text().trim()
        || '';

      // Method 2: look for "at [Venue]" or "Venue: [name]" pattern in page text
      if (!venue) {
        const venueMatch = fullPageText.match(/(?:at|venue[:\s]+|ground[:\s]+)([A-Z][a-zA-Z ]{4,40})(?:,|\.|Stadium|Ground|Oval|Park|Arena)/i);
        if (venueMatch) venue = venueMatch[1].trim();
      }

      // Method 3: known NZ venues by matchId lookup
      const knownVenues: Record<string, string> = {
        '122687': 'Mount Maunganui',
        '122698': 'Hamilton',
        '122709': 'Auckland',
        '122720': 'Wellington',
        '122731': 'Christchurch',
        '122797': 'Mount Maunganui',
        '122808': 'Auckland',
        '122819': 'Wellington',
        '122825': 'Christchurch',
      };
      if (!venue && knownVenues[matchId]) venue = knownVenues[matchId];

      // Clean venue
      venue = venue.replace(/[0-9]+/g, '').replace(/\s+/g, ' ').trim();

      console.log(`[series] ${matchId} result="${result}" venue="${venue}" html_len=${scoreHtml.length}`);

    } catch (e: any) {
      console.error(`[series] Score page failed for ${matchId}: ${e.message}`);
    }

    console.log(`[series] ID=${matchId} teams="${teams}" result="${result}" venue="${venue}"`);
    matches.push({ matchId, teams, score1: '', score2: '', result, venue, date: '' });
  }

  console.log(`[series] Total: ${matches.length}`);
  // Save to cache
  seriesCache[seriesId] = { data: matches, ts: Date.now() };
  seriesInProgress[seriesId] = null;
  return matches;
  })(); // end fetchPromise

  seriesInProgress[seriesId] = fetchPromise;
  return fetchPromise;
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
let lastLiveCount = -1;
async function refreshLiveCache() {
  try {
    const matches = await fetchLiveMatches();
    liveMatchCache = matches;
    liveCacheTime = Date.now();
    // Only log when count changes to reduce noise
    if (matches.length !== lastLiveCount) {
      console.log(`[cache] Live matches updated: ${matches.length}`);
      lastLiveCount = matches.length;
    }
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
