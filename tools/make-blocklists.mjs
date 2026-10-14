/*
 * tools/make-blocklists.mjs —— build/blocklists/*.txt → data/blocklists.bin + data/blocklists.js
 *
 *   node tools/make-blocklists.mjs
 *
 * 四个免费名单合成一张「IP → 命中哪些名单」的段表（位掩码），页面只查本地文件：
 *   drop(bit 1)         Spamhaus DROP      CIDR
 *   ipsum(bit 2)        IPsum              被 ≥3 个名单收录的才收（单名单条目的噪声太大）
 *   tor(bit 4)          Tor 出口节点        单个 IP
 *   blocklistde(bit 8)  blocklist.de       单个 IP
 *
 * 文件格式 IPBLK001（16 字节头 + 三段数组，全小端）：
 *   0..7   "IPBLK001"
 *   8..11  u32 版本
 *   12..15 u32 段数 count
 *   16..   u32 starts[count]（升序、互不重叠、不相邻）
 *          u32 ends[count]
 *          u8  bits[count]（每个名单一个 bit）
 *
 * 相邻或重叠的段会合并，bit 按位或 —— 段数能压掉一大截。
 * 这些名单都是「有则有」的事实数据：命中只说明这个 IP 在某个名单里，
 * 不代表一定是机房或代理（各名单的收录口径见 NOTICE）。
 */
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "build", "blocklists");

export const SOURCES = [
  {
    id: "drop", bit: 1, file: "drop.txt", name: "Spamhaus DROP",
    url: "https://www.spamhaus.org/drop/drop.txt",
    license: "免费（非商业）；商用需 Spamhaus 授权"
  },
  {
    id: "ipsum", bit: 2, file: "ipsum.txt", name: "IPsum",
    url: "https://github.com/stamparm/ipsum",
    license: "公开聚合名单（MIT 仓库）"
  },
  {
    id: "tor", bit: 4, file: "tor-exits.txt", name: "Tor 出口节点",
    url: "https://check.torproject.org/torbulkexitlist",
    license: "公开数据（Tor Project）"
  },
  {
    id: "blocklistde", bit: 8, file: "blocklistde.txt", name: "blocklist.de",
    url: "https://lists.blocklist.de/lists/all.txt",
    license: "免费（非商业）；商用需 blocklist.de 授权"
  }
];
export const IPSUM_MIN_LEVEL = 3;

export function ipToInt(s) {
  const p = String(s).split(".");
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
function cidrToRange(cidr) {
  const m = String(cidr).match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\/(\d{1,2})$/);
  if (!m) { return null; }
  const base = ipToInt(m[1]);
  const bits = Number(m[2]);
  if (base < 0 || bits < 0 || bits > 32) { return null; }
  const size = bits === 0 ? 4294967296 : Math.pow(2, 32 - bits);
  return { start: base, end: base + size - 1 };
}

/* ---------- 解析（都是纯函数，测试直接 import） ---------- */
export function parseDrop(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith(";") || s.startsWith("#")) { continue; }
    const r = cidrToRange(s.split(/\s+/)[0]);           /* "1.10.16.0/20 ; SBL256894" */
    if (r) { out.push(r); }
  }
  return out;
}
export function parseIpsum(text, minLevel) {
  const min = minLevel == null ? IPSUM_MIN_LEVEL : minLevel;
  const out = [], skipped = { low: 0, bad: 0 };
  for (const line of String(text).split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith("#")) { continue; }
    const p = s.split(/\s+/);
    const n = ipToInt(p[0]);
    if (n < 0) { skipped.bad++; continue; }
    if (Number(p[1] || 1) < min) { skipped.low++; continue; }
    out.push({ start: n, end: n });
  }
  out.skipped = skipped;
  return out;
}
export function parsePlainList(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith("#") || s.startsWith(";")) { continue; }
    const n = ipToInt(s.split(/\s+/)[0]);
    if (n >= 0) { out.push({ start: n, end: n }); }
  }
  return out;
}

