#!/usr/bin/env node
// scripts/fetch_bingo.mjs
// Node 20+ (有全域 fetch)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// -----------------------------------------------------------------------------
// 設定
// -----------------------------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OPEN_DATE = process.env.OPEN_DATE || tzDate('Asia/Taipei'); // e.g. 2025-08-18
const PAGE_SIZE = toInt(process.env.PAGE_SIZE, 50);
const MAX_PAGES = toInt(process.env.MAX_PAGES, 20);

// API base 與端點：
// - 你現有環境若已在程式內寫死，就保留這裡預設即可。
// - 也可以透過環境變數覆蓋：BINGO_API_BASE, BINGO_ENDPOINTS (逗號分隔)
const BASE_URL = (process.env.BINGO_API_BASE || '').trim().replace(/\/+$/, '');
const ENDPOINTS = ((process.env.BINGO_ENDPOINTS || '').trim() || '/BINGO/bingoQuery')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// 若你的舊程式裡原本就內建某些端點，建議併在這裡：
const FALLBACK_ENDPOINTS = [
  '/BINGO/bingoQuery',           // 看到 content.bingoQueryResult，合理預設
  '/bingo/query',
  '/api/bingo/query',
  '/api/bingo'
];

const CANDIDATE_ENDPOINTS = uniq([...ENDPOINTS, ...FALLBACK_ENDPOINTS]);

const DATE_KEYS = ['openDate', 'queryDate', 'drawDate', 'date'];
const PAGE_KEYS = ['pageNum', 'pageIndex', 'page'];

// 輸出檔案
const OUTPUT_FILE = path.resolve(__dirname, '..', 'web', 'data', 'draws.json');

// -----------------------------------------------------------------------------
// 主程式
// -----------------------------------------------------------------------------
async function main() {
  console.log(`info: openDate=${OPEN_DATE} pageSize=${PAGE_SIZE} maxPages=${MAX_PAGES} backfill=true`);

  const firstPage = await fetchPageSmart(OPEN_DATE, 1);
  if (!firstPage || !Array.isArray(firstPage.list) || firstPage.list.length === 0) {
    console.warn('warn: API returned empty list on all attempts for first page.');
    console.warn('warn: API returned no parseable rows, skip write.');
    return;
  }

  // 把第一頁的選項固化，後面翻頁沿用（dateKey/pageKey/endpoint/dateFormat）
  const chosen = firstPage.chosen;
  const totalSize = safeGet(firstPage.json, ['content', 'totalSize']);
  if (totalSize != null) {
    console.log(`debug: totalSize=${totalSize} list.length=${firstPage.list.length}`);
  }

  const allRows = [...firstPage.list];

  // 從第 2 頁開始抓
  const pagesToTry = Math.max(
    2,
    Math.min(
      MAX_PAGES,
      // 若有 totalSize，用它估算頁數；否則就用 MAX_PAGES
      totalSize ? Math.ceil(Number(totalSize) / PAGE_SIZE) : MAX_PAGES
    )
  );

  for (let p = 2; p <= pagesToTry; p++) {
    const res = await fetchPageWithChosen(OPEN_DATE, p, chosen);
    if (!res || !Array.isArray(res.list)) break;
    if (res.list.length === 0) break;
    allRows.push(...res.list);
  }

  // 標準化
  const normalized = [];
  for (const item of allRows) {
    const n = normalizeItem(item);
    if (n) normalized.push(n);
  }

  if (normalized.length === 0) {
    console.warn('warn: parsed 0 normalized rows, skip write.');
    return;
  }

  // 讀舊檔 merge
  const before = readJsonArraySafe(OUTPUT_FILE);
  const merged = mergeByPeriod(before, normalized);

  // 排序（依 period 由小到大；若需要你可依日期）
  merged.sort((a, b) => {
    // period 多為字串數字
    const pa = toInt(a.period, 0);
    const pb = toInt(b.period, 0);
    return pa - pb;
  });

  // 寫回
  ensureDir(path.dirname(OUTPUT_FILE));
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(merged, null, 2), 'utf8');

  console.log(`info: wrote ${normalized.length} new rows, total=${merged.length} -> ${relPath(OUTPUT_FILE)}`);
  // 顯示一筆樣本，幫助對齊欄位
  console.log('info: sample normalized row:', JSON.stringify(merged[merged.length - 1], null, 2));
}

