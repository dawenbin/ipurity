/* 全球段表自检：段表覆盖、ASN 查询、标定占比、任意 IPv4 兜底判定
   node test/test-global.mjs */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const World = require(join(root, "assets", "sources.js"));
const Core = require(join(root, "assets", "core.js"));
const CityPacks = require(join(root, "assets", "city.js"));

let fail = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  if (!cond) fail++;
};
const grab = (file, name) => {
  const m = readFileSync(join(root, file), "utf8").match(new RegExp(`window\\.${name}\\s*=\\s*([\\s\\S]*?);?\\s*$`));
  if (!m) throw new Error(`${file} 解析失败`);
  return JSON.parse(m[1]);
};

/* ---------- 装数据 ---------- */
const packed = World.putPack(readFileSync(join(root, "data", "global-pack.bin")));
const asns = World.setMeta(grab("data/global-asn.js", "GLOBAL_ASN"));
const calib = World.setCalib(grab("data/asn-calib.js", "ASN_CALIB"));
check("段表读取", packed.segments > 500000, `${packed.segments} 段 / ${packed.asns} 个 ASN`);
check("ASN 元数据读取", asns > 70000, `${asns} 个 ASN`);
check("标定表读取", calib > 100, `${calib} 个 ASN 有住宅占比`);
check("World.ready()", World.ready() === true);

/* ---------- 段表覆盖：段内首尾相接（1.0.0.0–223.255.255.255，占地址空间 87.1%） ---------- */
let gaps = 0;
const buf = readFileSync(join(root, "data", "global-pack.bin"));
const n = buf.readUInt32LE(12);
let prev = buf.readUInt32LE(24);
for (let i = 1; i < n; i++) {
  const s = buf.readUInt32LE(24 + i * 4);
  if (s <= prev) { gaps++; }
  prev = s;
}
check("段起点严格递增（二分查找前提）", gaps === 0, `${gaps} 处异常`);
const cov = World.coverage();
const sum = Object.values(cov.pct).reduce((a, b) => a + b, 0);
check("类别占比合计 100%（分母 = 段表覆盖到的地址量）", Math.abs(sum - 100) < 0.2,
  `合计 ${sum.toFixed(1)}%，共 ${cov.blocks24} 个 /24`);
check("段表覆盖可路由段（1.0.0.0–223.255.255.255 ≈ 87.1% 地址空间）",
  Math.abs(cov.covered - 87.1) < 0.2, `covered=${cov.covered}%`);
console.log("      构成：" + Object.entries(cov.pct).map(([k, v]) => `${Core.CAT_NAME[k]} ${v}%`).join("  "));

/* 段表外的地址（0.0.0.0/8、224.0.0.0 起的组播/保留段）必须查不到，不能落到末段 */
for (const ip of ["0.0.0.0", "0.255.255.255", "223.255.255.0", "224.0.0.1", "239.1.2.3", "255.255.255.255"]) {
  check(`${ip} 落在段表外 → 查不到`, World.asnOf(ip) === 0, World.asnOf(ip) ? "误命中 AS" + World.asnOf(ip).asn : "");
}
check("223.255.254.255（末段末地址）仍在表内", !!World.asnOf("223.255.254.255"),
  World.asnOf("223.255.254.255") ? "AS" + World.asnOf("223.255.254.255").asn : "未命中");

/* ---------- 任意 IP → ASN ---------- */
const cases = [
  ["1.1.1.1", 13335, "Cloudflare"],
  ["8.8.8.8", 15169, "Google"],
  ["198.72.205.197", 20001, "Charter / TWC"],
  ["24.24.0.1", 11351, "Charter"],
  ["94.140.14.14", 212772, "AdGuard"]
];
for (const [ip, want, hint] of cases) {
  const got = World.asnOf(ip);
  check(`${ip} → AS${want} (${hint})`, !!got && got.asn === want, got ? `AS${got.asn} ${got.name.slice(0, 40)}` : "未命中");
}

