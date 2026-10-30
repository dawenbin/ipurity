/* 用真实粘贴样例验证清洗 + 判定链路（node test/test-inline.mjs）
 *
 * UPDATE_EXPECT=1 node test/test-inline.mjs —— 把「各级行数冻结」重算一遍写回下面的 fixtures 表。
 *   只给数据刷新工作流用（refresh-segments.yml）：实测层按月自动换数据，行数会跟着动，
 *   这时硬失败只会变成每月一次的人工改数。写回之后提交里能看见「这次哪一级挪了几行」，
 *   判定口径 / 解析层的改动仍然得自己改，别拿这个开关糊过去。 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const UPDATE_EXPECT = process.env.UPDATE_EXPECT === "1";
const updates = [];

const Core = require("../assets/core.js");
const data = JSON.parse(readFileSync(new URL("../data/segments-data.json", import.meta.url), "utf8"));

let fail = 0;
function check(name, cond, extra) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  if (!cond) { fail++; }
}

const fixtures = [
  { file: "pasted-list-1.txt", expectItems: 200, expectCities: {} },
  { file: "pasted-list-2.txt", expectItems: 200, expectCities: { "Los Angeles": 200 } },
  { file: "pasted-list-3.md",  expectItems: 10,  expectCities: { "San Jose": 6, "Los Angeles": 3, "San Francisco": 1 } },
  /* 脏格式混排：全角 / ? 和 x 打码 / \. 转义 / 加粗 / 表格 / 端口 / CIDR / 保留地址。
     保留地址一律照样收下（是不是公网由判定那一层说，解析层不偷偷丢行）。 */
  { file: "pasted-list-4.txt", expectItems: 35, expectUnmatched: 1, expectDuplicates: 1 },
  /* 供应商清单：加粗 IP 紧贴着运营商名，每行一个 —— 解析层最容易整段丢掉的一类 */
  { file: "pasted-list-5.txt", expectItems: 48, expectUnmatched: 0, expectDuplicates: 0,
    expectCounts: { A: 10, B: 9, C: 9, D: 11, X: 9, fail: 0 } }
];

for (const f of fixtures) {
  const p = new URL(`./fixtures/${f.file}`, import.meta.url);
  if (!existsSync(p)) { console.log(`SKIP  ${f.file} 不存在`); continue; }
  const text = readFileSync(p, "utf8");
  const rep = Core.parseWithReport(text);
  console.log(`\n--- ${f.file}: 行 ${rep.lineCount} / 识别 ${rep.items.length} / 重复 ${rep.duplicateCount} / 未识别 ${rep.unmatched.length}`);
  check(`${f.file} 识别条数`, rep.items.length === f.expectItems, `期望 ${f.expectItems} 实得 ${rep.items.length}`);
  if (f.expectUnmatched !== undefined) {
    check(`${f.file} 未识别行数`, rep.unmatched.length === f.expectUnmatched,
      `期望 ${f.expectUnmatched} 实得 ${rep.unmatched.length}` +
      (rep.unmatched.length ? "：" + rep.unmatched.slice(0, 3).map(u => u.line + ":" + u.text).join(" | ") : ""));
  }
  if (f.expectDuplicates !== undefined) {
    check(`${f.file} 重复行只算一条`, rep.duplicateCount === f.expectDuplicates,
      `期望 ${f.expectDuplicates} 实得 ${rep.duplicateCount}`);
  }
  if (f.expectUnmatched === undefined) {
    check(`${f.file} 无未识别行`, rep.unmatched.length === 0, rep.unmatched.slice(0, 3).map(u => u.line + ":" + u.text).join(" | "));
  }
  const bad = rep.items.filter(it => !Core.isValidPattern(it.pattern));
  check(`${f.file} 全部 token 合法`, bad.length === 0, bad.slice(0, 3).map(b => b.pattern).join(","));
  /* 清单里的国家/城市列一律丢弃：解析结果里不该有城市标注这种字段 */
  const hinted = rep.items.filter(it => "cityHint" in it || "wantCity" in it);
  check(`${f.file} 只取 IP 列（丢国家/城市/操作列）`, hinted.length === 0, `${hinted.length} 行带了标注`);
  const res = Core.analyzeMany(rep.items, data);
  const known = res.rows.filter(r => r.ok).length;
  console.log(`      判定：A=${res.counts.A} B=${res.counts.B} C=${res.counts.C} D=${res.counts.D} 未识别=${res.counts.fail}  (有数据 ${known}/${rep.items.length})`);
  if (f.file === "pasted-list-1.txt") {
    check("列表1 A 级 = 5 行", res.counts.A === 5, `实得 ${res.counts.A}`);
    check("列表1 全部命中数据包", res.counts.fail === 0, `未命中 ${res.counts.fail}`);
  }
  if (f.file === "pasted-list-2.txt") {
    check("列表2 全部命中数据包", res.counts.fail === 0, `未命中 ${res.counts.fail}`);
  }
  if (f.expectCounts) {
    /* 整包冻结各级行数：解析、判定、数据包任一层动了都在这儿现形 */
    const got = { A: res.counts.A, B: res.counts.B, C: res.counts.C, D: res.counts.D, X: res.counts.X, fail: res.counts.fail };
    const want = Object.assign({ A: 0, B: 0, C: 0, D: 0, X: 0, fail: 0 }, f.expectCounts);
    const same = Object.keys(want).every((k) => want[k] === got[k]);
    if (!same && UPDATE_EXPECT) {
      updates.push({ file: f.file, got });
      console.log(`UPDATE  ${f.file} 各级行数 ${JSON.stringify(want)} → ${JSON.stringify(got)}`);
    } else {
      check(`${f.file} 各级行数冻结`, same, `期望 ${JSON.stringify(want)} 实得 ${JSON.stringify(got)}`);
    }
  }
}