// -----------------------------------------------------------------------------
// 擷取與解析
// -----------------------------------------------------------------------------
async function fetchPageSmart(openDate, pageNum) {
  // 只用 GET，第一頁從 1 起跳
  const dateFormats = [openDate, openDate.replaceAll('-', '/')];

  for (const ep of CANDIDATE_ENDPOINTS) {
    for (const d of dateFormats) {
      for (const dk of DATE_KEYS) {
        for (const pk of PAGE_KEYS) {
          try {
            const r = await tryFetchOne({ endpoint: ep, date: d, dateKey: dk, pageKey: pk, pageNum });
            const totalSize = safeGet(r.json, ['content', 'totalSize']);
            if (Array.isArray(r.list) && r.list.length > 0) {
              console.log(`debug: using method=GET endpoint="${ep}" ${dk}="${d}" ${pk}=${pageNum} startPage=1`);
              if (totalSize != null) console.log(`debug: totalSize=${totalSize} list.length=${r.list.length}`);
              return { ...r, chosen: { endpoint: ep, dateFormat: d.includes('/') ? 'slash' : 'dash', dateKey: dk, pageKey: pk } };
            }
            // 僅第一頁印 detail
            const topKeys = Object.keys(r.json ?? {});
            const contentKeys = r.json?.content ? Object.keys(r.json.content) : [];
            console.warn(`warn: empty list with GET ${dk}=${d} ${pk}=${pageNum} pageSize=${PAGE_SIZE}`);
            console.warn('warn: top-level keys =', topKeys);
            if (contentKeys.length) console.warn('warn: content keys =', contentKeys);
          } catch (e) {
            console.warn(`warn: fetch failed (GET ${dk}=${d} ${pk}=${pageNum}): ${e.message}`);
            // 若是 500, 405 之類就換組合重試
          }
        }
      }
    }
  }
  return null;
}

async function fetchPageWithChosen(openDate, pageNum, chosen) {
  const date = chosen?.dateFormat === 'slash' ? openDate.replaceAll('-', '/') : openDate;
  return tryFetchOne({
    endpoint: chosen.endpoint,
    date,
    dateKey: chosen.dateKey,
    pageKey: chosen.pageKey,
    pageNum
  }).catch(e => {
    console.warn(`warn: fetch page ${pageNum} failed: ${e.message}`);
    return null;
  });
}

