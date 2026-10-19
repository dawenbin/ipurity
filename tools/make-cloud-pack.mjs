/*
 * tools/make-cloud-pack.mjs —— build/cloud/* → data/cloud-pack.bin + data/cloud-meta.js
 *
 *   node tools/make-cloud-pack.mjs
 *
 * 把四家云厂商的 IPv4 段压成「/24 区间 + 厂商位掩码」：
 *   0..7    "CLOUDPK1"
 *   8..11   u32 版本 = 1
 *   12..15  u32 区间数 count
 *   16..    u32 starts[count]         /24 索引 = (a<<16)|(b<<8)|c
 *           u32 ends[count]           含端点
 *           u8  providerBits[count]   任意覆盖：aws=1, gcp=2, cloudflare=4, azure=8
 *           u8  fullBits[count]       整 /24 覆盖的厂商（providerBits 的子集）
 *
 * 只有 fullBits 命中的 /24 才能把一行改判成机房；providerBits 只用于标注
 * （例如一个 /28 落在某厂商段里，不足以把整个 /24 判死）。
 *
 * 区间按 /24 升序、互不重叠；bits 相同的相邻区间合并。全小端。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "build", "cloud");

export const PROVIDERS = [
  {
    id: "aws", bit: 1, label: "AWS", name: "Amazon Web Services",
    file: "aws.json", url: "https://ip-ranges.amazonaws.com/ip-ranges.json",
    license: "Amazon 公开段表（https://ip-ranges.amazonaws.com/ip-ranges.json）"
  },
  {
    id: "gcp", bit: 2, label: "GCP", name: "Google Cloud",
    file: "gcp.json", url: "https://www.gstatic.com/ipranges/cloud.json",
    license: "Google 公开段表（https://www.gstatic.com/ipranges/cloud.json）"
  },
  {
    id: "cloudflare", bit: 4, label: "CF", name: "Cloudflare",
    file: "cloudflare.txt", url: "https://www.cloudflare.com/ips-v4",
    license: "Cloudflare 公开段表（https://www.cloudflare.com/ips-v4）"
  },
  {
    id: "azure", bit: 8, label: "AZ", name: "Microsoft Azure",
    file: "azure.json", url: "https://www.microsoft.com/en-us/download/details.aspx?id=56519",
    license: "Microsoft Service Tags（公开下载）"
  }
];

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
export function cidrToRange(cidr) {
  const m = String(cidr).trim().match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\/(\d{1,2})$/);
  if (!m) { return null; }
  const base = ipToInt(m[1]);
  const bits = Number(m[2]);
  if (base < 0 || bits < 0 || bits > 32) { return null; }
  const size = bits === 0 ? 4294967296 : Math.pow(2, 32 - bits);
  return { start: base, end: base + size - 1 };
}

/* 排序 → 相邻/重叠合并（同一厂商内部先并，避免两个 /25 拼成整 /24 时漏掉 full） */
export function mergeExact(ranges) {
  const sorted = ranges.slice().sort((a, b) => a.start - b.start);
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + 1) {
      if (r.end > last.end) { last.end = r.end; }
      continue;
    }
    out.push({ start: r.start, end: r.end });
  }
  return out;
}

function cidrsOf(list) {
  const out = [];
  for (const c of list) {
    const r = cidrToRange(c);
    if (r) { out.push(r); }
  }
  return mergeExact(out);
}

export function parseAws(json) {
  const arr = (json && Array.isArray(json.prefixes)) ? json.prefixes : [];
  return cidrsOf(arr.map((p) => p && p.ip_prefix).filter((c) => c && !String(c).includes(":")));
}
export function parseGcp(json) {
  const arr = (json && Array.isArray(json.prefixes)) ? json.prefixes : [];
  return cidrsOf(arr.map((p) => p && p.ipv4Prefix).filter((c) => c && !String(c).includes(":")));
}
export function parseCloudflare(text) {
  const lines = String(text).split(/\r?\n/).map((s) => s.trim())
    .filter((s) => s && !s.startsWith("#") && !s.startsWith(";"));
  return cidrsOf(lines);
}
export function parseAzure(json) {
  const values = (json && Array.isArray(json.values)) ? json.values : [];
  const list = [];
  for (const v of values) {
    const p = (v && v.properties) || {};
    for (const c of (Array.isArray(p.addressPrefixes) ? p.addressPrefixes : [])) {
      if (c && !String(c).includes(":")) { list.push(c); }
    }
  }
  return cidrsOf(list);
}

/* 把一家厂商的区间标进 any/full 两个 Uint8Array（长度 1<<24，索引是 /24） */
export function markProvider(any, full, ranges, bit) {
  for (const r of ranges) {
    const first = Math.floor(r.start / 256);
    const last = Math.floor(r.end / 256);
    for (let i = first; i <= last; i++) {
      any[i] |= bit;
      const base = i * 256;
      if (r.start <= base && r.end >= base + 255) { full[i] |= bit; }
    }
  }
}

/* any/full → 升序、不重叠、bits 相同的相邻区间 */
export function buildIntervals(any, full) {
  const out = [];
  let cur = null;
  const n = any.length;
  for (let i = 0; i < n; i++) {
    const bits = any[i], fb = full[i] & any[i];
    if (!bits) {
      if (cur) { out.push(cur); cur = null; }
      continue;
    }
    if (cur && cur.bits === bits && cur.fullBits === fb && cur.end === i - 1) {
      cur.end = i;
      continue;
    }
    if (cur) { out.push(cur); }
    cur = { start: i, end: i, bits, fullBits: fb };
  }
  if (cur) { out.push(cur); }
  return out;
}

