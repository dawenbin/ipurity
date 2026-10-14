/*
 * build/prefixmap-all.csv（ip-api 逐 /24 实测样本，含 as + Cat 两列）→ data/asn-calib.js
 *
 * 为什么需要它：全球 ASN 层只能按 AS 名称/PeeringDB 类型给一个“整块 ASN”的类型，
 * 而大型混合 ASN（AS7018 / AS701 / AS16509 这种）内部既有住宅池也有企业段，
 * 对拍显示这类 ASN 会被系统性高估一级。用我们已经实测样本过的 /24 反推每个 ASN 的
 * “住宅 /24 占比”，用占比代替“整块算住宅”，就能把虚高压下去。
 *
 * 产物：window.ASN_CALIB = { "7018": [样本数, 住宅数], ... }（只收样本数 >= 5 的 ASN）
 * 用法：node tools/make-calibration.mjs
 */
import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const csvPath = join(root, "build", "prefixmap-all.csv");
if (!existsSync(csvPath)) {
  throw new Error(`缺少 ${csvPath}：先用 tools/make-data.ps1 / tools/scan-prefixes.ps1 扫出实测数据`);
}

const MIN_SAMPLE = 5;      // 样本太少不给占比（避免 1/1=100% 这种噪声）
const rows = readFileSync(csvPath, "utf8").split(/\r?\n/);
const head = rows[0].match(/"[^"]*"|[^,]+/g).map((s) => s.replace(/^"|"$/g, ""));
const iCat = head.indexOf("Cat"), iAs = head.indexOf("as"), iPrefix = head.indexOf("prefix");
const iO2 = head.indexOf("o2v");

const perAsn = new Map();     // asn → { n, isp }
const seen24 = new Set();     // 每行 = 一个 /24（o2v + prefix），去重防重复扫描
let lines = 0;
const prefixes = new Set();

for (const row of rows.slice(1)) {
  if (!row.trim()) { continue; }
  const c = row.match(/"[^"]*"|[^,]+/g).map((s) => s.replace(/^"|"$/g, ""));
  const cat = c[iCat];
  const asn = Number(String(c[iAs] || "").replace(/^AS(\d+).*/, "$1"));
  const block = c[iPrefix];                      // 形如 198.*.205
  const key = c[iO2] + "|" + block;
  if (!cat || !asn || seen24.has(key)) { continue; }
  seen24.add(key);
  prefixes.add(block);
  lines++;
  const g = perAsn.get(asn) || { n: 0, isp: 0, name: String(c[iAs] || "").slice(0, 48) };
  g.n++;
  if (cat === "ISP") { g.isp++; }
  perAsn.set(asn, g);
}

const kept = [...perAsn.entries()]
  .filter(([, g]) => g.n >= MIN_SAMPLE)
  .sort((a, b) => b[1].n - a[1].n);

const calib = {};
const names = {};
for (const [asn, g] of kept) { calib[asn] = [g.n, g.isp]; names[asn] = g.name; }

const out = {
  generated: new Date().toISOString().slice(0, 16).replace("T", " "),
  source: "ip-api 逐 /24 实测样本（build/prefixmap-all.csv）反推 ASN 住宅占比",
  legend: "ASN → [样本 /24 数, 判为住宅的 /24 数]；样本数 < " + MIN_SAMPLE + " 的 ASN 不收",
  scannedBlocks: prefixes.size,
  scanned24: lines,
  asns: Object.keys(calib).length,
  calib: calib,
  names: names
};
writeFileSync(join(root, "data", "asn-calib.js"), "window.ASN_CALIB=" + JSON.stringify(out) + ";\n");

console.log(`实测样本前缀 ${prefixes.size} 个 / 去重后 ${lines} 个 /24，覆盖 ASN ${perAsn.size} 个，保留样本 >=${MIN_SAMPLE} 的 ${kept.length} 个`);
console.log("占比最极端的前几个（大 ASN）：");
for (const [asn, g] of kept.slice(0, 10)) {
  console.log(`  AS${String(asn).padEnd(7)} ${String(g.isp).padStart(3)}/${String(g.n).padStart(3)} = ${(100 * g.isp / g.n).toFixed(0)}%  ${g.name.slice(0, 40)}`);
}
console.log(`asn-calib.js ${(statSync(join(root, "data", "asn-calib.js")).size / 1024).toFixed(1)} KB`);
