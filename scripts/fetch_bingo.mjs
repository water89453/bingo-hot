// scripts/fetch_bingo.mjs
// A 版：支援 OPEN_DATE 覆蓋，預設抓台北今天；從官方 API 分頁抓、合併寫入 web/data/draws.json

import fs from 'node:fs/promises';
import path from 'node:path';

// ---------------------- 設定 ----------------------
const OUT_FILE = path.join('web', 'data', 'draws.json');

// 可由 workflow 傳入的環境變數：
// OPEN_DATE: 覆蓋查詢日期（YYYY-MM-DD）；不填則用台北今天
// PAGE_SIZE: 每頁筆數（預設 50，上限 50）
// MAX_PAGES: 最多抓幾頁（預設 20）
const PAGE_SIZE = Math.min(parseInt(process.env.PAGE_SIZE || '50', 10) || 50, 50);
const MAX_PAGES = parseInt(process.env.MAX_PAGES || '20', 10) || 20;

// ---------------------- 小工具 ----------------------
function tpeTodayStr() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const z = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${z(now.getMonth() + 1)}-${z(now.getDate())}`;
}

const OPEN_DATE = (process.env.OPEN_DATE || '').trim() || tpeTodayStr();

function normalizeNums(arr) {
  // 轉 int、過濾 1..80、去重、排序
  const set = new Set(
    arr
      .map(x => parseInt(String(x).trim(), 10))
      .filter(n => Number.isInteger(n) && n >= 1 && n <= 80)
  );
  return Array.from(set).sort((a, b) => a - b);
}

function parseNumbersFromUnknownShape(item) {
  // 嘗試從 API 項目中取出 20 顆號碼與超級獎號，容錯多種欄位名稱/格式
  // 常見欄位猜測：winNum / winNo / drawNumbers / numbers ... 可能是 "1,2,..."
  const candidates = [
    item.winNum, item.winNo, item.drawNumbers, item.numbers, item.normalNumbers,
    item.WinNum, item.WinNo, item.Numbers
  ];
  let numsRaw = candidates.find(v => v != null);

  // 一些 API 會把號碼分欄：n1..n20
  if (!numsRaw) {
    const keys = Object.keys(item);
    const nKeys = keys.filter(k => /^n\d{1,2}$|^num\d{1,2}$/i.test(k));
    if (nKeys.length) {
      numsRaw = nKeys.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
        .map(k => item[k]);
    }
  }

  // 正規化 20 顆
  let balls = [];
  if (Array.isArray(numsRaw)) {
    balls = normalizeNums(numsRaw);
  } else if (typeof numsRaw === 'string') {
    // 拆出所有整數
    balls = normalizeNums(numsRaw.split(/[^0-9]+/));
  } else if (numsRaw == null) {
    // 有些可能放在 array 欄位
    if (Array.isArray(item.normal) || Array.isArray(item.numbers)) {
      balls = normalizeNums((item.normal || item.numbers));
    }
  }

  // 超級獎號
  const superCandidates = [
    item.super, item.superNo, item.superNum, item.superNumber,
    item.bonus, item.bonusNo, item.Special, item.special, item.SuperNo, item.SuperNum
  ].filter(v => v != null);

  let sup = NaN;
  for (const cand of superCandidates) {
    if (Number.isInteger(cand)) { sup = cand; break; }
    if (typeof cand === 'string') {
      const m = cand.match(/\d+/);
      if (m) { sup = parseInt(m[0], 10); break; }
    }
  }

  // 若 API 沒提供獨立超級號，沿用網頁慣例：以 20 顆中的最後一顆視為 super
  if (!Number.isInteger(sup) && balls.length === 20) {
    sup = balls.at(-1);
  }

  return { balls, super: sup };
}

function getPeriodFromItem(item) {
  // 常見欄位：period / issueNo / drawTerm / term
  const cands = [item.period, item.issueNo, item.drawTerm, item.term, item.IssueNo, item.Period];
  const val = cands.find(v => v != null);
  return val != null ? String(val).trim() : '';
}

function getDateFromItem(item) {
  // 常見欄位：openDate / drawDate / date
  const cands = [item.openDate, item.drawDate, item.date, item.OpenDate, item.DrawDate];
  const val = cands.find(v => v != null);
  return val != null ? String(val).trim() : '';
}

async function readJsonSafe(file) {
  try {
    const txt = await fs.readFile(file, 'utf8');
    return JSON.parse(txt);
  } catch {
    return [];
  }
}

async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2));
}

function latestPeriod(list) {
  if (!list.length) return null;
  // 字串比較即可（同長度、遞增）
  return list.map(x => x.period).sort().at(-1);
}

// ---------------------- 抓取 API ----------------------
function buildApiUrl(dateStr, pageNum, pageSize) {
  const u = new URL('https://api.taiwanlottery.com/TLCAPIWeB/Lottery/BingoResult');
  u.searchParams.set('openDate', dateStr);    // YYYY-MM-DD
  u.searchParams.set('pageNum', String(pageNum));
  u.searchParams.set('pageSize', String(pageSize));
  return u.toString();
}

async function fetchOnePage(dateStr, pageNum, pageSize) {
  const url = buildApiUrl(dateStr, pageNum, pageSize);
  const res = await fetch(url, {
    headers: {
      'Accept': 'application/json, text/plain, */*',
      'User-Agent': 'bingo-hot-fetch/1.0 (+github actions; node20)',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
    }
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }
  const json = await res.json();

  // 嘗試從幾個常見容器拿資料
  const rows =
    json?.pageData ||
    json?.data?.pageData ||
    json?.data?.list ||
    json?.list ||
    json?.data ||
    [];

  if (!Array.isArray(rows)) return [];
  // 轉成我們的結構
  const parsed = [];
  for (const it of rows) {
    const period = getPeriodFromItem(it);
    const date = getDateFromItem(it);
    const { balls, super: sup } = parseNumbersFromUnknownShape(it);
    parsed.push({ period, date, balls, super: sup });
  }
  return parsed;
}

async function fetchAllPages(dateStr) {
  const all = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const rows = await fetchOnePage(dateStr, page, PAGE_SIZE);
    all.push(...rows);
    // 若回傳數量小於 pageSize，視為最後一頁
    if (rows.length < PAGE_SIZE) break;
  }
  return all;
}

// ---------------------- 主流程 ----------------------
(async () => {
  console.log(`info: openDate=${OPEN_DATE} pageSize=${PAGE_SIZE} maxPages=${MAX_PAGES}`);

  const old = await readJsonSafe(OUT_FILE);
  const oldLatest = latestPeriod(old);

  let pageRows = [];
  try {
    pageRows = await fetchAllPages(OPEN_DATE);
  } catch (err) {
    console.error('error: fetch failed:', err?.message || err);
    process.exitCode = 1;
    return;
  }

  // 只保留完整資料
  const complete = pageRows.filter(r =>
    r.period && r.balls?.length === 20 && Number.isInteger(r.super)
  );

  if (complete.length === 0) {
    console.warn('warn: API returned no complete rows, skip writing.');
    console.log(`info: oldLatest=${oldLatest ?? 'none'}`);
    return;
  }

  // 以 period 合併舊資料（同期若舊資料不完整則用新資料覆蓋）
  const byPeriod = new Map(old.map(x => [x.period, x]));
  let added = 0;
  for (const r of complete) {
    if (!byPeriod.has(r.period)) {
      byPeriod.set(r.period, r);
      added++;
    } else {
      const prev = byPeriod.get(r.period);
      const prevOk = prev?.balls?.length === 20 && Number.isInteger(prev?.super);
      const curOk = r.balls?.length === 20 && Number.isInteger(r.super);
      if (!prevOk && curOk) byPeriod.set(r.period, r);
    }
  }

  // 排序（由小到大）
  const next = Array.from(byPeriod.values())
    .sort((a, b) => String(a.period).localeCompare(String(b.period)));

  // 只有有變化才寫檔
  if (added > 0 || next.length !== old.length) {
    await writeJson(OUT_FILE, next);
  }

  const newLatest = latestPeriod(next);
  console.log(`done. added=${added}, total=${next.length}, latest(old->new)=${oldLatest} -> ${newLatest}`);
})();
