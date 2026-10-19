/*
 * tools/fetch-asn-dbip.mjs —— 下载 DB-IP ASN Lite（CC BY 4.0，每月更新）到 build/dbip-asn/
 *
 *   node tools/fetch-asn-dbip.mjs
 *
 * 只用来做「第二路 ASN 对照」：和 iptoasn 都完整覆盖的 /24 如果 ASN 不一致，
 * 页面标「两源不一致」，不判断谁对谁错。免费库按月命名，当月 404 就退回上个月。
 */
import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "build", "dbip-asn");
mkdirSync(outDir, { recursive: true });

const dest = join(outDir, "dbip-asn-lite.csv.gz");

function monthStamp(offset) {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + offset);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

let res, url, month;
for (const offset of [0, -1]) {
  month = monthStamp(offset);
  url = `https://download.db-ip.com/free/dbip-asn-lite-${month}.csv.gz`;
  process.stdout.write(`↓ ${url}\n`);
  res = await fetch(url, { headers: { "User-Agent": "ipurity/1.0 (+data refresh; https://github.com/dawenbin/ipurity)" } });
  if (res.ok) { break; }
  process.stdout.write(`  ! ${res.status} ${res.statusText}，换上一月\n`);
}
if (!res || !res.ok) { throw new Error("DB-IP ASN Lite 当月与上月都取不到，检查网络或发布状态"); }

await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
writeFileSync(join(outDir, "source-month.txt"), month + "\n");
process.stdout.write(`  → ${dest}（${month}）\n下一步：node tools/make-asn-disagreements.mjs\n`);
