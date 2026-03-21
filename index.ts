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
    const fs = require('fs');
    const { execSync } = require('child_process');

    // Find real Chromium — skip snap stubs which fail in Railway containers
    const executablePath: string | undefined = process.env.PUPPETEER_EXECUTABLE_PATH || (() => {
      // 1. Try `which chromium` — skip snap wrappers
      try {
        const w = execSync('which chromium', { timeout: 3000 }).toString().trim();
        if (w && !w.includes('snap') && fs.existsSync(w)) return w;
      } catch {}

      // 2. Search Nix store for real chromium binary
      try {
        const found = execSync(
          'find /nix/store -name "chromium" -type f 2>/dev/null | grep "/bin/chromium$" | head -1',
          { timeout: 5000 }
        ).toString().trim();
        if (found && fs.existsSync(found)) return found;
      } catch {}

      // 3. Common Nix profile paths
      const candidates = [
        '/nix/var/nix/profiles/default/bin/chromium',
        '/root/.nix-profile/bin/chromium',
        '/usr/local/bin/chromium',
      ];
      for (const p of candidates) {
        try { if (fs.existsSync(p)) return p; } catch {}
      }

      return undefined;
    })();

    console.log(`[browser] Using: ${executablePath || 'puppeteer bundled chrome'}`);

    sharedBrowser = await puppeteer.launch({
      headless: true,
      executablePath,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-default-apps',
        '--mute-audio',
      ],
    });
    console.log('[browser] Shared browser started');
    sharedBrowser.on('disconnected', () => {
      console.log('[browser] Browser disconnected — will restart on next request');
      sharedBrowser = null;
      activePages.clear();
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

    // FIX: wait for either old cb-* selectors OR new table-based UI
    try {
      await page.waitForSelector(
        '.cb-min-stts, .cb-text-complete, .cb-text-inprogress, ' +
        'a[href*="/live-cricket-scores/"], .cb-scrd-itms, ' +
        'table th, [class*="scorecard"], [class*="innings"]',
        { timeout: 6000 }
      );
    } catch {
      // selector didn't appear — proceed with whatever loaded
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
// ── Scorecard cache ───────────────────────────────────────────────────────────
const scorecardCache: Record<string, { data: any; ts: number }> = {};
const SCORECARD_TTL = 10 * 60 * 1000;

// ── CricAPI scorecard — clean JSON, no scraping, works for all IPL matches ───
async function fetchScorecardFromAPI(matchId: string): Promise<any | null> {
  const apiKey = process.env.CRICKET_API_KEY;
  if (!apiKey) return null;
  try {
    const url = `https://api.cricapi.com/v1/match_scorecard?apikey=${apiKey}&id=${matchId}`;
    const res  = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) { console.warn(`[scorecard] CricAPI HTTP ${res.status}`); return null; }
    const json = await res.json();
    if (json.status !== 'success' || !json.data) return null;
    const d = json.data;
    const innings: any[] = [];
    for (const inn of (d.scorecard || [])) {
      const batting: any[] = [];
      for (const b of (inn.batting || [])) {
        if (b.batsman?.name && b.r !== undefined) {
          batting.push({ batsman: b.batsman.name, runs: String(b.r ?? 0), balls: String(b.b ?? 0), fours: String(b["4s"] ?? 0), sixes: String(b["6s"] ?? 0) });
        }
      }
      const bowling: any[] = [];
      for (const b of (inn.bowling || [])) {
        if (b.bowler?.name && b.o !== undefined) {
          bowling.push({ bowler: b.bowler.name, overs: String(b.o), maidens: String(b.m ?? 0), runs: String(b.r ?? 0), wickets: String(b.w ?? 0) });
        }
      }
      if (batting.length || bowling.length) {
        innings.push({ title: inn.inning || `Innings ${innings.length + 1}`, batting, bowling });
      }
    }
    return { matchName: d.name || "", venue: d.venue || "", result: d.status || "", innings, source: "cricapi" };
  } catch (e: any) {
    console.warn("[scorecard] CricAPI error:", e.message);
    return null;
  }
}

// Known slugs for completed matches — avoids depending on series cache
const KNOWN_SLUGS: Record<string, string> = {
  // Men's NZ vs SA
  '122687': 'new-zealand-vs-south-africa-1st-t20i',
  '122698': 'new-zealand-vs-south-africa-2nd-t20i',
  '122709': 'new-zealand-vs-south-africa-3rd-t20i',
  '122720': 'new-zealand-vs-south-africa-4th-t20i',
  '122731': 'new-zealand-vs-south-africa-5th-t20i',
  // Women's NZ vs SA
  '122783': 'new-zealand-women-vs-south-africa-women-1st-t20i',
  '122797': 'new-zealand-women-vs-south-africa-women-2nd-t20i',
  '122836': 'new-zealand-women-vs-south-africa-women-3rd-t20i',
  '122847': 'new-zealand-women-vs-south-africa-women-4th-t20i',
  '122858': 'new-zealand-women-vs-south-africa-women-5th-t20i',
};

const fetchScorecard = async (matchId: string, slug?: string): Promise<any> => {
  // Check cache first
  const cached = scorecardCache[matchId];
  if (cached && Date.now() - cached.ts < SCORECARD_TTL) {
    console.log(`[scorecard] Cache hit: ${matchId}`);
    return cached.data;
  }

  // Try CricAPI first — works for ALL matches including IPL, no scraping
  const apiResult = await fetchScorecardFromAPI(matchId);
  if (apiResult && apiResult.innings?.length > 0) {
    scorecardCache[matchId] = { data: apiResult, ts: Date.now() };
    console.log(`[scorecard] CricAPI success: ${matchId}`);
    return apiResult;
  }

  // Fallback: Puppeteer scraper (only for NZ vs SA with known slugs)
  // Priority: explicit slug → known slugs map → series cache → generic fallback
  let matchSlug = slug
    || KNOWN_SLUGS[matchId]
    || (() => {
        for (const seriesData of Object.values(seriesCache)) {
          const match = (seriesData as any).data?.find((m: any) => m.matchId === matchId);
          if (match?.slug) return match.slug;
        }
        return null;
      })()
    || 'cricket-scorecard';

  // Try scorecard URL, then live-scores URL as fallback
  const urlsToTry = [
    `https://www.cricbuzz.com/live-cricket-scorecard/${matchId}/${matchSlug}`,
    `https://www.cricbuzz.com/live-cricket-scores/${matchId}/${matchSlug}`,
  ];

  let html = '';
  let usedUrl = '';
  for (const tryUrl of urlsToTry) {
    try {
      console.log(`[scorecard] Fetching: ${tryUrl}`);
      html = await fetchHTMLWithBrowser(tryUrl);
      if (html.length > 10000) { usedUrl = tryUrl; break; }
    } catch(e: any) {
      console.warn(`[scorecard] Fetch failed ${tryUrl}: ${e.message}`);
    }
  }

  if (!html) return { matchName: '', venue: '', result: '', innings: [] };

  const $ = cheerio.load(html);
  const fullText = $('body').text().replace(/\s+/g, ' ').trim();

  // ── Match meta ────────────────────────────────────────────
  const matchName = $("h1.cb-nav-hdr").first().text().trim()
    || $(".cb-nav-hdr").first().text().trim()
    || $('h1').first().text().trim()
    || '';

  const venue = $(".cb-col.cb-col-100.cb-venue-it").text().trim()
    || $("[class*='venue']").first().text().trim()
    || $('[itemprop="location"]').text().trim()
    || '';

  let result = $(".cb-col.cb-col-100.cb-min-stts").first().text().trim()
    || $(".cb-text-complete").first().text().trim()
    || $(".cb-col.cb-col-100.cb-font-12.cb-text-gray").first().text().trim()
    || '';
  if (!result) {
    // Scan all elements for result text
    $('*').each((_i: number, el: any) => {
      if (result) return false as any;
      if ($(el).children().length > 2) return;
      const txt = $(el).text().trim();
      if (txt && txt.length < 150 &&
          /won by \d+ (?:runs?|wickets?|wkts?)|tied|drawn|no result|abandoned/i.test(txt)) {
        result = txt;
      }
    });
  }

  const innings: any[] = [];

  // ══════════════════════════════════════════════════════════
  // STRATEGY 1 — Old Cricbuzz class-based selectors
  // Works on pages that haven't migrated to new Tailwind UI
  // ══════════════════════════════════════════════════════════
  const innContainers = $(".cb-col.cb-col-100.cb-ltst-wgt-hdr");
  innContainers.each((i: number, innEl: any) => {
    const innTitle = $(innEl).find(".cb-col.cb-col-100.cb-bg-gray").text().trim()
      || $(innEl).find("[class*='cb-bg-gray']").first().text().trim()
      || `Innings ${i + 1}`;

    const batting: any[] = [];
    $(innEl).find(".cb-col.cb-col-100.cb-scrd-itms").each((j: number, row: any) => {
      const batsman = $(row).find(".cb-col.cb-col-27").text().trim();
      const allEight = $(row).find(".cb-col.cb-col-8");
      const runs    = $(row).find(".cb-col.cb-col-8.text-bold").first().text().trim()
                   || allEight.eq(0).text().trim();
      const balls   = allEight.eq(1).text().trim();
      const fours   = allEight.eq(2).text().trim();
      const sixes   = allEight.eq(3).text().trim();
      if (batsman && runs && !isNaN(Number(runs)) && Number(runs) >= 0) {
        batting.push({ batsman, runs, balls, fours, sixes });
      }
    });

    const bowling: any[] = [];
    $(innEl).find(".cb-col.cb-col-100.cb-scrd-itms").each((j: number, row: any) => {
      const bowler  = $(row).find(".cb-col.cb-col-40").text().trim();
      const cols    = $(row).find(".cb-col.cb-col-8");
      const overs   = cols.eq(0).text().trim();
      const maidens = cols.eq(1).text().trim();
      const runs_b  = cols.eq(2).text().trim();
      const wickets = cols.eq(3).text().trim();
      if (bowler && overs && !isNaN(Number(overs)) && Number(overs) > 0) {
        bowling.push({ bowler, overs, maidens: maidens || '0', runs: runs_b || '0', wickets: wickets || '0' });
      }
    });

    if (batting.length > 0 || bowling.length > 0) {
      innings.push({ title: innTitle, batting, bowling });
    }
  });

  // ══════════════════════════════════════════════════════════
  // STRATEGY 2 — New Cricbuzz Tailwind UI: table-based
  // New UI uses <table> with <th> "Batter"/"Bowler" headers
  // ══════════════════════════════════════════════════════════
  if (innings.length === 0) {
    console.log(`[scorecard] Strategy 1 found 0 innings — trying Strategy 2 (tables)`);

    let currentInnings: { title: string; batting: any[]; bowling: any[] } | null = null;

    // Detect inning boundary headers
    $('h2, h3, [class*="inning"], [class*="innings"], [class*="header"]').each((_i: number, el: any) => {
      const text = $(el).text().trim();
      if (/innings|1st inn|2nd inn|batting/i.test(text) && text.length < 150) {
        if (currentInnings && (currentInnings.batting.length > 0 || currentInnings.bowling.length > 0)) {
          innings.push(currentInnings);
        }
        currentInnings = { title: text, batting: [], bowling: [] };
      }
    });

    // Parse all tables
    $('table').each((_i: number, table: any) => {
      const headers = $(table).find('th').map((_j: number, th: any) =>
        $(th).text().trim().toLowerCase()
      ).get() as string[];

      const rows = $(table).find('tr').filter((_j: number, tr: any) =>
        $(tr).find('td').length > 0
      );

      // Batting table: "batter" or "batsman" in headers
      if (headers.some((h: string) => h.includes('batter') || h.includes('batsman'))) {
        const batData: any[] = [];
        rows.each((_j: number, row: any) => {
          const cells = $(row).find('td').map((_k: number, td: any) =>
            $(td).text().trim()
          ).get() as string[];
          // cells: [name, dismissal, R, B, 4s, 6s, SR]
          if (cells.length >= 3 && cells[0] && /^\d+$/.test(cells[2] || '')) {
            batData.push({
              batsman:   cells[0].replace(/\s*\(c\)|\s*\†/g, '').trim(),
              dismissal: cells[1] || '',
              runs:      cells[2] || '0',
              balls:     cells[3] || '0',
              fours:     cells[4] || '0',
              sixes:     cells[5] || '0',
            });
          }
        });
        if (batData.length > 0) {
          if (!currentInnings) currentInnings = { title: `Innings ${innings.length + 1}`, batting: [], bowling: [] };
          (currentInnings as any).batting.push(...batData);
        }
      }

      // Bowling table: "bowler" in headers
      if (headers.some((h: string) => h.includes('bowler'))) {
        const bowlData: any[] = [];
        rows.each((_j: number, row: any) => {
          const cells = $(row).find('td').map((_k: number, td: any) =>
            $(td).text().trim()
          ).get() as string[];
          // cells: [name, O, M, R, W, Econ]
          if (cells.length >= 4 && cells[0] && /^\d+\.?\d*$/.test(cells[1] || '')) {
            bowlData.push({
              bowler:  cells[0].replace(/\s*\(c\)/g, '').trim(),
              overs:   cells[1] || '0',
              maidens: cells[2] || '0',
              runs:    cells[3] || '0',
              wickets: cells[4] || '0',
              economy: cells[5] || '',
            });
          }
        });
        if (bowlData.length > 0) {
          if (!currentInnings) currentInnings = { title: `Innings ${innings.length + 1}`, batting: [], bowling: [] };
          (currentInnings as any).bowling.push(...bowlData);
        }
      }
    });

    if (currentInnings && ((currentInnings as any).batting.length > 0 || (currentInnings as any).bowling.length > 0)) {
      innings.push(currentInnings as any);
    }
  }

  // ══════════════════════════════════════════════════════════
  // STRATEGY 3 — Generic JSON-LD / script tag data
  // Cricbuzz sometimes embeds match data in JSON-LD <script> tags
  // ══════════════════════════════════════════════════════════
  if (innings.length === 0) {
    console.log(`[scorecard] Strategy 2 found 0 innings — trying Strategy 3 (JSON-LD)`);
    $('script[type="application/ld+json"]').each((_i: number, el: any) => {
      if (innings.length > 0) return false as any;
      try {
        const json = JSON.parse($(el).html() || '{}');
        if (json['@type'] === 'SportsEvent' && json.subEvent) {
          for (const inningData of json.subEvent) {
            const batting: any[] = [];
            if (inningData.performer?.length) {
              for (const p of inningData.performer) {
                if (p.name && p.description) {
                  const runs = p.description.match(/(\d+)\s*runs?/i)?.[1] || '0';
                  batting.push({ batsman: p.name, runs, balls: '0', fours: '0', sixes: '0' });
                }
              }
            }
            if (batting.length > 0) {
              innings.push({ title: inningData.name || `Innings ${innings.length + 1}`, batting, bowling: [] });
            }
          }
        }
      } catch { /* invalid JSON */ }
    });
  }

  // ── Final logging ─────────────────────────────────────────
  if (innings.length === 0) {
    console.warn(`[scorecard] All strategies failed for ${matchId}. URL: ${usedUrl}`);
    console.warn(`[scorecard] Page snippet: ${fullText.substring(0, 300)}`);
  } else {
    console.log(`[scorecard] ${matchId}: ${innings.length} innings, ${innings[0]?.batting?.length || 0} batters | url: ${usedUrl}`);
  }

  const scraped = { matchName, venue, result, innings };
  // Cache even partial results — better than hitting Cricbuzz every time
  scorecardCache[matchId] = { data: scraped, ts: Date.now() };
  return scraped;
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
  const matchDateUTC = matchDateElement ? new Date(matchDateElement).toISOString() : '';

  return {
    title: getText("h1.cb-nav-hdr").replace(" - Live Cricket Score, Commentary", "").trim(),
    update: matchUpdate,
    matchDate: matchDateUTC,          // raw UTC ISO string (empty string if unavailable)
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


// ── Live match cache + source health tracking ─────────────────────────────────
let liveMatchCache: any[] = [];
let liveCacheTime  = 0;
let lastLiveCount  = -1;
const LIVE_CACHE_TTL = 60 * 1000; // 60 seconds

// Track which data source is working
const sourceHealth = {
  cricbuzz: { healthy: true,  failures: 0, lastOk: 0 },
  cricapi:  { healthy: false, failures: 0, lastOk: 0 },
};

// ── CricAPI live scores — backup when Cricbuzz is blocked ────────────────────
async function fetchLiveMatchesCricAPI(): Promise<any[]> {
  const apiKey = process.env.CRICKET_API_KEY;
  if (!apiKey) return [];
  try {
    const res = await fetch(
      `https://api.cricapi.com/v1/currentMatches?apikey=${apiKey}&offset=0`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return [];
    const json = await res.json();
    if (json.status !== 'success' || !json.data) return [];

    sourceHealth.cricapi.healthy = true;
    sourceHealth.cricapi.lastOk  = Date.now();
    sourceHealth.cricapi.failures = 0;

    return json.data
      .filter((m: any) => m.matchStarted && !m.matchEnded)
      .map((m: any) => {
        // Parse score into standard format
        const scores: any[] = (m.score || []).map((s: any, i: number) => ({
          r: parseInt(s.r) || 0,
          w: parseInt(s.w) || 0,
          o: parseFloat(s.o) || 0,
          inning: i === 0 ? '1st' : '2nd',
        }));

        const teams = m.teams || [];
        return {
          id:             m.id,
          name:           m.name || `${teams[0]} vs ${teams[1]}`,
          teams,
          status:         'live',
          venue:          m.venue || '',
          score:          scores,
          matchType:      (m.matchType || 'T20').toUpperCase(),
          battingTeamIdx: 0,
          isLive:         true,
          source:         'cricapi',
        };
      });
  } catch (e: any) {
    sourceHealth.cricapi.failures++;
    console.warn('[backup] CricAPI live failed:', e.message);
    return [];
  }
}

// ── RapidAPI live scores — second backup ─────────────────────────────────────
async function fetchLiveMatchesRapidAPI(): Promise<any[]> {
  const apiKey = process.env.RAPIDAPI_KEY;
  if (!apiKey) return [];
  try {
    const res = await fetch(
      'https://cricbuzz-cricket.p.rapidapi.com/matches/v1/live',
      {
        headers: {
          'X-RapidAPI-Key':  apiKey,
          'X-RapidAPI-Host': 'cricbuzz-cricket.p.rapidapi.com',
        },
        signal: AbortSignal.timeout(8000),
      }
    );
    if (!res.ok) return [];
    const json = await res.json();
    const matches: any[] = [];

    for (const typeMatches of (json.typeMatches || [])) {
      for (const seriesMatch of (typeMatches.seriesMatches || [])) {
        for (const m of (seriesMatch.seriesAdWrapper?.matches || [])) {
          const mi = m.matchInfo;
          const ms = m.matchScore;
          if (!mi || mi.state !== 'In Progress') continue;

          const t1 = mi.team1?.teamSName || mi.team1?.teamName || '';
          const t2 = mi.team2?.teamSName || mi.team2?.teamName || '';
          const inn1 = ms?.team1Score?.inngs1;
          const inn2 = ms?.team2Score?.inngs1;
          const scores = [];
          if (inn1) scores.push({ r: inn1.runs || 0, w: inn1.wickets || 0, o: inn1.overs || 0, inning: '1st' });
          if (inn2) scores.push({ r: inn2.runs || 0, w: inn2.wickets || 0, o: inn2.overs || 0, inning: '2nd' });

          matches.push({
            id:             String(mi.matchId),
            name:           `${t1} vs ${t2}`,
            teams:          [t1, t2],
            status:         'live',
            venue:          mi.venueInfo?.ground || '',
            score:          scores,
            matchType:      (mi.matchFormat || 'T20').toUpperCase(),
            battingTeamIdx: 0,
            isLive:         true,
            source:         'rapidapi',
          });
        }
      }
    }
    console.log(`[backup] RapidAPI live: ${matches.length} matches`);
    return matches;
  } catch (e: any) {
    console.warn('[backup] RapidAPI live failed:', e.message);
    return [];
  }
}

// ── Smart refresh — Cricbuzz primary, auto-fallback to APIs ──────────────────
async function refreshLiveCache() {
  // Try Cricbuzz first (primary — most detailed data)
  if (sourceHealth.cricbuzz.healthy || sourceHealth.cricbuzz.failures < 3) {
    try {
      const matches = await fetchLiveMatches();
      if (matches.length > 0 || sourceHealth.cricbuzz.lastOk > Date.now() - 300_000) {
        liveMatchCache  = matches;
        liveCacheTime   = Date.now();
        sourceHealth.cricbuzz.healthy  = true;
        sourceHealth.cricbuzz.failures = 0;
        sourceHealth.cricbuzz.lastOk   = Date.now();
        if (matches.length !== lastLiveCount) {
          console.log(`[cache] Cricbuzz: ${matches.length} live matches`);
          lastLiveCount = matches.length;
        }
        return;
      }
    } catch (err: any) {
      sourceHealth.cricbuzz.failures++;
      sourceHealth.cricbuzz.healthy = sourceHealth.cricbuzz.failures < 3;
      console.warn(`[cache] Cricbuzz failed (${sourceHealth.cricbuzz.failures}/3):`, err.message);
    }
  }

  // Cricbuzz failed — try CricAPI
  console.log('[cache] Switching to CricAPI backup...');
  const cricapiMatches = await fetchLiveMatchesCricAPI();
  if (cricapiMatches.length > 0) {
    liveMatchCache = cricapiMatches;
    liveCacheTime  = Date.now();
    if (cricapiMatches.length !== lastLiveCount) {
      console.log(`[cache] CricAPI backup: ${cricapiMatches.length} live matches`);
      lastLiveCount = cricapiMatches.length;
    }
    return;
  }

  // CricAPI also failed — try RapidAPI
  console.log('[cache] Switching to RapidAPI backup...');
  const rapidMatches = await fetchLiveMatchesRapidAPI();
  if (rapidMatches.length > 0) {
    liveMatchCache = rapidMatches;
    liveCacheTime  = Date.now();
    console.log(`[cache] RapidAPI backup: ${rapidMatches.length} live matches`);
    lastLiveCount  = rapidMatches.length;
    return;
  }

  // All sources failed — keep stale cache
  console.error('[cache] ALL sources failed — keeping stale data');
}

// Retry Cricbuzz every 5 minutes even when it's marked unhealthy
setInterval(() => {
  if (!sourceHealth.cricbuzz.healthy) {
    console.log('[cache] Retrying Cricbuzz...');
    sourceHealth.cricbuzz.failures = 0;
    sourceHealth.cricbuzz.healthy  = true;
  }
}, 5 * 60 * 1000);

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

// ── /health endpoint (was missing entirely) ─────────
app.get('/health', (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    browser: sharedBrowser ? 'running' : 'not_started',
    activePages: activePages.size,
    liveCache: {
      count:      liveMatchCache.length,
      ageSeconds: Math.round((Date.now() - liveCacheTime) / 1000),
      source:     liveMatchCache[0]?.source || 'cricbuzz',
    },
    sources: {
      cricbuzz: { healthy: sourceHealth.cricbuzz.healthy, failures: sourceHealth.cricbuzz.failures },
      cricapi:  { healthy: sourceHealth.cricapi.healthy,  failures: sourceHealth.cricapi.failures  },
    },
    apis: {
      cricketApi: !!process.env.CRICKET_API_KEY,
      rapidApi:   !!process.env.RAPIDAPI_KEY,
    },
    seriesCached: Object.keys(seriesCache).length,
    uptime: Math.round(process.uptime()),
  });
});

// ── /prematch/:matchId — scrape squads, venue, head-to-head ──
// Called by match-agent 90min before, and by match.html on load.
// Scrapes Cricbuzz match page for:
//  - Playing XIs (when confirmed)
//  - Toss result (when available)
//  - Venue info + pitch report
//  - Head-to-head record
//  - Umpires
const prematchCache: Record<string, { data: any; ts: number }> = {};
const PREMATCH_TTL = 5 * 60 * 1000; // 5 min cache

app.get(
  '/prematch/:matchId',
  asyncHandler(async (req: Request, res: Response) => {
    const { matchId } = req.params;
    const slug = req.query.slug as string || '';

    // Cache hit
    const cached = prematchCache[matchId];
    if (cached && Date.now() - cached.ts < PREMATCH_TTL) {
      res.json({ ...cached.data, cached: true });
      return;
    }

    // Resolve slug from known slugs or query
    const KNOWN_SLUGS: Record<string, string> = {
      '122720': 'new-zealand-vs-south-africa-4th-t20i',
      '122731': 'new-zealand-vs-south-africa-5th-t20i',
      '122847': 'new-zealand-women-vs-south-africa-women-4th-t20i',
      '122858': 'new-zealand-women-vs-south-africa-women-5th-t20i',
    };
    const matchSlug = slug || KNOWN_SLUGS[matchId] || 'cricket-match';

    try {
      const url  = `https://www.cricbuzz.com/live-cricket-scores/${matchId}/${matchSlug}`;
      console.log(`[prematch] Fetching: ${url}`);
      const html = await fetchHTMLWithBrowser(url);
      const $    = cheerio.load(html);

      // ── Toss ──────────────────────────────────────────────
      let toss = $('.cb-toss-sts').first().text().trim()
        || $('.cb-text-inprogress').first().text().trim()
        || '';
      // Clean up toss text
      if (toss && !/won toss/i.test(toss)) toss = '';

      // ── Match status / result ─────────────────────────────
      const status = $('.cb-text-complete').first().text().trim()
        || $('.cb-min-stts').first().text().trim()
        || '';

      // ── Venue ─────────────────────────────────────────────
      let venue = $('[itemprop="location"]').text().trim()
        || $('.cb-nav-subhdr span').last().text().trim()
        || '';
      if (!venue) {
        const bodyText = $('body').text().replace(/\s+/g, ' ');
        const vm = bodyText.match(/(?:at|venue)[:\s]+([A-Z][^,\n]{5,60})/i);
        if (vm) venue = vm[1].trim();
      }

      // ── Match date ────────────────────────────────────────
      const matchDateEl = $('span[itemprop="startDate"]').attr('content');
      const matchDate   = matchDateEl ? new Date(matchDateEl).toISOString() : '';

      // ── Playing XIs ───────────────────────────────────────
      // Cricbuzz shows XIs inside .cb-minfo-tm-nm / .cb-player-name divs
      const teams: any[] = [];
      $('.cb-minfo-tm-nm').each((_i: number, el: any) => {
        const teamName = $(el).find('.cb-font-16').first().text().trim()
          || $(el).text().trim().split('\n')[0].trim();
        const players: string[] = [];
        $(el).find('.cb-player-name, .cb-col-50').each((_j: number, p: any) => {
          const name = $(p).text().trim();
          if (name && name.length > 2 && name.length < 40 && !/squad|playing|xi/i.test(name)) {
            players.push(name);
          }
        });
        if (teamName && players.length > 0) {
          teams.push({ name: teamName, players: players.slice(0, 11) });
        }
      });

      // Fallback: try alternate XI selectors
      if (teams.length === 0) {
        const xiBlocks = $('.cb-col-100.cb-col.cb-teams-ng-itm');
        xiBlocks.each((_i: number, block: any) => {
          const teamName = $(block).find('.cb-col-67').first().text().trim();
          const players: string[] = [];
          $(block).find('.cb-col-50, .cb-player-name').each((_j: number, p: any) => {
            const name = $(p).text().trim();
            if (name && name.length > 2 && name.length < 40) players.push(name);
          });
          if (teamName && players.length > 0) {
            teams.push({ name: teamName, players: players.slice(0, 11) });
          }
        });
      }

      // ── Umpires ───────────────────────────────────────────
      let umpires = '';
      $('*').each((_i: number, el: any) => {
        if (umpires) return false as any;
        const text = $(el).text().trim();
        if (/umpire/i.test(text) && text.length < 200 && $(el).children().length < 3) {
          umpires = text.replace(/\s+/g, ' ').trim();
        }
      });

      // ── Head-to-head ──────────────────────────────────────
      // Try to extract from page (Cricbuzz sometimes shows this)
      let h2h = '';
      $('*').each((_i: number, el: any) => {
        if (h2h) return false as any;
        const text = $(el).text().trim();
        if (/head.to.head|h2h/i.test(text) && text.length < 300 && $(el).children().length < 5) {
          h2h = text.replace(/\s+/g, ' ').trim();
        }
      });

      // ── Pitch report ──────────────────────────────────────
      let pitch = '';
      $('*').each((_i: number, el: any) => {
        if (pitch) return false as any;
        const text = $(el).text().trim();
        if (/pitch|track|surface|conditions/i.test(text) && text.length > 30 && text.length < 400
            && $(el).children().length < 4 && /batting|bowling|pace|spin|flat/i.test(text)) {
          pitch = text.replace(/\s+/g, ' ').trim();
        }
      });

      // ── Win probability (simple, from CricAPI if key available) ──
      let winProb = { team1: 50, team2: 50 };
      const apiKey = process.env.CRICKET_API_KEY;
      if (apiKey) {
        try {
          const apiRes = await fetch(
            `https://api.cricapi.com/v1/match_info?apikey=${apiKey}&id=${matchId}`,
            { signal: AbortSignal.timeout(6000) }
          );
          if (apiRes.ok) {
            const apiData = await apiRes.json();
            if (apiData.data?.toss && !toss) toss = apiData.data.toss;
            if (apiData.data?.venue && !venue) venue = apiData.data.venue;
          }
        } catch { /* non-critical */ }
      }

      const result = {
        matchId,
        toss,
        status,
        venue,
        matchDate,
        teams,          // [{ name, players[] }]
        umpires,
        h2h,
        pitch,
        winProb,
        scrapedAt: new Date().toISOString(),
      };

      prematchCache[matchId] = { data: result, ts: Date.now() };
      console.log(`[prematch] ${matchId}: toss="${toss}" teams=${teams.length} venue="${venue}"`);
      res.json(result);

    } catch (err: any) {
      console.error(`[prematch] Failed for ${matchId}:`, err.message);
      res.status(500).json({ error: 'Pre-match data unavailable', matchId });
    }
  })
);

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

// ── /schedule — auto-fetches results + upcoming from Cricbuzz ─────────────────
// Returns structured match data for the active international series
// Called by sportvibe-live server every 5 minutes — no manual updates needed

let scheduleData: any = null;
let scheduleTime = 0;
const SCHEDULE_TTL = 5 * 60 * 1000; // 5 min cache

async function buildSchedule(): Promise<any> {
  // Fetch current international schedules from Cricbuzz
  const url = 'https://www.cricbuzz.com/cricket-schedule/upcoming-series/international';
  const html = await fetchHTMLWithBrowser(url);
  const $ = cheerio.load(html);

  const series: any[] = [];

  // Parse each schedule item
  $('.cb-col-100.cb-col.cb-ltst-wgt-hdr').each((_i: number, el: any) => {
    const seriesName = $(el).find('a').first().text().trim();
    if (!seriesName) return;

    const matches: any[] = [];
    $(el).nextUntil('.cb-col-100.cb-col.cb-ltst-wgt-hdr', '.cb-col-100.cb-col').each((_j: number, row: any) => {
      const link      = $(row).find('a').first();
      const matchText = link.text().trim();
      const href      = link.attr('href') || '';
      const dateText  = $(row).find('.schedule-date').text().trim()
                     || $(row).find('span[data-timestamp]').attr('data-timestamp') || '';

      const statusEl = $(row).find('.cb-text-complete, .cb-text-inprogress, .cb-text-live');
      const status   = statusEl.length ? 'result' : 'upcoming';
      const result   = $(row).find('.cb-text-complete').text().trim();

      if (matchText) {
        const ts = parseInt(dateText);
        matches.push({
          title:   matchText,
          href,
          matchId: href.split('/')[2] || '',
          status,
          result:  result || null,
          startMs: ts > 0 ? ts : null,
          startUTC: ts > 0 ? new Date(ts).toISOString() : null,
        });
      }
    });

    if (matches.length > 0) {
      series.push({ seriesName, matches });
    }
  });

  return { series, fetchedAt: new Date().toISOString() };
}

app.get(
  '/schedule',
  asyncHandler(async (req: Request, res: Response) => {
    const now = Date.now();
    if (scheduleData && now - scheduleTime < SCHEDULE_TTL) {
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.json({ ...scheduleData, cached: true });
      return;
    }
    try {
      scheduleData = await buildSchedule();
      scheduleTime = now;
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.json(scheduleData);
    } catch (err) {
      if (scheduleData) {
        res.json({ ...scheduleData, stale: true });
        return;
      }
      res.status(500).json({ error: 'Schedule fetch failed', detail: (err as Error).message });
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
