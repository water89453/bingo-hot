// scripts/fetch_bingo.mjs
import fs from 'fs/promises';
import path from 'path';
import axios from 'axios';
import * as cheerio from 'cheerio';

const DATA_PATH = path.join(process.cwd(), 'web', 'data', 'draws.json');

// 標準化資料
function normalizeDraw(d) {
  const set = new Set(d.balls.map(n => Number(n)));
  const balls = Array.from(set).sort((a, b) => a - b);
  return {
    period: String(d.period),
    date: d.date || '',
    balls,
    super: Number(d.super ?? balls[balls.length - 1]),
  };
}

async function readLocal() {
  try {
    const raw = await fs.readFile(DATA_PATH, 'utf8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}
async function writeLocal(list) {
  const dir = path.dirname(DATA_PATH);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(DATA_PATH, JSON.stringify(list, null, 2), 'utf8');
}

// 來源 1：pilio（主要）
async function fetchFromPilio(limit = 200) {
  const url = 'https://www.pilio.idv.tw/bingo/list.asp';
  const { data: html } = await axios.get(url, { timeout: 15000 });
  const $ = cheerio.load(html);
  const text = $('body').text().replace(/\s+/g, ' ').trim();

  // 例：期別: 114046565 ... 10, 13, ... , 80 超級獎號:80
  const re = /期別:\s*(\d{9})[\s\S]*?((?:\d{1,2}\s*,\s*){19}\d{1,2})[\s\S]*?超級獎號:\s*(\d{1,2})/g;
  const out = [];
  let m;
  while ((m = re.exec(text)) && out.length < limit) {
    const period = m[1];
    const nums = m[2].split(',').map(s => Number(s.trim()));
    const sup = Number(m[3]);
    if (nums.length === 20 && nums.every(n => n >= 1 && n <= 80)) {
      out.push(normalizeDraw({ period, balls: nums, super: sup }));
    }
  }
  return out;
}

// 來源 2：auzonet（備援）
async function fetchFromAuzonet(limit = 200) {
  const url = 'https://lotto.auzonet.com/bingobingoV1.php';
  const { data: html } = await axios.get(url, { timeout: 15000 });
  const $ = cheerio.load(html);
  const text = $('body').text().replace(/\s+/g, ' ').trim();

  // 行內：114046582 14:55 01 14 21 ...（取 20 顆，最後一顆當超級）
  const re = /(\d{9}).{0,30}?((?:\d{1,2}\s+){19}\d{1,2})/g;
  const out = [];
  let m;
  while ((m = re.exec(text)) && out.length < limit) {
    const period = m[1];
    const toks = m[2].trim().split(/\s+/).map(n => Number(n));
    if (toks.length === 20 && toks.every(n => n >= 1 && n <= 80)) {
      const sup = toks[toks.length - 1];
      out.push(normalizeDraw({ period, balls: toks, super: sup }));
    }
  }
  return out;
}

function mergeDedup(oldList, newList) {
  const map = new Map(oldList.map(d => [d.period, d]));
  for (const d of newList) map.set(d.period, d);
  return Array.from(map.values()).sort((a, b) => Number(b.period) - Number(a.period));
}

async function main() {
  const local = await readLocal();

  // 每 5 分鐘抓即時，先主要，失敗再備援
  let live = [];
  try {
    live = await fetchFromPilio(200);
  } catch (e) {
    console.warn('pilio 來源失敗，改抓備援：', e.message);
    live = await fetchFromAuzonet(200);
  }

  const merged = mergeDedup(local, live);
  const trimmed = merged.slice(0, 100000); // 保留最多 10 萬筆
  await writeLocal(trimmed);
  console.log(`寫入完成：共 ${trimmed.length} 筆（新增 ${merged.length - local.length}）`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
