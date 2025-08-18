// scripts/fetch_bingo.mjs
// 目的：每 5 分鐘抓官網最新開獎，解析「期別 + 20 顆 + 超級獎號」，合併到 web/data/draws.json

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import puppeteer from "puppeteer";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 官方即時頁（若之後官方改路徑，這裡改 URL 即可）
const SOURCE_URL = "https://www.taiwanlottery.com/lotto/result/bingo_bingo/";

// 解析參數
const MAX_KEEP = 5000;           // 最多保留幾期（避免檔案無限長大）
const OUTPUT = path.join(__dirname, "..", "web", "data", "draws.json");

// 工具：安全 parse 整數（處理 01, 07 也可）
function toInt(x) {
  const v = parseInt(String(x).trim(), 10);
  return Number.isFinite(v) ? v : null;
}

// 工具：判斷是否為 1..80 的合法球號
function isBall(n) {
  return Number.isInteger(n) && n >= 1 && n <= 80;
}

// 工具：從整頁文字中，走訪行並抽取「期別+21 顆（20 顆+超級）」。
// 作法：遇到 9~10 位數的「期別」就開一個新段，往後收集 1..80 的數字。
// 收到至少 20 顆後，第 21 顆視為「超級獎號」。若沒有第 21 顆，退而取第 20 顆為超級（保底）。
function parseDrawsFromText(fullText) {
  const lines = fullText
    .replace(/\u00A0/g, " ") // NBSP -> space
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  const periodRe = /\b\d{8,10}\b/; // 期別常見 8~10 位（你目前看到像 114046629 為 9 位）
  const numRe = /\b(?:0?[1-9]|[1-7][0-9]|80)\b/g; // 1..80，允許前導 0

  const out = [];
  let cur = null;

  for (const line of lines) {
    // 先檢查是否是新期別
    const pMatch = line.match(periodRe);
    if (pMatch) {
      const p = pMatch[0];
      // 若上一期已經有足夠球號，先結束它
      if (cur && cur.balls.length >= 20) {
        // 第 21 顆當超級；若沒有第 21 顆，就用第 20 顆當保底
        cur.super = cur.balls[20] ?? cur.balls[19];
        cur.balls = cur.balls.slice(0, 20);
        out.push(cur);
      }
      // 開新期
      cur = { period: p, date: "", balls: [], super: null };
      continue; // 換下一行
    }

    // 若目前在一個期別區間，抽數字
    if (cur) {
      const nums = line.match(numRe);
      if (nums && nums.length) {
        for (const raw of nums) {
          const n = toInt(raw);
          if (isBall(n)) {
            cur.balls.push(n);
            // 最多收 21 顆（20 顆 + 1 顆超級）
            if (cur.balls.length >= 21) break;
          }
        }
      }

      // 若球號已滿 21 顆，就結束這一期
      if (cur.balls.length >= 21) {
        cur.super = cur.balls[20];       // 第 21 顆為超級
        cur.balls = cur.balls.slice(0, 20);
        out.push(cur);
        cur = null; // 清空，等待下一次遇到期別
      }
    }
  }

  // 收尾：如果最後一個期別未滿 21 顆，但至少有 20 顆，仍然寫一筆（保底用第 20 顆當超級）
  if (cur && cur.balls.length >= 20) {
    cur.super = cur.balls[20] ?? cur.balls[19];
    cur.balls = cur.balls.slice(0, 20);
    out.push(cur);
  }

  // 篩掉不合格（例如重複、球數不足）
  const clean = out.filter(
    (d) =>
      d.period &&
      Array.isArray(d.balls) &&
      d.balls.length === 20 &&
      d.balls.every(isBall) &&
      isBall(d.super)
  );

  // 去重複（同 period 只留一筆，保留最先出現的）
  const seen = new Set();
  const uniq = [];
  for (const d of clean) {
    if (!seen.has(d.period)) {
      seen.add(d.period);
      // 排序球號（你前端會 sort，因此這裡先排好）
      d.balls = Array.from(new Set(d.balls)).sort((a, b) => a - b).slice(0, 20);
      uniq.push(d);
    }
  }

  return uniq;
}

async function fetchPageText() {
  const browser = await puppeteer.launch({
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
    headless: "new",
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"
    );

    await page.goto(SOURCE_URL, { waitUntil: "networkidle2", timeout: 60_000 });

    // 嘗試等一下（有些頁面會用 JS 填數字）
    await new Promise(r => setTimeout(r, 2000));  // 等 2 秒

    const fullText = await page.evaluate(() => document.body.innerText || "");
    return fullText;
  } finally {
    await (await browser).close();
  }
}

function loadOld() {
  try {
    const raw = fs.readFileSync(OUTPUT, "utf-8");
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return arr;
  } catch (_) {}
  return [];
}

function mergeDraws(oldList, newList) {
  const byPeriod = new Map();
  for (const d of oldList) byPeriod.set(String(d.period), d);
  for (const d of newList) byPeriod.set(String(d.period), d);

  // 期別看起來像數字，轉成數字排序（新到舊）
  const merged = Array.from(byPeriod.values()).sort(
    (a, b) => Number(b.period) - Number(a.period)
  );

  // 只保留前 MAX_KEEP 筆
  return merged.slice(0, MAX_KEEP);
}

async function main() {
  console.log("Fetching:", SOURCE_URL);
  const text = await fetchPageText();
  const parsed = parseDrawsFromText(text);
  console.log("Parsed draws:", parsed.length);

  if (parsed.length === 0) {
    throw new Error("Parser found 0 records. Site may have changed. Abort.");
  }

  const old = loadOld();
  const merged = mergeDraws(old, parsed);

  // 是否真的有新資料？
  const oldTop = old[0]?.period ?? null;
  const newTop = merged[0]?.period ?? null;

  // 寫檔
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, JSON.stringify(merged, null, 2));
  console.log("Wrote:", OUTPUT, "records:", merged.length);

  // 回傳是否需要 commit（有新期別才回傳 true）
  const hasNew = oldTop !== newTop || merged.length !== old.length;
  if (!hasNew) {
    console.log("No new periods. Skip commit.");
    process.exit(0);
  } else {
    console.log("New periods detected:", newTop, "(was", oldTop, ")");
    process.exit(10); // 用非零碼讓 workflow 的「條件步驟」知道要 commit
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
