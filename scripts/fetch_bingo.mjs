// scripts/fetch_bingo.mjs  (A3)
import fs from 'node:fs/promises';

const API_URL = 'https://api.taiwanlottery.com/TLCAPIWeB/Lottery/BingoResult';

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
const dashToSlash = (s) => String(s).replaceAll('-', '/');

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

  // 陣列型號碼
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

// 取清單：優先在 content 下找
function pickListFromApi(json) {
  if (Array.isArray(json)) return json;
  const j = json ?? {};
  const c = j.content ?? j.data ?? j.Content ?? {};
  const candidates = [
    c?.list, c?.rows, c?.result, c?.data, c?.List, c?.bingoList, c?.items,
    j?.list, j?.rows, j?.result, j?.List
  ];
  for (const x of candidates) {
    if (Array.isArray(x)) return x;
  }
  return [];
}

async function fetchJsonGET(params) {
  const url = `${API_URL}?` + new URLSearchParams(params).toString();
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'bingo-hot/1.0 (+github actions)',
      'Accept': 'application/json, text/plain, */*',
      'Referer': 'https://www.taiwanlottery.com.tw/',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return { json: await res.json(), url, method: 'GET' };
}

async function fetchJsonPOST(body) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'User-Agent': 'bingo-hot/1.0 (+github actions)',
      'Accept': 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
      'Referer': 'https://www.taiwanlottery.com.tw/',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return { json: await res.json(), url: API_URL, method: 'POST' };
}

async function tryFetchOne(dateStr, dateKey, pageKey, pageNum, usePost) {
  const base = { [dateKey]: dateStr, [pageKey]: pageNum, pageSize: PAGE_SIZE };
  const { json, url, method } = usePost ? await fetchJsonPOST(base) : await fetchJsonGET(base);
  const list = pickListFromApi(json);

  return { json, list, url, method, params: base };
}

async function fetchPageSmart(openDate, pageNum, carry) {
  const dateFormats = [openDate, dashToSlash(openDate)];
  const dateKeys = ['openDate', 'queryDate', 'drawDate', 'date'];
  const pageKeys = ['pageNum', 'pageIndex', 'page'];
  const pageNums = pageNum === 1 ? [1, 0] : [pageNum]; // 第一頁同時嘗試 1 / 0 起始
  const methods = carry?.method ? [carry.method] : ['GET', 'POST']; // 若已知上一頁方法，沿用優先

  for (const method of methods) {
    for (const d of dateFormats) {
      for (const dk of dateKeys) {
        for (const pk of pageKeys) {
          for (const pn of pageNums) {
            try {
              const r = await tryFetchOne(d, dk, pk, pn, method === 'POST');
              if (Array.isArray(r.list) && r.list.length > 0) {
                return { ...r, chosen: { openDate: d, dateKey: dk, pageKey: pk, pageNum: pn } };
              }
              if (pageNum === 1) {
                const topKeys = Object.keys(r.json ?? {});
                const contentKeys = r.json?.content ? Object.keys(r.json.content) : [];
                console.warn(`warn: empty list with ${method} ${dk}=${d} ${pk}=${pn} pageSize=${PAGE_SIZE}`);
                console.warn('warn: top-level keys =', topKeys);
                if (contentKeys.length) console.warn('warn: content keys =', contentKeys);
                const sample = Array.isArray(r.json?.content) ? r.json.content[0]
                  : Array.isArray(r.json?.content?.list) ? r.json.content.list[0]
                  : Array.isArray(r.json?.content?.rows) ? r.json.content.rows[0]
                  : undefined;
                if (sample) {
                  const s = { ...sample };
                  for (const k of Object.keys(s)) {
                    const v = s[k];
                    if (typeof v === 'string' && v.length > 160) s[k] = v.slice(0, 160) + '...';
                  }
                  console.warn('warn: content first item sample =', s);
                }
              }
            } catch (e) {
              if (pageNum === 1) console.warn(`warn: fetch failed (${method} ${dk}=${d} ${pk}=${pn}): ${e.message}`);
            }
          }
        }
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
const sortByPeriodAsc = (a, b) => {
  const na = parseInt(a.period, 10);
  const nb = parseInt(b.period, 10);
  if (Number.isNaN(na) || Number.isNaN(nb)) return String(a.period).localeCompare(String(b.period));
  return na - nb;
};

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
  let carry = null;
  let printedSample = false;

  while (page <= MAX_PAGES) {
    const r = await fetchPageSmart(openDate, page, carry);
    if (!r) {
      if (page === 1) console.warn('warn: API returned empty list on all attempts for first page.');
      break;
    }
    carry = { method: r.method, dateKey: r.chosen.dateKey, pageKey: r.chosen.pageKey };

    const list = r.list;
    if (!printedSample) {
      const sample = { ...list[0] };
      for (const k of Object.keys(sample)) {
        const v = sample[k];
        if (typeof v === 'string' && v.length > 160) sample[k] = v.slice(0, 160) + '...';
      }
      console.log('debug: first item from API:', sample);
      console.log(`debug: using method=${r.method} openDate("${r.chosen.dateKey}")="${r.chosen.openDate}", pageKey="${r.chosen.pageKey}", startPage=${r.chosen.pageNum}`);
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
