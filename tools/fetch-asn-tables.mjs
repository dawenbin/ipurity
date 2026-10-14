/*
 * 拉取全量 ASN 数据源到 build/asn/（供 make-global-pack.mjs 用）
 *   node tools/fetch-asn-tables.mjs [--skip-peeringdb]
 *
 * 数据源：
 *   iptoasn.com        IPv4 → ASN 全表（RouteViews 导出，每天更新）
 *   PeeringDB /api/net ASN 类型（Cable/DSL/ISP、NSP、Content、Enterprise…）
 *   bad-asn-list       被标记为机房/VPN/代理的 ASN 名单
 */
import { createWriteStream, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "build", "asn");
mkdirSync(outDir, { recursive: true });

const UA = { "User-Agent": "ipurity/1.0 (+data refresh; https://github.com/dawenbin/ipurity)" };

async function download(url, dest) {
  process.stdout.write(`↓ ${url}\n`);
  const res = await fetch(url, { headers: UA });
  if (!res.ok) { throw new Error(`${res.status} ${res.statusText} for ${url}`); }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
  process.stdout.write(`  → ${dest}\n`);
}

/* PeeringDB 不允许一次拉全表，按 250/页翻（约 320 页）。
   GitHub Actions 的机房 IP 是共享的，翻快了就 429 —— 所以：
     1. 页与页之间固定停一下（默认 1s，可用 PEERINGDB_DELAY_MS 调）；
     2. 一旦吃 429，先把间隔永久加大（最短 1s，最长 6s），再按 Retry-After / 递增退避重试；
     3. 重试次数给足（12 次），单页最多耗一分多钟，不会因为一次限速就整套刷新失败。 */
let pageDelay = Number(process.env.PEERINGDB_DELAY_MS || 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function backoff(res, tries) {
  const ra = Number(res.headers.get("retry-after"));
  if (Number.isFinite(ra) && ra > 0) { return Math.min(60000, ra * 1000); }
  return Math.min(60000, 2000 * tries);
}

async function fetchPeeringDB(dest) {
  const nets = new Map();
  let skip = 0;
  const limit = 250;
  const fields = "asn,name,info_type,info_traffic,info_scope,info_types";
  for (;;) {
    const url = `https://www.peeringdb.com/api/net?limit=${limit}&skip=${skip}&depth=0&fields=${fields}`;
    let res, tries = 0;
    for (;;) {
      res = await fetch(url, { headers: UA });
      if (res.status !== 429 && res.ok) { break; }
      if (++tries > 12) { throw new Error(`PeeringDB ${res.status} at skip=${skip}（重试 12 次仍被限速）`); }
      const wait = backoff(res, tries);
      pageDelay = Math.min(6000, Math.round(pageDelay * 1.5));   /* 被限速过就放慢整趟节奏 */
      process.stdout.write(`  ! ${res.status} skip=${skip}，${wait}ms 后重试（之后每页间隔 ${pageDelay}ms）\n`);
      await sleep(wait);
    }
    const json = await res.json();
    const data = json.data || [];
    for (const n of data) { nets.set(n.asn, n); }
    process.stdout.write(`  PeeringDB skip=${skip} 累计 ${nets.size} 个网络\n`);
    if (data.length < limit) { break; }
    skip += limit;
    await sleep(pageDelay);
  }
  writeFileSync(dest, JSON.stringify([...nets.values()]));
  process.stdout.write(`  → ${dest}（${nets.size} 个 ASN）\n`);
}

await download("https://iptoasn.com/data/ip2asn-v4.tsv.gz", join(outDir, "ip2asn-v4.tsv.gz"));
await download(
  "https://raw.githubusercontent.com/brianhama/bad-asn-list/master/bad-asn-list.csv",
  join(outDir, "bad-asn-list.csv")
);
if (!process.argv.includes("--skip-peeringdb")) {
  await fetchPeeringDB(join(outDir, "peeringdb-net.json"));
} else {
  process.stdout.write("跳过 PeeringDB\n");
}

const stamp = new Date().toISOString().replace("T", " ").slice(0, 16);
writeFileSync(join(outDir, "fetched-at.txt"), stamp + "Z\n");
process.stdout.write(`\n完成（${stamp}Z）。下一步：node tools/make-global-pack.mjs\n`);
