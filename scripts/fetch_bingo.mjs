/* eslint-disable no-console */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASE = (process.env.BINGO_API_BASE || '').replace(/\/+$/, ''); // 去尾斜線
const OPEN_DATE = process.env.OPEN_DATE || new Date().toISOString().slice(0, 10);
const PAGE_SIZE = Number(process.env.PAGE_SIZE || 50);
const MAX_PAGES = Number(process.env.MAX_PAGES || 20);

const DATA_FILE = path.join(__dirname, '..', 'web', 'data', 'draws.json');

// 小工具
async function readJson(file) {
  try {
    const s = await fs.readFile(file, 'utf8');
    return JSON.parse(s);
  } catch {
    return [];
  }
}
async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

async function safeFetch(url, opts = {}) {
  console.log('debug: GET', url);
  const res = await fetch(url, { ...opts, redirect: 'follow' });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw Object.assign(new Error(`${res.status} ${res.statusText}`), {
      status: res.status,
      body: text?.slice(0, 400),
    });
  }
  // 嘗試 JSON；失敗就回文字
  const ctype = res.headers.get('content-type') || '';
  if (ctype.includes('application/json')) return res.json();
  return res.text();
}

// ==== 第一階段：嘗試 API（多種參數名稱）====
async function tryOfficialApi(openDate) {
  // 這裡留白「endpoint 清單」，因為官網 API 路徑常改名。
  // 你可以把觀察到能回 200 的實際路徑補在 endpoints 裡。
  const endpoints = [
    // 以下是「猜測」的範例，請依你 curl/Log 驗證後改成正確路徑：
    // '/api/Games/BingoBingo/GetAwardList',
    // '/api/BingoBingo/GetAwardList',
    // '/api/Draw/GetBingoAwardList',
  ];

  const dateKeys = ['openDate', 'queryDate', 'drawDate', 'date', 'OpenDate'];
  const pageKeys = ['pageNum', 'pageIndex', 'page'];

  for (const ep of endpoints) {
    for (const dk of dateKeys) {
      for (const pk of pageKeys) {
        for (let page = 1; page <= Math.min(MAX_PAGES, 3); page += 1) {
          const url = `${BASE}${ep}?${dk}=${openDate}&${pk}=${page}&pageSize=${PAGE_SIZE}`;
          try {
            const data = await safeFetch(encodeURI(url));
            // 依實際 API 結構調整解析：
            // 預期 data 會有 list；這裡盡量兼容常見結構
            const list = Array.isArray(data?.list)
              ? data.list
              : Array.isArray(data?.data)
              ? data.data
              : Array.isArray(data?.result)
              ? data.result
              : Array.isArray(data)
              ? data
              : [];

            if (list.length) {
              console.log(`info: API hit at ${ep} (${dk}, ${pk}) page=${page}, got ${list.length} rows`);
              return { rows: list, source: 'api', meta: { ep, dk, pk } };
            }
          } catch (err) {
            console.log(`warn: API 失敗 (${url}): ${err.message}`);
          }
          await delay(100);
        }
      }
    }
  }
  return { rows: [], source: 'api' };
}

// ==== 第二階段：HTML fallback（官網頁面解析）====
import { JSDOM } from 'jsdom';

// 嘗試幾個可能的頁面（舉例）
const HTML_PAGES = [
  // 有些官網頁面會把當日或近幾期資料渲染在 HTML/JS 中
  'https://www.taiwanlottery.com/lotto/bingobingo/drawing.aspx',
  'https://www.taiwanlottery.com/lotto/bingobingo/history.aspx',
];

function parseBingoFromHtml(html) {
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  // 這部分依實際 DOM 結構微調：以下提供一個「通用」搜表格/清單的策略
  const rows = [];
  const tables = [...doc.querySelectorAll('table')];
  for (const tb of tables) {
    const trs = [...tb.querySelectorAll('tr')];
    for (const tr of trs) {
      const tds = [...tr.querySelectorAll('td,th')].map((x) => x.textContent.trim());
      // 嘗試從一列中抓出 20 顆球＋期別（需依實際頁面調）
      const nums = tds.flatMap((t) => t.match(/\d+/g) || []).map((x) => Number(x)).filter((n) => n >= 1 && n <= 80);
      if (nums.length >= 20) {
        const balls = nums.slice(0, 20);
        const superNum = nums.find((n, i) => i >= 20 && n >= 1 && n <= 80) ?? null;
        // 期別：從該列文字找連續數字長串
        const periodMatch = tds.join(' ').match(/\b\d{6,}\b/);
        rows.push({
          period: periodMatch ? periodMatch[0] : '',
          date: '',
          balls,
          super: superNum,
        });
      }
    }
  }
  // 去重＆基本清洗
  const uniq = new Map();
  for (const r of rows) {
    const key = r.period ? r.period : r.balls.join('-') + '-' + r.super;
    if (!uniq.has(key)) uniq.set(key, r);
  }
  return [...uniq.values()];
}

async function scrapeHtmlFallback() {
  for (const url of HTML_PAGES) {
    try {
      console.log('debug: GET (html)', url);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const html = await res.text();
      const rows = parseBingoFromHtml(html);
      if (rows.length) {
        console.log(`info: HTML 解析到 ${rows.length} 筆`);
        return { rows, source: 'html' };
      }
    } catch (err) {
      console.log('warn: HTML 失敗', url, err.message);
    }
  }
  return { rows: [], source: 'html' };
}

// ==== 主流程 ====
(async () => {
  console.log(`info: openDate=${OPEN_DATE} pageSize=${PAGE_SIZE} maxPages=${MAX_PAGES} backfill=true`);

  const existing = await readJson(DATA_FILE);

  // 先打 API
  let { rows, source } = await tryOfficialApi(OPEN_DATE);

  // 全部 404/空 -> 退回 HTML 解析
  if (!rows.length) {
    console.log('warn: API 全部 404 或無資料，嘗試 HTML fallback...');
    const fb = await scrapeHtmlFallback();
    rows = fb.rows;
    source = fb.source;
  }

  if (!rows.length) {
    console.log('warn: API returned no parseable rows, skip write.');
    process.exit(0);
  }

  // 將 rows 正規化（依你的前端需求）
  const normalized = rows.map((r) => ({
    period: String(r.period || ''),
    date: r.date || '',
    balls: Array.isArray(r.balls) ? r.balls.slice(0, 20).map((n) => Number(n)) : [],
    super: r.super != null ? Number(r.super) : null,
  })).filter(r => r.balls.length === 20);

  // 合併舊資料（以 period/balls 為 key 去重）
  const keyOf = (it) => (it.period ? `P:${it.period}` : `B:${it.balls.join('-')}:${it.super ?? ''}`);
  const map = new Map(existing.map((e) => [keyOf(e), e]));
  for (const n of normalized) map.set(keyOf(n), n);
  const merged = [...map.values()];

  // 有變化才寫檔
  const changed = JSON.stringify(existing) !== JSON.stringify(merged);
  if (changed) {
    await writeJson(DATA_FILE, merged);
    console.log(`info: ${source} -> write ${DATA_FILE}, total=${merged.length}`);
  } else {
    console.log('info: no changes after merge.');
  }
})().catch((e) => {
  console.error('fatal:', e.message);
  process.exit(1);
});
