// scripts/fetch_bingo.mjs
import fs from 'node:fs/promises';

const API_BASE = 'https://api.taiwanlottery.com/TLCAPIWeB/Lottery/BingoResult';

const OPEN_DATE = process.env.OPEN_DATE?.trim() || '';          // 指定日期 YYYY-MM-DD（留空=台北今天）
const PAGE_SIZE = parseInt(process.env.PAGE_SIZE || '50', 10);  // 建議 50
const MAX_PAGES = parseInt(process.env.MAX_PAGES || '20', 10);  // 最多翻到幾頁
const BACKFILL = process.env.BACKFILL === 'true' || !!OPEN_DATE; // 有指定 OPEN_DATE 就自動回填
const DATA_PATH = 'web/data/draws.json';

function toTaipeiTodayISO() {
  const fmt = (n) => String(n).padStart(2, '0');
  const now = new Date();
  const tzNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const y = tzNow.getFullYear();
  const m = fmt(tzNow.getMonth() + 1);
  const d = fmt(tzNow.getDate());
  return `${y}-${m}-${d}`;
}

function splitNums(s) {
  if (!s) return [];
  return String(s)
    .split(/[\s,;、，]+/)
    .map(x => x.replace(/[^\d]/g, ''))
    .filter(x => x.length > 0)
    .map(x => parseInt(x, 10))
    .filter(n => Number.isInteger(n) && n >= 1 && n <= 80);
}

// 將一筆 API 物件轉成我們的資料格式：{ period, date, balls[20], super }
function normalizeItem(item) {
  // 期數（盡量從各種常見欄位撈）
  const periodRaw = item?.period ?? item?.lotteryDrawNum ?? item?.drawNo ?? item?.term ?? item?.issueNo ?? item?.DRAW_NO ?? item?.id;
  const period = periodRaw != null ? String(periodRaw).trim() : '';

  // 日期
  const dateRaw = item?.openDate ?? item?.open_time ?? item?.drawDate ?? item?.date ?? item?.OPEN_DATE ?? '';
  const date = dateRaw ? String(dateRaw).slice(0, 10) : '';

  // 號碼 20 顆
  const ballsStr =
    item?.winNo ?? item?.winningNumbers ?? item?.WinningNumbers ?? item?.winningNum ??
    item?.numbers ?? item?.OpenCode ?? item?.winNumbers ?? item?.WIN_NO ?? item?.num;
  const balls = splitNums(ballsStr).slice(0, 20);

  // 超級號
  const superRaw = item?.super ?? item?.superNumber ?? item?.SUPER ?? item?.special ?? item?.extra ?? item?.super_num;
  const superNum = superRaw != null ? splitNums(superRaw)[0] ?? parseInt(superRaw, 10) : undefined;

  // 有些 API 可能把前 20 顆拆在陣列/欄位；補捉一下
  if (balls.length < 20) {
    const maybeArray = item?.numbers ?? item?.nums ?? item?.winNums ?? item?.WIN_NUMS;
    if (Array.isArray(maybeArray)) {
      const arr = maybeArray.map(n => parseInt(n, 10)).filter(n => Number.isInteger(n) && n >= 1 && n <= 80);
      if (arr.length >= 20) {
        balls.splice(0, balls.length, ...arr.slice(0, 20));
      }
    }
  }

  if (!period || balls.length !== 20) return null;

  return {
    period,
    date,
    balls,
    super: Number.isInteger(superNum) ? superNum : undefined,
  };
}

