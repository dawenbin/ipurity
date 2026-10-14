/*
 * build/asn/* → data/global-pack.bin + data/global-pack.js
 *
 * IPv4 可路由段 → ASN 段表（iptoasn，53 万段，覆盖 1.0.0.0–223.255.255.255），每段带一个类型码：
 * 表尾（末段结束地址 +1）写进头部第 20 字节，查表越界时按「查不到」处理。
 *   1 住宅ISP / 2 机房·云 / 3 商业中转·机构 / 4 移动 / 6 其他·未分配
 *
 * 类型码由 ASN 分类器给出，依据（按优先级）：
 *   1. bad-asn-list（人工确认的机房/VPN/代理 ASN）→ 2
 *   2. AS 名称关键词：机房/云/托管 → 2；移动 → 4；教育/政府/企业 → 3
 *   3. PeeringDB info_type：Cable/DSL/ISP → 1；NSP/Network Services/Content → 3；Enterprise → 3
 *   4. AS 名称关键词：Cable/Broadband/Telecom/Communications/Fiber… → 1
 *   5. 都不命中 → 6
 *
 * 用法：node tools/make-global-pack.mjs [--eval]
 *   --eval  额外用 build/prefixmap-all.csv（ip-api 逐 /24 实测记录结果）评估分类准确率
 */
import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const asnDir = join(root, "build", "asn");

const CAT = { ISP: 1, DC: 2, BIZ: 3, MOB: 4, UNK: 6 };

/* ------------------------------ 分类级联 ------------------------------ */
/* 一轮一轮过：命中即停。顺序很讲究——先把“招牌词”用掉，最后才让
   communications/networks 这种中性词落到“商业中转”，否则 Cogent 这种中转商
   会因为名称里有 Communications 被误判成住宅。 */
