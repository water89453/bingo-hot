// scripts/fetch_bingo.mjs
// Robust Bingo Bingo fetcher for Taiwan Lottery
// Features:
// - Tries multiple API endpoints automatically (new/old domains)
// - Tries multiple date param keys and formats
// - Sends proper headers (User-Agent / Origin / Referer)
// - Falls back to HTML pages (new route / old .aspx) if API returns 404
// - Normalizes different payload shapes into { period, date, balls[20], super }

import fs from 'node:fs/promises';
import path from 'node:path';

// ---------- Config & Env ----------
const ENV = {
  ENDPOINT: process.env.ENDPOINT?.trim() || '',
  OPEN_DATE: process.env.OPEN_DATE?.trim() || '',
  PAGE_SIZE: parseInt(process.env.PAGE_SIZE || '50', 10),
  MAX_PAGES: parseInt(process.env.MAX_PAGES || '20', 10),
};

const DEFAULT_ENDPOINTS = [
  // Newer WebAPI first
  'https://api.taiwanlottery.com/TLCAPIWebAPI/api/Bingo/GetBingoList',
  'https://api.taiwanlottery.com/TLCAPIWebAPI/api/Bingo/GetBingoResult',
  // Older paths
  'https://api.taiwanlottery.com/TLCAPIWeb/Lottery/BingoResult',
];

const HTML_FALLBACK_URLS = [
  // Newer MVC-like routes (without .aspx)
  'https://www.taiwanlottery.com/lotto/bingobingo/drawing',
  'https://www.taiwanlottery.com/lotto/bingobingo/history',
  // Older WebForms routes (still try in case)
  'https://www.taiwanlottery.com/lotto/bingobingo/drawing.aspx',
  'https://www.taiwanlottery.com/lotto/bingobingo/history.aspx',
];

const HTTP_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
  'Accept': 'application/json, text/plain, */*',
  'Origin': 'https://www.taiwanlottery.com',
  'Referer': 'https://www.taiwanlottery.com/lotto/bingobingo/history',
};

const OUT_PATH = path.join('web', 'data', 'draws.json');

// ---------- Helpers ----------
function logInfo(...a) { console.log('info:', ...a); }
function logWarn(...a) { console.warn('warn:', ...a); }
function logDebug(...a) { console.log('debug:', ...a); }

function todayISO() {
  const d = new Date();
  const yyyy = String(d.getUTCFullYear());
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// 民國格式：YYYY-MM-DD → 114-08-18（今年是 2025 → 民國 114）
function toMinguo(dateStr /* YYYY-MM-DD */) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) return '';
  const y = Number(m[1]) - 1911;
  return `${String(y).padStart(3, '0')}-${m[2]}-${m[3]}`;
}

