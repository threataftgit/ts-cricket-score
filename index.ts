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
app.use(express.urlencoded({ extended: true }));
app.use(setSecureHeaders);
app.disable("x-powered-by");
app.use(express.static(path.join(__dirname, '.', 'public')));

app.get('/', (req: Request, res: Response) => {
  res.sendFile(path.join(__dirname, '.', 'public', 'index.html'));
});

// ── Simple axios fetch (non-Cloudflare endpoints) ────────
const fetchHTML = async (url: string): Promise<string> => {
  try {
    const response = await axios.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      },
    });
    return response.data;
  } catch (error) {
    throw new Error("Failed to fetch the HTML content");
  }
};

// ── Shared browser — singleton, reused across requests ──
let sharedBrowser: any = null;
const activePages = new Set<any>(); // FIX: track open pages to avoid leaks

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
    sharedBrowser.on('disconnected', () => {
      console.log('[browser] Browser disconnected — will restart on next request');
      sharedBrowser = null;
      activePages.clear(); // FIX: drop all tracked pages from dead browser
    });
  }
  return sharedBrowser;
}

// ── Puppeteer fetch — reuses browser, closes only the page ─
const fetchHTMLWithBrowser = async (url: string): Promise<string> => {
  const browser = await getSharedBrowser();
  const page = await browser.newPage();
  activePages.add(page); // FIX: track page
  try {
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    );
    await page.setRequestInterception(true);
    page.on('request', (req: any) => {
      if (['image', 'media', 'font', 'stylesheet'].includes(req.resourceType())) {
        req.abort();
      } else {
        req.continue();
      }
    });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });

    // FIX: smart wait — wait for meaningful content selectors instead of blind 1500ms sleep
    try {
      await page.waitForSelector(
        '.cb-min-stts, .cb-text-complete, .cb-text-inprogress, a[href*="/live-cricket-scores/"], .cb-scrd-itms',
        { timeout: 5000 }
      );
    } catch {
      // selector didn't appear in time — proceed with whatever loaded
    }

    return await page.content();
  } finally {
    activePages.delete(page); // FIX: untrack before closing
    await page.close();
  }
};

// ── Helper: detect match type from slug/text ─────────────
function detectMatchType(slug: string, cardText: string): string {
  // FIX: was always hardcoded 'T20'
  if (/\btest\b/i.test(slug) || /\btest match\b/i.test(cardText)) return 'Test';
  if (/\bodi\b/i.test(slug) || /\bone.?day/i.test(cardText)) return 'ODI';
  if (/\bt20i?\b/i.test(slug) || /\bt20\b/i.test(cardText)) return 'T20';
  return 'T20'; // sensible fallback
}

// ── Fetch live matches ───────────────────────────────────
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

    const slug = parts[3] || '';
    const vsIdx = slug.indexOf('-vs-');
    let team1 = '', team2 = '';

    if (vsIdx > -1) {
      const stripDesc = (s: string) => s
        .replace(/-[0-9].*$/, '')
        .replace(/-(?:final|semi|quarter|qualifier|warm|practice|tour|series|of|the|and).*$/i, '');
      team1 = stripDesc(slug.substring(0, vsIdx)).toUpperCase();
      team2 = stripDesc(slug.substring(vsIdx + 4)).toUpperCase();
    }

    const card = $(el).parent().parent();
    const cardText = card.text().replace(/\s+/g, ' ').trim().substring(0, 500);
    const isLive = /live|batting|bowling|(?:[0-9]+\/[0-9]+)/i.test(cardText);

    // Get text from leaf nodes only
    const textOnly = card.find('*').map((_: number, el: any) => {
      if ($(el).children().length === 0) return $(el).text().trim();
      return '';
    }).get().join(' ');

    // FIX: also extract overs from card text
    const scorePattern = /([0-9]{1,3})\/([0-9]{1,2})/g;
    const scores: any[] = [];
    let sm: RegExpExecArray | null;

    while ((sm = scorePattern.exec(textOnly)) !== null) {
      const runs = parseInt(sm[1]);
      const wkts = parseInt(sm[2]);
      if (runs <= 500 && wkts <= 10) {
        // FIX: extract overs from surrounding text around this score
        const surroundingText = textOnly.substring(Math.max(0, sm.index - 30), sm.index + 30);
        const oversMatch = surroundingText.match(/([0-9]+\.?[0-9]*)\s*(?:ov(?:ers?)?|Ov)/i)
          || textOnly.match(/([0-9]+\.?[0-9]*)\s*(?:ov(?:ers?)?|Ov)/i);
        scores.push({
          r: runs,
          w: wkts,
          o: oversMatch ? oversMatch[1] : '0.0', // FIX: real overs instead of hardcoded '0.0'
          inning: scores.length === 0 ? '1st' : '2nd',
        });
        if (scores.length >= 2) break;
      }
    }

    // Venue extraction
    let venue = '';
    card.find('span, p').each((_: number, el: any) => {
      if (venue || $(el).children().length > 0) return;
      const txt = $(el).text().trim();
      if (txt && txt.length > 3 && txt.length < 40 &&
          !txt.includes(' vs ') && !/[0-9]/.test(txt) &&
          !/log.?in|sign|menu|live|won|tied|drawn|upcoming|match|t20|odi|test/i.test(txt)) {
        venue = txt;
        return false as any;
      }
    });

    // FIX: detect which team is batting from card text
    let battingTeamIdx = 0; // default: first team is batting
    if (scores.length >= 2) {
      // 2 innings present — second innings is current batting team
      battingTeamIdx = 1;
    } else if (/\b(batting|bat)\b/i.test(cardText)) {
      // Check which team name appears before "batting"
      const battingPos = cardText.search(/\bbatting\b/i);
      const t1Pos = team1 ? cardText.toUpperCase().indexOf(team1) : -1;
      const t2Pos = team2 ? cardText.toUpperCase().indexOf(team2) : -1;
      if (t2Pos > -1 && t2Pos < battingPos && (t1Pos === -1 || t2Pos > t1Pos)) {
        battingTeamIdx = 1;
      }
    }

    // FIX: detect match type properly
    const matchType = detectMatchType(slug, cardText);

    matches.push({
      id: matchId,
      team1: team1 || slug.split('-')[0].toUpperCase(),
      team2: team2 || (slug.split('-')[2] || '').toUpperCase(),
      teams: [team1, team2].filter(Boolean),
      status: isLive ? 'live' : 'upcoming',
      venue,
      score: scores,
      matchType,
      battingTeamIdx, // FIX: export which index is batting (0 or 1)
    });
  });

  console.log(`[live] Found ${matches.length} matches`);
  return matches;
};