const PASSES = [
  /* 1. 机房 / 云 / 托管 / VPN 转售 */
  [CAT.DC, [
    "amazon", " aws", "aws ", "google", "microsoft", "azure", "oracle", "alibaba", "alicloud",
    "tencent", "huawei cloud", "digitalocean", "hetzner", "ovh", "vultr", "linode", "contabo",
    "scaleway", "leaseweb", "m247", "choopa", "softlayer", "rackspace", "equinix", "datacamp",
    "fastly", "cloudflare", "akamai", "limelight", "stackpath", "edgio", "imperva", "zscaler",
    "twilio", "sendgrid", "backblaze", "wasabi", "vercel", "netlify", "heroku", "render",
    "railway", "fly.io", "northflank", "ibm cloud", "salesforce", "okta", "hosting", "hostmaster",
    "webhost", "web hosting", "thehosting", "datacenter", "data center", "data centre",
    "datacentre", "colocation", "colo ", "idc ", " idc", "vps", "server", "servers", "cloud",
    "vpn", "proxy", "tunnel", "gcore", "zenlayer", "xserver", "sakura internet", "kagoya",
    "conoha", "aeza", "alexhost", "timeweb", "selectel", "reg.ru", "beget", "racknerd",
    "colocrossing", "multacom", "quadranet", "psychz", "hivelocity", "nocix", "sharktech",
    "buyvm", "frantech", "pacificrack", "hostdare", "hosthatch", "greencloud", "hostwinds",
    "ionos", "strato", "godaddy", "namecheap", "bluehost", "hostgator", "dreamhost",
    "computer systems", "computing", "cyber", "technologies", "technology", "it solutions",
    "internet solutions", "network solutions", "managed services", "unified", "software",
    "digitalocean", "aruba s.p.a", "aruba.it", "incapsula", "imperva", "cdn", "koala",
    "webhosting", "firstvds", "iqhost", "justhost", "mchost", "vpsvault", "wholesale internet"
  ]],
  /* 2. 移动网络 */
  [CAT.MOB, [
    "mobile", "wireless", "cellular", " gsm", "gsm ", " lte", "lte ", "4g", "5g", "umts",
    "hspa", "td-lte", "t-mobile", "tmobile", "vodafone", "telefonica moviles", "turkcell",
    "china mobile", "reliance jio", " jio ", "airtel", "mtn ", "mtn-", "orange mobile",
    "optus mobile", "singtel mobile", "telecom personal", "claro", "tim s.p.a"
  ]],
  /* 3. 教育 / 科研 / 政府 / 机构 —— 不是机房，也不是家用池 */
  [CAT.BIZ, [
    "university", "universit", "universidad", "universidade", "universitat", "universite",
    "college", "school", "academy", "institute", "research", "academic", "laboratory",
    "hospital", "clinic", "health", "medical", "government", "gov ", "ministry", "minist",
    "municipal", "city of", "state of", "county of", "department", "federal ", "defense",
    "defence", "army", "navy", "air force", "bank", "insurance", "reinsur", "financial",
    "holdings", "corporation", "corp ", "company", "enterprise", "petroleum", "energy",
    "airlines", "airport", "railway", "postal", "nasa", "cern", "nato", "united nations",
    "united states", "us dept", "u.s. "
  ]],
  /* 4. 住宅 ISP：品牌 + 结构性关键词 */
  [CAT.ISP, [
    "telecom", "telecommunication", "telekom", "telefon", "telco", "teleglobe",
    "cable", "broadband", "breitband", "fiber", "fibre", "glasfaser", "dsl", "adsl", "vdsl",
    "ftth", "fttx", "internet service", "internet servicos", "comcast", "xfinity", "spectrum",
    "charter", "cox communications", "cox.net", "centurylink", "frontier", "windstream",
    "mediacom", "wideopenwest", "cable one", "cableone", "altice", "optimum", "suddenlink",
    "breezeline", "cincinnati bell", "deutsche telekom", "1&1", "kabel", "kpn", "ziggo",
    "xs4all", "proximus", "swisscom", "virgin media", "sky broadband", "talktalk", "plusnet",
    "telefonica", "movistar", "meo", "nos ", "vivacom", "upc ", "liberty global", "telenet",
    "fastweb", "wind tre", "iliad", "free sas", "bouygues", "sfr", "turk telekom",
    "superonline", "ttnet", "megafon", "mts ", "beeline", "rostelecom", "kyivstar", "lifecell",
    "elisa", "dna oyj", "altibox", "lyse", "globalconnect", "tele2", "com hem", "chinanet",
    "china169", "china unicom", "china telecom", "hinet", "chunghwa", "seednet", "nifty",
    "biglobe", "so-net", "ocn", "plala", "jcom", "softbank", "kddi", "korea telecom", "kornet",
    "sk broadband", "hanaro", "singnet", "starhub", "viewqwest", "iinet", "internode",
    "telstra", "optus", "aussie broadband", "vocus", "true internet", "3bb", "maxis",
    "tm net", "time dotcom", "indosat", "telkomsel", "telkom indonesia", "biznet", "myrepublic",
    "first media", "viettel", "vnpt", "fpt telecom", "pldt", "globe telecom", "converge",
    "unifi", "bsnl", "mtnl", "hathway", "act fibernet", "excitel", "zain", "etisalat",
    "mobily", "ooredoo", "batelco", "telkom sa", "safaricom", "telmex", "izzi", "totalplay",
    "megacable", "tigo", "entel", "vtr ", "antel", "cantv", "telecom argentina", "shatel",
    "pars online", "tiscali", "eolo", "linkem", "onlime", "skynet", "telia", "telenor",
    "telus", "bell canada", "rogers", "shaw ", "videotron", "cogeco", "brazil telecom",
    "algar telecom", "brasil telecom", "orange s.a", "orange sa", "bt group", "british telecom",
    "cell c", "rain ", "liquid telecom", "er-telecom", "internetbolaget", "sonic", "eaccess"
  ]],
  /* 5. 兜底：中性网络运营商 / 中转批发 → 商业中转（放在家用之后、未知之前） */
  [CAT.BIZ, [
    "communications", "communication", "comunicaciones", "comunicacoes", "communicatie",
    "networks", "network", "internet", "transit", "backbone", "carrier", "exchange",
    "cogent", "zayo", "lumen", "gtt", "level 3", "verizon business", "at&t services",
    "internet services", "tierpoint", "internap", "hurricane electric", "unitas global",
    "pccw", "hkt", "singtel", "telehouse", "solutions", "services", "group", "international",
    "global", "telecom italia", "spark new zealand", "tata", "reliance", "hathway"
  ]]
];

/* AS 名称 → 类型码 */
function classifyName(name) {
  const n = " " + String(name || "").toLowerCase() + " ";
  for (const [cat, words] of PASSES) {
    for (const w of words) { if (n.includes(w)) { return cat; } }
  }
  return CAT.UNK;
}

