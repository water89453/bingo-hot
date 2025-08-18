// scripts/fetch_bingo.mjs
// BingoBingo 抓取腳本（支援手動 ENDPOINT 快速通道 + 自動猜 API 參數 + HTML 保底）
// Node 20+ (原生 fetch)

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ----------- 環境變數 -----------
const BASE      = process.env.BINGO_API_BASE || 'https://api.taiwanlottery.com/TLCAPIWeb';
const openDate  = process.env.OPEN_DATE || '';         // YYYY-MM-DD（空=今天）
const PAGE_SIZE = Number(process.env.PAGE_SIZE || '50');
const MAX_PAGES = Number(process.env.MAX_PAGES || '20');
const ENDPOINT  = process.env.ENDPOINT || '';          // 例如 /api/Draw/GetBingoAwardList

// ----------- 小工具 -----------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function safeFetch(url, opt = {}) {
  const res = await fetch(url, { ...opt, headers: { 'accept': 'application/json,*/*;q=0.8' } });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText}${text ? ` - ${text.slice(0, 120)}` : ''}`);
  }
  // 嘗試 JSON -> 失敗就回傳 text
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) return res.json();
  const txt = await res.text();
  try { return JSON.parse(txt); } catch { return txt; }
}

function toInt(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : undefined;
}

function parseBallArray(v) {
  // 支援：
  // - [1,2,3,...]
  // - ["1","2",...]
  // - "1,2,3,..." / "01,02,..." / "1 2 3 ..."
  // - [{no:1},{No:2}] / [{num:1}]
  if (!v) return [];
  if (Array.isArray(v)) {
    const arr = v.map(x => {
      if (typeof x === 'number' || typeof x === 'string') return toInt(x);
      if (x && typeof x === 'object') {
        return toInt(x.no ?? x.No ?? x.num ?? x.Num ?? x.n ?? x.value);
      }
      return undefined;
    }).filter(n => Number.isFinite(n));
    return arr;
  }
  if (typeof v === 'string') {
    const parts = v.split(/[^0-9]+/).map(s => s.trim()).filter(Boolean);
    return parts.map(toInt).filter(Number.isFinite);
  }
  return [];
}

function pick(obj, keys) {
  for (const k of keys) {
    if (obj?.[k] != null) return obj[k];
  }
  return undefined;
}

function normalizeOne(item) {
  if (!item || typeof item !== 'object') return null;

  // 期別
  const periodRaw = pick(item, [
    'period','Period','term','Term','issueNo','IssueNo','drawTerm','DrawTerm',
    'Serial','SerialNo','id','Id','ID'
  ]);
  const period = periodRaw != null ? String(periodRaw).trim() : undefined;

  // 日期
  const dateRaw = pick(item, [
    'date','Date','drawDate','DrawDate','openDate','OpenDate','awardDate','AwardDate'
  ]);
  const date = dateRaw != null ? String(dateRaw).trim() : '';

  // 球號
  const ballsRaw = pick(item, [
    'balls','Balls','numbers','Numbers','nums','Nums','luckyNos','DrawNumbers','DrawNums'
  ]);
  const balls = parseBallArray(ballsRaw);

  // 超級號
  const superRaw = pick(item, [
    'super','Super','superNo','SuperNo','superNumber','SuperNumber','special','Special','Bonus','extra','Extra'
  ]);
  const superNumber =
    Number.isFinite(toInt(superRaw))
      ? toInt(superRaw)
      : (() => {
          // 有些資料會把超級號混在同一陣列最後一個
          if (Array.isArray(balls) && balls.length >= 21) {
            return balls[balls.length - 1];
          }
          return undefined;
        })();

  // 嘗試從其他可能結構補球號：例如 obj {n01:1,n02:3,...}
  if (balls.length === 0) {
    const nums = [];
    for (let i = 1; i <= 20; i++) {
      const k1 = `n${i.toString().padStart(2,'0')}`;
      const k2 = `N${i.toString().padStart(2,'0')}`;
      const k3 = `no${i}`;
      const v = item[k1] ?? item[k2] ?? item[k3];
      const iv = toInt(v);
      if (Number.isFinite(iv)) nums.push(iv);
    }
    if (nums.length) {
      balls.push(...nums);
    }
  }

  // 只接受至少 20 個球
  if (!period || balls.length < 20) return null;

  // balls 只取前 20
  const first20 = balls.slice(0,20).map(n => toInt(n)).filter(Number.isFinite);
  if (first20.length !== 20) return null;

  return {
    period: String(period),
    date: date || '',
    balls: first20,
    super: Number.isFinite(superNumber) ? superNumber : undefined
  };
}

function normalizeList(listLike) {
  const list = Array.isArray(listLike) ? listLike
              : Array.isArray(listLike?.list) ? listLike.list
              : Array.isArray(listLike?.data) ? listLike.data
              : Array.isArray(listLike?.result) ? listLike.result
              : Array.isArray(listLike?.rows) ? listLike.rows
              : Array.isArray(listLike?.items) ? listLike.items
              : Array.isArray(listLike?.Data?.List) ? listLike.Data.List
              : Array.isArray(listLike?.Response?.Data) ? listLike.Response.Data
              : [];

  const out = list.map(normalizeOne).filter(Boolean);

  // 去重（以 period 為 key）
  const seen = new Set();
  const uniq = [];
  for (const r of out) {
    if (!seen.has(r.period)) {
      seen.add(r.period);
      uniq.push(r);
    }
  }
  return uniq;
}

function makeDateVariants() {
  const d = openDate ? new Date(openDate) : new Date();
  const yyyy = d.getFullYear();
  const mm   = String(d.getMonth() + 1).padStart(2, '0');
  const dd   = String(d.getDate()).padStart(2, '0');
  const roc  = String(yyyy - 1911).padStart(3, '0');

  return [
    `${yyyy}-${mm}-${dd}`,
    `${yyyy}/${mm}/${dd}`,
    `${roc}-${mm}-${dd}`,
    `${roc}/${mm}/${dd}`
  ];
}

async function tryEndpointOnce(endpoint, dk, dv, pk, page) {
  const qs = new URLSearchParams();
  qs.set(dk, dv);
  if (pk) qs.set(pk, page);
  if (!qs.has('pageSize')) qs.set('pageSize', String(PAGE_SIZE));

  const url = `${BASE}${endpoint}?${qs.toString()}`;
  const data = await safeFetch(url);
  return data;
}

async function tryEndpointPaged(endpoint, dk, dv, pk) {
  // 逐頁抓，直到空或達上限
  const pages = [];
  for (let p = 1; p <= MAX_PAGES; p++) {
    try {
      const data = await tryEndpointOnce(endpoint, dk, dv, pk, p);
      const got = normalizeList(data);
      if (got.length === 0) {
        if (p === 1) {
          // 第一頁就空，直接放棄
          return [];
        }
        break;
      }
      pages.push(...got);
    } catch (e) {
      console.log(`warn: fetch failed (GET ${dk}=${dv} ${pk ? `${pk}=${p}` : ''}): ${e.message}`);
      // 第一頁就 404 / 失敗 => 視為此組不可用
      if (p === 1) return [];
      break;
    }
    await sleep(120);
  }
  return pages;
}

async function manualFastPath() {
  if (!ENDPOINT) return null;

  const tryKeys  = ['openDate','queryDate','drawDate','date','OpenDate'];
  const tryPages = ['pageNum','pageIndex','page','']; // '' 表示不帶分頁參數也試試
  const dvs = makeDateVariants();

  for (const dv of dvs) {
    for (const dk of tryKeys) {
      for (const pk of tryPages) {
        try {
          const rows = await tryEndpointPaged(ENDPOINT, dk, dv, pk || null);
          if (rows.length) {
            console.log(`info: API hit at ${ENDPOINT} date=${dv} (${dk}${pk?`, ${pk}`:''}) got ${rows.length} rows`);
            return rows;
          }
        } catch (e) {
          const qs = `${dk}=${encodeURIComponent(dv)}${pk?`&${pk}=1`:''}`;
          console.log(`warn: manual endpoint failed (${ENDPOINT}?${qs}): ${e.message}`);
        }
        await sleep(100);
      }
    }
  }
  console.log('warn: manual endpoint gave no rows, fallback to auto guessing…');
  return null;
}

async function autoGuessApis() {
  // 嘗試可能的端點
  const endpoints = [
    '/api/Draw/GetBingoAwardList',
    '/api/Game/GetBingoAwardList',
    '/api/BingoBingo/GetAwardList',
    '/api/Games/BingoBingo/GetAwardList',
    '/api/Lottery/GetBingoAwardList'
  ];

  const dateKeys  = ['openDate','queryDate','drawDate','date','OpenDate'];
  const pageKeys  = ['pageNum','pageIndex','page','']; // '' = 不帶分頁參數
  const dvs       = makeDateVariants();

  for (const ep of endpoints) {
    for (const dv of dvs) {
      for (const dk of dateKeys) {
        for (const pk of pageKeys) {
          const rows = await tryEndpointPaged(ep, dk, dv, pk || null);
          if (rows.length) {
            console.log(`info: API hit at ${ep} date=${dv} (${dk}${pk?`, ${pk}`:''}) got ${rows.length} rows`);
            return rows;
          }
          await sleep(100);
        }
      }
    }
  }
  return [];
}

async function htmlFallback() {
  // 舊官網頁面可能 404，但還是嘗試一次
  const urls = [
    'https://www.taiwanlottery.com/lotto/bingobingo/drawing.aspx',
    'https://www.taiwanlottery.com/lotto/bingobingo/history.aspx'
  ];
  for (const u of urls) {
    try {
      console.log(`debug: GET (html) ${u}`);
      const txt = await safeFetch(u);
      if (typeof txt !== 'string') throw new Error('not html');
      // 這裡略：若未來有 HTML 結構可 parse，再補解析器
      throw new Error('parser not implemented for HTML');
    } catch (e) {
      console.log(`warn: HTML 失敗 ${u} ${e.message}`);
    }
    await sleep(80);
  }
  return [];
}

async function loadExisting() {
  const p = path.join(__dirname, '..', 'web', 'data', 'draws.json');
  try {
    const buf = await fs.readFile(p, 'utf8');
    const arr = JSON.parse(buf);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function mergeDraws(existing, incoming) {
  const map = new Map(existing.map(r => [String(r.period), r]));
  for (const r of incoming) {
    map.set(String(r.period), r);
  }
  // 排序：期別數字大到小（或小到大都可，這裡選小到大）
  const out = [...map.values()].sort((a, b) => {
    const na = Number(a.period);
    const nb = Number(b.period);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
    return String(a.period).localeCompare(String(b.period));
  });
  return out;
}

async function saveDraws(all) {
  const p = path.join(__dirname, '..', 'web', 'data', 'draws.json');
  await fs.mkdir(path.dirname(p), { recursive: true });
  const json = JSON.stringify(all, null, 2);
  await fs.writeFile(p, json, 'utf8');
}

async function main() {
  // 訊息列印
  console.log(`info: openDate=${openDate || '(today)'} pageSize=${PAGE_SIZE} maxPages=${MAX_PAGES} backfill=true`);

  // 先試手動 endpoint（若有填）
  let rows = await manualFastPath();
  if (!rows) {
    // 自動猜
    rows = await autoGuessApis();
  }

  if (!rows || rows.length === 0) {
    console.log('warn: API 全部 404 或無資料，嘗試 HTML fallback...');
    const htmlRows = await htmlFallback();
    if (!htmlRows.length) {
      console.log('warn: API returned no parseable rows, skip write.');
      return;
    }
    rows = htmlRows;
  }

  // 正常寫入
  const existing = await loadExisting();
  const merged   = mergeDraws(existing, rows);

  if (JSON.stringify(existing) === JSON.stringify(merged)) {
    console.log('warn: no new normalized rows, skip write.');
    return;
  }

  await saveDraws(merged);
  console.log(`info: wrote ${merged.length} rows to web/data/draws.json`);
}

main().catch(err => {
  console.error('fatal:', err);
  process.exitCode = 1;
});
