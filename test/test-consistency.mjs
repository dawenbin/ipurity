/* 一致性自检：同一份事实在表格 / 详情 / 报告 / CSV 里必须是同一个说法。
   这里只断言「跨界面一致」和「不编数字」这类不变量，不重复各模块自己的单元测试。
   node test/test-consistency.mjs */
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

World.putPack(readFileSync(join(root, "data", "global-pack.bin")));
World.setMeta(grab("data/global-asn.js", "GLOBAL_ASN"));
World.setCalib(grab("data/asn-calib.js", "ASN_CALIB"));
const DATA = JSON.parse(readFileSync(join(root, "data", "segments-data.json"), "utf8"));
for (const o1 of [50, 82, 171, 198]) {
  CityPacks.put(o1, readFileSync(join(root, "data", "city", `${o1}.bin`)));
}

/* 一行一类：实测记录打码 / IP 归属表打码 / 实测记录单 IP / IP 归属表单 IP */
const patterns = [
  ["50.*.54.100", "Los Angeles", "实测记录打码"],
  ["171.213.132.*", "Los Angeles", "IP 归属表打码"],
  ["198.3.243.16", "Garland", "实测记录单 IP"],
  ["43.131.250.193", "Los Angeles", "IP 归属表单 IP"]
];
const rep = Core.parseWithReport(patterns.map((p, i) => `${i + 1}\t${p[0]}\t美国\t洛杉矶`).join("\n"));
const res = Core.analyzeMany(rep.items, DATA, { world: World, cityPack: CityPacks });
/* 页面是逐行分批算的（好让进度条动）：分批算出来的行与汇总必须和一口气算完一模一样 */
const oneByOne = rep.items.map((it) => Core.analyzeItem(it, DATA, { world: World, cityPack: CityPacks }));
check("分批算 == 一口气算（同一行结果逐字段一致）",
  JSON.stringify(oneByOne) === JSON.stringify(res.rows),
  `分批 ${oneByOne.length} 行 / 汇总 ${res.rows.length} 行`);
check("countRows 汇总 == analyzeMany 顺手给的汇总",
  JSON.stringify(Core.countRows(oneByOne)) === JSON.stringify(res.counts),
  JSON.stringify(Core.countRows(oneByOne)));
check("各级行数加起来 == 总行数",
  Object.values(Core.countRows(oneByOne)).reduce((a, b) => a + b, 0) === oneByOne.length,
  JSON.stringify(res.counts));

const rows = Core.rankRows(res.rows);
check("四行都判定成功", rows.every((r) => r.ok), rows.map((r) => r.pattern + (r.ok ? "" : ":" + r.reason)).join(" "));

/* ---------- 住宅那一格：四种形状，每种都自洽 ----------
   单个 IP            → `单个 IP · 类别`
   纯类型先验（打码行）→ `按类型先验 · 类别`   （那个百分数是常数，不能当占比写）
   [≈]N/M · P%        → 有实测或 ASN 标定样本支撑的占比
   注：前两种其实是同一件事（都写类别），形状本该统一成一个「来源形态 · 类别」。
       留着两种是技术债 —— 改它要同时动 3 条 i18n 词条和 4 条断言，等这批改动提交后再做。 */
