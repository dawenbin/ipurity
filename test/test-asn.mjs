/* ASN 输入 / 反查 / 聚合行 / 展开上限 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const Core = require("../assets/core.js");
const World = require("../assets/sources.js");

const grab = (file, name) => {
  const m = readFileSync(join(root, file), "utf8")
    .match(new RegExp(`window\\.${name}\\s*=\\s*([\\s\\S]*?);?\\s*$`));
  return m ? JSON.parse(m[1]) : null;
};

let fail = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  if (!cond) fail++;
};

World.putPack(readFileSync(join(root, "data", "global-pack.bin")));
World.setMeta(grab("data/global-asn.js", "GLOBAL_ASN"));
World.setCalib(grab("data/asn-calib.js", "ASN_CALIB"));

/* ---------- 解析 ---------- */
const one = Core.parseWithReport("AS4766");
check("单个 ASN 被识别成一条 ASN token",
  one.asns.length === 1 && one.asns[0].asn === 4766, JSON.stringify(one.asns));
check("ASN-only 行不算未识别", one.items.length === 0 && one.unmatched.length === 0);
const lower = Core.parseWithReport("as4766");
check("小写 as 也认", lower.asns.length === 1 && lower.asns[0].asn === 4766);
const dup = Core.parseWithReport("AS4766 AS4766");
check("同一个 ASN 只收一次", dup.asns.length === 1 && dup.asnDuplicateCount === 1);
const mixed = Core.parseWithReport("AS4766 1.2.3.4");
check("一行里 ASN 和 IP 都收下", mixed.asns.length === 1 && mixed.items.length === 1, `${mixed.asns.length}/${mixed.items.length}`);
const prose = Core.parseWithReport("AS Number 4766");
check("「AS Number 4766」不误认成 ASN", prose.asns.length === 0);
let many = "";
for (let i = 0; i < 51; i++) { many += "AS" + (1000 + i) + "\n"; }
const cap = Core.parseWithReport(many);
check("ASN 输入上限 50，超出部分明确写进未识别", cap.asns.length === 50 && cap.unmatched.length === 1, `${cap.asns.length}/${cap.unmatched.length}`);

/* ---------- 反查 ---------- */
const prof = World.profileOf(4766);
check("AS4766 概览：名称 / 国家 / 段数 / CIDR / /24",
  !!prof && prof.asn === 4766 && /KOREA|KT|KIXS/i.test(prof.name) && prof.cc === "KR" &&
  prof.segments > 0 && prof.ranges > 0 && prof.cidrs > 0 && prof.blocks24 > 0, JSON.stringify(prof && {
    name: prof.name, cc: prof.cc, segments: prof.segments, ranges: prof.ranges, cidrs: prof.cidrs, blocks24: prof.blocks24
  }));

const ranges = World.rangesOf(4766);
check("rangesOf 返回合并后的区间", Array.isArray(ranges) && ranges.length > 0, String(ranges && ranges.length));
let badRange = null;
for (const r of ranges) {
  const e = World.asnOf(World.intToIp(r.start));
  if (!e || e.asn !== 4766) { badRange = r; break; }
}
check("每个区间起点都能反查回 AS4766", !badRange, badRange ? JSON.stringify(badRange) : "");

const cidrs = World.cidrsOf(4766);
check("cidrsOf 产出 CIDR 且格式正确",
  Array.isArray(cidrs) && cidrs.length > 0 && cidrs.every((c) => /^\d+\.\d+\.\d+\.\d+\/\d{1,2}$/.test(c)),
  String(cidrs && cidrs.length));

const blocks = World.blocks24Of(4766, 8);
check("blocks24Of 均匀取 8 个 /24", blocks && blocks.blocks.length === 8 && blocks.total > 8 && blocks.truncated === true,
  JSON.stringify({ shown: blocks && blocks.shown, total: blocks && blocks.total }));
check("展开项都是 a.b.c.* 形式",
  blocks.blocks.every((b) => /^\d+\.\d+\.\d+\.\*$/.test(b)), blocks.blocks.join(", "));

/* ---------- 聚合行 ---------- */
const row = Core.analyzeAsn(4766, { world: World });
check("analyzeAsn 产出聚合行", row.ok === true && row.pattern === "AS4766", JSON.stringify({ ok: row.ok, reason: row.reason }));
check("聚合行来源是 IP 归属表（估算）", row.source === "全球ASN" && row.approx === true && row.probOnly === true);
check("聚合行带 ASN 概览", row.asnProfile && row.asnProfile.asn === 4766 && row.asnProfile.blocks24 > 0);
check("聚合行国家取 ASN 注册国", row.country && row.country.cc === "KR", row.country && row.country.cc);
check("没有标定样本 → 未评级；有标定 → 有级别",
  row.asnProfile.calibrated ? !!row.tier : (row.ungraded === true && row.tier === ""),
  `calibrated=${row.asnProfile.calibrated} tier=${row.tier} ungraded=${row.ungraded}`);

const unknown = Core.analyzeAsn(4294967290, { world: World });
check("不存在的 ASN 返回 ok=false + 原因", unknown.ok === false && !!unknown.reason, unknown.reason);

const expanded = Core.expandAsn(4766, { world: World, cap: 5 });
check("expandAsn 遵守 cap", expanded.length === 5 && expanded.every((p) => /^\d+\.\d+\.\d+\.\*$/.test(p)), expanded.join(", "));

console.log(fail === 0 ? "\nASN 自检通过 ✅" : `\n${fail} 项失败 ❌`);
process.exit(fail === 0 ? 0 : 1);
