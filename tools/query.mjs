/*
 * 命令行查询：直接对数据包做分级，用来快速复查某个模式
 *   node tools/query.mjs "130.*.253.66" "198.*.42.81" --city "San Francisco" --top 5
 * 实测记录里没有的段会自动落到IP 归属表（全量 ASN 段表 + 城市片），任意 IPv4 都能查。
 */
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const Core = require(join(root, "assets", "core.js"));
const World = require(join(root, "assets", "sources.js"));
const City = require(join(root, "assets", "city.js"));
const data = JSON.parse(readFileSync(join(root, "data", "segments-data.json"), "utf8"));

/* ---- IP 归属表：段表 + ASN 元数据 + 标定（缺哪个就少一层能力，不报错） ---- */
const grab = (file, name) => {
  const p = join(root, "data", file);
  if (!existsSync(p)) { return null; }
  const m = readFileSync(p, "utf8").match(new RegExp(`window\\.${name}\\s*=\\s*([\\s\\S]*?);?\\s*$`));
  return m ? JSON.parse(m[1]) : null;
};
let worldOk = false;
try {
  if (existsSync(join(root, "data", "global-pack.bin"))) {
    World.putPack(readFileSync(join(root, "data", "global-pack.bin")));
    World.setMeta(grab("global-asn.js", "GLOBAL_ASN"));
    const cal = grab("asn-calib.js", "ASN_CALIB");
    if (cal) { World.setCalib(cal); }
    worldOk = World.ready();
  }
} catch (e) { worldOk = false; }

/* 城市片按需读磁盘（磁盘上是 data/city/<o1>.bin） */
function citySlice(o1) {
  if (City.has(o1)) { return true; }
  const p = join(root, "data", "city", o1 + ".bin");
  if (!existsSync(p)) { return false; }
  City.put(o1, readFileSync(p));
  return true;
}

const argv = process.argv.slice(2);
const inputs = [];
let top = 5, online = false, onlineSamples = 3, expand = 0, cidrs = 0;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--top") { top = Number(argv[++i]) || 5; }
  else if (argv[i] === "--online") { online = true; }
  else if (argv[i] === "--online-samples") { onlineSamples = Number(argv[++i]) || 3; }
  else if (argv[i] === "--expand") { expand = Math.max(0, Math.min(256, Number(argv[++i]) || 0)); }
  else if (argv[i] === "--cidrs") { cidrs = Math.max(0, Math.min(5000, Number(argv[++i]) || 0)); }
  else { inputs.push(argv[i]); }
}

if (!inputs.length) {
  console.log('用法: node tools/query.mjs "198.*.42.81" [AS4766] [更多模式] [--top 5] [--online]');
  console.log('  城市名一律城市数据原文（DB-IP 的英文名，不做本地化）');
  console.log('  AS4766     按 ASN 聚合：名称 / 国家 / 段数 / CIDR 数 / /24 数 / 级别');
  console.log('  --expand N 展开该 ASN 的 N 个 /24（均匀取样，最多 256）');
  console.log('  --cidrs N  列出该 ASN 的 N 个 CIDR（最多 5000）');
  console.log('  --online   联网核验：抽样几个 IP 问 ipwho.is / ip-api，把「ASN 里的机房段」挑出来');
  process.exit(1);
}

/* 先过一遍清洗层：CIDR（198.3.242.0/24）、全角、转义星号、空格分段都能吃下 */
let patterns = [];
let asns = [];
for (const raw of inputs) {
  const rep = Core.parseWithReport(raw);
  for (const a of rep.asns) { if (asns.indexOf(a.asn) < 0) { asns.push(a.asn); } }
  if (!rep.items.length) {
    if (!rep.asns.length) { patterns.push(raw); }
    continue;
  }
  patterns = patterns.concat(rep.items.map((it) => it.pattern));
}

/* 联网核验（可选）：node 里两家接口都能用，先问 ip-api（标记最全），失败再落 ipwho.is */
const Online = online ? require(join(root, "assets", "online.js")) : null;