async function fetchPage(openDate, pageNum) {
  const url = `${API_BASE}?openDate=${encodeURIComponent(openDate)}&pageNum=${pageNum}&pageSize=${PAGE_SIZE}`;
  const res = await fetch(url, {
    headers: {
      // 一些公開 API 需要 UA；加上以防被擋
      'User-Agent': 'bingo-hot/1.0 (+github actions)',
      'Accept': 'application/json, text/plain, */*',
      'Referer': 'https://www.taiwanlottery.com.tw/',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return res.json();
}

function pickListFromApi(json) {
  // 常見包裝：{ code, data: { list: [...] } } / { data: [...] } / { list: [...] } / 直接陣列
  const d = json?.data ?? json;
  if (Array.isArray(d)) return d;
  if (Array.isArray(d?.list)) return d.list;
  if (Array.isArray(json?.list)) return json.list;
  return [];
}

async function loadExisting() {
  try {
    const txt = await fs.readFile(DATA_PATH, 'utf-8');
    const arr = JSON.parse(txt);
    if (Array.isArray(arr)) return arr;
    return [];
  } catch {
    return [];
  }
}

function sortByPeriodAsc(a, b) {
  const na = parseInt(a.period, 10);
  const nb = parseInt(b.period, 10);
  if (Number.isNaN(na) || Number.isNaN(nb)) return String(a.period).localeCompare(String(b.period));
  return na - nb;
}

async function saveIfChanged(rows) {
  const prev = await loadExisting();
  const prevStr = JSON.stringify(prev);

  // 合併：以 period 去重
  const map = new Map();
  for (const r of prev) map.set(r.period, r);
  for (const r of rows) map.set(r.period, r);

  const merged = Array.from(map.values()).sort(sortByPeriodAsc);
  const nextStr = JSON.stringify(merged);

  if (prevStr === nextStr) {
    console.log('info: merged equals previous, no write.');
    return false;
  }
  await fs.mkdir('web/data', { recursive: true });
  await fs.writeFile(DATA_PATH, nextStr);
  console.log(`info: wrote ${merged.length} rows to ${DATA_PATH}`);
  return true;
}

async function main() {
  const openDate = OPEN_DATE || toTaipeiTodayISO();
  console.log(`info: openDate=${openDate} pageSize=${PAGE_SIZE} maxPages=${MAX_PAGES} backfill=${BACKFILL}`);

  const collected = [];
  let page = 1;
  let printedSample = false;

  while (page <= MAX_PAGES) {
    let json;
    try {
      json = await fetchPage(openDate, page);
    } catch (e) {
      console.warn(`warn: fetch page ${page} failed: ${e.message}`);
      break;
    }
    const list = pickListFromApi(json);
    if (!Array.isArray(list) || list.length === 0) {
      if (page === 1) console.warn('warn: API returned empty list.');
      break;
    }

    if (!printedSample) {
      // 印第一筆做除錯（避免太長，挑重點）
      const sample = { ...list[0] };
      for (const k of Object.keys(sample)) {
        const v = sample[k];
        if (typeof v === 'string' && v.length > 120) sample[k] = v.slice(0, 120) + '...';
      }
      console.log('debug: first item from API:', sample);
      printedSample = true;
    }

    for (const it of list) {
      const row = normalizeItem(it);
      if (row) collected.push(row);
    }

    // 有些 API 沒有總頁數資訊；簡單規則：少於 pageSize 就視為最後一頁
    if (list.length < PAGE_SIZE) break;
    page += 1;
  }

  if (collected.length === 0) {
    console.warn('warn: API returned no parseable rows, skip write.');
    return;
  }

  // 去重（同一頁有重複也不怕）
  const uniqueMap = new Map();
  for (const r of collected) uniqueMap.set(r.period, r);
  const unique = Array.from(uniqueMap.values());

  if (!BACKFILL) {
    // 非回填模式：只追加比現有最新 period 更大的
    const existing = await loadExisting();
    const maxPrev = existing.reduce((m, x) => {
      const n = parseInt(x.period, 10);
      return Number.isInteger(n) ? Math.max(m, n) : m;
    }, -Infinity);

    const newer = unique.filter(x => {
      const n = parseInt(x.period, 10);
      return Number.isInteger(n) && n > maxPrev;
    });

    if (newer.length === 0) {
      console.warn('warn: no newer periods than existing max, skip write.');
      return;
    }
    console.log(`info: ${newer.length} new rows (> ${maxPrev})`);
    await saveIfChanged(newer);
  } else {
    // 回填模式：直接跟既有資料按 period 合併
    console.log(`info: backfill mode: merging ${unique.length} rows for ${openDate}`);
    await saveIfChanged(unique);
  }
}

main().catch(err => {
  console.error('fatal:', err);
  process.exit(1);
});
