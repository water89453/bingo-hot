// scripts/fetch_bingo.mjs
import fs from 'node:fs/promises';
import path from 'node:path';
import fetch from 'node-fetch';
import * as cheerio from 'cheerio';

/**
 * 產出檔案位置（GitHub Pages 會從 web/ 當根目錄）
 */
const OUT = path.join('web', 'data', 'draws.json');
const BASE = 'https://www.taiwanlottery.com/lotto/result/bingo_bingo/';

/* --------------------- 讀寫工具 --------------------- */

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

/* --------------------- 小工具 --------------------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normalizeNums(arr) {
  // 轉 int → 過濾 1..80 → 去重 → 排序
  const set = new Set(
    arr
      .map((x) => parseInt(String(x).trim(), 10))
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= 80),
  );
  return Array.from(set).sort((a, b) => a - b);
}

function latestPeriod(list) {
  if (!list || list.length === 0) return null;
  return list.map((x) => String(x.period)).sort().at(-1);
}

/* --------------------- 解析邏輯（cheerio） --------------------- */

/**
 * 嘗試從一個「可能的期別容器」中抽出一筆資料
 * 規則：
 *  - 期別：優先找「第xxxx期」或 9~12 位數字的長號
 *  - 號碼：抓容器內所有 1..80 的數字，取前 20 顆（去重）
 *  - 超級獎號：若容器內有「超級」相關字樣旁的數字，就用之；否則以 20 顆中的「最後一顆」為超級獎號
 */
function extractOneFromContainer($, $box) {
  const text = $box.text().replace(/\s+/g, ' ').trim();

  // 期別：第XXXXXXXX期 或 連續 9~12 位數字
  let period = null;
  const m1 = text.match(/第\s*([0-9]{6,})\s*期/); // 寬鬆一點
  if (m1) {
    period = m1[1];
  } else {
    const m2 = text.match(/\b([0-9]{9,12})\b/); // 網站期號常見 9 位數
    if (m2) period = m2[1];
  }

  // 先找「超級獎號」相關的塊（若網站有標註）
  let superCandidate = null;
  // 嘗試各式標籤的文字（中英文與常見別名）
  const superLabels = [
    '超級獎號',
    '超級',
    'Super',
    'super',
    '特別號', // 以防站方文字描述變化
  ];
  for (const label of superLabels) {
    // 找到包含 label 的元素後，抽取它附近/本身的數字
    const el = $box.find(`*:contains("${label}")`).first();
    if (el && el.length) {
      const near = el.text();
      const m = near.match(/\b([0-9]{1,2})\b/);
      if (m) {
        const v = parseInt(m[1], 10);
        if (v >= 1 && v <= 80) {
          superCandidate = v;
          break;
        }
      }
    }
  }

  // 在容器內抓所有 1..80 的數字
  const allNums = (text.match(/\b([1-9][0-9]?)\b/g) || []).map((s) => parseInt(s, 10))
    .filter((n) => n >= 1 && n <= 80);

  const balls = normalizeNums(allNums).slice(0, 20);
  if (balls.length !== 20) return null;

  const sup = Number.isInteger(superCandidate) ? superCandidate : balls.at(-1);

  // 日期（選填）：嘗試找 YYYY/MM/DD 或 YYYY-MM-DD
  let date = '';
  const dm = text.match(/\b(20[0-9]{2}[\/\-][01]?[0-9][\/\-][0-3]?[0-9])\b/);
  if (dm) date = dm[1];

  if (!period) return null;
  return { period: String(period), date, balls, super: sup };
}

/**
 * 把整頁 HTML 轉為 n 筆期別資料
 * 為了耐用性，用「多策略」：
 *  1) 先試著找看起來像「一筆一筆卡片/區塊」的容器（含「期」字）
 *  2) 若抓不到，再回退用粗糙切片（例如每次抓到 20~22 顆號碼附近字串）做分段
 */
