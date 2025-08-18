// scripts/fetch_bingo.mjs  (vA2)
import fs from 'node:fs/promises';

const API_BASE = 'https://api.taiwanlottery.com/TLCAPIWeB/Lottery/BingoResult';

const OPEN_DATE = process.env.OPEN_DATE?.trim() || '';
const PAGE_SIZE = parseInt(process.env.PAGE_SIZE || '50', 10);
const MAX_PAGES = parseInt(process.env.MAX_PAGES || '20', 10);
const BACKFILL = process.env.BACKFILL === 'true' || !!OPEN_DATE;
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

function dashToSlash(dateStr) {
  return String(dateStr).replaceAll('-', '/');
}

function splitNums(s) {
  if (!s) return [];
  return String(s)
    .split(/[\s,;、，]+/)
    .map(x => x.replace(/[^\d]/g, ''))
    .filter(Boolean)
    .map(x => parseInt(x, 10))
    .filter(n => Number.isInteger(n) && n >= 1 && n <= 80);
}

function normalizeItem(item) {
  const periodRaw = item?.period ?? item?.lotteryDrawNum ?? item?.drawNo ?? item?.term ?? item?.issueNo ?? item?.DRAW_NO ?? item?.id;
  const period = periodRaw != null ? String(periodRaw).trim() : '';

  const dateRaw = item?.openDate ?? item?.open_time ?? item?.drawDate ?? item?.date ?? item?.OPEN_DATE ?? '';
  const date = dateRaw ? String(dateRaw).slice(0, 10).replace(/\./g, '-').replace(/\//g, '-') : '';

  const ballsStr =
    item?.winNo ?? item?.winningNumbers ?? item?.WinningNumbers ?? item?.winningNum ??
    item?.numbers ?? item?.OpenCode ?? item?.winNumbers ?? item?.WIN_NO ?? item?.num;
  const balls = splitNums(ballsStr).slice(0, 20);

  const superRaw = item?.super ?? item?.superNumber ?? item?.SUPER ?? item?.special ?? item?.extra ?? item?.super_num;
  let superNum = undefined;
  if (superRaw != null) {
    const arr = splitNums(superRaw);
    superNum = Number.isInteger(arr[0]) ? arr[0] : (Number.isInteger(parseInt(superRaw, 10)) ? parseInt(superRaw, 10) : undefined);
  }

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

  return { period, date, balls, super: Number.isInteger(superNum) ? superNum : undefined };
}

function pickListFromApi(json) {
  if (Array.isArray(json)) return json;
  const cand = [
    json?.data?.list,
    json?.data?.rows,
    json?.data?.result,
    json?.data?.List,
    json?.list,
    json?.List,
    json?.result,
    json?.rows,
    json?.Data?.List,
  ];
  for (const c of cand) {
    if (Array.isArray(c)) return c;
  }
  return [];
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'bingo-hot/1.0 (+github actions)',
      'Accept': 'application/json, text/plain, */*',
      'Referer': 'https://www.taiwanlottery.com.tw/',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return res.json();
}

async function tryFetch(openDate, pageParamKey, pageNum) {
  const url = `${API_BASE}?openDate=${encodeURIComponent(openDate)}&${pageParamKey}=${pageNum}&pageSize=${PAGE_SIZE}`;
  const json = await fetchJson(url);
  const list = pickListFromApi(json);
  return { url, json, list };
}

async function fetchPageSmart(openDate, pageNum) {
  // 依序嘗試：日期格式 × 分頁 key
  const dateCandidates = [openDate, dashToSlash(openDate)];
  const pageKeyCandidates = ['pageNum', 'pageIndex'];

  for (const d of dateCandidates) {
    for (const k of pageKeyCandidates) {
      try {
        const r = await tryFetch(d, k, pageNum);
        if (Array.isArray(r.list) && r.list.length > 0) return { ...r, openDateTried: d, pageKey: k };
        // 第一頁拿不到資料就輸出偵錯資訊
        if (pageNum === 1) {
          const topKeys = Object.keys(r.json ?? {});
          const dataKeys = r.json?.data ? Object.keys(r.json.data) : [];
          console.warn(`warn: empty list with openDate=${d} ${k}=${pageNum} pageSize=${PAGE_SIZE}`);
          console.warn('warn: top-level keys =', topKeys);
          if (dataKeys.length) console.warn('warn: data keys =', dataKeys);
        }
      } catch (e) {
        if (pageNum === 1) console.warn(`warn: fetch failed (${d}, ${k}=${pageNum}): ${e.message}`);
      }
    }
  }
  return null;
}

async function loadExisting() {
  try {
    const txt = await fs.readFile(DATA_PATH, 'utf-8');
    const arr = JSON.parse(txt);
    return Array.isArray(arr) ? arr : [];
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

async function saveMerged(rows) {
  const prev = await loadExisting();
  const prevStr = JSON.stringify(prev);

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
  let openDateUsed = openDate;
  let pageKeyUsed = 'pageNum';

  while (page <= MAX_PAGES) {
    const r = await fetchPageSmart(openDateUsed, page);
    if (!r) {
      if (page === 1) {
        console.warn('warn: API returned empty list on all attempts for first page.');
      }
      break;
    }
    // 更新實際使用到的參數（後續翻頁沿用）
    openDateUsed = r.openDateTried;
    pageKeyUsed = r.pageKey;

    const list = r.list;
    if (!printedSample) {
      const sample = { ...list[0] };
      for (const k of Object.keys(sample)) {
        const v = sample[k];
        if (typeof v === 'string' && v.length > 160) sample[k] = v.slice(0, 160) + '...';
      }
      console.log('debug: first item from API:', sample);
      console.log(`debug: using openDate="${openDateUsed}", pageKey="${pageKeyUsed}"`);
      printedSample = true;
    }

    for (const it of list) {
      const row = normalizeItem(it);
      if (row) collected.push(row);
    }

    if (list.length < PAGE_SIZE) break;
    page += 1;
  }

  if (collected.length === 0) {
    console.warn('warn: API returned no parseable rows, skip write.');
    return;
  }

  // 去重
  const uniq = Array.from(new Map(collected.map(r => [r.period, r])).values());

  if (!BACKFILL) {
    const existing = await loadExisting();
    const maxPrev = existing.reduce((m, x) => {
      const n = parseInt(x.period, 10);
      return Number.isInteger(n) ? Math.max(m, n) : m;
    }, -Infinity);

    const newer = uniq.filter(x => {
      const n = parseInt(x.period, 10);
      return Number.isInteger(n) && n > maxPrev;
    });

    if (newer.length === 0) {
      console.warn('warn: no newer periods than existing max, skip write.');
      return;
    }
    console.log(`info: ${newer.length} new rows (> ${maxPrev})`);
    await saveMerged(newer);
  } else {
    console.log(`info: backfill mode: merging ${uniq.length} rows for ${openDate}`);
    await saveMerged(uniq);
  }
}

main().catch(err => {
  console.error('fatal:', err);
  process.exit(1);
});