/* 把新的行数写回本文件（正则按 file 名定位那一条 fixture，别碰别处） */
if (updates.length) {
  const self = fileURLToPath(import.meta.url);
  let src = readFileSync(self, "utf8");
  for (const u of updates) {
    const re = new RegExp(
      `(\\{ file: "${u.file}"[\\s\\S]*?expectCounts: )\\{ A: \\d+, B: \\d+, C: \\d+, D: \\d+, X: \\d+, fail: \\d+ \\}`,
    );
    if (!re.test(src)) { console.log(`WARN  ${u.file} 的 expectCounts 没找到，没写回`); continue; }
    src = src.replace(re, `$1{ A: ${u.got.A}, B: ${u.got.B}, C: ${u.got.C}, D: ${u.got.D}, X: ${u.got.X}, fail: ${u.got.fail} }`);
  }
  writeFileSync(self, src);
  console.log(`\n已把 ${updates.length} 处冻结行数写回 test/test-inline.mjs`);
}

/* 定向用例 */
console.log("\n--- 定向用例");
const t1 = Core.parseWithReport("| 1 | 38.\\*.239.3 | 美国 | 加州圣何塞 | 提取 |\n");
check("Markdown 转义 \\* 还原", t1.items[0] && t1.items[0].pattern === "38.*.239.3", JSON.stringify(t1.items[0] || {}));
check("清单里的城市列不进解析结果", t1.items[0] && !("cityHint" in t1.items[0]), JSON.stringify(t1.items[0] || {}));

const t2 = Core.parseWithReport("7\t198.*.42.81\t美国\t洛杉矶\t提取\n");
check("表格行号不被误当 IP 段", t2.items.length === 1 && t2.items[0].pattern === "198.*.42.81", t2.items.map(i => i.pattern).join(","));

const t3 = Core.parseWithReport("198.3.242.0/24\n");
check("CIDR 展开为 /24 模式", t3.items.length === 1 && t3.items[0].pattern === "198.3.242.*", t3.items.map(i => i.pattern).join(","));

/* CIDR 的粒度统一到 /24：一段 CIDR 展开成它覆盖的那些 /24，不做 o3 进位那种错算 */
const c23 = Core.parseWithReport("198.3.242.0/23").items.map(i => i.pattern);
check("/23 展开成 2 个 /24（同 o2、o3 +1）", c23.join(",") === "198.3.242.*,198.3.243.*", c23.join(","));
const c16 = Core.parseWithReport("198.3.0.0/16").items.map(i => i.pattern);
check("/16 展开成 256 个 /24（o2 不动，o3 走满）",
  c16.length === 256 && c16[0] === "198.3.0.*" && c16[255] === "198.3.255.*", `${c16.length} 个 ${c16[0]}…${c16[255]}`);
const c20 = Core.parseWithReport("198.3.0.0/20").items.map(i => i.pattern);
check("/20 展开成 16 个 /24", c20.length === 16 && c20[15] === "198.3.15.*", `${c20.length} 个 ${c20[15]}`);
const c30 = Core.parseWithReport("198.3.242.16/30").items.map(i => i.pattern);
check("比 /24 更长的 CIDR 落在同一个 /24 里（1 个）", c30.join(",") === "198.3.242.*", c30.join(","));
const c15 = Core.parseWithReport("198.3.242.0/15");
check("小于 /16 的 CIDR 报「暂不支持」而不是静默丢掉", c15.items.length === 0 && c15.unmatched.length === 1,
  `items=${c15.items.length} unmatched=${c15.unmatched.length}`);

const t4 = Core.parseWithReport("64 . *.180 . 53\n");
check("空格分隔四段可清洗", t4.items.length === 1 && t4.items[0].pattern === "64.*.180.53", t4.items.map(i => i.pattern).join(","));

