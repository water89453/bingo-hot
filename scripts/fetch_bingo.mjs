// scripts/fetch_bingo.mjs
import fs from 'node:fs/promises';
import path from 'node:path';

// ===== 設定（可由環境變數覆蓋）==========================================
const OUT_FILE   = path.join('web', 'data', 'draws.json');
const PAGE_SIZE  = parseInt(process.env.PAGE_SIZE || '50', 10) || 50; // API 一次最多 50
const MAX_PAGES  = parseInt(process.env.MAX_PAGES || '20', 10) || 20; // 安全上限，避免無限抓
const OPEN_DATE  = process.env.OPEN_DATE || todayInTaipei();          // 預設抓台北今天
const RETRIES    = 3;                                                 // 單頁重試次數
const RETRY_WAIT = 1500;                                              // 重試間隔(ms)

// ===== 小工具 ==========================================================
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function todayInTaipei() {
  const fmt = (n) => String(n).padStart(2, '0');
  const now = new Date(
    new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' })
  );
  return `${now.getFullYear()}-${fmt(now.getMonth()+1)}-${fmt(now.getDate())}`;
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

function normalizeBalls(arr) {
  // 只接受 1..80 的整數，去重、排序
  const set = new Set(
    (arr || [])
      .map(x => parseInt(String(x).trim(), 10))
      .filter(n => Number.isInteger(n) && n >= 1 && n <= 80)
  );
  return Array.from(set).sort((a, b) => a - b);
}

function latestPeriod(list) {
  if (!list.length) return null;
  return list.map(x => String(x.period)).sort().at(-1);
}

// ===== 呼叫 API（分頁 + 重試）==========================================
async function fetchPage(openDate, pageNum, pageSize) {
  const url = new URL('https://api.taiwanlottery.com/TLCAPIWeB/Lottery/BingoResult');
  url.searchParams.set('openDate', openDate);
  url.searchParams.set('pageNum', String(pageNum));
  url.searchParams.set('pageSize', String(pageSize));

  for (let i = 0; i < RETRIES; i++) {
    try {
      const res = await fetch(url, {
        headers: {
          'Accept': 'application/json',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache',
          // 加個 UA 以防被擋
          'User-Agent': 'bingo-hot/1.0 (GitHub Actions; Node20)',
        },
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json();
      // 依官方 API 結構取資料（常見鍵：result / rows / data，由實測為準）
      const rows = (data?.result ?? data?.rows ?? data?.data ?? []).map(rec => {
        // 這裡把常見字段對應到我們的格式
        const period = String(rec?.Period ?? rec?.period ?? rec?.drawNo ?? rec?.term ?? '').trim();
        const date   = String(rec?.OpenDate ?? rec?.openDate ?? rec?.date ?? '').trim();

        // balls 來源可能是陣列或逗號字串，兩者都處理
        let numsRaw = rec?.Balls ?? rec?.balls ?? rec?.numbers ?? rec?.Nums ?? rec?.nums ?? [];
        if (typeof numsRaw === 'string') {
          numsRaw = numsRaw.split(/[,\s]+/);
        }
        const balls = normalizeBalls(numsRaw);

        // super（超級獎號），若無專屬欄位就取 balls 最後一顆
        let supRaw = rec?.Super ?? rec?.super ?? rec?.special ?? rec?.spNum ?? null;
        let sup = Number.isInteger(parseInt(supRaw, 10)) ? parseInt(supRaw, 10) : (balls.at(-1) ?? null);

        return { period, date, balls, super: sup };
      });

      // 過濾掉不完整的
      const clean = rows.filter(r => r.period && r.balls.length === 20 && Number.isInteger(r.super));
      return { clean, total: clean.length, rawCount: rows.length };
    } catch (err) {
      const left = RETRIES - i - 1;
      console.log(`warn: fetch page ${pageNum} failed: ${err?.message || err}. retriesLeft=${left}`);
      if (left > 0) await sleep(RETRY_WAIT);
    }
  }
  return { clean: [], total: 0, rawCount: 0 };
}

// 把某天的所有頁抓完（最多 MAX_PAGES）
async function fetchAllForDate(openDate, pageSize, maxPages) {
  const all = [];
  for (let page = 1; page <= maxPages; page++) {
    const { clean, total } = await fetchPage(openDate, page, pageSize);
    if (total === 0) {
      // 頁面沒有資料，視為到底（或暫無）
      break;
    }
    all.push(...clean);
    // 如果回傳筆數 < pageSize，多半已經最後一頁
    if (total < pageSize) break;
  }
  return all;
}

// ===== 主流程 =========================================================
(async () => {
  console.log(`info: openDate=${OPEN_DATE} pageSize=${PAGE_SIZE} maxPages=${MAX_PAGES}`);

  // 讀舊資料
  const oldList   = await readJsonSafe(OUT_FILE);
  const oldLatest = latestPeriod(oldList);

  // 抓當天（或 OPEN_DATE 指定日期）的所有頁
  const fetched = await fetchAllForDate(OPEN_DATE, PAGE_SIZE, MAX_PAGES);

  if (!fetched.length) {
    console.log('warn: API returned no complete rows, skip writing.');
    console.log(`info: oldLatest=${oldLatest ?? 'none'}`);
    return;
  }

  // 以 period 去重：舊資料 + 新資料合併
  const map = new Map(oldList.map(x => [String(x.period), x]));
  let added = 0;

  for (const r of fetched) {
    const key = String(r.period);
    if (!map.has(key)) {
      map.set(key, r);
      added++;
    } else {
      // 若舊資料殘缺，新資料完整則覆蓋
      const prev = map.get(key);
      if ((prev?.balls?.length ?? 0) < 20 && r.balls.length === 20) {
        map.set(key, r);
      }
    }
  }

  // 轉陣列、按期別排序（舊→新）
  const next = Array.from(map.values()).sort((a, b) => String(a.period).localeCompare(String(b.period)));
  const newLatest = latestPeriod(next);

  // 寫檔（只有有變化才寫）
  if (added > 0 || next.length !== oldList.length) {
    await writeJson(OUT_FILE, next);
    console.log(`done: added=${added}, total=${next.length}, latest(old->new)=${oldLatest} -> ${newLatest}`);
  } else {
    console.log('info: no new rows to add.');
    console.log(`done: total=${next.length}, latest=${newLatest}`);
  }
})().catch(err => {
  console.error('fatal:', err);
  process.exit(1);
});
