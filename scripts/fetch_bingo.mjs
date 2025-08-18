// scripts/fetch_bingo.mjs
import fs from 'node:fs/promises';
import path from 'node:path';
import fetch from 'node-fetch';

const OUT = path.join('web', 'data', 'draws.json');
const URL = 'https://www.taiwanlottery.com/lotto/result/bingo_bingo/';

// ---------- File utils ----------
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

// ---------- Helpers ----------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function normalizeNums(arr) {
  const set = new Set(
    arr.map(x => parseInt(String(x).trim(), 10))
       .filter(n => Number.isInteger(n) && n >= 1 && n <= 80)
  );
  return Array.from(set).sort((a, b) => a - b);
}
function latestPeriod(list) {
  if (!list.length) return null;
  return list.map(x => String(x.period)).sort().at(-1);
}

// ---------- Parsing (pure text + regex) ----------
/**
 * 從「一大段文字」解析出多期：
 * 1) 先把 HTML 去掉 <script>/<style> 及標籤，得到純文字
 * 2) 以「第.....期」當分段點
 * 3) 每段取到的數字(1..80)去重後取前 20 顆；超級獎號若段落內有「超級/特別/Super」旁的數字就用，否則取第 20 顆
 */
function stripHtml(html) {
  // 移除 script/style
  const noScript = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
  // 去標籤
  const text = noScript.replace(/<[^>]+>/g, ' ');
  // 摺疊空白
  return text.replace(/\s+/g, ' ').trim();
}

function parseFromText(text) {
  const rows = [];
  const parts = text.split(/(?=第\s*[0-9]{6,}\s*期)/g); // 保留分隔符本身
  const seen = new Set();

  for (const chunk of parts) {
    // 期別：第XXXXXXXX期 或 連續 9~12 位數字
    let period = null;
    const m1 = chunk.match(/第\s*([0-9]{6,})\s*期/);
    if (m1) period = m1[1];
    if (!period) {
      const m2 = chunk.match(/\b([0-9]{9,12})\b/);
      if (m2) period = m2[1];
    }
    if (!period) continue;

    // 所有號碼
    const nums = (chunk.match(/\b([1-9][0-9]?)\b/g) || []).map(s => parseInt(s, 10))
      .filter(n => n >= 1 && n <= 80);
    const balls = normalizeNums(nums).slice(0, 20);
    if (balls.length !== 20) continue;

    // 超級獎號（段內尋找關鍵字附近的數字）
    let superCandidate = null;
    const superBlock = chunk.match(/(超級獎號|超級|特別號|Super)\D{0,6}([1-9][0-9]?)/i);
    if (superBlock) {
      const v = parseInt(superBlock[2], 10);
      if (v >= 1 && v <= 80) superCandidate = v;
    }
    const sup = Number.isInteger(superCandidate) ? superCandidate : balls.at(-1);

    // 日期（可選）
    let date = '';
    const dm = chunk.match(/\b(20[0-9]{2}[\/\-][01]?[0-9][\/\-][0-3]?[0-9])\b/);
    if (dm) date = dm[1];

    if (!seen.has(period)) {
      seen.add(period);
      rows.push({ period: String(period), date, balls, super: sup });
    }
  }
  return rows;
}

// ---------- Fetch with retries ----------
async function fetchAndParse(url) {
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36 bingo-hot/1.0';
  for (let i = 0; i < 6; i++) {
    const res = await fetch(url + `?t=${Date.now()}`, {
      headers: {
        'User-Agent': ua,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
      },
    });
    const html = await res.text();
    const text = stripHtml(html);
    const rows = parseFromText(text);

    const bad = rows.filter(r => !r.period || r.balls.length !== 20 || !Number.isInteger(r.super));
    if (rows.length && bad.length === 0) {
      return rows;
    }
    // 可能頁面還在更新，等待再試
    await sleep(10_000);
  }
  return [];
}

// ---------- Main ----------
(async () => {
  const old = await readJsonSafe(OUT);
  const map = new Map(old.map(x => [String(x.period), x]));
  const oldLatest = latestPeriod(old);

  const rows = await fetchAndParse(URL);

  if (!rows.length) {
    console.log('warn: page returned no complete rows, skip this round.');
    console.log(`info: oldLatest=${oldLatest ?? 'none'}`);
    return;
  }

  // 合併
  let added = 0;
  for (const r of rows) {
    const key = String(r.period);
    const prev = map.get(key);
    if (!prev) {
      map.set(key, r);
      added++;
    } else if ((prev.balls?.length ?? 0) < 20 && r.balls.length === 20) {
      map.set(key, r);
    }
  }

  const next = Array.from(map.values()).sort((a, b) => String(a.period).localeCompare(String(b.period)));
  const newLatest = latestPeriod(next);

  if (added > 0 || next.length !== old.length) {
    await writeJson(OUT, next);
  }

  console.log(`done. added=${added}, total=${next.length}, latest(old->new)=${oldLatest} -> ${newLatest}`);
})();