/* 区间 → CLOUDPK1 */
export function packCloud(intervals) {
  const n = intervals.length;
  const buf = Buffer.alloc(16 + n * 10);
  buf.write("CLOUDPK1", 0, "ascii");
  buf.writeUInt32LE(1, 8);
  buf.writeUInt32LE(n, 12);
  for (let i = 0; i < n; i++) {
    buf.writeUInt32LE(intervals[i].start >>> 0, 16 + i * 4);
    buf.writeUInt32LE(intervals[i].end >>> 0, 16 + (n + i) * 4);
  }
  for (let i = 0; i < n; i++) {
    buf[16 + n * 8 + i] = intervals[i].bits & 0xff;
    buf[16 + n * 9 + i] = intervals[i].fullBits & 0xff;
  }
  return buf;
}

function readJson(file) {
  return JSON.parse(readFileSync(join(srcDir, file), "utf8"));
}

function main() {
  if (!existsSync(srcDir)) {
    console.error("缺少 build/cloud/，先跑 node tools/fetch-cloud-ranges.mjs");
    process.exit(2);
  }
  const readers = {
    aws: (f) => parseAws(readJson(f)),
    gcp: (f) => parseGcp(readJson(f)),
    cloudflare: (f) => parseCloudflare(readFileSync(join(srcDir, f), "utf8")),
    azure: (f) => parseAzure(readJson(f))
  };

  let status = {};
  if (existsSync(join(srcDir, "status.json"))) {
    try {
      const st = JSON.parse(readFileSync(join(srcDir, "status.json"), "utf8"));
      for (const s of (st.sources || [])) { status[s.id] = s; }
    } catch (e) { status = {}; }
  }

  const any = new Uint8Array(1 << 24);
  const full = new Uint8Array(1 << 24);
  const byProvider = [];
  const sourceParts = [];

  for (const p of PROVIDERS) {
    const file = join(srcDir, p.file);
    if (!existsSync(file)) {
      byProvider.push({ id: p.id, bit: p.bit, label: p.label, name: p.name, url: p.url, license: p.license,
        prefixes: 0, blocks24: 0, fullBlocks24: 0, status: "missing" });
      continue;
    }
    let ranges = [];
    try { ranges = readers[p.id](p.file); }
    catch (e) {
      byProvider.push({ id: p.id, bit: p.bit, label: p.label, name: p.name, url: p.url, license: p.license,
        prefixes: 0, blocks24: 0, fullBlocks24: 0, status: "parse-error" });
      continue;
    }
    markProvider(any, full, ranges, p.bit);
    const st = status[p.id];
    byProvider.push({
      id: p.id, bit: p.bit, label: p.label, name: p.name, url: p.url, license: p.license,
      prefixes: ranges.length,
      status: st ? (st.ok ? "ok" : "stale") : "ok"
    });
    sourceParts.push(p.name);
    console.log(`${p.name.padEnd(20)} ${String(ranges.length).padStart(7)} 段`);
  }

  const intervals = buildIntervals(any, full);
  let blocks24 = 0, fullBlocks24 = 0;
  for (let i = 0; i < any.length; i++) {
    if (any[i]) { blocks24++; }
    if (full[i]) { fullBlocks24++; }
  }
  for (const p of byProvider) {
    let b = 0, fb = 0;
    if (p.prefixes) {
      for (let i = 0; i < any.length; i++) {
        if (any[i] & p.bit) { b++; }
        if (full[i] & p.bit) { fb++; }
      }
    }
    p.blocks24 = b;
    p.fullBlocks24 = fb;
  }

  const bin = packCloud(intervals);
  mkdirSync(join(root, "data"), { recursive: true });
  writeFileSync(join(root, "data", "cloud-pack.bin"), bin);

  const meta = {
    generated: new Date().toISOString().slice(0, 16).replace("T", " "),
    source: sourceParts.join(" + "),
    format: "CLOUDPK1（/24 区间 + 厂商位掩码 + 整/24 覆盖位掩码，全小端）",
    providers: PROVIDERS.map((p) => ({ id: p.id, bit: p.bit, label: p.label, name: p.name, url: p.url, license: p.license })),
    intervals: intervals.length,
    blocks24,
    fullBlocks24,
    byProvider,
    note: "只有 fullBits 命中的整 /24 才改判机房；partial 覆盖只标注。Azure 的 Service Tags 链接会轮换，status=stale/missing 表示本次没取到。"
  };
  writeFileSync(join(root, "data", "cloud-meta.js"), "window.CLOUD_META=" + JSON.stringify(meta) + ";\n");

  console.log(`\n区间 ${intervals.length}；覆盖 /24 ${blocks24}，其中整/24 ${fullBlocks24}`);
  console.log(`cloud-pack.bin ${(statSync(join(root, "data", "cloud-pack.bin")).size / 1024).toFixed(0)} KB`);
}

const selfPath = fileURLToPath(import.meta.url);
if (process.argv[1] && join(process.argv[1]) === selfPath) { main(); }
