/*
 * tools/refresh-data.mjs —— 数据自动刷新（给 GitHub Actions 用；本地也能跑）
 *
 *   node tools/refresh-data.mjs --segments   # ip-api 逐 /24 实测 → data/segments-data.{js,json}
 *   node tools/refresh-data.mjs --asn        # iptoasn + PeeringDB + bad-asn-list → IP 归属表 → 重算标定
 *   node tools/refresh-data.mjs --city       # DB-IP City Lite → 220 个城市片
 *   node tools/refresh-data.mjs --asn --dry  # 只比对指纹，不下载、不打包、不改文件
 *
 * 四条设计原则：
 *   0. **按月跑，不按天跑**：三份上游里最勤的是 iptoasn（每天），但实测一天下来只有约 0.06%
 *      的 IP 换了归属（2026-10-29 抽样 6 万个 IP 对比前一天的数据包：38 个变了，全是 ASN 换号）。
 *      按天跑等于每天往仓库里塞 7 MB 新对象、每天把整站的 ?v= 缓存戳换一遍，换来的只是一个
 *      几乎没人看得出差别的数字。三个 workflow 都排在每月 5 号，顺序 segments → asn → city
 *      （标定库要用当月的实测 CSV 反推，所以实测必须排在最前面）。
 *   1. **只有数据真的变了才提交**：产物里的 `generated` 时间戳每次都会变，比对指纹时必须先把它抹掉，
 *      不然每次都会「假装变了」提交一次 —— 白触发一次 Cloudflare Pages 重建，还会把 33 MB 城市片的
 *      CDN 缓存全部打失效（这些 URL 带 ?v=<build>）。
 *   2. **没变就还原**：指纹和 HEAD 一致 → git checkout 回产物，不动构建戳，退出码 0。
 *      变了 → 调 tools/bump-build.mjs 换构建戳（HTML/JS/数据 URL 的缓存戳一起换），
 *      提交推送交给 workflow（推送到 main 由 Cloudflare Pages 自动发布）。
 *   3. **实测层要有下限**：ip-api 是逐个 /24 发的请求，被限速或断流时脚本只会丢批次（CSV 少行）。
 *      少于预期行数的 98% 就直接失败 —— 宁可不刷新，也不拿半份实测去覆盖标定基准。
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
const mode = process.argv.includes("--segments") ? "segments"
  : process.argv.includes("--city") ? "city"
  : process.argv.includes("--asn") ? "asn"
  : null;
if (!mode) {
  console.error("用法：node tools/refresh-data.mjs --segments | --asn | --city [--dry]");
  process.exit(2);
}

/* 实测层的输入 / 输出。带环境变量是为了能在本地拿小样本试跑：
 *   SCAN_PATTERNS=build/patterns-new.txt SCAN_CSV=build/tmp/scan.csv node tools/refresh-data.mjs --segments */
const PATTERNS = process.env.SCAN_PATTERNS || "build/prefixes-all.txt";
const SCAN_CSV = process.env.SCAN_CSV || "build/prefixmap-all.csv";
const PWSH = process.env.PWSH || "pwsh";

/* 扫描中途断流时 CSV 会缺行（每个失败的批次丢 100 行）。低于预期 98% 就当这次扫描不成立。 */
const MIN_SCAN_RATIO = 0.98;

const PLAN = {
  segments: {
    what: "实测记录（ip-api 免费批量接口，逐 /24 实测）",
    steps: [
      () => shell(PWSH, ["-NoProfile", "-File", "tools/scan-prefixes.ps1", "-PatternFile", PATTERNS, "-OutFile", SCAN_CSV]),
      checkScanRows,
      () => shell(PWSH, ["-NoProfile", "-File", "tools/make-data.ps1", "-InputCsv", SCAN_CSV, "-OutDir", "data"]),
    ],
    products: () => ["data/segments-data.js", "data/segments-data.json"],
  },
  asn: {
    what: "ASN 层（iptoasn + PeeringDB + bad-asn-list）",
    steps: [
      () => node("tools/fetch-asn-tables.mjs"),
      () => node("tools/make-global-pack.mjs"),
      () => node("tools/make-calibration.mjs"),
    ],
    products: () => ["data/global-pack.bin", "data/global-asn.js", "data/asn-calib.js"],
  },
  city: {
    what: "城市层（DB-IP City Lite）",
    steps: [
      () => node("tools/fetch-city-tables.mjs"),
      () => node("tools/make-city-packs.mjs"),
    ],
    products: () =>
      readdirSync(join(root, "data", "city"))
        .filter((f) => f === "index.json" || f.endsWith(".bin"))
        .sort()
        .map((f) => "data/city/" + f),
  },
};
const plan = PLAN[mode];

function node(script) {
  console.log(`\n$ node ${script}`);
  const r = spawnSync(process.execPath, [script], { cwd: root, stdio: "inherit" });
  if (r.status !== 0) { throw new Error(`${script} 退出码 ${r.status}`); }
}
function shell(exe, args) {
  console.log(`\n$ ${exe} ${args.join(" ")}`);
  const r = spawnSync(exe, args, { cwd: root, stdio: "inherit" });
  if (r.error) { throw new Error(`跑不起 ${exe}：${r.error.message}`); }
  if (r.status !== 0) { throw new Error(`${exe} ${args.join(" ")} 退出码 ${r.status}`); }
}

/* 每个模式共用的最后一道闸：产物本身能不能看 */
function checkScanRows() {
  const expected =
    readFileSync(join(root, PATTERNS), "utf8").split(/\r?\n/).filter((l) => /\d/.test(l)).length * 256;
  const file = join(root, SCAN_CSV);
  const rows = existsSync(file) ? readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l.trim()).length - 1 : 0;
  const min = Math.floor(expected * MIN_SCAN_RATIO);
  if (rows < min) {
    throw new Error(`${SCAN_CSV} 只有 ${rows} 行，预期 ${expected} 行（下限 ${min}）——扫描被限速或断流，本次不刷新`);
  }
  console.log(`\n扫描行数 ${rows} / 预期 ${expected}，通过`);
}

/* 指纹：产物里的 generated 时间戳每次都变，先抹掉再哈希，只比“数据本身”。
 * 同时把 CRLF 折成 LF：Windows 上 core.autocrlf=true 签出来的单行 JSON 会多一个 \r，
 * 不折的话本地 --dry 会把每个文件都报成「变了」（CI 是 Linux，没这个问题）。 */
function fp(buf) {
  const body = buf.includes(0)                          /* 二进制片（城市 .bin / 段表）直接哈希 */
    ? buf
    : Buffer.from(
        buf.toString("utf8").replace(/\r\n/g, "\n").replace(/"generated"\s*:\s*"[^"]*"/g, '"generated":"-'),
        "utf8",
      );
  return createHash("sha256").update(body).digest("hex").slice(0, 16);
}
function headFp(rel) {
  const r = spawnSync("git", ["show", "HEAD:" + rel], { cwd: root, maxBuffer: 128 * 1024 * 1024 });
  return r.status === 0 ? fp(r.stdout) : null;          /* null = HEAD 里没有（新文件） */
}

if (!dry) { for (const s of plan.steps) { s(); } }

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
  node("tools/bump-build.mjs");                         /* 数据变了才换缓存戳 */
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