function uniqueByPeriod(arr) {
  const seen = new Set();
  const out = [];
  for (const r of arr) {
    const k = r.period ?? '';
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

function parseIntMaybe(x) {
  const n = Number.parseInt(String(x), 10);
  return Number.isFinite(n) ? n : null;
}

function toArrayNumbersMaybe(value) {
  if (Array.isArray(value)) {
    const nums = value
      .map(parseIntMaybe)
      .filter((x) => Number.isFinite(x));
    return nums.length ? nums : null;
  }
  return null;
}

function normalizeOneRecord(raw) {
  // Try multiple field names
  const period =
    raw.period ?? raw.Period ?? raw.DrawTerm ?? raw.Term ?? raw.DrawNo ?? raw.DrawId ?? null;

  const date =
    raw.date ?? raw.DrawDate ?? raw.OpenDate ?? raw.QueryDate ?? raw.DrawTime ?? raw.Date ?? '';

  // Numbers:
  // 1) As array: Numbers / Balls / WinningNumbers / DetailList[*]
  // 2) As object No1..No20
  // 3) As string "1,2,3,..."
  let balls = null;

  balls =
    toArrayNumbersMaybe(raw.Numbers) ||
    toArrayNumbersMaybe(raw.Balls) ||
    toArrayNumbersMaybe(raw.WinningNumbers) ||
    toArrayNumbersMaybe(raw.DetailList) ||
    null;

  if (!balls) {
    // Collect No1..No20
    const tmp = [];
    for (let i = 1; i <= 20; i++) {
      const v =
        raw[`No${i}`] ??
        raw[`no${i}`] ??
        raw[`N${i}`] ??
        raw[`Ball${i}`] ??
        raw[`b${i}`];
      const n = parseIntMaybe(v);
      if (Number.isFinite(n)) tmp.push(n);
    }
    if (tmp.length) {
      balls = tmp;
    }
  }

  if (!balls && typeof raw.Numbers === 'string') {
    const nums = raw.Numbers.split(/[^\d]+/g).map(parseIntMaybe).filter((x) => Number.isFinite(x));
    if (nums.length) balls = nums;
  }
  if (!balls && typeof raw.Balls === 'string') {
    const nums = raw.Balls.split(/[^\d]+/g).map(parseIntMaybe).filter((x) => Number.isFinite(x));
    if (nums.length) balls = nums;
  }

  // Super number: maybe Super / Special / Bonus / SNo
  const superNo =
    parseIntMaybe(raw.super) ??
    parseIntMaybe(raw.Super) ??
    parseIntMaybe(raw.Special) ??
    parseIntMaybe(raw.Bonus) ??
    parseIntMaybe(raw.SNo) ??
    null;

  // If any field missing, try nested shapes some APIs use (e.g., raw.Data or raw.Item)
  const nested = raw.Data || raw.Item || null;
  if ((!period || !balls) && nested && typeof nested === 'object') {
    return normalizeOneRecord({ ...nested, super: superNo ?? nested.super ?? nested.Super });
  }

  // As a last resort: scan object values for 20 integers (1..80) and 1 "super-like"
  if (!balls) {
    const allNums = [];
    for (const v of Object.values(raw)) {
      if (Array.isArray(v)) {
        const nums = v.map(parseIntMaybe).filter((x) => x >= 1 && x <= 80);
        if (nums.length >= 10) allNums.push(...nums);
      } else if (typeof v === 'string') {
        const nums = v.split(/[^\d]+/g).map(parseIntMaybe).filter((x) => x >= 1 && x <= 80);
        if (nums.length >= 10) allNums.push(...nums);
      }
    }
    if (allNums.length >= 20) {
      balls = allNums.slice(0, 20);
    }
  }

  if (!period || !balls || balls.length < 20) return null;

  return {
    period: String(period),
    date: typeof date === 'string' ? date : String(date ?? ''),
    balls: balls.slice(0, 20),
    super: superNo ?? null,
  };
}

function normalizeAPIResponse(json) {
  // Try many shapes:
  // 1) { Data: [ ... ] } / { data: [ ... ] }
  // 2) { Result: [ ... ] } / { result: [ ... ] }
  // 3) array []
  // 4) { Items: [...] } / { List: [...] }
  let list = null;
  const candidates = [
    json?.Data,
    json?.data,
    json?.Result,
    json?.result,
    json?.Items,
    json?.items,
    json?.List,
    json?.list,
    Array.isArray(json) ? json : null,
  ].filter(Boolean);

  for (const c of candidates) {
    if (Array.isArray(c) && c.length) {
      list = c;
      break;
    }
  }
  // Some APIs use {Data:{List:[...]}}
  if (!list && json?.Data?.List && Array.isArray(json.Data.List)) list = json.Data.List;

  if (!list) return [];

  const out = [];
  for (const item of list) {
    const n = normalizeOneRecord(item);
    if (n) out.push(n);
  }
  return out;
}

function buildDateVariants(dateStr) {
  // Accept YYYY-MM-DD or YYYY/MM/DD or 民國
  const ymd = dateStr.replaceAll('/', '-');
  const variants = new Set();
  variants.add(ymd); // 2025-08-18
  variants.add(ymd.replaceAll('-', '/')); // 2025/08/18
  const ming = toMinguo(ymd);
  if (ming) {
    variants.add(ming); // 114-08-18
    variants.add(ming.replaceAll('-', '/')); // 114/08/18
  }
  return [...variants];
}

const DATE_KEYS = ['openDate', 'queryDate', 'drawDate', 'date', 'OpenDate'];
const PAGE_KEYS = ['pageNum', 'pageIndex', 'page', '']; // '' means no page param

function buildURL(base, params) {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    usp.set(k, String(v));
  }
  const u = base.includes('?') ? `${base}&${usp}` : `${base}?${usp}`;
  return u;
}

async function fetchJSON(url) {
  const res = await fetch(url, { headers: HTTP_HEADERS });
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}`);
  }
  // some endpoints return text/html with JSON content, try json first then text->json
  try {
    return await res.json();
  } catch {
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Bad JSON payload from ${url}`);
    }
  }
}