/* ---------- 标定占比压掉大型混合 ASN 的虚高 ---------- */
const att = World.lookup("12.1.2.3");       // AS7018 AT&T，实测样本 4/463 判为住宅
check("AS7018 被标定压成低住宅占比", att && att.asn === 7018 && att.p < 0.05,
  att ? `AS${att.asn} p=${att.p.toFixed(3)} ${att.name.slice(0, 30)}` : "未命中");
const comcast = World.lookup("73.0.0.1");   // AS7922 Comcast，实测样本 418/419
check("AS7922 Comcast 保持高住宅占比", comcast && comcast.p > 0.9,
  comcast ? `AS${comcast.asn} p=${comcast.p.toFixed(3)}` : "未命中");
const cogent = World.lookup("38.0.0.1");    // AS174 Cogent，实测样本 0/1233
check("AS174 中转商压到接近 0", cogent && cogent.p < 0.02,
  cogent ? `AS${cogent.asn} p=${cogent.p.toFixed(3)} ${cogent.name.slice(0, 30)}` : "未命中");

/* ---------- 整行（带 *）判定：全球段表 ---------- */
const masked = Core.analyzeGlobal("198.*.205.197", { world: World });
check("打码行在全球段表可判定", masked.ok === true, masked.ok ? `级别 ${masked.tier} · 住宅 ${masked.pctIsp}% · 枚举 ${masked.hardIsp}/256 住宅` : masked.reason);
check("打码行枚举了 256 种取值", masked.sampled === 256, String(masked.sampled));
check("级别落在 A/B/C/D 内", ["A", "B", "C", "D"].indexOf(masked.tier) >= 0, masked.tier + " " + masked.tierText);
check("标了数据来源", masked.source === "全球ASN" && masked.approx === true, masked.source);
check("ASN 命中明细非空", Object.keys(masked.asnHist).length >= 1,
  Object.entries(masked.asnHist).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([a, c]) => `AS${a}×${c}`).join(" "));

/* 全球段表 + 城市片：没有实测数据的前缀也能给出落点城市分布 */
CityPacks.put(198, readFileSync(join(root, "data", "city", "198.bin")));
const withCity = Core.analyzeGlobal("198.*.205.197", { world: World, city: CityPacks });
check("全球段表 + 城市片能算落点城市分布", withCity.covered > 200 && withCity.cityTop.length > 0,
  `覆盖 ${withCity.covered}/256 · ${withCity.cityTop.slice(0, 3).map((c) => c.city + "×" + c.count).join(" ")}`);

/* 单个确定 IP */
const one = Core.analyzeGlobal("73.45.128.9", { world: World });
check("单个 IP 全球段表可判定", one.ok === true && one.singleHost === true,
  one.ok ? `${one.pattern} → ${one.tier} ${one.tierText} · ${one.host24.isp.slice(0, 30)}` : one.reason);

/* ---------- 实测样本缺失时自动兜底 ---------- */
const fine = JSON.parse(readFileSync(join(root, "data", "segments-data.json"), "utf8"));
const rep = Core.parseWithReport("73.*.42.81\n198.*.205.197");
const res = Core.analyzeMany(rep.items, fine, { world: World, cityPack: CityPacks });
const r0 = res.rows[0], r1 = res.rows[1];
check("实测样本没有的前缀走全球段表", r0.ok && r0.source === "全球ASN", `${r0.pattern} → ${r0.tier} (${r0.source})`);
check("实测样本有的前缀仍走实测样本", r1.ok && !r1.source, `${r1.pattern} → ${r1.tier} (${r1.source || "实测样本"})`);
check("排名把整行当单位", Core.rankRows(res.rows).every((r) => r.rank > 0 && r.pattern.indexOf("*") >= 0));
const csv = Core.toCsv(Core.rankRows(res.rows), ["A", "B", "C", "D"], 3);
check("排名表 CSV 带数据来源列", csv.split("\n")[0].indexOf("数据来源") > 0 && csv.split("\n").length === 3,
  `${csv.split("\n").length} 行`);

console.log(fail === 0 ? "\n全球段表自检通过 ✅" : `\n${fail} 项失败 ❌`);
process.exit(fail === 0 ? 0 : 1);