const t5 = Core.parseWithReport("198.x.42.81\n198.?.42.81\n");
check("x / ? 打码位可清洗", t5.items.length === 1 && t5.items[0].pattern === "198.*.42.81", t5.items.map(i => i.pattern).join(","));

/* ---------- 脏格式：全角 / 转义 / 加粗 / 端口 —— 都是真实粘贴里会出现的写法 ---------- */
const dirty = [
  ["１９８．＊．205.197", "198.*.205.197", "全角数字与全角星号"],
  ["198\\.*.43.186",        "198.*.43.186",  "Markdown 转义的 \\*"],
  ["198.\\*.43.186:8080",   "198.*.43.186",  "带端口要剥掉"],
  ["**198.*.21.63**",       "198.*.21.63",   "加粗包着（两个星号）"],
  ["*198.*.184.120*",       "198.*.184.120", "斜体包着（一个星号）"],
  ["198.**.42.81",          "198.*.42.81",   "野写法：两个以上星号折成一个"],
  ["`198.*.13.200`",        "198.*.13.200",  "反引号包着"],
  ['"198.*.70.111"',        "198.*.70.111",  "英文引号包着"],
  ["198.*.43.222 （美国 洛杉矶）", "198.*.43.222", "IP 后面跟着全角括号备注"],
  ["198.*.243.58\t美国\t洛杉矶\t提取", "198.*.243.58", "表格制表符分隔"]
];
for (const [input, want, why] of dirty) {
  const got = Core.parseWithReport(input + "\n");
  check(why, got.items.length === 1 && got.items[0].pattern === want,
    `期望 ${want} 实得 ${got.items.map(i => i.pattern).join(",") || "(没识别)"}`);
}

/* 加粗 IP 紧贴着运营商名 —— 整段清单最容易被丢掉的一类（实测 48 行曾只认出 2 行） */
const bold = Core.parseWithReport("**111.169.14.1**BIGLOBE BIGLOBE Inc.\n**198.185.203.7**NTT America, Inc.\n");
check("加粗 IP 紧贴运营商名也能认出来", bold.items.length === 2 &&
  bold.items[0].pattern === "111.169.14.1" && bold.items[1].pattern === "198.185.203.7",
  bold.items.map(i => i.pattern).join(",") || "(没识别)");
check("被加粗包着的行没有整行吞掉", bold.items.length === 0 || bold.items.every(i => !i.pattern.includes("Inc")),
  bold.items.map(i => i.pattern).join(","));
/* 只在 token 以 * 开头时才认加粗 —— 免得把普通文字里的数字抓成 IP */
const plainText = Core.parseWithReport("价格 1.2.3.4 美元\n共 198.3.242.16 条\n");
check("普通文字里的 IP 照样认（加粗规则不掺和）", plainText.items.length === 2,
  plainText.items.map(i => i.pattern).join(",") || "(没识别)");
check("认出来的是 IP，不是被加粗规则截出来的半截", plainText.items.map(i => i.pattern).join(",") === "1.2.3.4,198.3.242.16",
  plainText.items.map(i => i.pattern).join(","));

/* 一行里摆好几个 IP：**收几个出几行**。只认第一个会让后面那些无声无息地消失
   （真实踩过：10 个 IP 粘成 4 行，结果只出 2 行）。斜杠、逗号、空格、竖线都是分隔符。 */
const multi = [
  ["10.0.0.1 / 127.0.0.1 / 192.168.1.1", "10.0.0.1,127.0.0.1,192.168.1.1", "斜杠分隔"],
  ["8.8.8.8, 1.1.1.1, 73.45.128.9", "8.8.8.8,1.1.1.1,73.45.128.9", "逗号分隔"],
  ["198.*.42.81 82.24.73.*", "198.*.42.81,82.24.73.*", "空格分隔（打码行也要全收）"],
  ["8.8.8.8 | 1.1.1.1", "8.8.8.8,1.1.1.1", "竖线分隔"],
  ["10.0.0.1 / 10.0.0.1 / 10.0.0.1", "10.0.0.1", "同一行重复只算一条"]
];
for (const [input, want, why] of multi) {
  const got = Core.parseWithReport(input + "\n");
  check(`一行多个 IP：${why}`, got.items.map(i => i.pattern).join(",") === want,
    `期望 ${want} 实得 ${got.items.map(i => i.pattern).join(",") || "(没识别)"}`);
}
/* 分隔用的斜杠不能把 CIDR 的斜杠也切了 —— 这条判据最容易写错 */
const cidr2 = Core.parseWithReport("198.3.242.0/24\n10.0.0.1 / 192.168.1.1\n");
check("斜杠既是 CIDR 也是分隔符，两边都不能错",
  cidr2.items.map(i => i.pattern).join(",") === "198.3.242.*,10.0.0.1,192.168.1.1",
  cidr2.items.map(i => i.pattern).join(","));
