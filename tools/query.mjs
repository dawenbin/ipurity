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
let top = 5, online = false, onlineSamples = 3;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--top") { top = Number(argv[++i]) || 5; }
  else if (argv[i] === "--online") { online = true; }
  else if (argv[i] === "--online-samples") { onlineSamples = Number(argv[++i]) || 3; }
  else { inputs.push(argv[i]); }
}

if (!inputs.length) {
  console.log('用法: node tools/query.mjs "198.*.42.81" [更多模式] [--top 5] [--online]');
  console.log('  城市名一律城市数据原文（DB-IP 的英文名，不做本地化）');
  console.log('  --online  联网核验：抽样几个 IP 问 ipwho.is / ip-api，把「ASN 里的机房段」挑出来');
  process.exit(1);
}

/* 先过一遍清洗层：CIDR（198.3.242.0/24）、全角、转义星号、空格分段都能吃下 */
let patterns = [];
for (const raw of inputs) {
  const rep = Core.parseWithReport(raw);
  if (!rep.items.length) { patterns.push(raw); continue; }
  patterns = patterns.concat(rep.items.map((it) => it.pattern));
}

/* 联网核验（可选）：node 里两家接口都能用，先问 ip-api（标记最全），失败再落 ipwho.is */
const Online = online ? require(join(root, "assets", "online.js")) : null;

for (const p of patterns) {
  let r = Core.analyze(p, data);
  if (!r.ok && worldOk) {
    const o1 = Number(String(p).split(".")[0]);
    const sliced = citySlice(o1);
    const g = Core.analyzeGlobal(p, { world: World, city: sliced ? City : null });
    if (g.ok) { r = g; }
  }
  if (!r.ok) { console.log(`${p}\n  ✗ ${r.reason}`); continue; }
  if (Online) {
    /* node 里优先 ip-api（hosting/proxy/mobile 标记最全），失败再落 ipwho.is */
    const v = await Online.checkPattern(p, { maxSamples: onlineSamples, timeoutMs: 9000, order: ["ip-api", "ipwho"] });
    Core.applyOnline(r, v);
  }
  console.log(`${p}\n  ${r.tier} 级${r.approx ? "（估算）" : ""} · ${r.tierText}` +
    `  [${r.source || "实测记录"}]` +
    /* IP 归属表给的是概率加权，不是实测计数：写成 ≈90% 而不是 229/254 */
    (r.probOnly
      ? `  住宅概率（ASN 级） ≈${r.pctIsp}%` + (r.singleHost ? "" : `（按 ${r.sampled} 个地址加权）`)
      : `  ${r.hostRange ? "住宅主机" : "住宅 /24"} ${r.counts[1]}/${r.sampled} (${r.pctIsp}%)`) +
    `  机房 ${r.counts[2]}  商业 ${r.counts[3]}  移动 ${r.counts[4]}` +
    (r.city && r.city.city ? `  城市 ${Core.cityLabel(r.city.city)}（${r.city.count}/${r.city.n} 个取值）` : ""));
  /* 打码行给排最前的那个候选段 —— 命令行里把它连同口径一起印出来 */
  console.log(`  建议拿 ${Core.takeNetwork(r) || "—"}   得分 ${Core.rowScore(r)}` +
    (r.starPos === 1 || r.starPos === 2 ? `（${Core.takeWhy(r)}）` : ""));
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
    console.log(`  → ${c.ip}  ${Core.cityLabel(c.city)}${c.city ? " · " : ""}${c.isp}` +
      `${c.metro ? "  [" + ((data.metro && data.metro.zh) || "标记区域") + "]" : ""}`);
  }
}
