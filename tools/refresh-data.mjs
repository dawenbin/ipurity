/*
 * tools/refresh-data.mjs —— 数据自动刷新（给 GitHub Actions 用；本地也能跑）
 *
 *   node tools/refresh-data.mjs --asn      # iptoasn + PeeringDB + bad-asn-list → 全球段表 → 重算标定
 *   node tools/refresh-data.mjs --city     # DB-IP City Lite → 220 个城市片
 *   node tools/refresh-data.mjs --asn --dry   # 只比对指纹，不下载、不打包、不改文件
 *
 * 三条设计原则：
 *   1. **节奏分开**：iptoasn 每天更新（ASN 那套每天跑）；DB-IP City Lite 每月更新，源文件 86 MB、
 *      产物 33 MB —— 城市那套每月跑一次就够，所以拆成两个 workflow 调这个脚本的两个模式。
 *   2. **只有数据真的变了才提交**：产物里的 `generated` 时间戳每次都会变，比对指纹时必须先把它抹掉，
 *      不然每天都会「假装变了」提交一次 —— 白触发一次 Cloudflare Pages 重建，还会把 33 MB 城市片的 CDN
 *      缓存全部打失效（这些 URL 带 ?v=<build>）。
 *   3. **没变就还原**：指纹和 HEAD 一致 → git checkout 回产物，不动构建戳，退出码 0。
 *      变了 → 调 tools/bump-build.mjs 换构建戳（HTML/JS/数据 URL 的缓存戳一起换），
 *      提交推送交给 workflow（推送到 main 由 Cloudflare Pages 自动发布）。
 *
 * 结果写进 $GITHUB_OUTPUT（本地跑就只打印）：changed=true|false
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dry = process.argv.includes("--dry");
const mode = process.argv.includes("--city") ? "city" : process.argv.includes("--asn") ? "asn" : null;
if (!mode) {
  console.error("用法：node tools/refresh-data.mjs --asn | --city [--dry]");
  process.exit(2);
}

const PLAN = {
  asn: {
    what: "ASN 层（iptoasn + PeeringDB + bad-asn-list）",
    steps: ["tools/fetch-asn-tables.mjs", "tools/make-global-pack.mjs", "tools/make-calibration.mjs"],
    products: () => ["data/global-pack.bin", "data/global-asn.js", "data/asn-calib.js"],
  },
  city: {
    what: "城市层（DB-IP City Lite）",
    steps: ["tools/fetch-city-tables.mjs", "tools/make-city-packs.mjs"],
    products: () =>
      readdirSync(join(root, "data", "city"))
        .filter((f) => f === "index.json" || f.endsWith(".bin"))
        .sort()
        .map((f) => "data/city/" + f),
  },
};
const plan = PLAN[mode];

function run(script) {
  console.log(`\n$ node ${script}`);
  const r = spawnSync(process.execPath, [script], { cwd: root, stdio: "inherit" });
  if (r.status !== 0) { throw new Error(`${script} 退出码 ${r.status}`); }
}

/* 指纹：产物里的 generated 时间戳每次都变，先抹掉再哈希，只比“数据本身” */
function fp(buf) {
  const body = buf.includes(0)                          /* 二进制片（城市 .bin / 段表）直接哈希 */
    ? buf
    : Buffer.from(buf.toString("utf8").replace(/"generated"\s*:\s*"[^"]*"/g, '"generated":"-'), "utf8");
  return createHash("sha256").update(body).digest("hex").slice(0, 16);
}
function headFp(rel) {
  const r = spawnSync("git", ["show", "HEAD:" + rel], { cwd: root, maxBuffer: 128 * 1024 * 1024 });
  return r.status === 0 ? fp(r.stdout) : null;          /* null = HEAD 里没有（新文件） */
}

if (!dry) { for (const s of plan.steps) { run(s); } }

const products = plan.products();
const rows = products.map((rel) => {
  const p = join(root, rel);
  const now = existsSync(p) ? fp(readFileSync(p)) : null;
  const head = headFp(rel);
  return { rel, now, head, same: now !== null && now === head };
});
const changed = rows.some((r) => !r.same);

console.log(`\n${plan.what}：产物 ${rows.length} 个`);
if (changed) {
  rows.filter((r) => !r.same).forEach((r) => console.log(`  变了 ${r.rel}  HEAD=${r.head || "(新)"} → ${r.now}`));
} else {
  console.log("  指纹与 HEAD 完全一致，数据没变。");
}

if (dry) {
  console.log("\n[干跑] 没动任何文件。");
} else if (changed) {
  run("tools/bump-build.mjs");                          /* 数据变了才换缓存戳 */
} else {
  const tracked = rows.filter((r) => r.head).map((r) => r.rel);
  if (tracked.length) {
    const r = spawnSync("git", ["checkout", "--", ...tracked], { cwd: root, stdio: "inherit" });
    if (r.status !== 0) { throw new Error("git checkout 还原产物失败"); }
  }
  console.log(`已把 ${tracked.length} 个产物还原成 HEAD（只有 generated 时间戳不同，不算数据变化）。`);
}

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\n`);
}
console.log(`\nchanged=${changed}`);