/* PeeringDB info_type → 类型码（名称规则不命中时的第二信号） */
function classifyPeeringDB(net) {
  const t = String(net.info_type || "");
  const types = Array.isArray(net.info_types) ? net.info_types : [];
  const all = types.length ? types : [t];
  if (all.includes("Cable/DSL/ISP")) { return CAT.ISP; }
  if (all.includes("NSP") || all.includes("Network Services") ||
      all.includes("Route Server") || all.includes("Route Collector") ||
      all.includes("Content") || all.includes("Enterprise") ||
      all.includes("Government") || all.includes("Educational/Research")) { return CAT.BIZ; }
  return 0;
}

/* ------------------------------ 读取数据源 ------------------------------ */
const gz = join(asnDir, "ip2asn-v4.tsv.gz");
const pdbFile = join(asnDir, "peeringdb-net.json");
const badFile = join(asnDir, "bad-asn-list.csv");
for (const f of [gz, pdbFile, badFile]) {
  if (!existsSync(f)) { throw new Error(`缺少 ${f}，先跑 node tools/fetch-asn-tables.mjs`); }
}

const tsv = gunzipSync(readFileSync(gz)).toString("utf8").trim().split("\n");
const peeringdb = new Map();
for (const n of JSON.parse(readFileSync(pdbFile, "utf8"))) { peeringdb.set(n.asn, n); }
const badAsns = new Set(
  readFileSync(badFile, "utf8").split(/\r?\n/).slice(1)
    .map((l) => parseInt(l.split(",")[0], 10)).filter(Number.isFinite)
);

