/* 风险名单包：解析器、IPBLK001 格式、标注不改级别/得分 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDrop, parseIpsum, parsePlainList, mergeRanges, packBlocklists } from "../tools/make-blocklists.mjs";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const Core = require("../assets/core.js");
const BL = require("../assets/blocklists.js");

let fail = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  if (!cond) fail++;
};

/* ---------- 纯解析器 ---------- */
const drop = parseDrop("1.10.16.0/20 ; SBL256894\n; comment\n\n2.2.2.0/24");
check("DROP：CIDR + 行尾注释", drop.length === 2 && drop[0].start > 0, JSON.stringify(drop));
const ipsum = parseIpsum("1.2.3.4\t2\n5.6.7.8\t5\n9.9.9.9\t3", 3);
check("IPsum：只收 >=3 的条目", ipsum.length === 2 && ipsum.skipped.low === 1, JSON.stringify(ipsum.length));
const plain = parsePlainList("1.2.3.4\n# x\n\n5.6.7.8");
check("纯 IP 列表：一行一个", plain.length === 2);
const merged = mergeRanges([
  { start: 10, end: 20, bit: 1 },
  { start: 21, end: 30, bit: 2 },
  { start: 100, end: 100, bit: 4 }
]);
check("相邻段合并、bit 按位或", merged.length === 2 && merged[0].bits === 3, JSON.stringify(merged));

/* ---------- 真实包 ---------- */
const buf = readFileSync(join(root, "data", "blocklists.bin"));
const n = buf.readUInt32LE(12);
const starts = [], ends = [], bits = [];
for (let i = 0; i < n; i++) {
  starts.push(buf.readUInt32LE(16 + i * 4));
  ends.push(buf.readUInt32LE(16 + (n + i) * 4));
  bits.push(buf[16 + n * 8 + i]);
}
check("IPBLK001 魔数", buf.toString("ascii", 0, 8) === "IPBLK001");
check("段数 > 0", n > 0, String(n));
let orderBad = null;
for (let i = 1; i < n; i++) { if (starts[i] <= ends[i - 1] || starts[i] > ends[i]) { orderBad = i; break; } }
check("段升序、互不重叠", !orderBad, orderBad == null ? "" : "第 " + orderBad + " 段");
check("bits 只用四个来源位", bits.every((b) => (b & ~0x0f) === 0 && b !== 0));

const meta = JSON.parse(readFileSync(join(root, "data", "blocklists.js"), "utf8")
  .match(/window\.BLOCKLISTS\s*=\s*([\s\S]*?);?\s*$/)[1]);
BL.put(buf);
BL.setMeta(meta);
check("IPBlocklists 就绪", BL.ready() === true);
check("meta 记录四个来源", (meta.sources || []).length === 4, (meta.sources || []).map((s) => s.id).join(","));

const intToIp = (x) => [(x >>> 24) & 255, (x >>> 16) & 255, (x >>> 8) & 255, x & 255].join(".");
const firstIp = intToIp(starts[0]);
const hit = BL.lookupIp(firstIp);
check("包内区间起点能查回命中", !!hit && hit.bits > 0, JSON.stringify(hit && { bits: hit.bits, ids: hit.ids }));
check("命中带来源名", !!hit && hit.sources.length > 0, hit && hit.sources.map((s) => s.id).join(","));

/* 构造一个「已评级」的假行，确认标注不改级别/来源/得分 */
const row = {
  pattern: firstIp, ok: true, starPos: -1, singleHost: true, sampled: 1,
  tier: "A", tierText: "住宅为主", counts: { 1: 1, 2: 0, 3: 0, 4: 0, 6: 0 },
  pctIsp: 100, source: "实测记录", approx: false, candidates: []
};
const before = { tier: row.tier, source: row.source, score: Core.rowScore(row), counts: JSON.stringify(row.counts) };
Core.applyBlocklist(row, BL);
check("命中后挂上 blocklist 标记", !!row.blocklist && row.blocklist.ids.length > 0, JSON.stringify(row.blocklist && row.blocklist.ids));
check("标注不改级别 / 来源 / 得分 / 计数",
  row.tier === before.tier && row.source === before.source &&
  Core.rowScore(row) === before.score && JSON.stringify(row.counts) === before.counts);
check("CSV 标记串包含 bl:", /bl:/.test(Core.markerTxt(row)), Core.markerTxt(row));

/* 打码行：第 4 段 254 个主机都扫一遍 */
const pattern = firstIp.split(".").slice(0, 3).join(".") + ".*";
const wide = {
  pattern: pattern, ok: true, starPos: 3, singleHost: false, sampled: 254,
  tier: "A", tierText: "住宅为主", counts: { 1: 254, 2: 0, 3: 0, 4: 0, 6: 0 },
  pctIsp: 100, source: "实测记录", approx: false, candidates: []
};
Core.applyBlocklist(wide, BL);
check("第 4 段打码按 254 个主机统计", wide.blocklist && wide.blocklist.sampled === 254, wide.blocklist && String(wide.blocklist.sampled));

const notice = readFileSync(join(root, "NOTICE"), "utf8");
for (const name of ["Spamhaus", "IPsum", "Tor", "blocklist.de"]) {
  check(`NOTICE 记录了 ${name}`, notice.indexOf(name) >= 0);
}

console.log(fail === 0 ? "\n风险名单自检通过 ✅" : `\n${fail} 项失败 ❌`);
process.exit(fail === 0 ? 0 : 1);
