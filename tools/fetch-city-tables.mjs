/*
 * 下载城市级数据源到 build/city/（DB-IP City Lite，CC BY 4.0，每月更新）
 *   node tools/fetch-city-tables.mjs
 */
import { createWriteStream, mkdirSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "build", "city");
mkdirSync(outDir, { recursive: true });

const dest = join(outDir, "dbip-city-lite.csv.gz");

/* DB-IP 免费库按月份命名（dbip-city-lite-2026-10.csv.gz）。月初当月版可能还没放出来，
   所以当月 404 就退回上个月 —— 每月定时的 workflow 就不用去猜人家的发布日。 */
function monthStamp(offset) {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + offset);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

let res, url;
for (const offset of [0, -1]) {
  url = `https://download.db-ip.com/free/dbip-city-lite-${monthStamp(offset)}.csv.gz`;
  process.stdout.write(`↓ ${url}\n`);
  res = await fetch(url, { headers: { "User-Agent": "ipurity/1.0 (+data refresh; https://github.com/dawenbin/ipurity)" } });
  if (res.ok) { break; }
  process.stdout.write(`  ! ${res.status} ${res.statusText}，换上一月\n`);
}
if (!res || !res.ok) { throw new Error("DB-IP 当月与上月都取不到，检查网络或发布状态"); }
await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
process.stdout.write(`  → ${dest}\n下一步：node tools/make-city-packs.mjs\n`);