check("行尾那个分隔用的斜杠不影响前面", Core.parseWithReport("8.8.8.8 / 1.1.1.1 /\n").items.length === 2,
  Core.parseWithReport("8.8.8.8 / 1.1.1.1 /\n").items.map(i => i.pattern).join(","));

const nl = Core.parseWithReport("**111.169.14.1**BIGLOBE Inc.\n**111.169.14.2**BIGLOBE Inc.\n**111.169.14.3**BIGLOBE Inc.\n");
check("行尾带点的运营商名不会与下一行粘连", nl.items.length === 3,
  `${nl.items.length} 条：` + nl.items.map(i => i.pattern).join(","));
check("三行三行都在，一条不少", nl.items.map(i => i.pattern).join(",") === "111.169.14.1,111.169.14.2,111.169.14.3",
  nl.items.map(i => i.pattern).join(","));

/* 保留地址 / 界面噪声：解析层一律照收或明确丢弃，绝不凭空造出一个 IP */
const reserved = Core.parseWithReport("10.0.0.1\n192.168.1.1\n127.0.0.1\n169.254.1.1\n0.0.0.0\n255.255.255.255\n224.1.1.1\n");
check("保留地址照样收下（不做静默丢弃）", reserved.items.length === 7,
  reserved.items.map(i => i.pattern).join(","));
check("保留地址不落进未识别", reserved.unmatched.length === 0,
  reserved.unmatched.map(u => u.text).join(" | "));
/* 界面噪声：IPv6 / 域名 / 数不清的空白行一律不当成 IPv4；只有「像 IP 但多了一段」
   这种最像的才记进未识别（4 段以上是用户真想贴的东西，静默丢掉最伤人），
   完全不像 IP 的界面文案直接丢，免得未识别列表被噪声淹没。 */
const noise = Core.parseWithReport("2001:db8::1\nexample.com\n已选 0 条数据：\n1.2.3.4.5\n");
check("IPv6 / 域名 / 界面文案都不当成 IPv4", noise.items.length === 0,
  noise.items.map(i => i.pattern).join(","));
check("4 段以上（最像 IP 的噪声）记进未识别，不静默消失", noise.unmatched.length === 1 && noise.unmatched[0].line === 4,
  noise.unmatched.map(u => u.line + ":" + u.text).join(" | ") || "(无)");