// ── Series cache ─────────────────────────────────────────
const seriesCache: Record<string, { data: any[]; ts: number }> = {};
const SERIES_CACHE_TTL = 10 * 60 * 1000; // 10 minutes
const seriesInProgress: Record<string, Promise<any[]> | null> = {};

const fetchSeriesMatches = async (seriesId: string): Promise<any[]> => {
  const cached = seriesCache[seriesId];
  if (cached && Date.now() - cached.ts < SERIES_CACHE_TTL) {
    console.log(`[series] Cache hit for ${seriesId} (${cached.data.length} matches)`);
    return cached.data;
  }

  if (seriesInProgress[seriesId] != null) {
    console.log(`[series] Already fetching ${seriesId} — deduplicating`);
    return seriesInProgress[seriesId] as Promise<any[]>;
  }

  const url = `https://www.cricbuzz.com/cricket-series/${seriesId}/matches`;
  console.log(`[series] Fetching: ${url}`);

  const fetchPromise = (async () => {
    let html: string;
    try {
      html = await fetchHTMLWithBrowser(url);
    } catch (err) {
      console.error('[series] Fetch failed:', err);
      return [];
    }

    const $ = cheerio.load(html);
    const matchLinks: Array<{ matchId: string; slug: string }> = [];
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

    // FIX: process in parallel batches of 3 instead of sequential (was N × Puppeteer pages in series)
    const CONCURRENCY = 3;
    for (let i = 0; i < matchLinks.length; i += CONCURRENCY) {
      const batch = matchLinks.slice(i, i + CONCURRENCY);

      const batchResults = await Promise.allSettled(
        batch.map(async ({ matchId, slug }) => {
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
            if ((slug.includes('south-africa') || slug.includes('rsa')) &&
                (slug.includes('new-zealand') || slug.includes('nz'))) {
              if (slug.includes('-w-') || slug.includes('women') || slug.includes('-nzw') || slug.includes('rsaw')) {
                teams = 'NZW vs RSAW';
              } else {
                teams = 'NZ vs RSA';
              }
            } else {
              teams = slug.split('-').slice(0, 4).join(' ').toUpperCase();
            }
          }

          let result = '';
          let venue = '';

          const scoreHtml = await fetchHTMLWithBrowser(
            `https://www.cricbuzz.com/live-cricket-scores/${matchId}/${slug}`
          );
          const s$ = cheerio.load(scoreHtml);

          result = s$('.cb-text-complete').first().text().trim()
            || s$('.cb-min-stts').first().text().trim()
            || s$('.cb-text-inprogress').first().text().trim()
            || '';

          if (!result) {
            s$('*').each((_i: number, el: any) => {
              if (result) return false as any;
              if (s$(el).children().length > 2) return;
              const txt = s$(el).text().trim();
              if (txt && txt.length < 150 &&
                  /won by [0-9]+ (?:runs?|wickets?|wkts?)|tied|drawn|no result|abandoned/i.test(txt)) {
                result = txt;
                return false as any;
              }
            });
          }

          if (result) {
            const rm = result.match(
              /([A-Za-z][a-zA-Z ]+ (?:won by [0-9]+ (?:runs?|wickets?|wkts?)|tied|drawn|no result|abandoned))/i
            );
            if (rm) result = rm[1].trim();
          }

          const fullPageText = s$('body').text().replace(/\s+/g, ' ');

          venue = s$('.cb-nav-subhdr span').last().text().trim()
            || s$('[itemprop="location"]').text().trim()
            || s$('[class*="venue"]').first().text().trim()
            || '';

          if (!venue) {
            // FIX: broader venue regex to work for IPL and other venues
            const venueMatch = fullPageText.match(
              /(?:at|venue[:\s]+|ground[:\s]+)([A-Z][a-zA-Z ]{4,50})(?:Stadium|Ground|Oval|Park|Arena|Gardens?)/i
            );
            if (venueMatch) {
              const suffix = venueMatch[0].replace(venueMatch[1], '').split(/[,.\s]/)[0];
              venue = venueMatch[1].trim() + ' ' + suffix;
            }
          }

          // Known venue fallback (extended with IPL venues)
          const knownVenues: Record<string, string> = {
            '122687': 'Bay Oval, Mount Maunganui',
            '122698': 'Seddon Park, Hamilton',
            '122709': 'Eden Park, Auckland',
            '122720': 'Sky Stadium, Wellington',
            '122731': 'Hagley Oval, Christchurch',
            '122808': 'Eden Park, Auckland',
            '122819': 'Sky Stadium, Wellington',
            '122825': 'Hagley Oval, Christchurch',
            '122797': 'Seddon Park, Hamilton',
            '122836': 'Bay Oval, Mount Maunganui',
            '122847': 'Bay Oval, Mount Maunganui',
          };
          if (!venue && knownVenues[matchId]) venue = knownVenues[matchId];

          venue = venue.replace(/[0-9]+/g, '').replace(/\s+/g, ' ').trim();

          console.log(`[series] ${matchId} teams="${teams}" result="${result}" venue="${venue}"`);
          return { matchId, slug, teams, result, venue, date: '' };
        })
      );

      for (const res of batchResults) {
        if (res.status === 'fulfilled') {
          matches.push(res.value);
        } else {
          console.error('[series] Batch item failed:', res.reason?.message);
        }
      }

      // FIX: small delay between batches to avoid Cricbuzz rate limiting
      if (i + CONCURRENCY < matchLinks.length) {
        await new Promise(r => setTimeout(r, 500));
      }
    }

    console.log(`[series] Total: ${matches.length}`);
    seriesCache[seriesId] = { data: matches, ts: Date.now() };
    seriesInProgress[seriesId] = null;
    return matches;
  })();

  seriesInProgress[seriesId] = fetchPromise;
  return fetchPromise;
};

