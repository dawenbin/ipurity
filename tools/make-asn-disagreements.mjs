/*
 * tools/make-asn-disagreements.mjs
 *   build/dbip-asn/dbip-asn-lite.csv.gz + data/global-pack.bin + data/global-asn.js
 *   → data/asn-disagree.bin + data/asn-disagree.js
 *
 *   node tools/make-asn-disagreements.mjs
 *
 * 只收录「两源都完整覆盖同一个 /24、但 ASN 不同」的段。这样体积小、误报少；
 * 页面只标「两源不一致」，不判断谁对谁错（可能是迁移、更具体宣告或时间差）。
 *
 * ASNDIF01（全小端）：
 *   0..7    "ASNDIF01"
 *   8..11   u32 版本 = 1
 *   12..15  u32 区间数 count
 *   16..    u32 starts[count]      区间起点（含）
 *           u32 ends[count]        区间终点（含）
 *           u32 otherAsn[count]    DB-IP 的 ASN
 */
import { createReadStream, readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const N24 = 1 << 24;                 /* /24 总数 */
const AMBIG = 0xffffffff;            /* 同一个 /24 被两行不同 ASN 覆盖：不参与比较 */

export function ipToInt(s) {
  const p = String(s).trim().split(".");
  if (p.length !== 4) { return -1; }
  let n = 0;
  for (const x of p) {
    const v = Number(x);
    if (!(v >= 0 && v <= 255)) { return -1; }
    n = n * 256 + v;
  }
  return n;
}
export function intToIp(n) {
  n = n >>> 0;
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

/* data/global-asn.js → {meta, names: Map<asn, name>} */
export function parseGlobalMeta(text) {
  const m = String(text).match(/window\.GLOBAL_ASN\s*=\s*([\s\S]*?);?\s*$/);
  if (!m) { throw new Error("global-asn.js 里没有 window.GLOBAL_ASN"); }
  const meta = JSON.parse(m[1]);
  const names = new Map();
  for (const r of (meta.list || [])) {
    if (r && r[0] != null) { names.set(Number(r[0]), String(r[3] || "")); }
  }
  return { meta, names };
}

/* IPPACK01 → ours24（整 /24 才写 ASN；0 = 没有单一 ASN 完整覆盖） */
export function markPack(ours24, buf, list) {
  const str = buf.toString("ascii", 0, 8);
  if (str !== "IPPACK01") { throw new Error("不是 IPPACK01 段表"); }
  const n = buf.readUInt32LE(12);
  const packEndRaw = buf.readUInt32LE(20);
  const packEnd = packEndRaw > 0 ? packEndRaw : 4294967296;
  for (let i = 0; i < n; i++) {
    const start = buf.readUInt32LE(24 + i * 4);
    const end = (i + 1 < n ? buf.readUInt32LE(24 + (i + 1) * 4) : packEnd) - 1;
    const entry = list[buf.readUInt32LE(24 + n * 4 + i * 4)];
    if (!entry) { continue; }
    const asn = Number(entry[0]) >>> 0;
    if (!asn) { continue; }
    const first = Math.floor(start / 256), last = Math.floor(end / 256);
    for (let j = first; j <= last; j++) {
      const base = j * 256;
      if (start <= base && end >= base + 255) { ours24[j] = asn; }
    }
  }
  return n;
}

/* DB-IP 一行 → 标记 dbip24；返回是否解析到 IPv4 段 */
export function markDbipLine(dbip24, dbipNames, line) {
  const s = String(line).trim();
  if (!s) { return false; }
  const cols = s.split(",");
  const start = ipToInt(cols[0]);
  const end = ipToInt(cols[1]);
  const asn = Number(cols[2]);
  if (start < 0 || end < start || !(asn > 0)) { return false; }
  if (dbipNames && cols[3]) {
    const name = cols.slice(3).join(",").replace(/^"|"$/g, "").trim();
    if (name && !dbipNames.has(asn)) { dbipNames.set(asn, name); }
  }
  const first = Math.floor(start / 256), last = Math.floor(end / 256);
  for (let j = first; j <= last; j++) {
    const base = j * 256;
    if (start <= base && end >= base + 255) {
      if (dbip24[j] === 0) { dbip24[j] = asn; }
      else if (dbip24[j] !== asn) { dbip24[j] = AMBIG; }
    }
  }
  return true;
}

/* 两个 /24 表 → 分歧区间（/24 下标，含端点） */
export function diffRanges(ours24, dbip24) {
  const out = [];
  let cur = null;
  for (let i = 0; i < N24; i++) {
    const a = ours24[i], b = dbip24[i];
    const hit = a && b && b !== AMBIG && a !== b;
    if (hit) {
      if (cur && cur.otherAsn === b && cur.end === i - 1) { cur.end = i; }
      else {
        if (cur) { out.push(cur); }
        cur = { start: i, end: i, otherAsn: b };
      }
    } else if (cur) {
      out.push(cur); cur = null;
    }
  }
  if (cur) { out.push(cur); }
  return out;
}

export function packAsnDiff(ranges) {
  const n = ranges.length;
  const buf = Buffer.alloc(16 + n * 12);
  buf.write("ASNDIF01", 0, "ascii");
  buf.writeUInt32LE(1, 8);
  buf.writeUInt32LE(n, 12);
  for (let i = 0; i < n; i++) {
    buf.writeUInt32LE((ranges[i].start * 256) >>> 0, 16 + i * 4);
    buf.writeUInt32LE((ranges[i].end * 256 + 255) >>> 0, 16 + (n + i) * 4);
    buf.writeUInt32LE(ranges[i].otherAsn >>> 0, 16 + (n * 2 + i) * 4);
  }
  return buf;
}

async function main() {
  const packPath = join(root, "data", "global-pack.bin");
  const metaPath = join(root, "data", "global-asn.js");
  const csvPath = join(root, "build", "dbip-asn", "dbip-asn-lite.csv.gz");
  for (const p of [packPath, metaPath, csvPath]) {
    if (!existsSync(p)) {
      console.error(`缺少 ${p}，先跑对应的 fetch 脚本`);
      process.exit(2);
    }
  }

  const { meta, names: ourNames } = parseGlobalMeta(readFileSync(metaPath, "utf8"));
  const ours24 = new Uint32Array(N24);
  const segs = markPack(ours24, readFileSync(packPath), meta.list || []);
  console.log(`iptoasn ${segs} 段 → 完整覆盖的 /24 已标记`);

  const dbip24 = new Uint32Array(N24);
  const dbipNames = new Map();
  let rows = 0, v4 = 0;
  const rl = createInterface({ input: createReadStream(csvPath).pipe(createGunzip()), crlfDelay: Infinity });
  for await (const line of rl) {
    rows++;
    if (markDbipLine(dbip24, dbipNames, line)) { v4++; }
  }
  console.log(`DB-IP ${rows} 行，IPv4 段 ${v4}`);

  const ranges = diffRanges(ours24, dbip24);
  const bin = packAsnDiff(ranges);
  mkdirSync(join(root, "data"), { recursive: true });
  writeFileSync(join(root, "data", "asn-disagree.bin"), bin);

  const otherAsns = Array.from(new Set(ranges.map((r) => r.otherAsn))).sort((a, b) => a - b);
  const names = {};
  let namesTruncated = false;
  for (const a of otherAsns) {
    if (ourNames.has(a)) { continue; }
    if (Object.keys(names).length >= 5000) { namesTruncated = true; break; }
    const n = dbipNames.get(a);
    if (n) { names[a] = n; }
  }
  let blocks24 = 0;
  for (const r of ranges) { blocks24 += r.end - r.start + 1; }

  let sourceMonth = "";
  const monthPath = join(root, "build", "dbip-asn", "source-month.txt");
  if (existsSync(monthPath)) { sourceMonth = readFileSync(monthPath, "utf8").trim(); }

  const out = {
    generated: new Date().toISOString().slice(0, 16).replace("T", " "),
    source: "DB-IP ASN Lite（第二路 ASN）对照 iptoasn",
    license: "DB-IP ASN Lite — CC BY 4.0；IP Geolocation by DB-IP (https://db-ip.com)",
    sourceMonth,
    comparedAgainst: meta.generated || "",
    ranges: ranges.length,
    blocks24,
    asns: otherAsns.length,
    names,
    namesTruncated,
    note: "只收录两源都完整覆盖该 /24、且 ASN 不一致的段；不一致不代表谁对谁错（可能是迁移、更具体宣告或时间差）。"
  };
  writeFileSync(join(root, "data", "asn-disagree.js"), "window.ASN_DISAGREE=" + JSON.stringify(out) + ";\n");

  console.log(`分歧 ${ranges.length} 段 / ${blocks24} 个 /24 / ${otherAsns.length} 个 DB-IP ASN`);
  console.log(`asn-disagree.bin ${(statSync(join(root, "data", "asn-disagree.bin")).size / 1024).toFixed(0)} KB`);
}

const selfPath = fileURLToPath(import.meta.url);
if (process.argv[1] && join(process.argv[1]) === selfPath) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