/* ---------- 不可路由：一条规则 —— 公网没人宣告（IP 归属表记成 AS0 / Not routed） ----------
   私有段、环回、链路本地、CGNAT、文档段、组播全都落在这一条上，它们不是「住宅占比低」，
   是这个问题对它没意义。判定层直接说不可路由，不参与排名与得分。 */
{
  const W = require("../assets/sources.js");
  W.putPack(readFileSync(new URL("../data/global-pack.bin", import.meta.url)));
  W.setMeta(JSON.parse(readFileSync(new URL("../data/global-asn.js", import.meta.url), "utf8")
    .match(/window\.GLOBAL_ASN\s*=\s*([\s\S]*?);?\s*$/)[1]));
  const cal = readFileSync(new URL("../data/asn-calib.js", import.meta.url), "utf8")
    .match(/window\.ASN_CALIB\s*=\s*([\s\S]*?);?\s*$/);
  if (cal) { W.setCalib(JSON.parse(cal[1])); }

  const mk = (ips) => Core.analyzeMany(ips.map((p, i) => ({ index: i + 1, sourceLine: i + 1, raw: p, pattern: p })),
    null, { world: W }).rows;

  /* 该判不可路由的：私有 / 环回 / 链路本地 / CGNAT / 未分配 / 文档段 / 组播 */
  const notRouted = ["10.0.0.1", "172.16.0.1", "192.168.1.1", "127.0.0.1", "169.254.1.1",
    "100.64.1.1", "0.0.0.0", "224.1.1.1", "192.0.2.5", "198.51.100.7", "203.0.113.9", "198.18.0.1"];
  const nr = mk(notRouted);
  const bad = nr.filter(r => r.ok || !r.reserved);
  check("没人宣告的地址一律判不可路由（12 个）", bad.length === 0,
    bad.map(r => r.pattern + " ok=" + r.ok + " reserved=" + r.reserved).join(" | ") || "全部命中");
  check("不可路由不给级别、不给占比",
    nr.every(r => !r.ok && !r.tier && Core.homeTxt(r) === "不可路由"),
    nr.map(r => r.pattern + ":" + Core.homeTxt(r)).join(" "));
  check("不可路由的得分是 0（不参与得分）", nr.every(r => Core.rowScore(r) === 0),
    nr.slice(0, 3).map(r => Core.rowScore(r)).join(","));

  /* 真地址一个都不能误伤 —— 这条规则最容易伤到的就是「像保留但其实是真的」 */
  const routed = ["8.8.8.8", "1.1.1.1", "73.45.128.9", "198.3.243.16", "198.*.42.81", "82.24.73.*"];
  const ro = mk(routed);
  const wrong = ro.filter(r => !r.ok || r.reserved);
  check("真地址不会被判成不可路由", wrong.length === 0,
    wrong.map(r => r.pattern + ":" + r.reason).join(" | ") || ro.map(r => r.pattern + "=" + r.tier).join(" "));

  /* 排名与统计：不可路由只占「未识别/缺数据」那一格，不进 A/B/C/D */
  const all = Core.rankRows(mk(notRouted.concat(routed)));
  const counts = Core.countRows(all);
  check("不可路由不计入 A/B/C/D 任何一档",
    counts.A + counts.B + counts.C + counts.D === ro.filter(r => r.ok).length,
    JSON.stringify(counts));
  check("不可路由算进「未识别/缺数据」，数字才对得上总数",
    counts.fail === notRouted.length && Object.values(counts).reduce((a, b) => a + b, 0) === all.length,
    `fail=${counts.fail} 合计=${Object.values(counts).reduce((a, b) => a + b, 0)} 总行=${all.length}`);
  check("不可路由排在最末（不占推荐位）",
    all.slice(-notRouted.length).every(r => r.reserved),
    all.slice(-4).map(r => r.rank + ":" + r.pattern).join(" "));

  /* 走整条判定链（analyzeItem）再看一次：真的 IP 不会被误判成不可路由 */
  const viaItem = (p) => Core.analyzeItem({ index: 1, sourceLine: 1, raw: p, pattern: p }, null, { world: W });
  check("单个私有地址走完判定链同样判不可路由", (() => {
    const r = viaItem("10.1.2.3");
    return !r.ok && r.reserved === true && r.reason === "不可路由";
  })(), viaItem("10.1.2.3").reason);
  check("单个公网地址走完判定链照常判出级别", (() => {
    const r = viaItem("73.45.128.9");
    return r.ok && !r.reserved && r.tier === "A";
  })(), viaItem("73.45.128.9").tier + " " + viaItem("73.45.128.9").tierText);

  /* 「这一行是估算还是实测」只由「来源」列一个信号传达：approx ⟺ source="全球ASN"。
     以前级别列还挂一个「估算」徽标，那是同一件事说两遍（已删）。两条路各三个入口，
     这里把六个入口的组合都钉住 —— 一旦哪个入口漏设 source，来源列就会把估算行
     写成「实测记录」，那是最难发现的一类错。 */
  const combos = [
    ["实测打码", Core.analyze("198.*.42.81", data), false, "实测记录"],
    ["实测单 IP", Core.analyze("198.3.243.16", data), false, "实测记录"],
    ["实测第 4 段打码", Core.analyze("198.3.242.*", data), false, "实测记录"],
    ["归属表打码", Core.analyzeGlobal("50.*.54.100", { world: W }), true, "IP 归属表"],
    ["归属表单 IP", Core.analyzeGlobal("73.45.128.9", { world: W }), true, "IP 归属表"],
    ["归属表第 4 段打码", Core.analyzeGlobal("82.24.73.*", { world: W }), true, "IP 归属表"]
  ];
  const mism = combos.filter(([, r, isEst, shown]) => {
    const name = r.source === "全球ASN" ? "IP 归属表" : (r.source || "实测记录");
    return r.ok && (!!r.approx !== isEst || name !== shown);
  });
  check("估算 ⟺ 来源列写「IP 归属表」（两条路六个入口都对齐）", mism.length === 0,
    mism.map(([n]) => n).join(" | ") || combos.map(([n, r]) => n + "=" + (r.approx ? "估算" : "实测")).join(" "));
  /* 未评级：只有运营商关键词类型、一个标定样本都没有 → 不给级别、不给得分、不进推荐。
     判据是「这个 ASN 有没有够用的标定样本」（world.calibrated），不是「像不像住宅」。
     第三个样例是扫出来的，不是手挑的 —— 哪些 /8 已经被宣告、哪些没被宣告是外部事实，
     写死在测试里迟早过期（13.* / 2.* 这些段就没被宣告）。 */
  const un = mk(["171.213.132.*", "1.1.70.*", "50.*.54.100", "198.3.1.*"]);
  let picked = null;
  for (let o1 = 1; o1 <= 60 && !picked; o1++) {
    for (let o3 = 0; o3 < 256 && !picked; o3 += 7) {
      const pat = `${o1}.1.${o3}.*`;
      if (un.some(r => r.pattern === pat)) { continue; }
      const r = mk([pat])[0];
      if (r.ok && r.ungraded && r.counts[Core.topCat(r)] > 0) { picked = r; }
    }
  }
  check("扫得出一行「未评级且类别计数非零」的行（给下面几条用）", !!picked,
    picked ? picked.pattern + " topCat=" + Core.topCat(picked) + "×" + picked.counts[Core.topCat(picked)] : "(没扫到)");
  if (picked) { un.push(picked); }
  const ungraded = un.filter(r => r.ungraded);
  check("没有标定样本的行判为未评级", ungraded.length === 3,
    un.map(r => r.pattern + "=" + (r.ungraded ? "未评级" : (r.reserved ? "不可路由" : (r.tier || "?")))).join(" "));
  check("未评级：没有级别、没有得分、tier 为空",
    ungraded.every(r => !r.tier && !r.tierText && Core.rowScore(r) === 0),
    ungraded.map(r => r.pattern + " tier=" + JSON.stringify(r.tier) + " score=" + Core.rowScore(r)).join(" | "));
  check("未评级：住宅那格写类别，不写占比",
    ungraded.every(r => /^按类型先验 · \S+$/.test(Core.homeTxt(r)) && !/%/.test(Core.homeTxt(r))),
    ungraded.map(r => Core.homeTxt(r)).join(" | "));
  /* counts[1] 对先验行是按概率折算后**改写过**的（229/254 那种），所以不能拿它去凑样本数；
     能保证的是「类别这一列是真数出来的」—— 类别名取得到，且它落在真实类别里。 */
  check("未评级仍保留类别计数（类别那一列是真数出来的）",
    ungraded.every(r => [1, 2, 3, 4, 6].indexOf(Core.topCat(r)) >= 0 && r.counts[Core.topCat(r)] > 0),
    ungraded.map(r => r.pattern + " topCat=" + Core.topCat(r) + "(" + Core.CAT_NAME[Core.topCat(r)] + ")×" + r.counts[Core.topCat(r)]).join(" | "));
  /* 有标定样本的行不能被误判成未评级。注意 D 级行的得分本来就是 0（级别奖励 0），
     所以这里只断言「有级别」，别把 0 分当成异常。 */
  const kept = un.filter(r => !r.ungraded);
  check("有标定样本的行照常评级（D 级得分本就可能是 0，不算异常）",
    kept.every(r => !!r.tier && r.tierText),
    kept.map(r => r.pattern + "=" + r.tier + "/" + Core.rowScore(r)).join(" "));
  /* 单 IP 走的是另一条路（类别比密度可信），不受未评级影响 */
  check("单个 IP 不受未评级影响", (() => {
    const s = Core.analyzeItem({ index: 1, sourceLine: 1, raw: "73.45.128.9", pattern: "73.45.128.9" }, data, { world: W });
    return s.ok && !s.ungraded && s.tier === "A" && /^单个 IP · /.test(Core.homeTxt(s));
  })(), Core.homeTxt(Core.analyzeItem({ index: 1, sourceLine: 1, raw: "73.45.128.9", pattern: "73.45.128.9" }, data, { world: W })));
  /* 统计条不该冒出空字符串这种键，未评级算进「未识别/缺数据」 */
  const cnt = Core.countRows(un);
  check("未评级算进「未识别/缺数据」，统计条不冒出空键",
    cnt.fail === ungraded.length && !("" in cnt) && cnt.A + cnt.B + cnt.C + cnt.D + cnt.fail === un.length,
    JSON.stringify(cnt));
  /* 排名：未评级排在所有有级别的行之后 */
  const unRanked = Core.rankRows(un);
  const firstUngraded = unRanked.findIndex(r => r.ungraded);
  check("未评级排在有级别的行之后",
    firstUngraded < 0 || unRanked.slice(firstUngraded).every(r => r.ungraded || !r.tier),
    unRanked.map(r => r.pattern + "(" + (r.tier || "未评级") + ")").join(" "));
  /* 导出：不按级别筛时，粘了几行就导出几行（未评级/不可路由也在，格子留空） */
  const allCsv = Core.toCsv(unRanked, null, 3).split("\n");
  check("导出不按级别筛时，粘几行出几行", allCsv.length - 1 === un.length, `导出 ${allCsv.length - 1} / 共 ${un.length}`);
  const unLine = allCsv.find(l => l.indexOf(ungraded[0].pattern) >= 0);
  check("未评级行的得分列留空（不是 0）", !!unLine && unLine.split(",")[7] === "",
    unLine ? JSON.stringify(unLine.split(",").slice(0, 8)) : "(没找到)");
  check("按级别筛时未评级行不出现",
    !ungraded.some(r => Core.toCsv(unRanked, ["A", "B"], 3).indexOf(r.pattern) >= 0),
    Core.toCsv(unRanked, ["A", "B"], 3).split("\n").map(l => l.split(",")[1]).join(" "));
}

