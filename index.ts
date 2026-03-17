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

  // Track seen matchIds to avoid duplicates
  const seenIds = new Set<string>();

  // Find all links to match scorecards
  $("a[href*='/live-cricket-scores/']").each((i, el) => {
    const link = $(el).attr('href');
    const matchId = link ? link.split('/')[2] : null;
    if (!matchId || seenIds.has(matchId)) return;
    seenIds.add(matchId);

    // The card container — go up several levels to find the full match card
    const card = $(el).closest('[class*="border"]').first();
    const cardDiv = card.length ? card : $(el).parent().parent().parent();

    // ── Extract teams ─────────────────────────────────────
    // Try multiple selectors Cricbuzz uses for team names
    let team1 = '';
    let team2 = '';

    // Method 1: font-semibold divs (new Cricbuzz UI)
    const semibold = cardDiv.find('div.font-semibold, span.font-semibold');
    if (semibold.length >= 2) {
      team1 = semibold.eq(0).text().trim();
      team2 = semibold.eq(1).text().trim();
    }

    // Method 2: cb-hmscg-tm-nm (old Cricbuzz UI)
    if (!team1 || !team2) {
      const cbTeams = cardDiv.find('.cb-hmscg-tm-nm');
      if (cbTeams.length >= 2) {
        team1 = cbTeams.eq(0).text().trim();
        team2 = cbTeams.eq(1).text().trim();
      }
    }

    // Method 3: extract from the href slug (e.g. /live-cricket-scores/122709/nz-vs-sa-...)
    if (!team1 || !team2) {
      const slug = link || '';
      const slugParts = slug.split('/');
      if (slugParts.length > 3) {
        const matchSlug = slugParts[3] || '';
        const vsIndex = matchSlug.indexOf('-vs-');
        if (vsIndex > -1) {
          team1 = matchSlug.substring(0, vsIndex).replace(/-/g, ' ').toUpperCase();
          team2 = matchSlug.substring(vsIndex + 4).split('-')[0].replace(/-/g, ' ').toUpperCase();
        }
      }
    }

    const teams = team1 && team2 ? `${team1} vs ${team2}` : '';

    // ── Extract scores ────────────────────────────────────
    const scoreDivs = cardDiv.find('div.text-gray-700, .cb-scrs-wrp');
    const score1 = scoreDivs.first().text().trim();
    const score2 = scoreDivs.length > 1 ? scoreDivs.eq(1).text().trim() : '';

    // ── Extract result — clean version ────────────────────
    let result = '';

    // Scan all text nodes for result keywords, then clean the string
    cardDiv.find('*').each((_i: number, resEl: any) => {
      if (result) return false;
      const children = $(resEl).children();
      // Only look at leaf-level or near-leaf elements to avoid concatenated text
      if (children.length > 3) return;
      const txt = $(resEl).text().trim();
      if (txt && /won by|tied|no result|drawn|abandoned/i.test(txt)) {
        // Extract ONLY the result sentence using regex
        const match = txt.match(/((?:[A-Za-z][\w\s]*?)\s+(?:won by[\w\s,]+|tied|no result|drawn|abandoned[^.]*?)(?:[.]|$))/i);
        if (match) {
          result = match[1].trim();
        } else {
          // Fallback: extract from "won by" onwards
          const wonIdx = txt.search(/won by|tied|no result|drawn|abandoned/i);
          if (wonIdx > -1) {
            // Walk back to find team name before "won by"
            const before = txt.substring(0, wonIdx);
            const teamMatch = before.match(/([A-Z][a-z]+( [A-Z][a-z]+)*) *$/);
            const teamPart = teamMatch ? teamMatch[1] + ' ' : '';
            const afterText = txt.substring(wonIdx);
            const newlineIdx = afterText.indexOf(' ');
            const cleanAfter = afterText.split(' ').slice(0, 8).join(' ');
            result = (teamPart + cleanAfter).trim();
          }
        }
        return false;
      }
    });

    // ── Extract venue ─────────────────────────────────────
    let venue = '';
    cardDiv.find('span[class*="gray"], span[class*="text-xs"], .cb-venue').each((_i: number, venEl: any) => {
      if (venue) return false;
      const txt = $(venEl).text().trim();
      if (txt && txt.length > 2 && txt.length < 50 && !/\d{1,2}:\d{2}|GMT|IST/.test(txt)) {
        venue = txt; return false;
      }
    });

    // ── Extract date ──────────────────────────────────────
    let date = '';
    cardDiv.find('span[class*="gray"], span[class*="text-xs"]').each((_i: number, dtEl: any) => {
      if (date) return false;
      const txt = $(dtEl).text().trim();
      if (txt && /\d{1,2}:\d{2}|GMT|IST|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec/i.test(txt)) {
        date = txt; return false;
      }
    });

    console.log(`[series] ID=${matchId} teams="${teams}" result="${result}" venue="${venue}"`);
    matches.push({ matchId, teams, score1, score2, result, venue, date });
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
