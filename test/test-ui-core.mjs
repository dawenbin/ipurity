/* 筛选 / 排序 / 置信度：纯函数，不依赖 DOM */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const Core = require("../assets/core.js");

let fail = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  if (!cond) fail++;
};

const mk = (o) => Object.assign({
  pattern: "1.1.1.1", ok: true, tier: "A", tierText: "住宅为主",
  counts: { 1: 100, 2: 0, 3: 0, 4: 0, 6: 0 }, sampled: 100, pctIsp: 100,
  source: "实测记录", approx: false, rank: 1, singleHost: true, country: null, city: null
}, o);

const rA = mk({ rank: 1, pattern: "1.1.1.1", country: { cc: "US" }, city: { city: "A" } });
const rB = mk({
  rank: 2, pattern: "2.2.2.2", tier: "B", tierText: "混合",
  counts: { 1: 60, 2: 5, 3: 5, 4: 5, 6: 25 }, pctIsp: 60,
  country: { cc: "JP" }, city: { city: "B" }
});
const rU = mk({
  rank: 3, pattern: "3.3.3.3", tier: "", tierText: "", ungraded: true, priorOnly: true,
  counts: { 1: 0, 2: 0, 3: 0, 4: 0, 6: 0 }, sampled: 10, pctIsp: 0,
  source: "全球ASN", approx: true
});
const rF = { pattern: "4.4.4.4", ok: false, rank: 4, reason: "unroutable" };
const rC = mk({
  rank: 5, pattern: "5.5.5.5", country: { cc: "US" }, city: { city: "A" },
  cloud: { ids: ["aws"], fullIds: ["aws"], count: 1, any: 1, full: 1, share: 100, network: "5.5.5.0/24", override: true }
});
const rR = mk({ rank: 6, pattern: "6.6.6.6", blocklist: { ids: ["tor"], count: 1, sampled: 1 } });
const rD = mk({ rank: 7, pattern: "7.7.7.7", asnDiff: { otherAsn: 123, count: 1, sampled: 1 } });
const rows = [rA, rB, rU, rF, rC, rR, rD];
const pats = (list) => list.map((r) => r.pattern).join(",");

/* ---------- filterRows ---------- */
check("空筛选返回全部", Core.filterRows(rows, {}).length === 7);
check("A+B 只留已评级的 A/B",
  pats(Core.filterRows(rows, { tier: "ab" })) === "1.1.1.1,2.2.2.2,5.5.5.5,6.6.6.6,7.7.7.7",
  pats(Core.filterRows(rows, { tier: "ab" })));
check("未评级筛选收未评级与失败行",
  pats(Core.filterRows(rows, { tier: "x" })) === "3.3.3.3,4.4.4.4",
  pats(Core.filterRows(rows, { tier: "x" })));
check("单一级别筛选", pats(Core.filterRows(rows, { tier: "B" })) === "2.2.2.2");
check("国家筛选忽略大小写",
  pats(Core.filterRows(rows, { country: "us" })) === "1.1.1.1,5.5.5.5",
  pats(Core.filterRows(rows, { country: "us" })));
check("城市筛选", pats(Core.filterRows(rows, { city: "A" })) === "1.1.1.1,5.5.5.5");
check("标记筛选：云段 / 名单 / 二源 / 任意",
  pats(Core.filterRows(rows, { flag: "cloud" })) === "5.5.5.5" &&
  pats(Core.filterRows(rows, { flag: "risk" })) === "6.6.6.6" &&
  pats(Core.filterRows(rows, { flag: "diff" })) === "7.7.7.7" &&
  pats(Core.filterRows(rows, { flag: "any" })) === "5.5.5.5,6.6.6.6,7.7.7.7");
check("组合筛选同时生效",
  pats(Core.filterRows(rows, { tier: "ab", country: "US", flag: "any" })) === "5.5.5.5",
  pats(Core.filterRows(rows, { tier: "ab", country: "US", flag: "any" })));
check("筛选不改原数组", rows.length === 7 && rows[0] === rA);

/* ---------- sortRows ---------- */
check("默认按排名升序", pats(Core.sortRows(rows, "rank", 1)) === "1.1.1.1,2.2.2.2,3.3.3.3,4.4.4.4,5.5.5.5,6.6.6.6,7.7.7.7");
check("排名可倒序", pats(Core.sortRows(rows, "rank", -1)) === "7.7.7.7,6.6.6.6,5.5.5.5,4.4.4.4,3.3.3.3,2.2.2.2,1.1.1.1");

const byScore = Core.sortRows(rows, "score", -1);
const scoreOf = (r) => (r.ok && r.tier && !r.ungraded ? Core.rowScore(r) : null);
let firstNull = -1;
byScore.forEach((r, i) => { if (firstNull < 0 && scoreOf(r) == null) { firstNull = i; } });
check("得分倒序：缺分（未评级/失败）永远排最后",
  firstNull === 5 && byScore.slice(5).every((r) => scoreOf(r) == null),
  byScore.map((r) => scoreOf(r)).join(","));
check("得分倒序：有分部分确实降序",
  byScore.slice(0, firstNull).every((r, i) => i === 0 || scoreOf(byScore[i - 1]) >= scoreOf(r)),
  byScore.map((r) => scoreOf(r)).join(","));
check("得分缺失行保持原相对顺序", byScore.slice(5).map((r) => r.pattern).join(",") === "3.3.3.3,4.4.4.4");

const byCountry = Core.sortRows(rows, "country", 1);
check("国家升序，缺国家排最后",
  byCountry.slice(0, 3).map((r) => r.country && r.country.cc).join(",") === "JP,US,US" &&
  byCountry.slice(3).every((r) => !r.country),
  byCountry.map((r) => (r.country ? r.country.cc : "-")).join(","));
check("缺值排序与方向无关（倒序也在最后）",
  Core.sortRows(rows, "country", -1).slice(-4).every((r) => !r.country));

const tie = [mk({ rank: 1, pattern: "a" }), mk({ rank: 2, pattern: "b" })];
check("得分相同按原顺序（稳定）", pats(Core.sortRows(tie, "score", -1)) === "a,b");
const byPattern = Core.sortRows(rows, "pattern", -1);
check("字符串列可倒序", byPattern[0].pattern === "7.7.7.7" && byPattern[6].pattern === "1.1.1.1");
check("排序不改原数组", rows.map((r) => r.pattern).join(",") === "1.1.1.1,2.2.2.2,3.3.3.3,4.4.4.4,5.5.5.5,6.6.6.6,7.7.7.7");

/* ---------- confidenceRank：核验时先做最没把握的 ---------- */
check("失败行不参与核验排序", Core.confidenceRank(rF) === 9);
check("云段确定性改判最后考虑", Core.confidenceRank(mk({ cloud: { override: true } })) === 4);
check("未评级 / 只有先验 → 0", Core.confidenceRank(rU) === 0);
check("打码截断 → 1", Core.confidenceRank(mk({ capped: true })) === 1);
check("IP 归属表估算 → 2", Core.confidenceRank(mk({ source: "全球ASN", approx: true })) === 2);
check("实测记录 → 3", Core.confidenceRank(rA) === 3);
check("空行排在最后", Core.confidenceRank(null) === 9);

console.log(fail === 0 ? "\n筛选 / 排序 / 置信度自检通过 ✅" : `\n${fail} 项失败 ❌`);
process.exit(fail === 0 ? 0 : 1);
