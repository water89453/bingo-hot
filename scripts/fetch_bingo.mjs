// scripts/fetch_bingo.mjs
import fs from 'node:fs/promises';
import path from 'node:path';
import fetch from 'node-fetch';
import { JSDOM } from 'jsdom';

const OUT = path.join('web', 'data', 'draws.json');
const BASE = 'https://www.taiwanlottery.com/lotto/result/bingo_bingo/';

// 讀/寫 JSON ----------------------------------------------------------
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

// 小工具 --------------------------------------------------------------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function normalizeNums(arr) {
  // 轉 int、過濾 1..80、去重、排序
  const set = new Set(
    arr
      .map(x => parseInt(String(x).trim(), 10))
      .filter(n => Number.isInteger(n) && n >= 1 && n <= 80)
  );
  return Array.from(set).sort((a, b) => a - b);
}

function latestPeriod(list) {
  if (!list.length) return null;
  // 假設 period 是數字字串，取最大
  return list.map(x => x.period).sort().at(-1);
}

// 解析一個 HTML 區段為多期資料（依你原本選擇器調整）
function parsePage(html) {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const rows = [];

  // === 以下 Selector 依官網實際結構調整 ===
  // 範例：每期有「期別」、「日期」、「20 顆號碼」、「超級獎號」
  // 你原本怎麼取就保持，只要最後形成 row 物件即可。
  const items = doc.querySelectorAll('.result_item'); // <- 替換為正確容器
  items.forEach(it => {
    const period = it.querySelector('.period')?.textContent?.trim() ?? '';
    const date = it.querySelector('.date')?.textContent?.trim() ?? '';

    // 取 20 顆號碼
    const ballsTexts = [...it.querySelectorAll('.balls .num')] // <- 替換
      .map(el => el.textContent || '');
    const balls = normalizeNums(ballsTexts);

    // 取超級獎號（若官網另有標示）
    let supText = it.querySelector('.super .num')?.textContent ?? ''; // <- 替換
    let sup = parseInt(supText, 10);
    if (!Number.isInteger(sup)) {
      // 若沒有獨立欄位，規則：以「20 顆中的最後一顆」視為超級獎號
      sup = balls.at(-1);
    }

    rows.push({ period, date, balls, super: sup });
  });

  return rows;
}

// 嘗試抓一頁，直到「每期都是 20 顆」為止（最多重試）
async function fetchPage(url) {
  const ua = 'Mozilla/5.0 (compatible; bingo-hot-fetch/1.0)';
  for (let i = 0; i < 6; i++) { // 最多 6 次、每次 20 秒內就會完成
    const res = await fetch(url, {
      headers: {
        'User-Agent': ua,
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
      }
    });
    const html = await res.text();
    const rows = parsePage(html);

    const bad = rows.filter(r => !r.period || r.balls.length !== 20 || !Number.isInteger(r.super));
    if (rows.length && bad.length === 0) {
      return rows;
    }
    // 等個 10 秒再試，避免抓到半頁
    await sleep(10_000);
  }
  return []; // 放棄（本輪不寫入）
}

// 主流程 --------------------------------------------------------------
(async () => {
  const backfillMin = parseInt(process.env.BACKFILL_MINUTES || '0', 10) || 0;
  const old = await readJsonSafe(OUT);
  const oldLatest = latestPeriod(old);

  // 1) 抓首頁（或最新頁）
  const url = BASE; // 如需分頁可在這裡組 URL
  const pageRows = await fetchPage(url);

  if (!pageRows.length) {
    console.log('warn: page returned no complete rows, skip this round.');
    console.log(`info: oldLatest=${oldLatest ?? 'none'}`);
    return;
  }

  // 2) 以 period 去重、保留完整 20 顆
  const complete = pageRows.filter(r => r.period && r.balls.length === 20 && Number.isInteger(r.super));
  const map = new Map(old.map(x => [x.period, x]));
  let added = 0;

  for (const r of complete) {
    if (!map.has(r.period)) {
      map.set(r.period, r);
      added++;
    } else {
      // 若已存在但舊資料是殘缺，可用新資料覆蓋（防止早期寫入殘缺）
      const prev = map.get(r.period);
      if ((prev.balls?.length ?? 0) < 20 && r.balls.length === 20) {
        map.set(r.period, r);
      }
    }
  }

  // 3) 排序（舊→新）
  const next = Array.from(map.values()).sort((a, b) => String(a.period).localeCompare(String(b.period)));
  const newLatest = latestPeriod(next);

  // 4) 回填（可選）：若指定 backfill 分鐘，這裡可以再去抓歷史頁（略）
  // 你若本來就有 backfill 迴圈，保留即可。

  // 5) 寫檔（只有在新增/修補時才寫）
  if (added > 0 || next.length !== old.length) {
    await writeJson(OUT, next);
  }

  // 6) 日誌：清楚顯示最新期號對比
  console.log(`done. added=${added}, total=${next.length}, latest(old->new)=${oldLatest} -> ${newLatest}`);
})();