async function tryAPIOnce(endpoint, openDate, pageSize, maxPages) {
  const rows = [];

  const dateVariants = buildDateVariants(openDate);
  for (const dateKey of DATE_KEYS) {
    for (const dateVal of dateVariants) {
      let gotAnyThisKey = false;

      for (const pageKey of PAGE_KEYS) {
        for (let p = 1; p <= maxPages; p++) {
          const params = { [dateKey]: dateVal, pageSize };
          if (pageKey) params[pageKey] = p;

          const url = buildURL(endpoint, params);
          try {
            const json = await fetchJSON(url);
            const normalized = normalizeAPIResponse(json);

            if (normalized.length) {
              rows.push(...normalized);
              gotAnyThisKey = true;
              logDebug(`ok: ${url} -> +${normalized.length}`);
              // Continue paging if this page returned data; break when empty
              if (normalized.length < pageSize) break;
            } else {
              // empty page; stop paging for this key/format
              logDebug(`empty: ${url}`);
              break;
            }
          } catch (err) {
            logWarn(`fetch failed (GET ${dateKey}=${dateVal} ${pageKey ? `${pageKey}=${p}` : ''}): ${err.message}`);
            // For 404 on page 1, try next param combo; for later pages, break paging
            const m = /(\d{3})/.exec(err.message);
            if (m && Number(m[1]) === 404) {
              if (p === 1) {
                // change param combo
                break;
              } else {
                // stop paging
                break;
              }
            } else {
              // network error or 5xx: try next page or break? safer: break paging
              break;
            }
          }
        } // page
      } // pageKey

      if (gotAnyThisKey) {
        // If we got data for this date key, no need to try other date keys too aggressively
        // but we keep going to maximize coverage for the same date (some APIs split lists)
      }
    } // dateVal
  } // dateKey

  return uniqueByPeriod(rows);
}