for (const p of patterns) {
  /* 走和页面**完全相同**的那条路（analyzeItem）：实测数据优先，没命中落到 IP 归属表，
     然后统一过不可路由 / 未评级两道判定。早先 CLI 自己拼 analyze + analyzeGlobal，
     结果绕过了保留地址那道闸口 —— 同一个地址命令行说「X 级」、页面说「不可路由」。 */
  let r = null;
  if (worldOk) {
    const o1 = Number(String(p).split(".")[0]);
    const sliced = citySlice(o1);
    if (sliced) { City.put(o1, sliced); }
    r = Core.analyzeItem({ index: 1, sourceLine: 1, raw: p, pattern: p }, data,
      { world: World, cityPack: sliced ? City : null });
  } else {
    r = Core.analyze(p, data);
  }
  if (!r.ok && !r.reserved && !r.ungraded) { console.log(`${p}\n  ✗ ${r.reason}`); continue; }
  /* 不可路由：页面怎么写，命令行就怎么说 */
  if (r.reserved) { console.log(`${p}\n  不可路由（公网没人宣告这个地址，不参与排名与得分）`); continue; }
  if (Online) {
    /* node 里优先 ip-api（hosting/proxy/mobile 标记最全），失败再落 ipwho.is */
    const v = await Online.checkPattern(p, { maxSamples: onlineSamples, timeoutMs: 9000, order: ["ip-api", "ipwho"] });
    Core.applyOnline(r, v);
  }
  /* 未评级：只有关键词类型，没有密度数据 —— 不报级别、不报得分，只说它是什么类型 */
  if (r.ungraded) {
    console.log(`${p}\n  未评级 · ${Core.CAT_NAME[Core.topCat(r)] || "未知"}  [${r.source || "实测记录"}]` +
      `  按运营商类型判（这个 ASN 一个标定样本都没有，没有密度数据）` +
      `  机房 ${r.counts[2]}  商业 ${r.counts[3]}  移动 ${r.counts[4]}`);
    continue;
  }
  console.log(`${p}\n  ${r.tier} 级${r.approx ? "（估算）" : ""} · ${r.tierText}` +
    `  [${r.source || "实测记录"}]` +
    /* IP 归属表给的是概率加权，不是实测计数：写成 ≈90% 而不是 229/254 */
    (r.probOnly
      ? `  住宅概率（ASN 级） ≈${r.pctIsp}%` + (r.singleHost ? "" : `（按 ${r.sampled} 个地址加权）`)
      : `  ${r.hostRange ? "住宅主机" : "住宅 /24"} ${r.counts[1]}/${r.sampled} (${r.pctIsp}%)`) +
    `  机房 ${r.counts[2]}  商业 ${r.counts[3]}  移动 ${r.counts[4]}` +
    (r.city && r.city.city ? `  城市 ${Core.cityLabel(r.city.city)}（${r.city.count}/${r.city.n} 个取值）` : ""));
  console.log(`  得分 ${Core.rowScore(r)}`);
  if (r.capped) {
    console.log(`  注：ASN 级估算，占比按上限封顶 ${Math.round(Core.ASN_CONF_CAP * 100)}%（同一 ASN 里可能有对方机房的段）`);
  }
  if (r.online) {
    console.log(`  联网核验（${r.online.provider}，抽样 ${r.online.checked}/${r.online.sampled}）：${r.online.verdict}` +
      `  org ${r.online.org || "?"}  ${r.online.why || ""}`);
  }
  if (r.singleHost && r.host24) {
    console.log(`  本 /24: ${r.host24.network}  ${r.host24.city}  ${r.host24.isp}`);
  }
  if (r.source === "全球ASN") {
    const asns = Object.entries(r.asnHist).sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([a, n]) => `AS${a}×${n} ${(World.byNumber(a) || {}).name || ""}`.trim());
    console.log(`  IP 归属表 ASN：${asns.join("  |  ")}`);
    if (r.cityTop && r.cityTop.length) {
      console.log(`  城市分布：${r.cityTop.slice(0, 5).map((c) => `${Core.cityLabel(c.city)}×${c.count}`).join(" · ")}`);
    }
  }
  const cands = Core.sortCandidates(r.candidates).slice(0, top);
  for (const c of cands) {
    console.log(`  → ${c.ip}  ${Core.cityLabel(c.city)}${c.city ? " · " : ""}${c.isp}`);
  }
}

/* ---------- ASN：一条聚合概览 + 可选展开 ---------- */
if (asns.length && !worldOk) {
  console.log("ASN 查询需要 data/global-pack.bin + data/global-asn.js");
}
const num = (x) => Number(x || 0).toLocaleString("en-US");
for (const asn of worldOk ? asns : []) {
  const r = Core.analyzeAsn(asn, { world: World });
  const head = `AS${asn}`;
  if (!r.ok) { console.log(`${head}\n  ✗ ${r.reason}`); continue; }
  const p = r.asnProfile;
  const entry = World.byNumber(asn) || {};
  const typeName = Core.CAT_NAME[entry.t] || "未知";
  console.log(head);
  console.log(`  ${p.name || "（无名称）"}  ·  ${p.cc || "??"}  ·  ${typeName}`);
  console.log(`  段 ${num(p.segments)}  合并区间 ${num(p.ranges)}  CIDR ${num(p.cidrs)}` +
    `  /24 ${num(p.blocks24)}  地址 ${num(p.addresses)}  首个 ${p.firstIp || "?"}`);
  if (r.ungraded) {
    console.log(`  未评级 · ${Core.CAT_NAME[Core.topCat(r)] || "未知"}  （这个 ASN 一个标定样本都没有：` +
      `只有类型先验，没有密度数据，不报级别 / 得分 / 概率）`);
    console.log(`  按先验折算：住宅 ${r.counts[1]}  机房 ${r.counts[2]}  商业 ${r.counts[3]}  移动 ${r.counts[4]}` +
      `（${num(r.sampled)} 个 /24）`);
  } else {
    console.log(`  住宅概率（ASN 级） ≈${(r.pctIsp || 0)}%` +
      (r.capped ? `（原始 ${(p.rawProbability * 100).toFixed(1)}%，按上限封顶 ${Math.round(Core.ASN_CONF_CAP * 100)}%）` : "") +
      `  [${r.source}]`);
    console.log(`  ${r.tier} 级 · ${r.tierText}  得分 ${Core.rowScore(r)}`);
    console.log(`  住宅 ${r.counts[1]}  机房 ${r.counts[2]}  商业 ${r.counts[3]}  移动 ${r.counts[4]}` +
      `（按 ${num(r.sampled)} 个 /24 折算）`);
  }
  if (expand > 0) {
    const blocks = Core.expandAsn(asn, { world: World, cap: expand });
    console.log(`  展开 /24（${blocks.length}/${num(p.blocks24)}，按地址顺序均匀取样）：`);
    for (const b of blocks) { console.log(`    ${b}`); }
  }
  if (cidrs > 0) {
    const list = World.cidrsOf(asn) || [];
    console.log(`  CIDR（${Math.min(list.length, cidrs)}/${num(list.length)}）：`);
    for (const c of list.slice(0, cidrs)) { console.log(`    ${c}`); }
    if (list.length > cidrs) { console.log(`    … 还有 ${num(list.length - cidrs)} 个`); }
  }
  if (expand === 0 && cidrs === 0) {
    console.log(`  （--expand N 展开 /24，--cidrs N 列出 CIDR）`);
  }
}
