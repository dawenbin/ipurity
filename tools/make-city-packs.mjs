/*
 * build/city/dbip-city-lite.csv.gz → data/city/<第一段>.js（按 /8 切片，页面按需懒加载）
 *
 * 源：DB-IP City Lite（CC BY 4.0，每月更新，含 IPv4+IPv6，解压后 500MB+，所以流式处理只看 IPv4）
 * 每片内容：该 /8 内的地址段 → 城市索引；城市表带 城市/省州/国家。
 *
 * 用法：node tools/make-city-packs.mjs [--dry]
 *   先跑 node tools/fetch-city-tables.mjs 下载源文件
 */
import { createReadStream, readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "build", "city", "dbip-city-lite.csv.gz");
const outDir = join(root, "data", "city");
if (!existsSync(src)) { throw new Error(`缺少 ${src}，先跑 node tools/fetch-city-tables.mjs`); }
if (!process.argv.includes("--dry")) { mkdirSync(outDir, { recursive: true }); }

const ip2int = (s) => {
  const p = s.split(".");
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + Number(p[3]);
};

/* DB-IP 的城市名可能带逗号并加引号（如 "Washington, D.C."），得按 CSV 规则切 */
function parseCsvLine(line) {
  const out = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else { q = false; } }
      else { cur += ch; }
    } else if (ch === '"') { q = true; }
    else if (ch === ",") { out.push(cur); cur = ""; }
    else { cur += ch; }
  }
  out.push(cur);
  return out;
}

/* 每个 /8 一个桶：starts + 城市键 */
const buckets = new Map();
const cityKeys = new Map();   // 全局城市表：key → 序号，最后再按片引用
const cityList = [];
let total = 0, skipped = 0, v6 = 0;

const rl = createInterface({ input: createReadStream(src).pipe(createGunzip()), crlfDelay: Infinity });
for await (const line of rl) {
  if (!line) { continue; }
  /* 列序：ip_start,ip_end,大洲,国家,省州,城市,纬度,经度 */
  const c = parseCsvLine(line);
  if (c.length < 6) { skipped++; continue; }
  const s = c[0];
  if (s.includes(":")) { v6++; continue; }                 // 只留 IPv4
  if (s.split(".").length !== 4) { skipped++; continue; }
  const country = c[3] || "", state = c[4] || "";
  /* DB-IP 会给“Los Angeles (Tujunga)”这种带城区后缀的名字，去掉括号尾巴，城市名才好读 */
  const city = (c[5] || "").replace(/\s*\([^)]*\)\s*$/, "").replace(/\s+/g, " ").trim();
  if (!city && !state) { skipped++; continue; }             // 没有城市信息的段先丢掉（省体积）
  const key = city + "|" + country;
  let ci = cityKeys.get(key);
  if (ci === undefined) { ci = cityList.length; cityList.push([city, country]); cityKeys.set(key, ci); }
  const o1 = Number(s.split(".")[0]);
  let b = buckets.get(o1);
  if (!b) { b = { starts: [], cities: [] }; buckets.set(o1, b); }
  b.starts.push(ip2int(s));
  b.cities.push(ci);
  total++;
}

console.log(`IPv4 段 ${total}  跳过(无城市/格式) ${skipped}  IPv6 行 ${v6}  唯一城市 ${cityList.length}`);

let bytes = 0;
const sizes = [];
const manifest = [];
for (const [o1, b] of [...buckets.entries()].sort((a, b2) => a[0] - b2[0])) {
  const n = b.starts.length;
  /* 片内城市表只保留本片用到的城市 */
  const local = new Map();
  const map = new Uint16Array(n);
  const table = [];
  for (let i = 0; i < n; i++) {
    const g = b.cities[i];
    let li = local.get(g);
    if (li === undefined) { li = table.length; table.push(cityList[g]); local.set(g, li); }
    map[i] = li;
  }
  const startArr = Uint32Array.from(b.starts);
  const trailer = Buffer.from(JSON.stringify({ o1: o1, cities: table }), "utf8");
  const HEADER = 24;
  const body = Buffer.alloc(HEADER + n * 6);
  body.write("CITYPK02", 0, "ascii");
  body.writeUInt32LE(n, 8);
  body.writeUInt32LE(HEADER + n * 6, 12);      // trailer 偏移
  body.writeUInt32LE(trailer.length, 16);
  body.writeUInt32LE(0, 20);
  Buffer.from(startArr.buffer).copy(body, HEADER);
  Buffer.from(map.buffer).copy(body, HEADER + n * 4);
  const bin = Buffer.concat([body, trailer]);
  if (!process.argv.includes("--dry")) { writeFileSync(join(outDir, o1 + ".bin"), bin); }
  const sz = bin.length;
  bytes += sz;
  sizes.push([o1, n, sz]);
  manifest.push([o1, n, sz]);
}

if (!process.argv.includes("--dry")) {
  writeFileSync(join(outDir, "index.json"), JSON.stringify({
    generated: new Date().toISOString().slice(0, 16).replace("T", " "),
    source: "DB-IP City Lite (CC BY 4.0)",
    codec: "CITYPK02: u32 start + u16 cityIndex + JSON trailer",
    total: bytes,
    slices: manifest.map(function (m) { return [m[0], m[1], m[2]]; })
  }) + "\n");
}
console.log(`\n切片 ${sizes.length} 个，合计 ${(bytes / 1048576).toFixed(2)} MB`);
const show = sizes.slice(0, 5).concat(sizes.slice(-3));
for (const [o1, n, sz] of show) { console.log(`  ${String(o1).padStart(3)}.*  ${String(n).padStart(6)} 段  ${(sz / 1024).toFixed(0)} KB`); }
console.log(`  单个切片平均 ${(bytes / sizes.length / 1024).toFixed(0)} KB`);