function parsePage(html) {
  // 先移除 <style>/<script>，避免噪音
  const cleaned = html.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<script[\s\S]*?<\/script>/gi, '');
  const $ = cheerio.load(cleaned);
  const rows = [];

  // 策略 1：尋找帶「期」字的較大容器
  const candidates = $('body *')
    .filter((_, el) => {
      const t = $(el).text();
      // 有「第…期」，且包含至少 20 個 1..80 的數字
      if (!/期/.test(t)) return false;
      const nums = (t.match(/\b([1-9][0-9]?)\b/g) || []).map((s) => parseInt(s, 10)).filter((n) => n >= 1 && n <= 80);
      return nums.length >= 20;
    });

  const seenPeriods = new Set();

  candidates.each((_, el) => {
    const it = extractOneFromContainer($, $(el));
    if (it && !seenPeriods.has(it.period)) {
      seenPeriods.add(it.period);
      rows.push(it);
    }
  });

  // 策略 2（備援）：如果第一招抓不到，就用大段文字切分
  if (rows.length === 0) {
    const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
    // 用「第xxxx期」把文字粗略切段
    const parts = bodyText.split(/(?=第\s*[0-9]{6,}\s*期)/g);
    for (const part of parts) {
      if (!/期/.test(part)) continue;
      const fakeDiv = $('<div></div>').text(part);
      const it = extractOneFromContainer($, fakeDiv);
      if (it && !seenPeriods.has(it.period)) {
        seenPeriods.add(it.period);
        rows.push(it);
      }
    }
  }

  return rows;
}

/* --------------------- 擷取流程 --------------------- */

/**
 * 抓頁面（多次重試），直到每筆都是完整 20 顆（或放棄）
 */
async function fetchPage(url) {
  const ua = 'Mozilla/5.0 (compatible; bingo-hot-fetch/1.0)';
  for (let i = 0; i < 6; i++) {
    const res = await fetch(url, {
      headers: {
        'User-Agent': ua,
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
      },
    });
    const html = await res.text();
    const rows = parsePage(html);

    const bad = rows.filter((r) => !r.period || r.balls.length !== 20 || !Number.isInteger(r.super));
    if (rows.length && bad.length === 0) {
      return rows;
    }
    // 等 10 秒避免抓到半頁（站方剛更新 DOM）
    await sleep(10_000);
  }
  return [];
}

/* --------------------- 主程式 --------------------- */

(async () => {
  const backfillMin = parseInt(process.env.BACKFILL_MINUTES || '0', 10) || 0;

  const old = await readJsonSafe(OUT);
  const oldMap = new Map(old.map((x) => [String(x.period), x]));
  const oldLatest = latestPeriod(old);

  // 1) 抓首頁/最新頁
  const pageRows = await fetchPage(BASE);
  if (!pageRows.length) {
    console.log('warn: page returned no complete rows, skip this round.');
    console.log(`info: oldLatest=${oldLatest ?? 'none'}`);
    return;
  }

  // 2) 與舊資料合併、去重
  let added = 0;
  for (const r of pageRows) {
    const key = String(r.period);
    const prev = oldMap.get(key);
    if (!prev) {
      oldMap.set(key, r);
      added++;
    } else {
      // 若舊資料不完整、新資料完整 → 覆蓋
      if ((prev.balls?.length ?? 0) < 20 && r.balls.length === 20) {
        oldMap.set(key, r);
      }
    }
  }

  // 3)（可選）回填：此站如果有分頁，可在這裡按 backfillMin 的需求往歷史頁抓
  //    目前先略（網站分頁規則可能會改，之後再補）。

  // 4) 排序 & 寫檔（只有在有新增/修補才寫）
  const next = Array.from(oldMap.values()).sort((a, b) => String(a.period).localeCompare(String(b.period)));
  const newLatest = latestPeriod(next);

  if (added > 0 || next.length !== old.length) {
    await writeJson(OUT, next);
  }

  console.log(`done. added=${added}, total=${next.length}, latest(old->new)=${oldLatest} -> ${newLatest}`);
})();