// ── Fetch scorecard ───────────────────────────────────────
const fetchScorecard = async (matchId: string, slug?: string): Promise<any> => {
  let matchSlug = slug || 'cricket-scorecard';
  for (const seriesData of Object.values(seriesCache)) {
    const match = (seriesData as any).data?.find((m: any) => m.matchId === matchId);
    if (match) { matchSlug = match.slug || matchSlug; break; }
  }

  const url = `https://www.cricbuzz.com/live-cricket-scorecard/${matchId}/${matchSlug}`;
  console.log(`[scorecard] Fetching: ${url}`);
  const html = await fetchHTMLWithBrowser(url);
  const $ = cheerio.load(html);

  const matchName = $("h1.cb-nav-hdr").text().trim();
  const venue = $(".cb-col.cb-col-100.cb-venue-it").text().trim();
  const result = $(".cb-col.cb-col-100.cb-font-12.cb-text-gray").first().text().trim();

  const innings: any[] = [];

  $(".cb-col.cb-col-100.cb-ltst-wgt-hdr").each((i, innEl) => {
    const innTitle = $(innEl).find(".cb-col.cb-col-100.cb-bg-gray").text().trim();

    // Batting
    const batting: any[] = [];
    $(innEl).find(".cb-col.cb-col-100.cb-scrd-itms").each((j, row) => {
      const batsman = $(row).find(".cb-col.cb-col-27").text().trim();
      const runs = $(row).find(".cb-col.cb-col-8.text-bold").text().trim();
      const balls = $(row).find(".cb-col.cb-col-8").eq(1).text().trim();
      const fours = $(row).find(".cb-col.cb-col-8").eq(2).text().trim();
      const sixes = $(row).find(".cb-col.cb-col-8").eq(3).text().trim();
      if (batsman && runs && !isNaN(Number(runs))) {
        batting.push({ batsman, runs, balls, fours, sixes });
      }
    });

    // FIX: extract bowling data (was completely missing before)
    const bowling: any[] = [];
    $(innEl).find(".cb-col.cb-col-100.cb-scrd-itms").each((j, row) => {
      const bowler = $(row).find(".cb-col.cb-col-40").text().trim();
      const cols = $(row).find(".cb-col.cb-col-8");
      const overs  = cols.eq(0).text().trim();
      const maidens = cols.eq(1).text().trim();
      const runs_b  = cols.eq(2).text().trim();
      const wickets = cols.eq(3).text().trim();
      // bowling rows have overs as a number like "4.0"
      if (bowler && overs && !isNaN(Number(overs))) {
        bowling.push({
          bowler,
          overs,
          maidens: maidens || '0',
          runs: runs_b,
          wickets: wickets || '0',
        });
      }
    });

    innings.push({ title: innTitle, batting, bowling });
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
    .map(selector => $(selector).first().text().trim())
    .find(status => status) || "Match Stats will Update Soon";

  const matchDateElement = $('span[itemprop="startDate"]').attr("content");
  // Send raw UTC ISO string — client will format in user's local timezone
  const matchDateUTC = matchDateElement ? new Date(matchDateElement).toISOString() : null;

  return {
    title: getText("h1.cb-nav-hdr").replace(" - Live Cricket Score, Commentary", "").trim(),
    update: matchUpdate,
    matchDate: matchDateUTC,          // raw UTC ISO string
    matchDateFormatted: matchDateUTC  // alias for backward compat
      ? new Date(matchDateUTC).toLocaleString("en-IN", {
          timeZone: "Asia/Kolkata",
          hour12: true,
          day: "2-digit", month: "short", year: "numeric",
          hour: "2-digit", minute: "2-digit"
        }) + " IST"
      : "Match Stats will Update Soon",
    livescore: getText(".cb-font-20.text-bold"),
    runrate: `${getText(".cb-font-12.cb-text-gray")}`,
  };
};

const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };

// ── /score endpoint (unchanged) ──────────────────────────
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
    res.json(parseCricketScore($));
  })
);