for (const r of rows) {
  const txt = Core.homeTxt(r);
  if (r.singleHost) {
    /* 单个 IP 只写类别：不带 ≈，也不带「数/样本」那种形状 */
    check(`${r.pattern} 单个 IP 不写占比`, /^单个 IP · /.test(txt) && !txt.includes("≈") && !/\d+\s*\//.test(txt),
      txt);
    continue;
  }
  if (Core.priorOnly(r)) {
    /* 纯类型先验：一个标定样本都没有，百分比是常数 → 写类别，绝不写占比 */
    check(`${r.pattern} 纯先验行写类别、不写占比`,
      /^按类型先验 · \S+$/.test(txt) && !txt.includes("≈") && !/%/.test(txt), txt);
    continue;
  }
  const m = txt.match(/^(≈?)(\d+(?:\.\d+)?)\/(\d+) · (\d+)%$/);
  check(`${r.pattern} 住宅形状 [≈]N/M · P%`, !!m, txt);
  if (m) {
    check(`${r.pattern} 分母 == 样本数`, +m[3] === r.sampled, `${m[3]} vs ${r.sampled}`);
    check(`${r.pattern} 百分比 == pctIsp`, +m[4] === r.pctIsp, `${m[4]} vs ${r.pctIsp}`);
    check(`${r.pattern} ≈ 只出现在概率加权的行上`, (m[1] === "≈") === !!r.probOnly, `≈=${!!m[1]} probOnly=${!!r.probOnly}`);
  }
}
/* 先验行的百分比在数据层还在（排序要用），只是不上屏 —— 这一点得钉住 */
check("纯先验行仍然有 pctIsp 供排序用（只是不上屏）", (() => {
  const pr = rows.filter((r) => Core.priorOnly(r));
  return pr.every((r) => typeof r.pctIsp === "number") && pr.length > 0;
})(), rows.filter((r) => Core.priorOnly(r)).map((r) => r.pattern + "=" + r.pctIsp + "%").join(" "));
check("单个 IP 的行住宅那格不再出现 ≈0/1 这类形状",
  rows.filter((r) => r.singleHost).every((r) => !/≈/.test(Core.homeTxt(r))),
  rows.filter((r) => r.singleHost).map((r) => Core.homeTxt(r)).join(" | "));

/* ---------- 得分：整数，且表格 / CSV 用的是同一个数 ---------- */
check("行级得分都是整数", rows.every((r) => Number.isInteger(r.score)), rows.map((r) => r.score).join(","));
check("行级得分与 rowScore 一致", rows.every((r) => r.score === Core.rowScore(r)), "rankRows 之后 score 必须就是 rowScore");

/* ---------- CSV 里的住宅列 == 表格那一格 ---------- */
const csv = Core.toCsv(rows, null, 3).split("\n");
const head = csv[0].split(",");
const iHome = head.indexOf("住宅");
const iScore = head.indexOf("得分");
const iCity = head.indexOf("主要城市");
const iCC = head.indexOf("主要国家");
check("CSV 有 住宅 / 得分 / 主要城市 / 主要国家 列", iHome > 0 && iScore > 0 && iCity > 0 && iCC > 0, head.join(","));
/* 一行可能跨多个国家/城市：列名要写成「主要」，别让人以为整行只有一个国家 */
check("列名写着「主要城市 / 主要国家」", head.indexOf("主要城市") > 0 && head.indexOf("主要国家") > 0, head.join(","));
csv.slice(1).forEach((line) => {
  const c = line.split(",");
  const r = rows.find((x) => x.pattern === c[1]);
  check(`CSV 住宅列 == Core.homeTxt(${c[1]})`, r && c[iHome] === Core.homeTxt(r), c[iHome]);
  /* 没级别的行（未评级 = 只有类型先验、不可路由）得分列留空 ——
     那个 0 是「没有分数」，不是「得分 0 分」，CSV 里不能写成 0。 */
  const wantScore = r && r.tier ? String(r.score) : "";
  check(`CSV 得分列（${c[1]}）${r && r.tier ? "== 行级得分" : "留空（这一行没级别）"}`,
    r && String(c[iScore]) === wantScore, `CSV=${JSON.stringify(c[iScore])} 期望=${JSON.stringify(wantScore)}`);
});

/* ---------- 国家 / 城市：同源、同规则，不能出现「国旗一个国、城市另一个国」 ---------- */
for (const r of rows) {
  if (r.city && r.city.viaSlice > 0) {
    check(`${r.pattern} 城市用了城市片 → 国家也用城市片`, r.country && r.country.viaCity > 0,
      `city.viaSlice=${r.city.viaSlice} country.viaCity=${r.country && r.country.viaCity}`);
  }
  if (r.country && r.country.cc) {
    check(`${r.pattern} 国家码是两字母`, /^[A-Z]{2}$/.test(r.country.cc), r.country.cc);
  }
}
const jp = rows.find((r) => r.pattern === "171.213.132.*");
check("171.213.132.* 是中国的段（国家 CN，城市 Chengdu）",
  jp && jp.country.cc === "CN" && jp.city.city === "Chengdu",
  jp ? `${jp.country.cc} / ${jp.city.city}` : "未命中");