const t6 = Core.analyze("50.*.54.100", data);
const t7 = Core.analyze("50.*.54.100", data, { city: "San Jose", wantCity: "Los Angeles" });
check("判定只认 IP：多余的标注参数不改变结果", t6.tier === t7.tier && t6.pctIsp === t7.pctIsp,
  `${t6.tier} ${t6.pctIsp}% vs ${t7.tier} ${t7.pctIsp}%`);

/* 带国家/城市列和只贴 IP，整行结论必须一模一样 */
const withCols = Core.analyzeMany(Core.parseWithReport("1\t198.*.205.197\t美国\t洛杉矶").items, data).rows[0];
const onlyIp = Core.analyzeMany(Core.parseWithReport("198.*.205.197").items, data).rows[0];
check("带/不带国家城市列，判定与城市解析完全一致",
  withCols.tier === onlyIp.tier && withCols.score === onlyIp.score &&
  JSON.stringify(withCols.city) === JSON.stringify(onlyIp.city),
  `${withCols.tier}/${withCols.score} vs ${onlyIp.tier}/${onlyIp.score}`);

/* 排名口径：一行 = 你粘贴的一行（带 *），不是枚举出来的具体 IP */
const rep1 = Core.parseWithReport(readFileSync(new URL("./fixtures/pasted-list-1.txt", import.meta.url), "utf8"));
const ranked1 = Core.rankRows(Core.analyzeMany(rep1.items, data).rows);
const aRows = ranked1.filter((r) => r.tier === "A");
check("排名连续 1..n", ranked1.every((r, i) => r.rank === i + 1), ranked1.slice(0, 3).map((r) => r.rank).join(","));
check("A 级排在最前", ranked1[0].tier === "A", ranked1[0].tier + " " + ranked1[0].pattern);
check("A 级内部按住宅占比降序", aRows.every((r, i) => i === 0 || aRows[i - 1].pctIsp >= r.pctIsp),
  aRows.map((r) => r.pctIsp + "%").join(" "));