/* ------------------------------ 解析段表 ------------------------------ */
function ip2int(s) {
  const p = s.split(".");
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + Number(p[3]);
}
function int2ip(n) {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

const starts = [];
const asnNums = [];
const meta = new Map();   // asn → { name, cc }
let prevEnd = -1, gaps = 0, truncated = 0, tableEnd = 0;

for (const line of tsv) {
  const c = line.split("\t");
  if (c.length < 3) { continue; }
  const s = ip2int(c[0]), e = ip2int(c[1]);
  const asn = Number(c[2]) || 0;
  if (e > 4294967295) { truncated++; }
  if (prevEnd >= 0 && s !== prevEnd + 1) { gaps++; }
  prevEnd = e;
  tableEnd = e + 1;   // 段表实际覆盖范围的右开边界
  starts.push(s);
  asnNums.push(asn);
  if (!meta.has(asn)) { meta.set(asn, { name: c[4] || "", cc: c[3] === "None" ? "" : c[3] }); }
}

/* ------------------------------ 分类 ------------------------------ */
const asnList = [...meta.keys()].sort((a, b) => a - b);
const asnIndex = new Map(asnList.map((a, i) => [a, i]));
const asnType = new Uint8Array(asnList.length);
const reason = { dc: 0, mob: 0, isp: 0, biz: 0, unk: 0, bad: 0, pdb: 0 };

for (let i = 0; i < asnList.length; i++) {
  const asn = asnList[i];
  const info = meta.get(asn);
  let t = 0;
  if (asn === 0) { t = CAT.UNK; }
  else if (badAsns.has(asn)) { t = CAT.DC; reason.bad++; }
  else {
    t = classifyName(info.name);
    if (t !== CAT.UNK) { reason[{ 1: "isp", 2: "dc", 3: "biz", 4: "mob" }[t]]++; }
    else {
      const p = classifyPeeringDB(peeringdb.get(asn) || {});
      if (p) { t = p; reason.pdb++; } else { t = CAT.UNK; reason.unk++; }
    }
  }
  asnType[i] = t;
}

/* ------------------------------ 编码 ------------------------------ */
const N = starts.length;
const startArr = Uint32Array.from(starts);
const idxArr = new Uint32Array(N);
for (let i = 0; i < N; i++) { idxArr[i] = asnIndex.get(asnNums[i]); }

const HEADER = 24;
const bin = Buffer.alloc(HEADER + N * 8);
bin.write("IPPACK01", 0, "ascii");
bin.writeUInt32LE(1, 8);              // version
bin.writeUInt32LE(N, 12);             // 段数
bin.writeUInt32LE(asnList.length, 16); // ASN 数
bin.writeUInt32LE(tableEnd >>> 0, 20); // 段表覆盖范围右开边界（末段结束地址 +1）
Buffer.from(startArr.buffer).copy(bin, HEADER);
Buffer.from(idxArr.buffer).copy(bin, HEADER + N * 4);
writeFileSync(join(root, "data", "global-pack.bin"), bin);

/* ASN 元数据（名称/国家/类型）：只在需要显示时懒加载 */
const asnJson = {
  generated: new Date().toISOString().slice(0, 16).replace("T", " "),
  source: "iptoasn.com(IPv4→ASN) + PeeringDB(info_type) + bad-asn-list",
  count: N,
  asns: asnList.length,
  legend: "t: 1住宅ISP 2机房/云 3商业中转/机构 4移动 6其他",
  list: asnList.map((a, i) => {
    const info = meta.get(a);
    return [a, asnType[i], info.cc, String(info.name).slice(0, 60)];
  })
};
writeFileSync(join(root, "data", "global-asn.js"),
  "window.GLOBAL_ASN=" + JSON.stringify(asnJson) + ";\n");

const spanPct = (100 * (tableEnd - startArr[0]) / 4294967296);
console.log(`段数 ${N}  唯一 ASN ${asnList.length}  不连续处 ${gaps}  超出 IPv4 ${truncated}`);
console.log(`覆盖范围 ${int2ip(startArr[0])} – ${int2ip(tableEnd - 1)}（占地址空间 ${spanPct.toFixed(2)}%，224.0.0.0 起为组播/保留段，不在段表内）`);
console.log(`分类来源：bad-asn-list ${reason.bad} / 名称规则 isp ${reason.isp} dc ${reason.dc} biz ${reason.biz} mob ${reason.mob} / PeeringDB ${reason.pdb} / 未知 ${reason.unk}`);
console.log(`global-pack.bin ${(statSync(join(root, "data", "global-pack.bin")).size / 1048576).toFixed(2)} MB`);
console.log(`global-asn.js   ${(statSync(join(root, "data", "global-asn.js")).size / 1048576).toFixed(2)} MB`);

/* 按覆盖地址量统计（比按 ASN 个数更有意义） */
const covered = { 1: 0, 2: 0, 3: 0, 4: 0, 6: 0 };
for (let i = 0; i < N; i++) {
  const end = i + 1 < N ? startArr[i + 1] : tableEnd;
  covered[asnType[idxArr[i]]] += (end - startArr[i]) / 256;   // 折算成 /24 个数
}
const grand = Object.values(covered).reduce((a, b) => a + b, 0);
console.log("覆盖占比：" + [1, 2, 3, 4, 6].map((k) =>
  `${["", "住宅ISP", "机房/云", "商业/机构", "移动", "", "未知"][k]} ${(100 * covered[k] / grand).toFixed(1)}%`).join("  "));

/* ------------------------------ 可选：对拍实测数据 ------------------------------ */
if (process.argv.includes("--eval")) {
  const lines = readFileSync(join(root, "build", "prefixmap-all.csv"), "utf8").split(/\r?\n/);
  const head = lines[0].split(",").map((s) => s.replace(/"/g, ""));
  const C_AS = head.indexOf("as"), C_CAT = head.indexOf("Cat");
  /* 与 tools/make-data.ps1 完全一致的类别映射 */
  const CATMAP = { ISP: 1, DC: 2, DCENT: 3, MOBILE: 4, UNK: 6 };
  const findAsn = (ip) => {
    let lo = 0, hi = N - 1, best = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (startArr[mid] <= ip) { best = mid; lo = mid + 1; } else { hi = mid - 1; } }
    if (best < 0) { return -1; }
    return asnList[idxArr[best]];
  };
  let hit = 0, total = 0, ispHit = 0, ispTotal = 0, dceHit = 0, dceTotal = 0, unknown = 0;
  const conf = {};
  for (const row of lines.slice(1)) {
    if (!row.trim()) { continue; }
    const c = row.match(/"[^"]*"|[^,]+/g).map((s) => s.replace(/^"|"$/g, ""));
    const cat = CATMAP[c[C_CAT]];
    const asn = Number(String(c[C_AS] || "").replace(/^AS(\d+).*/, "$1"));
    if (!cat || !asn) { continue; }
    const i = asnIndex.get(asn);
    if (i === undefined) { continue; }
    total++;
    const ours = asnType[i];
    if (ours === cat) { hit++; }
    else { conf[c[C_CAT] + "→" + ours] = (conf[c[C_CAT] + "→" + ours] || 0) + 1; }
    if (cat === 1) { ispTotal++; if (ours === 1) { ispHit++; } }
    if (cat === 2) { dceTotal++; if (ours === 2) { dceHit++; } }
    if (ours === 6) { unknown++; }
  }
  console.log(`\n对拍 ip-api 实测记录（${total} 个 /24）：类型完全一致 ${hit} (${(100 * hit / total).toFixed(1)}%)`);
  console.log(`住宅段召回 ${ispHit}/${ispTotal} = ${(100 * ispHit / (ispTotal || 1)).toFixed(1)}%   ` +
              `机房段召回 ${dceHit}/${dceTotal} = ${(100 * dceHit / (dceTotal || 1)).toFixed(1)}%   ` +
              `我方判未知 ${unknown} (${(100 * unknown / (total || 1)).toFixed(1)}%)`);
  console.log("主要分歧：" + Object.entries(conf).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k}×${v}`).join("  "));

  /* 真正决定 A/B/C/D 分级的是“住宅 / 非住宅”这个二分类，单独算一遍 */
  let tp = 0, fp = 0, fn = 0, tn = 0;
  const perPrefix = new Map();
  for (const row of lines.slice(1)) {
    if (!row.trim()) { continue; }
    const c = row.match(/"[^"]*"|[^,]+/g).map((s) => s.replace(/^"|"$/g, ""));
    const cat = CATMAP[c[C_CAT]];
    const asn = Number(String(c[C_AS] || "").replace(/^AS(\d+).*/, "$1"));
    if (!cat || !asn) { continue; }
    const i = asnIndex.get(asn);
    if (i === undefined) { continue; }
    const ours = asnType[i] === 1;
    const truth = cat === 1;
    if (ours && truth) { tp++; } else if (ours && !truth) { fp++; }
    else if (!ours && truth) { fn++; } else { tn++; }
    const k = c[head.indexOf("prefix")];
    const g = perPrefix.get(k) || { o: 0, t: 0, n: 0 };
    g.o += ours ? 1 : 0; g.t += truth ? 1 : 0; g.n++;
    perPrefix.set(k, g);
  }
  const tier = (isp, n) => (isp >= n * 0.586 ? "A" : isp >= n * 0.234 ? "B" : isp >= n * 0.078 ? "C" : "D");
  console.log(`\n住宅 vs 非住宅：准确率 ${(100 * (tp + tn) / (tp + fp + fn + tn)).toFixed(1)}%  ` +
    `精确率 ${(100 * tp / (tp + fp || 1)).toFixed(1)}%  召回率 ${(100 * tp / (tp + fn || 1)).toFixed(1)}%  ` +
    `（TP ${tp} FP ${fp} FN ${fn} TN ${tn}）`);
  console.log("\n按前缀对级别（只在实测记录过的前缀上；阈值按相同比例折算）：");
  for (const [k, g] of [...perPrefix.entries()].sort()) {
    const t = tier(g.t, g.n), o = tier(g.o, g.n);
    console.log(`  ${k.padEnd(12)} 实测记录 ${String(g.t).padStart(3)}/${g.n} → ${t} 级 ｜ 全量包 ${String(g.o).padStart(3)}/${g.n} → ${o} 级  ${t === o ? "" : "  ← 不一致"}`);
  }

  /* 分歧集中在哪几个 ASN？按在实测记录集里覆盖的 /24 数量排序 */
  const perAsn = new Map();
  for (const row of lines.slice(1)) {
    if (!row.trim()) { continue; }
    const c = row.match(/"[^"]*"|[^,]+/g).map((s) => s.replace(/^"|"$/g, ""));
    const cat = CATMAP[c[C_CAT]];
    const asn = Number(String(c[C_AS] || "").replace(/^AS(\d+).*/, "$1"));
    if (!cat || !asn) { continue; }
    const i = asnIndex.get(asn);
    if (i === undefined) { continue; }
    const g = perAsn.get(asn) || { org: 0, ours: asnType[i], truth: {}, name: meta.get(asn).name, n: 0 };
    g.n++;
    g.org += cat === 1 ? 1 : 0;
    g.truth[cat] = (g.truth[cat] || 0) + 1;
    perAsn.set(asn, g);
  }
  const wrong = [...perAsn.entries()]
    .filter(([, g]) => (g.org > 0) !== (g.ours === 1) || ((g.truth[1] || 0) !== g.n && g.truth[1]))
    .sort((a, b) => b[1].n - a[1].n).slice(0, 18);
  console.log("\n覆盖量最大的分歧 ASN（实测记录判为住宅 / 我们判了别的，或反之）：");
  for (const [asn, g] of wrong) {
    const truthCat = Object.entries(g.truth).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join(" ");
    console.log(`  AS${String(asn).padEnd(7)} 我们=${g.ours} 实测记录=${truthCat.padEnd(16)} /24 数 ${String(g.n).padStart(3)}  ${g.name.slice(0, 46)}`);
  }
}