check("城市解析与清单标注无关（清单写洛杉矶，解析出成都）",
  jp && jp.city.city !== "Los Angeles" && !("cityHint" in jp),
  jp ? jp.city.city : "未命中");

/* ---------- 城市名只有一种显示法：DB-IP 原文（英文），不做本地化 ---------- */
check("城市名一律原文：一份清单不会中英混排，也不猜译名",
  Core.cityLabel("Chengdu") === "Chengdu" && Core.cityLabel("Absecon") === "Absecon" &&
  Core.cityLabel("  Chengdu ") === "Chengdu" && Core.cityLabel(null) === "" && Core.cityLabel(undefined) === "",
  Core.cityLabel("Chengdu"));
check("只剩一个显示入口（译名表和切换接口都已拿掉）",
  Core.cityZh === undefined && Core.setCityMode === undefined && Core.cityMode === undefined &&
  Core.CITY_MAP === undefined, "");
check("CSV 城市列也是原文", Core.toCsv(rows, null, 3).indexOf("Chengdu") > 0, "");

/* ---------- 国家那一格的来源说法（不再出现「定位国」这种自造词） ---------- */
check("国家来源写成一句话：<口径> · <数据源>",
  /^(按 IP 定位 · 城市数据 DB-IP|按 ASN 注册地 · IP 归属表)$/.test(jp.country.src), jp.country.src);

/* 第 4 段打码 = 一个 /24：城市片对这个 /24 给的是同一个城市 */
const rep24 = Core.parseWithReport("1\t82.24.73.*\t美国\t洛杉矶");
const r24 = Core.analyzeMany(rep24.items, DATA, { world: World, cityPack: CityPacks }).rows[0];
check("第 4 段打码的样本是 254 个可用地址", r24.sampled === 254, String(r24.sampled));
check("第 4 段打码的城市覆盖 == 样本数", r24.city && r24.city.count === r24.sampled,
  r24.city ? `${r24.city.count}/${r24.city.n}` : "无城市");

/* ---------- 构成条：宽度、个数、百分比必须是同一件事 ---------- */
for (const r of rows.filter((x) => !x.singleHost)) {
  const w = Core.shareWidths(r);
  /* 未知段（w.unk）也是构成条的一部分：IP 归属表行看得到 ASN、看不到具体 /24，剩下那一截画成灰色的未知 */
  const sum = [1, 2, 3, 4, 6].reduce((a, k) => a + w[k], 0) + (w.unk || 0);
  check(`${r.pattern} 构成条宽度加起来 100%`, Math.abs(sum - 100) <= 1, sum + "%");
  check(`${r.pattern} 未知段只出现在IP 归属表估算行上`, r.probOnly ? w.unk >= 0 : w.unk === 0, `${w.unk}% probOnly=${!!r.probOnly}`);
  check(`${r.pattern} 构成条住宅段宽度 == 住宅占比`,
    Math.abs(w[1] - Core.homePct(r)) <= 1, `${w[1]}% vs ${Core.homePct(r)}%`);
  check(`${r.pattern} 构成条上的个数 == 表格住宅列的分子`,
    Core.catCount(r, 1).replace("≈", "") === Core.homeNum(r),
    `${Core.catCount(r, 1)} vs ${Core.homeNum(r)}`);
}
check("构成条上每个类别的个数加起来 == 样本数（实测记录行）",
  rows.filter((x) => !x.singleHost && !x.probOnly)
    .every((x) => [1, 2, 3, 4, 6].reduce((a, k) => a + Math.round(x.counts[k] || 0), 0) === x.sampled),
  rows.filter((x) => !x.singleHost && !x.probOnly).map((x) => x.pattern).join(" "));

/* ---------- 配色分档和级别线一致 ---------- */
check("住宅占比 0% → 红档", Core.shareBand(0) === "d");
check("住宅占比 90% → 绿档", Core.shareBand(90) === "g");
check("级别得分同一条尺子", Core.scoreBand(92) === "g" && Core.scoreBand(0) === "d");

console.log(fail === 0 ? "\n一致性自检通过 ✅" : `\n${fail} 项失败 ❌`);
process.exit(fail === 0 ? 0 : 1);
