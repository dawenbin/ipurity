/* 城市包自检：切片能解开、段表有序、查得到城市、打码行的城市分布能用
   node test/test-city.mjs */
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const CityPacks = require(join(root, "assets", "city.js"));
const Core = require(join(root, "assets", "core.js"));

let fail = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  if (!cond) fail++;
};

const dir = join(root, "data", "city");
const files = readdirSync(dir).filter((f) => f.endsWith(".bin"));
const stray = readdirSync(dir).filter((f) => !f.endsWith(".bin") && f !== "index.json");
check("切片文件数量", files.length > 200, `${files.length} 个 .bin`);
check("目录里没有旧格式残留", stray.length === 0, stray.slice(0, 5).join(" "));

const index = JSON.parse(readFileSync(join(dir, "index.json"), "utf8"));
check("index.json 记录了总段数", index.total > 3000000, `${index.total} 段`);
check("index.json 的切片数与磁盘一致", index.slices.length === files.length,
  `index ${index.slices.length} / 磁盘 ${files.length}`);

/* 全量校验：每个切片都能解析，且段起点严格递增（二分查找的前提）、落在本 /8 内 */
let bad = [], totalSeg = 0;
for (const f of files) {
  const o1 = Number(f.replace(".bin", ""));
  let sl;
  try { sl = CityPacks.put(o1, readFileSync(join(dir, f))); }
  catch (e) { bad.push(`${f}:${e.message}`); continue; }
  totalSeg += sl.starts.length;
  for (let i = 0; i < sl.starts.length; i++) {
    if (i && sl.starts[i] <= sl.starts[i - 1]) { bad.push(`${f}:第 ${i} 段起点非递增`); break; }
    if ((sl.starts[i] >>> 24) !== o1) { bad.push(`${f}:第 ${i} 段不在 /8 ${o1} 内`); break; }
    if (!sl.table[sl.cities[i]]) { bad.push(`${f}:第 ${i} 段城市索引越界`); break; }
  }
}
check("所有切片解析 + 段表有序 + 落在本 /8 内 + 城市索引不越界", bad.length === 0, bad.slice(0, 3).join(" | "));
check("切片总段数", totalSeg > 3000000, `${totalSeg} 段（磁盘 ${(files.reduce((n, f) => n + readFileSync(join(dir, f)).length, 0) / 1048576).toFixed(1)} MB）`);

/* 具体查询 */
const hit = CityPacks.lookupIp("198.72.205.197");
check("单个 IP 查城市", !!hit && !!hit.city, JSON.stringify(hit));
check("国家码是美国", !!hit && hit.country === "US", hit && hit.country);

const en = CityPacks.enumerate("198.*.205.197");
check("打码行枚举出 256 种取值", !!en && en.per.length === 256, en && String(en.per.length));
check("枚举结果带城市覆盖数", !!en && en.covered > 200, en && `${en.covered}/256 有城市`);
check("枚举结果按城市聚合出 top（详情里的城市标签用它）",
  !!en && en.top.length > 0 && en.top[0].count > 0,
  en && en.top.slice(0, 3).map((c) => `${c.city}×${c.count}`).join(" · "));
check("枚举出的 IP 保持打码位替换后的完整形式",
  !!en && en.per.every((p) => /^198\.\d+\.205\.197$/.test(p.ip)), en && en.per.slice(0, 2).map((p) => p.ip).join(","));

console.log(fail === 0 ? "\n城市包自检通过 ✅" : `\n${fail} 项失败 ❌`);
process.exit(fail === 0 ? 0 : 1);