// Very light HTML parser (best-effort):
// - 尋找像是 data 物件、或 table 裡的 20 個號碼 + 1 個特別號
function extractFromHTML(html) {
  const rows = [];

  // 1) 有些頁面會把 JSON 塞在 window.__DATA__ = {...}
  const jsonMatch = html.match(/(?:window\.__DATA__|var\s+data)\s*=\s*({[\s\S]*?});/);
  if (jsonMatch) {
    try {
      const obj = JSON.parse(jsonMatch[1]);
      const normalized = normalizeAPIResponse(obj);
      if (normalized.length) return uniqueByPeriod(normalized);
    } catch {}
  }

  // 2) 粗略抓表格上的數字：一行至少 20 個(1..80) → balls；再找 super（常見落在 1..80）
  //   注意：這是 best-effort，若版型大改可能抓不到
  const lineRE = /<tr[\s\S]*?<\/tr>/gi;
  const tdRE = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
  const numRE = /\b\d{1,2}\b/g;

  const trs = html.match(lineRE) || [];
  for (const tr of trs) {
    const cells = [...tr.matchAll(tdRE)].map((m) => m[1].replace(/<[^>]+>/g, '').trim());
    if (!cells.length) continue;
    const nums = [];
    for (const c of cells) {
      const found = c.match(numRE) || [];
      for (const n of found) {
        const v = parseInt(n, 10);
        if (v >= 1 && v <= 80) nums.push(v);
      }
    }
    if (nums.length >= 20) {
      const balls = nums.slice(0, 20);
      const superNo = nums[20] ?? null;
      // period 嘗試在該列找 9~12 位數字串（賽事期別）
      const periodMatch = tr.match(/\b\d{9,12}\b/);
      const period = periodMatch ? periodMatch[0] : '';
      rows.push({
        period,
        date: '',
        balls,
        super: superNo ?? null,
      });
    }
  }

  return uniqueByPeriod(rows);
}

async function tryHTMLFallback() {
  for (const url of HTML_FALLBACK_URLS) {
    try {
      logDebug(`GET (html) ${url}`);
      const res = await fetch(url, { headers: HTTP_HEADERS });
      if (!res.ok) {
        const text = await res.text();
        logWarn(`HTML 失敗 ${url} ${res.status} ${res.statusText} - ${text.slice(0, 120)}`);
        continue;
      }
      const html = await res.text();
      const rows = extractFromHTML(html);
      if (rows.length) return rows;
    } catch (e) {
      logWarn(`HTML 抓取錯誤 ${url}: ${e.message}`);
    }
  }
  return [];
}

async function readExisting() {
  try {
    const buf = await fs.readFile(OUT_PATH, 'utf-8');
    const arr = JSON.parse(buf);
    if (Array.isArray(arr)) return arr;
  } catch {}
  return [];
}

async function writeIfChanged(newRows) {
  if (!newRows.length) {
    logWarn('API returned no parseable rows, skip write.');
    return false;
  }

  const existing = await readExisting();
  // 合併、依 period 去重
  const map = new Map();
  for (const r of existing) map.set(r.period, r);
  for (const r of newRows) map.set(r.period, r);

  const merged = [...map.values()].sort((a, b) => (a.period > b.period ? 1 : -1));
  const changed = JSON.stringify(merged) !== JSON.stringify(existing);

  if (changed) {
    await fs.mkdir(path.dirname(OUT_PATH), { recursive: true });
    await fs.writeFile(OUT_PATH, JSON.stringify(merged, null, 2), 'utf-8');
  }
  return changed;
}

// ---------- Main ----------
(async () => {
  const openDate = ENV.OPEN_DATE || todayISO();

  logInfo(`openDate=${openDate} pageSize=${ENV.PAGE_SIZE} maxPages=${ENV.MAX_PAGES} backfill=true`);

  const endpoints = ENV.ENDPOINT ? [ENV.ENDPOINT] : DEFAULT_ENDPOINTS;

  let allRows = [];
  for (const ep of endpoints) {
    try {
      const got = await tryAPIOnce(ep, openDate, ENV.PAGE_SIZE, ENV.MAX_PAGES);
      if (got.length) {
        allRows.push(...got);
      }
    } catch (e) {
      logWarn(`endpoint error ${ep}: ${e.message}`);
    }
  }

  allRows = uniqueByPeriod(allRows);

  if (!allRows.length) {
    logWarn('API 全部 404 或無資料，嘗試 HTML fallback...');
    const htmlRows = await tryHTMLFallback();
    allRows = htmlRows;
  }

  const changed = await writeIfChanged(allRows);
  if (changed) {
    console.log(`wrote ${OUT_PATH} with ${allRows.length} rows.`);
  } else {
    console.log('No changes to draws.json.');
  }
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