check("每行都有得分", ranked1.every((r) => typeof r.score === "number" && r.score >= 0 && r.score <= 100),
  ranked1.slice(0, 3).map((r) => r.score).join(","));
check("行身份保持打码模式", ranked1[0].pattern.includes("*"), ranked1[0].pattern);
const csv1 = Core.toCsv(ranked1, ["A", "B"], 3);
const csvLines = csv1.split("\n");
/* 「建议拿哪个 IP」这个字段已经拿掉了：工具只看到 /24 这一层，
   挑不出「更该拿的那个」，给了就是假精确（详情面板第一格曾是它）。
   守一道门：接口不再暴露，导出的 CSV 里也不该再有这一列。 */
check("core 不再导出 takeIp / takeWhy", typeof Core.takeIp === "undefined" && typeof Core.takeWhy === "undefined",
  `${typeof Core.takeIp} / ${typeof Core.takeWhy}`);
check("排名表 CSV 没有「建议拿」这一列", !/建议拿/.test(csv1), csvLines[0]);
const abRows = ranked1.filter((r) => r.tier === "A" || r.tier === "B").length;
check("排名表 CSV 表头首列是“排名”", csvLines[0].split(",")[0] === "排名", csvLines[0].slice(0, 24));
check("排名表一行一个模式", csvLines.length === abRows + 1, `实得 ${csvLines.length - 1} 行 / 期望 ${abRows} 行`);
check("排名表保留带 * 的模式", csvLines.slice(1).every((l) => l.split(",")[1].includes("*")), csvLines[1].slice(0, 40));
const csvCand = Core.toCsvCandidates(ranked1, ["A", "B"], 25);
check("枚举明细行数多于排名表", csvCand.split("\n").length > csvLines.length,
  `${csvCand.split("\n").length - 1} vs ${csvLines.length - 1}`);

