/* 二源 ASN 分歧包：ASNDIF01 格式、查询、标注不改级别/得分 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const Core = require("../assets/core.js");
const Diff = require("../assets/asn-diff.js");

let fail = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  if (!cond) fail++;
};

const buf = readFileSync(join(root, "data", "asn-disagree.bin"));
const n = buf.readUInt32LE(12);
const starts = [], ends = [], other = [];
for (let i = 0; i < n; i++) {
  starts.push(buf.readUInt32LE(16 + i * 4));
  ends.push(buf.readUInt32LE(16 + (n + i) * 4));
  other.push(buf.readUInt32LE(16 + (n * 2 + i) * 4));
}
check("ASNDIF01 魔数", buf.toString("ascii", 0, 8) === "ASNDIF01");
check("区间数 > 0", n > 0, String(n));
let orderBad = null;
for (let i = 1; i < n; i++) { if (starts[i] <= ends[i - 1] || starts[i] > ends[i]) { orderBad = i; break; } }
check("区间升序、互不重叠", !orderBad, orderBad == null ? "" : "第 " + orderBad + " 段");
check("otherAsn 都是正整数", other.every((a) => a > 0 && a < 4294967295));

const meta = JSON.parse(readFileSync(join(root, "data", "asn-disagree.js"), "utf8")
  .match(/window\.ASN_DISAGREE\s*=\s*([\s\S]*?);?\s*$/)[1]);
Diff.put(buf);
Diff.setMeta(meta);
check("IPAsnDiff 就绪", Diff.ready() === true);
check("meta 记录了 CC BY 4.0 许可", /CC BY 4\.0/.test(meta.license || ""), meta.license);
check("meta 记录了对比月份", !!meta.sourceMonth, meta.sourceMonth);

const intToIp = (x) => [(x >>> 24) & 255, (x >>> 16) & 255, (x >>> 8) & 255, x & 255].join(".");
const ip = intToIp(starts[0]);
const hit = Diff.lookupIp(ip);
check("包内起点能查回 DB-IP ASN", !!hit && hit.otherAsn === other[0], JSON.stringify(hit && { otherAsn: hit.otherAsn }));

const ov = Diff.overlapRanges([{ start: starts[0], end: ends[0] }]);
check("overlapRanges 能统计分歧 /24", ov.blocks24 >= 1, JSON.stringify(ov));

const row = {
  pattern: ip, ok: true, starPos: -1, singleHost: true, sampled: 1,
  tier: "A", tierText: "住宅为主", counts: { 1: 1, 2: 0, 3: 0, 4: 0, 6: 0 },
  pctIsp: 100, source: "实测记录", approx: false, candidates: []
};
const before = { tier: row.tier, source: row.source, score: Core.rowScore(row) };
Core.applyAsnDiff(row, Diff);
check("命中后挂上 asnDiff 标记", !!row.asnDiff && row.asnDiff.otherAsn > 0, JSON.stringify(row.asnDiff && row.asnDiff.otherAsn));
check("二源分歧不改级别 / 来源 / 得分",
  row.tier === before.tier && row.source === before.source && Core.rowScore(row) === before.score);
check("CSV 标记串包含 diff:AS", /diff:AS\d+/.test(Core.markerTxt(row)), Core.markerTxt(row));

console.log(fail === 0 ? "\n二源分歧自检通过 ✅" : `\n${fail} 项失败 ❌`);
process.exit(fail === 0 ? 0 : 1);
