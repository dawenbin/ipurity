/* 用真实粘贴样例验证清洗 + 判定链路（node test/test-inline.mjs） */
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

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
  { file: "pasted-list-3.md",  expectItems: 10,  expectCities: { "San Jose": 6, "Los Angeles": 3, "San Francisco": 1 } }
];

for (const f of fixtures) {
  const p = new URL(`./fixtures/${f.file}`, import.meta.url);
  if (!existsSync(p)) { console.log(`SKIP  ${f.file} 不存在`); continue; }
  const text = readFileSync(p, "utf8");
  const rep = Core.parseWithReport(text);
  console.log(`\n--- ${f.file}: 行 ${rep.lineCount} / 识别 ${rep.items.length} / 重复 ${rep.duplicateCount} / 未识别 ${rep.unmatched.length}`);
  check(`${f.file} 识别条数`, rep.items.length === f.expectItems, `期望 ${f.expectItems} 实得 ${rep.items.length}`);
  check(`${f.file} 无未识别行`, rep.unmatched.length === 0, rep.unmatched.slice(0, 3).map(u => u.line + ":" + u.text).join(" | "));
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
check("建议拿的网络带 *", Core.maskedNetwork("198.*.42.81") === "198.*.42.0/24", Core.maskedNetwork("198.*.42.81"));
check("第 3 段打码的建议段也带 *", Core.maskedNetwork("198.42.*.81") === "198.42.*.0/24", Core.maskedNetwork("198.42.*.81"));

const csv1 = Core.toCsv(ranked1, ["A", "B"], 3);
const csvLines = csv1.split("\n");
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

  const r = Core.analyze("198.3.242.*", data, {});   // 实测样本里有 198.*.242
  check("第 4 段打码样本 = 254（跳过 .0/.255）", !!r.ok && r.sampled === 254 && r.hostRange === "1-254",
    r.ok ? `sampled=${r.sampled} hostRange=${r.hostRange}` : r.reason);
  check("建议拿的网络是标准 /24 写法", Core.maskedNetwork("82.24.73.*") === "82.24.73.0/24",
    Core.maskedNetwork("82.24.73.*"));

  /* CIDR 写法应该跟第 4 段打码走同一条路 */
  const cidr = Core.parseInput("198.3.242.0/24")[0];
  const rc = Core.analyze(cidr.pattern, data, {});
  check("/24 的 CIDR 展开后也是 254 个主机样本", !!rc.ok && rc.sampled === 254,
    rc.ok ? `${cidr.pattern} → sampled=${rc.sampled}` : rc.reason);

  /* 第 2 段打码仍然是 256 个 /24 */
  const r2 = Core.analyze("198.*.205.197", data, {});
  check("第 2 段打码仍是 256 个 /24", !!r2.ok && r2.sampled === 256 && !r2.hostRange,
    r2.ok ? `sampled=${r2.sampled}` : r2.reason);

  /* 全球段表同样按 1–254 */
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
    check("全球段表第 4 段打码样本 = 254", !!g.ok && g.sampled === 254 && g.source === "全球ASN",
      g.ok ? `sampled=${g.sampled} tier=${g.tier}` : g.reason);
    const g2 = Core.analyzeGlobal("82.*.73.5", { world: World });
    check("全球段表第 2 段打码样本 = 256", !!g2.ok && g2.sampled === 256,
      g2.ok ? `sampled=${g2.sampled}` : g2.reason);
  }
}

console.log(fail === 0 ? "\n全部通过 ✅" : `\n${fail} 项失败 ❌`);
process.exit(fail === 0 ? 0 : 1);
