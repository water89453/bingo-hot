// scripts/fetch_bingo.mjs
import fs from 'fs';
import path from 'path';
import process from 'process';
import fetch from 'node-fetch';
import * as cheerio from 'cheerio';

const MAX_KEEP = 2000; // 保留最多幾期
const OUTFILE = path.join('web', 'data', 'draws.json');

// 官網列表頁（最近期）
const URL = 'https://www.taiwanlottery.com/lotto/result/bingo_bingo/';

function normalizeNums(arr) {
  // 轉數字、去重、排序
  const set = new Set(
    arr.map(x => parseInt(String(x).trim(), 10))
       .filter(n => Number.isInteger(n) && n >= 1 && n <= 80)
  );
  return Array.from(set).sort((a,b)=>a-b);
}

function parseFromHtml(html) {
  const $ = cheerio.load(html);

  // 這裡盡量「寬鬆」去抓：找每一筆開獎容器內出現的數字
  // 1) 先找每一期的容器（常見會有日期/期別 + 20 顆 + 超級）
  // 2) 再把裡面所有「01~80」的號碼取出
  // 你可以依實際 DOM 結構把選擇器換更精準，例如：$('.bb-result .numbers') 之類
  const results = [];
  $('.container, .content, body') // 兜底地往大容器掃
    .find('*')
    .each((_, el) => {
      const text = $(el).text();
      // 快速檢測：此區塊同時要含有 20~21 個 1..80 之間的數字
      const nums = (text.match(/\d{1,2}/g) || [])
        .map(s => parseInt(s, 10))
        .filter(n => n >= 1 && n <= 80);

      // 先寬鬆判定：>= 20 顆就當成一筆候選
      if (nums.length >= 20) {
        const balls = normalizeNums(nums.slice(0, 20));
        if (balls.length === 20) {
          // 嘗試找第 21 顆超級獎號（若不存在就用最後一顆）
          const superBall = (nums[20] && nums[20] >=1 && nums[20] <=80)
            ? nums[20]
            : balls[balls.length - 1];
          results.push({ balls, super: superBall });
        }
      }
    });

  // 去重、只留前幾筆（通常最上面幾筆是最新的）
  const dedup = [];
  const seen = new Set();
  for (const d of results) {
    const key = `${d.balls.join('-')}|${d.super}`;
    if (!seen.has(key)) {
      seen.add(key);
      dedup.push(d);
    }
  }
  // 這個頁面一般只有幾十筆以內；回傳前 200 筆就好
  return dedup.slice(0, 200);
}

async function main() {
  console.log('Fetching:', URL);
  const res = await fetch(URL, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (GitHub Actions fetch script)',
      'Accept': 'text/html,application/xhtml+xml',
    }
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }

  const html = await res.text();
  const parsed = parseFromHtml(html);

  if (parsed.length === 0) {
    console.log('Parser found 0 records. Site may have changed. Abort.');
    process.exit(1);
  }
  console.log(`Parsed ${parsed.length} records from page.`);

  // 讀舊檔
  let old = [];
  try {
    old = JSON.parse(fs.readFileSync(OUTFILE, 'utf-8'));
  } catch { old = []; }

  // 合併去重（新資料放前面）
  const map = new Map();
  const pushOne = (d) => map.set(`${d.balls.join('-')}|${d.super}`, d);
  for (const d of parsed) pushOne(d);
  for (const d of old)    pushOne(d);

  const merged = Array.from(map.values()).slice(0, MAX_KEEP);

  fs.mkdirSync(path.dirname(OUTFILE), { recursive: true });
  fs.writeFileSync(OUTFILE, JSON.stringify(merged, null, 0));
  console.log(`Wrote ${merged.length} records -> ${OUTFILE}`);
}

main().catch(err => {
  console.error('ERROR:', err);
  process.exit(1);
});
