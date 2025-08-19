// scripts/fetch_bingo_api.mjs
import fs from 'node:fs/promises';
import path from 'node:path';

// ---- helpers ----
function tzTodayYMD(tz = 'Asia/Taipei') {
  const fmt = new Intl.DateTimeFormat('sv-SE', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
  });
  return fmt.format(new Date()); // 2025-08-19
}

const openDate = process.env.OPEN_DATE || tzTodayYMD('Asia/Taipei');
const pageSize = Number(process.env.PAGE_SIZE || 50);

console.log(`🏁 OPEN_DATE=${openDate}`);

function buildUrl(date, pageNum, size) {
  const base = 'https://api.taiwanlottery.com/TLCAPIWeB/Lottery/BingoResult';
  return `${base}?openDate=${encodeURIComponent(date)}&pageNum=${pageNum}&pageSize=${size}`;
}

async function fetchJson(url) {
  const r = await fetch(url, {
    headers: {
      'accept': '*/*',
      'origin': 'https://www.taiwanlottery.com',
      'referer': 'https://www.taiwanlottery.com/',
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
    }
  });
  const text = await r.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`非 JSON 回應（HTTP ${r.status}）：${text.slice(0, 200)}...`);
  }
}

function coerceNum(s) {
  if (s === null || s === undefined) return null;
  const n = Number(String(s).trim());
  return Number.isFinite(n) ? n : null;
}

function pickSuper(item) {
  const candKeys = ['superNo', 'starNo', 'superNumber', 'starNumber', 'bullEyeTop'];
  for (const k of candKeys) {
    if (item[k] !== undefined && item[k] !== null && item[k] !== '') {
      return coerceNum(item[k]);
    }
  }
  return null;
}

async function readJsonOrEmpty(file) {
  try {
    const t = await fs.readFile(file, 'utf8');
    return JSON.parse(t);
  } catch {
    return [];
  }
}

async function main() {
  const outDir = path.join('data');
  await fs.mkdir(outDir, { recursive: true });

  const artifactsDir = path.join('artifacts', 'last_fetch');
  await fs.mkdir(artifactsDir, { recursive: true });

  // 先讀舊的（累積）
  const outPath = path.join(outDir, 'draws.json');
  const existing = await readJsonOrEmpty(outPath);
  const map = new Map(existing.map(r => [String(r.term), r])); // term 為 key

  let page = 1;
  let totalSize = null;
  let fetchedCount = 0;

  while (true) {
    const url = buildUrl(openDate, page, pageSize);
    console.log(`📡 Fetching: ${url}`);
    let json;
    try {
      json = await fetchJson(url);
    } catch (err) {
      console.error(`❌ 讀取失敗: ${err.message}`);
      break;
    }

    await fs.writeFile(
      path.join(artifactsDir, `bingo_${openDate}_p${page}.json`),
      JSON.stringify(json, null, 2),
      'utf8'
    );

    const content = json?.content ?? {};
    if (totalSize == null && typeof content.totalSize === 'number') {
      totalSize = content.totalSize;
    }

    const list = Array.isArray(content.bingoQueryResult)
      ? content.bingoQueryResult
      : [];

    if (list.length === 0) {
      if (page === 1) {
        console.warn('⚠️ 第一頁就沒有資料：可能是當天尚未上架或 API 結構變動。');
      }
      break;
    }

    for (const item of list) {
      const term = String(item.drawTerm ?? '').trim();
      if (!term) continue;

      const numsSrc = Array.isArray(item.openShowOrder)
        ? item.openShowOrder
        : (Array.isArray(item.bigShowOrder) ? item.bigShowOrder : []);
      const numbers = numsSrc.map(coerceNum).filter(n => Number.isFinite(n));
      const superNo = pickSuper(item);

      // 如果既有就「更新」（例如補上 super 或修正號碼）；沒有就新增
      const old = map.get(term);
      const next = {
        term,
        numbers: numbers.length ? numbers : (old?.numbers ?? []),
        super: (superNo ?? old?.super ?? null),
      };
      map.set(term, next);
      fetchedCount += 1;
    }

    if (totalSize != null) {
      const totalPages = Math.ceil(totalSize / pageSize);
      if (page >= totalPages) break;
      page += 1;
    } else {
      page += 1;
    }
  }

  // 穩定排序：以 term 數值升冪
  const finalArr = Array.from(map.values())
    .sort((a, b) => Number(a.term) - Number(b.term));

  await fs.writeFile(outPath, JSON.stringify(finalArr, null, 2), 'utf8');

  console.log(`📥 fetched items (raw): ${fetchedCount}`);
  console.log(`🧮 total unique terms after merge: ${finalArr.length}`);
  console.log(`💾 wrote -> ${outPath}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