// ── Live match cache ─────────────────────────────────────
let liveMatchCache: any[] = [];
let liveCacheTime = 0;
const LIVE_CACHE_TTL = 60 * 1000; // 60 seconds
let lastLiveCount = -1;

async function refreshLiveCache() {
  try {
    const matches = await fetchLiveMatches();
    liveMatchCache = matches;
    liveCacheTime = Date.now();
    if (matches.length !== lastLiveCount) {
      console.log(`[cache] Live matches updated: ${matches.length}`);
      lastLiveCount = matches.length;
    }
  } catch (err) {
    console.error('[cache] Live refresh failed:', err);
  }
}

refreshLiveCache();
setInterval(refreshLiveCache, LIVE_CACHE_TTL);

// ── /live ─────────────────────────────────────────────────
app.get(
  "/live",
  asyncHandler(async (req: Request, res: Response) => {
    const age = Math.round((Date.now() - liveCacheTime) / 1000);
    res.json({
      matches: liveMatchCache,
      cached: true,
      ageSeconds: age,
      count: liveMatchCache.length,
    });
  })
);

// ── /live/cricket ─────────────────────────────────────────
app.get(
  "/live/cricket",
  asyncHandler(async (req: Request, res: Response) => {
    const cricket = liveMatchCache.filter((m: any) =>
      ['T20', 'T20I', 'ODI', 'Test'].includes(m.matchType)
    );
    res.json({ matches: cricket, count: cricket.length });
  })
);

// ── /series/:seriesId/matches ─────────────────────────────
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

// ── /scorecard/:matchId ───────────────────────────────────
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

// ── FIX: /health endpoint (was missing entirely) ─────────
app.get('/health', (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    browser: sharedBrowser ? 'running' : 'not_started',
    activePages: activePages.size,
    liveCache: {
      count: liveMatchCache.length,
      ageSeconds: Math.round((Date.now() - liveCacheTime) / 1000),
    },
    seriesCached: Object.keys(seriesCache).length,
    uptime: process.uptime(),
  });
});

// ── Debug: raw HTML ───────────────────────────────────────
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
      res.status(500).send("Error: " + (err instanceof Error ? err.message : String(err)));
    }
  })
);

app.use((req: Request, res: Response) => {
  res.status(404).json({ error: 'Resource not found' });
});

app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`\n🏏 ts-cricket-score running on port ${PORT}`);
  console.log(`📡 /live  |  /series/:id/matches  |  /scorecard/:id  |  /health\n`);
});
