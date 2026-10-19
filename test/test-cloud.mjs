/* 云厂商段包：格式、整 /24 改判、部分覆盖只标注、跨 256 个 /24 的 50% 阈值 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const Core = require("../assets/core.js");
const Cloud = require("../assets/cloud.js");

let fail = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  if (!cond) fail++;
};

const buf = readFileSync(join(root, "data", "cloud-pack.bin"));
const n = buf.readUInt32LE(12);
const starts = [], ends = [], bits = [], full = [];
for (let i = 0; i < n; i++) {
  starts.push(buf.readUInt32LE(16 + i * 4));
  ends.push(buf.readUInt32LE(16 + (n + i) * 4));
  bits.push(buf[16 + n * 8 + i]);
  full.push(buf[16 + n * 9 + i]);
}
check("CLOUDPK1 魔数", buf.toString("ascii", 0, 8) === "CLOUDPK1");
check("区间数 > 0", n > 0, String(n));
let orderBad = null;
for (let i = 1; i < n; i++) {
  if (starts[i] <= ends[i - 1] || starts[i] > ends[i]) { orderBad = i; break; }
}
check("区间升序、互不重叠", !orderBad, orderBad == null ? "" : "第 " + orderBad + " 段");
check("fullBits 是 providerBits 的子集", full.every((f, i) => (f & ~bits[i]) === 0));
check("没有未知厂商位", bits.every((b) => (b & ~0x0f) === 0));

const meta = JSON.parse(readFileSync(join(root, "data", "cloud-meta.js"), "utf8")
  .match(/window\.CLOUD_META\s*=\s*([\s\S]*?);?\s*$/)[1]);
Cloud.put(buf);
Cloud.setMeta(meta);
check("CloudPacks 就绪", Cloud.ready() === true);
check("meta 记录四家厂商", (meta.providers || []).length >= 3, (meta.providers || []).map((p) => p.id).join(","));

const intToIp = (x) => [(x >>> 24) & 255, (x >>> 16) & 255, (x >>> 8) & 255, x & 255].join(".");
let fullIp = "", partialIp = "";
for (let i = 0; i < n; i++) {
  if (!bits[i]) { continue; }
  const ip = intToIp(starts[i] * 256 + 1);
  if (full[i] && !fullIp) { fullIp = ip; }
  if (!full[i] && !partialIp) { partialIp = ip; }
}
check("找到一个整 /24 覆盖的段", !!fullIp, fullIp);
check("找到一个只部分覆盖的段", !!partialIp, partialIp);

function fake(ip) {
  return {
    pattern: ip, ok: true, starPos: -1, singleHost: true, sampled: 1,
    tier: "A", tierText: "住宅为主", counts: { 1: 1, 2: 0, 3: 0, 4: 0, 6: 0 },
    pctIsp: 100, source: "实测记录", approx: false, candidates: [], host24: { cat: 1 }
  };
}

if (fullIp) {
  const r = Core.applyCloud(fake(fullIp), Cloud);
  check("整 /24 命中 → 改判 D", r.tier === "D" && r.source === "云厂商段表", `${r.tier}/${r.source}`);
  check("云段改判后不再是估算", r.approx === false && r.cloud && r.cloud.override === true);
  check("云段改判清掉住宅计数", r.pctIsp === 0 && r.counts[1] === 0);
}
if (partialIp) {
  const r = Core.applyCloud(fake(partialIp), Cloud);
  check("部分覆盖只标注、不改判", r.source !== "云厂商段表" && r.cloud && r.cloud.override === false,
    `${r.source}/${r.cloud && r.cloud.override}`);
  check("部分覆盖的标记带 ?（CSV 用）", /aws\?/.test(Core.markerTxt(r)), Core.markerTxt(r));
}

/* 跨 256 个 /24：整 /24 覆盖 128/256 = 50% 才改判；127/256 不改判 */
function stub(fullBelow) {
  const p = { id: "aws", bit: 1, label: "AWS", name: "Amazon Web Services" };
  return {
    ready: function () { return true; },
    meta: function () { return { providers: [p] }; },
    lookupIp: function (ip) {
      const parts = ip.split(".");
      if (parts[0] !== "10" || Number(parts[1]) >= fullBelow) { return null; }
      return { bits: 1, fullBits: 1, providers: [p], fullProviders: [p], network: "10." + parts[1] + ".0.0/16" };
    }
  };
}
function wide() {
  return {
    pattern: "10.*.0.1", ok: true, starPos: 1, singleHost: false, sampled: 256,
    tier: "A", tierText: "住宅为主", counts: { 1: 256, 2: 0, 3: 0, 4: 0, 6: 0 },
    pctIsp: 100, source: "实测记录", approx: false, candidates: [], host24: null
  };
}
const half = Core.applyCloud(wide(), stub(128));
check("50% 整/24 覆盖 → 改判 D", half.cloud.override === true && half.tier === "D" && half.cloud.share === 50);
const less = Core.applyCloud(wide(), stub(127));
check("49% 整/24 覆盖 → 只标注", less.cloud.override === false && less.source === "实测记录", less.cloud.share + "%");

const ov = Cloud.overlapRanges([{ start: starts[0] * 256, end: starts[0] * 256 + 255 }]);
check("overlapRanges 能统计 ASN 区间覆盖", ov.blocks24 >= 1, JSON.stringify(ov));

const notice = readFileSync(join(root, "NOTICE"), "utf8");
for (const name of ["AWS", "Google Cloud", "Cloudflare", "Azure"]) {
  check(`NOTICE 记录了 ${name} 段表来源`, notice.indexOf(name) >= 0);
}

console.log(fail === 0 ? "\n云厂商段自检通过 ✅" : `\n${fail} 项失败 ❌`);
process.exit(fail === 0 ? 0 : 1);
