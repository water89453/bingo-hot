// scripts/fetch_bingo.mjs
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 站點首頁（最新開獎列表）
const BASE = 'https://www.taiwanlottery.com/lotto/result/bingo_bingo/';
const LIST_URL = BASE; // 我們從列表頁解析最近幾期

// 目標輸出
const OUT_FILE = path.join(__dirname, '..', 'web', 'data', 'draws.json');

// 解析工具：從 HTML 擷取最近 N 期（含期別、20 顆 + 超級獎號）
async function fetchLatestIssues(n = 6) {
  const res = await fetch(LIST_URL, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`Fetch list failed: ${res.status}`);
  const html = await res.text();

  // 這裡依官網 DOM 結構擷取（簡化示例：請依你先前已經測通的選擇器替換）
  // 假設能得到一個陣列 issues: [{period, balls:[...20], super:xx}, ...]
  const issues = [];

  // TODO: 用你之前可用的正則/DOM 解析邏輯把最近 n 期 push 進 issues
  // 下方示意：
  // issues.push({ period: '114046629', balls: [1,4,...,77], super: 42 })

  // ---- 你現有的解析程式碼放這裡 ----

  // 只保留 n 期
  return issues.slice(0, n);
}

// 讀既有 draws.json
async function loadExisting() {
  try {
    const raw = await fs.readFile(OUT_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

// 去重 + 排序（期別由大到小）
function mergeByPeriod(existing, incoming) {
  const map = new Map();
  for (const d of existing) map.set(String(d.period), d);
  for (const d of incoming) map.set(String(d.period), d);
  const merged = Array.from(map.values());
  merged.sort((a, b) => Number(b.period) - Number(a.period));
  return merged;
}

async function main() {
  // 最多重試 3 次，每次間隔 60 秒；每次都抓「最近 6 期」，補齊延遲
  const RETRIES = 3;
  const SLEEP_MS = 60_000;
  const PICK_N = 6;

  let existing = await loadExisting();
  let merged = existing;
  let added = 0;

  for (let i = 0; i <= RETRIES; i++) {
    const latest = await fetchLatestIssues(PICK_N);
    const before = merged.length;
    merged = mergeByPeriod(merged, latest);
    added = merged.length - before;

    if (added > 0 || i === RETRIES) {
      break; // 有新增就寫檔；或用完重試次數就結束
    }
    // 沒抓到新期別 -> 可能官網延遲，等一下再試
    await new Promise(r => setTimeout(r, SLEEP_MS));
  }

  // 可選：限制檔案最大長度（例如只保留近 10000 期）
  const MAX_KEEP = 10000;
  if (merged.length > MAX_KEEP) merged = merged.slice(0, MAX_KEEP);

  await fs.mkdir(path.dirname(OUT_FILE), { recursive: true });
  await fs.writeFile(OUT_FILE, JSON.stringify(merged, null, 2), 'utf8');
  console.log(`done. added=${added}, total=${merged.length}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
