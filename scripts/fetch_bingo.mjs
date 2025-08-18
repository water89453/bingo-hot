// scripts/fetch_bingo.mjs
// Node 20+
// 來源：https://api.taiwanlottery.com/TLCAPIWeB/Lottery/BingoResult?openDate=YYYY-MM-DD&pageNum=1&pageSize=50

import fs from 'node:fs/promises';
import path from 'node:path';

// === 設定 ===
const OUT = path.join('web', 'data', 'draws.json');
const BASE = 'https://api.taiwanlottery.com/TLCAPIWeB/Lottery/BingoResult';
const PAGE_SIZE = Math.max(1, parseInt(process.env.PAGE_SIZE || '50', 10));
const MAX_PAGES = Math.max(1, parseInt(process.env.MAX_PAGES || '20', 10));
const TZ = 'Asia/Taipei';

// === 小工具 ===
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ymdTodayInTaipei() {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  // en-CA => YYYY-MM-DD
  return fmt.format(now);
}

function normalizeNums(arr) {
  const set = new Set(
    arr
      .map((x) => parseInt(String(x).trim(), 10))
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= 80),
  );
  return Array.from(set).sort((a, b) => a - b);
}

function latestPeriod(list) {
  if (!list?.length) return null;
  // period 是數字字串：直接字典序就等同數值序（固定長度時），以防萬一還是轉整數比較
  return list
    .map((x) => String(x.period))
    .sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0))
    .at(-1);
}

async function fetchJsonWithRetry(url, options = {}, tries = 5) {
  for (let i = 1; i <= tries; i++) {
    const ctrl = new AbortController();
    const id = setTimeout(() => ctrl.abort(), 20_000);
    try {
      const res = await fetch(url, { ...options, signal: ctrl.signal, cache: 'no-store' });
      clearTimeout(id);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      clearTimeout(id);
      if (i === tries) throw err;
      await sleep(500 * i);
    }
  }
}

// 嘗試從一個 item 映射成 {period, date, balls[20], super}
function mapApiItem(it) {
  // 期別
  const period =
    it?.period ??
    it?.periodNo ??
    it?.term ??
    it?.drawTerm ??
    it?.issue ??
    it?.Issue ??
    it?.DrawTerm ??
    '';

  // 日期（YYYY-MM-DD 或原樣）
  const date =
    it?.openDate ??
    it?.drawDate ??
    it?.OpenDate ??
    it?.DrawDate ??
    '';

  // 20 顆 & 超級獎號：API 常見欄位：winNo / bingoNum / normalNumbers / noList... 以及 super/special/superNo
  // 先盡量找 array，否則從字串抽數字。
  let rawNums =
    it?.normalNumbers ??
    it?.winNumbers ??
    it?.noList ??
    it?.numbers ??
    null;

  if (!Array.isArray(rawNums)) {
    const cand =
      it?.winNo ??
      it?.bingoNum ??
      it?.numberStr ??
      it?.Nums ??
      '';
    if (typeof cand === 'string') {
      rawNums = cand.match(/\d{1,2}/g) || [];
    } else {
      rawNums = [];
    }
  }

  let balls = normalizeNums(rawNums).slice(0, 20);

  // 超級獎號：常見欄位名
  let sup =
    it?.super ??
    it?.superNo ??
    it?.special ??
    it?.specialNo ??
    it?.Super ??
    it?.Special ??
    null;

  // 若沒有獨立欄位：以「原始號碼字串的最後一顆」或 balls 最後一顆
  if (!Number.isInteger(parseInt(sup, 10))) {
    const allNumsFromStrings =
      (typeof it?.winNo === 'string' && it.winNo.match(/\d{1,2}/g)) ||
      (typeof it?.bingoNum === 'string' && it.bingoNum.match(/\d{1,2}/g)) ||
      [];
    const candidate = [...(allNumsFromStrings || rawNums)];
    const last = parseInt(String(candidate.at(-1) ?? balls.at(-1) ?? ''), 10);
    sup = Number.isInteger(last) ? last : null;
  } else {
    sup = parseInt(sup, 10);
  }

  return {
    period: String(period ?? '').trim(),
    date: String(date ?? '').trim(),
    balls,
    super: sup,
  };
}

// 下載某天全部頁次（pageSize=50，自動翻頁）
async function fetchDayAll(openDate) {
  const rows = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `${BASE}?openDate=${encodeURIComponent(openDate)}&pageNum=${page}&pageSize=${PAGE_SIZE}`;
    const js = await fetchJsonWithRetry(url);
    // 常見結構：{ data: { list: [...] , total: N } } 或 { list: [...], total: N }
    const list =
      js?.data?.list ??
      js?.list ??
      js?.data ??
      [];
    if (!Array.isArray(list) || list.length === 0) break;

    for (const it of list) {
      const row = mapApiItem(it);
      if (row.period && row.balls.length === 20 && Number.isInteger(row.super)) {
        rows.push(row);
      }
    }

    // 若已到最後一頁（以回傳數量判斷）
    if (list.length < PAGE_SIZE) break;
  }
  return rows;
}

// 主流程
(async () => {
  try {
    const openDate = process.env.OPEN_DATE || ymdTodayInTaipei();
    console.log(`info: openDate(Taipei)=${openDate}, pageSize=${PAGE_SIZE}, maxPages=${MAX_PAGES}`);

    // 舊資料
    const old = await readJsonSafe(OUT);
    const oldLatest = latestPeriod(old);

    // 抓今天所有頁
    const dayRows = await fetchDayAll(openDate);

    // 檢查
    const bad = dayRows.filter((r) => !r.period || r.balls.length !== 20 || !Number.isInteger(r.super));
    if (dayRows.length === 0 || bad.length > 0) {
      console.log(`warn: fetched=${dayRows.length}, bad=${bad.length}. Skip writing.`);
      console.log(`info: oldLatest=${oldLatest ?? 'none'}`);
      return;
    }

    // 合併去重（period 為 key）
    const map = new Map(old.map((x) => [String(x.period), x]));
    let added = 0;
    for (const r of dayRows) {
      if (!map.has(r.period)) {
        map.set(r.period, r);
        added++;
      } else {
        // 若舊的是殘缺、新的是完整，則覆蓋
        const prev = map.get(r.period);
        if ((prev?.balls?.length ?? 0) < 20 && r.balls.length === 20) {
          map.set(r.period, r);
        }
      }
    }

    const next = Array.from(map.values()).sort((a, b) => {
      const A = BigInt(String(a.period));
      const B = BigInt(String(b.period));
      return A < B ? -1 : A > B ? 1 : 0;
    });

    const newLatest = latestPeriod(next);

    if (added > 0 || next.length !== old.length) {
      await writeJson(OUT, next);
      console.log(`done: added=${added}, total=${next.length}, latest(old->new)=${oldLatest} -> ${newLatest}`);
    } else {
      console.log(`done: no new rows. total=${next.length}, latest=${newLatest}`);
    }
  } catch (err) {
    console.error('error:', err?.message || err);
    process.exitCode = 1;
  }
})();