// 嘗試打一種組合
async function tryFetchOne({ endpoint, date, dateKey, pageKey, pageNum }) {
  if (!BASE_URL) {
    throw new Error('BINGO_API_BASE is empty. Please set env BINGO_API_BASE to your API host, e.g. https://example.com');
  }
  const url = new URL(endpoint, BASE_URL);
  url.searchParams.set(dateKey, date);
  url.searchParams.set(pageKey, String(pageNum));     // 第一頁=1
  url.searchParams.set('pageSize', String(PAGE_SIZE));

  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      'accept': 'application/json, text/plain, */*'
    }
  });

  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}`);
  }

  const json = await parseJsonSafe(res);
  const list = pickListFromApi(json);
  return { url: url.toString(), json, list };
}

// 從 API 回傳中挑出清單（優先 content.bingoQueryResult）
function pickListFromApi(json) {
  if (Array.isArray(json)) return json;
  const j = json ?? {};
  const c = j.content ?? j.data ?? j.Content ?? {};

  const candidates = [
    c?.bingoQueryResult,      // <= 這次日誌顯示的真正清單
    c?.list, c?.rows, c?.result, c?.data, c?.List, c?.bingoList, c?.items,
    j?.list, j?.rows, j?.result, j?.List
  ];
  for (const x of candidates) {
    if (Array.isArray(x)) return x;
  }
  return [];
}

// -----------------------------------------------------------------------------
// 標準化
// -----------------------------------------------------------------------------
function normalizeItem(item) {
  if (!item || typeof item !== 'object') return null;

  // 期間/期數 (period)
  const period =
    str(item?.period) ??
    str(item?.issueNo) ??
    str(item?.issue) ??
    str(item?.drawNo) ??
    str(item?.PERIOD) ??
    str(item?.id) ??
    null;

  // 日期
  const dateRaw =
    str(item?.openDate) ??
    str(item?.open_time) ??
    str(item?.openTime) ??
    str(item?.drawDate) ??
    str(item?.date) ??
    str(item?.OPEN_DATE) ??
    '';

  const date = normalizeDate(dateRaw); // 轉成 YYYY-MM-DD（如果辦得到）

  // 20 顆球
  // 可能來自字串 "1,2,3..." 或 "1 2 3 ..." 或 "[1,2,...]"，或陣列
  const ballsStr =
    str(item?.winNo) ??
    str(item?.winningNumbers) ??
    str(item?.WinningNumbers) ??
    str(item?.winningNum) ??
    str(item?.numbers) ??
    str(item?.OpenCode) ??
    str(item?.winNumbers) ??
    str(item?.WIN_NO) ??
    str(item?.num) ??
    str(item?.bingoNumbers) ??
    '';

  const ballsArr = Array.isArray(item?.numbers)
    ? item.numbers
    : parseNumbers(ballsStr);

  const balls = cleanupBalls(ballsArr);

  // super / 特別號
  const superRaw =
    item?.super ??
    item?.superNumber ??
    item?.SUPER ??
    item?.special ??
    item?.extra ??
    item?.super_num ??
    item?.superNo ??
    item?.superBall ??
    null;

  const superNum = toInt(superRaw, null);

  // 基本驗證：balls 需是數字陣列，通常 20 顆（若不是也仍保留）
  if (!Array.isArray(balls) || balls.length === 0) return null;

  return {
    period: period ?? '',           // 有些來源沒有 period，仍保留
    date: date ?? '',
    balls,
    super: superNum
  };
}

// -----------------------------------------------------------------------------
// 工具
// -----------------------------------------------------------------------------
function tzDate(tz) {
  // 取某時區當地日期 YYYY-MM-DD
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  return fmt.format(new Date()); // en-CA -> YYYY-MM-DD
}

function toInt(v, d = 0) {
  const n = Number.parseInt(String(v ?? '').trim(), 10);
  return Number.isFinite(n) ? n : d;
}

function str(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

async function parseJsonSafe(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    // 有些 API 回 JSONP 或帶 BOM，簡單清一下
    const cleaned = text
      .replace(/^[\ufeff]+/, '')
      .replace(/^\)\]\}',?/, '')
      .trim();
    try {
      return JSON.parse(cleaned);
    } catch {
      return {};
    }
  }
}

function pickDateParts(s) {
  // 從各種字串中抓出 YYYY-MM-DD
  if (!s) return null;
  // 支援 "YYYY-MM-DD", "YYYY/MM/DD", "YYYYMMDD", "YYYY-MM-DD hh:mm:ss"
  const m =
    s.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/) ||
    s.match(/(\d{4})(\d{2})(\d{2})/);
  if (!m) return null;
  let y = Number(m[1]);
  let mo = Number(m[2]);
  let d = Number(m[3]);
  if (!y || !mo || !d) return null;
  return { y, mo, d };
}

function normalizeDate(s) {
  const p = pickDateParts(s || '');
  if (!p) return '';
  const mm = String(p.mo).padStart(2, '0');
  const dd = String(p.d).padStart(2, '0');
  return `${p.y}-${mm}-${dd}`;
}

function parseNumbers(s) {
  if (!s) return [];
  // 支援 "1,2,3", "1 2 3", "1|2|3", "1、2、3" 等
  const parts = String(s)
    .replace(/[\[\]\(\)]/g, ' ')
    .split(/[^0-9]+/g)
    .map(x => x.trim())
    .filter(Boolean);
  return parts.map(n => toInt(n, NaN)).filter(Number.isFinite);
}

function cleanupBalls(arr) {
  if (!Array.isArray(arr)) return [];
  // 僅保留 1~80 的整數，去重，最多保留 20 顆（BINGO 典型）
  const set = new Set();
  for (const n of arr) {
    const v = toInt(n, NaN);
    if (!Number.isFinite(v)) continue;
    if (v < 1 || v > 80) continue;
    set.add(v);
    if (set.size >= 20) break;
  }
  return Array.from(set.values());
}

function readJsonArraySafe(file) {
  try {
    const txt = fs.readFileSync(file, 'utf8');
    const j = JSON.parse(txt);
    return Array.isArray(j) ? j : [];
  } catch {
    return [];
  }
}

function mergeByPeriod(oldArr, newArr) {
  const map = new Map();
  for (const x of oldArr) {
    if (!x || typeof x !== 'object') continue;
    map.set(String(x.period ?? ''), x);
  }
  for (const y of newArr) {
    const key = String(y.period ?? '');
    if (!key || !map.has(key)) {
      map.set(key, y);
    } else {
      // 若要覆蓋，可在此比較日期新舊或欄位完整度
      // 這裡採「舊優先不覆蓋」
    }
  }
  return Array.from(map.values());
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function relPath(p) {
  return path.relative(process.cwd(), p);
}

function safeGet(obj, pathArr) {
  let cur = obj;
  for (const k of pathArr) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = cur[k];
  }
  return cur;
}

function uniq(arr) {
  return Array.from(new Set(arr));
}

// -----------------------------------------------------------------------------
// 執行
// -----------------------------------------------------------------------------
main().catch(err => {
  console.error('fatal:', err?.stack || err?.message || err);
  process.exitCode = 1;
});