/* 排序 → 相邻/重叠合并（bit 或起来）。输入 [{start,end,bit}] */
export function mergeRanges(entries) {
  const sorted = entries.slice().sort((a, b) => (a.start - b.start) || (a.bit - b.bit));
  const out = [];
  for (const e of sorted) {
    const last = out[out.length - 1];
    if (last && e.start <= last.end + 1) {
      if (e.end > last.end) { last.end = e.end; }
      last.bits |= e.bit;
      continue;
    }
    out.push({ start: e.start, end: e.end, bits: e.bit });
  }
  return out;
}

/* 段表 → IPBLK001 二进制 */
export function packBlocklists(ranges) {
  const n = ranges.length;
  const buf = Buffer.alloc(16 + n * 9);
  buf.write("IPBLK001", 0, "ascii");
  buf.writeUInt32LE(1, 8);
  buf.writeUInt32LE(n, 12);
  for (let i = 0; i < n; i++) {
    buf.writeUInt32LE(ranges[i].start >>> 0, 16 + i * 4);
    buf.writeUInt32LE(ranges[i].end >>> 0, 16 + (n + i) * 4);
  }
  for (let i = 0; i < n; i++) { buf[16 + n * 8 + i] = ranges[i].bits & 0xff; }
  return buf;
}

/* 各源原始条数 + 合并后仍带这个 bit 的段数 */
export function sourceStats(sources, ranges, rawCounts) {
  return sources.map((s) => ({
    id: s.id, bit: s.bit, name: s.name, file: s.file, url: s.url, license: s.license,
    raw: rawCounts[s.id] || 0,
    ranges: ranges.filter((r) => (r.bits & s.bit) !== 0).length
  }));
}

/* ---------- 主流程 ---------- */
function main() {
  const missing = SOURCES.filter((s) => !existsSync(join(srcDir, s.file)));
  if (missing.length) {
    console.error(`缺少 ${missing.map((s) => "build/blocklists/" + s.file).join(", ")}，先跑 node tools/fetch-blocklists.mjs`);
    process.exit(2);
  }

  const entries = [], rawCounts = {}, notes = {};
  const readers = { drop: parseDrop, ipsum: (t) => parseIpsum(t, IPSUM_MIN_LEVEL), tor: parsePlainList, blocklistde: parsePlainList };
  for (const s of SOURCES) {
    const text = readFileSync(join(srcDir, s.file), "utf8");
    const rows = readers[s.id](text);
    rawCounts[s.id] = rows.length;
    if (s.id === "ipsum" && rows.skipped) {
      notes[s.id] = `只收被 ≥${IPSUM_MIN_LEVEL} 个名单收录的条目（低置信度 ${rows.skipped.low} 条没收）`;
    }
    for (const r of rows) { entries.push({ start: r.start, end: r.end, bit: s.bit }); }
  }

  const ranges = mergeRanges(entries);
  const bin = packBlocklists(ranges);
  mkdirSync(join(root, "data"), { recursive: true });
  writeFileSync(join(root, "data", "blocklists.bin"), bin);

  const meta = {
    generated: new Date().toISOString().slice(0, 16).replace("T", " "),
    source: "Spamhaus DROP + IPsum + Tor exit list + blocklist.de",
    format: "IPBLK001（u32 起点 + u32 终点 + u8 来源位掩码）",
    note: "命中只说明这个 IP 在某个名单里，不代表一定是机房或代理；各名单口径见 NOTICE",
    total: ranges.length,
    sources: sourceStats(SOURCES, ranges, rawCounts).map((s) => Object.assign({}, s, notes[s.id] ? { note: notes[s.id] } : {}))
  };
  writeFileSync(join(root, "data", "blocklists.js"),
    "window.BLOCKLISTS=" + JSON.stringify(meta) + ";\n");

  console.log(`段数 ${ranges.length}（原始条目 ${entries.length}，合并掉 ${entries.length - ranges.length}）`);
  for (const s of meta.sources) { console.log(`  ${s.name.padEnd(18)} 原始 ${String(s.raw).padStart(7)} → 涉及段 ${String(s.ranges).padStart(7)}`); }
  console.log(`blocklists.bin ${(statSync(join(root, "data", "blocklists.bin")).size / 1024).toFixed(0)} KB`);
}

const selfPath = fileURLToPath(import.meta.url);
if (process.argv[1] && join(process.argv[1]) === selfPath) { main(); }