/* ---------- 第 4 段打码：按 /24 的 254 个可用地址（1–254）展开 ---------- */
{
  const p = Core.parseInput("82.24.73.*")[0];
  check("第 4 段打码能识别", !!p && p.pattern === "82.24.73.*", p && p.pattern);

  const r = Core.analyze("198.3.242.*", data, {});   // 实测记录里有 198.*.242
  check("第 4 段打码样本 = 254（跳过 .0/.255）", !!r.ok && r.sampled === 254 && r.hostRange === "1-254",
    r.ok ? `sampled=${r.sampled} hostRange=${r.hostRange}` : r.reason);
  /* 整行就是一整个网段 / 单个真实 IP：两种行都不再有「建议拿」这一格 */
  const rOne = Core.analyze("198.3.243.16", data, {});

  /* CIDR 写法应该跟第 4 段打码走同一条路 */
  const cidr = Core.parseInput("198.3.242.0/24")[0];
  const rc = Core.analyze(cidr.pattern, data, {});
  check("/24 的 CIDR 展开后也是 254 个主机样本", !!rc.ok && rc.sampled === 254,
    rc.ok ? `${cidr.pattern} → sampled=${rc.sampled}` : rc.reason);

  /* 第 2 段打码仍然是 256 个 /24 */
  const r2 = Core.analyze("198.*.205.197", data, {});
  check("第 2 段打码仍是 256 个 /24", !!r2.ok && r2.sampled === 256 && !r2.hostRange,
    r2.ok ? `sampled=${r2.sampled}` : r2.reason);

  /* IP 归属表同样按 1–254 */
  const World = require("../assets/sources.js");
  const packUrl = new URL("../data/global-pack.bin", import.meta.url);
  if (existsSync(packUrl)) {
    World.putPack(readFileSync(packUrl));
    World.setMeta(JSON.parse(readFileSync(new URL("../data/global-asn.js", import.meta.url), "utf8")
      .match(/window\.GLOBAL_ASN\s*=\s*([\s\S]*?);?\s*$/)[1]));
    const c = readFileSync(new URL("../data/asn-calib.js", import.meta.url), "utf8")
      .match(/window\.ASN_CALIB\s*=\s*([\s\S]*?);?\s*$/);
    if (c) { World.setCalib(JSON.parse(c[1])); }
    const g = Core.analyzeGlobal("82.24.73.*", { world: World });
    check("IP 归属表第 4 段打码样本 = 254", !!g.ok && g.sampled === 254 && g.source === "全球ASN",
      g.ok ? `sampled=${g.sampled} tier=${g.tier}` : g.reason);
    const g2 = Core.analyzeGlobal("82.*.73.5", { world: World });
    check("IP 归属表第 2 段打码样本 = 256", !!g2.ok && g2.sampled === 256,
      g2.ok ? `sampled=${g2.sampled}` : g2.reason);
  }
}

/* ---------- 「都会区标记」整套功能已删除，这里守门防止它悄悄回来 ----------
   删的原因：那个 +8 位只来自每个 /24 探的**一个**地址（scan-prefixes.ps1 用 x.1 探测），
   单点推整块；它却是排序键的第 4 位，实测 53 行里有 32 行的名次由它决定。
   没有依据让一个扫描副产品去决定「两行住宅质量相同」时谁排前面。 */
{
  check("数据包不再带 metro 元数据块", !("metro" in data), Object.keys(data).join(","));
  check("core 不再导出 METRO_BIT", typeof Core.METRO_BIT === "undefined", typeof Core.METRO_BIT);
  /* 类别码只剩 5 个值（1/2/3/4/6）：数据里不该再有第 4 位被置起来的格子 */
  const bits = new Set();
  Object.keys(data.prefixes).forEach((k) => data.prefixes[k].c.split(",").forEach((c) => bits.add(+c)));
  check("类别码只剩 1/2/3/4/6（没有 +8 残留）",
    [...bits].every((v) => [1, 2, 3, 4, 6].indexOf(v) >= 0), [...bits].sort((a, b) => a - b).join(","));
  check("数据包的 legend 也不再提 +8", !/\+8/.test(data.legend), data.legend);

  /* 结果对象和候选里都不该再有 metro 字段 */
  const rr = Core.analyze("198.*.42.81", data, {});
  check("判定结果不再带 metroCount", !("metroCount" in rr), Object.keys(rr).join(","));
  check("候选项不再带 metro 字段",
    rr.candidates.every((c) => !("metro" in c)), JSON.stringify(rr.candidates[0] || {}));
  check("host24 不再带 metro 字段", !("metro" in (rr.host24 || {})), JSON.stringify(rr.host24 || {}));
  check("候选排序只剩「城市 → IP」", (() => {
    const s = Core.sortCandidates(rr.candidates);
    return s.every((c, i) => i === 0 || s[i - 1].city < c.city || (s[i - 1].city === c.city && s[i - 1].ip <= c.ip));
  })(), Core.sortCandidates(rr.candidates).slice(0, 3).map((c) => c.ip).join(" "));
  /* 排名表 CSV / 枚举明细 CSV 都不该再有「都会区标记」列 */
  const ranked = Core.rankRows(Core.analyzeMany(
    Core.parseWithReport("198.*.42.81\n50.*.54.100").items, data).rows);
  check("排名表 CSV 没有都会区列", !/都会区/.test(Core.toCsv(ranked, null, 3)), Core.toCsv(ranked, null, 3).split("\n")[0]);
  check("枚举明细 CSV 没有都会区列",
    !/都会区/.test(Core.toCsvCandidates(ranked, null, 3)), Core.toCsvCandidates(ranked, null, 3).split("\n")[0]);
  check("CSV 里不再出现 ★", !/★/.test(Core.toCsv(ranked, null, 3) + Core.toCsvCandidates(ranked, null, 3)),
    "★ 只跟着标记功能存在");
}

console.log(fail === 0 ? "\n全部通过 ✅" : `\n${fail} 项失败 ❌`);
process.exit(fail === 0 ? 0 : 1);
