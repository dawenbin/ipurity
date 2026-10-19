/*
 * tools/refresh-data.mjs —— 数据自动刷新（给 GitHub Actions 用；本地也能跑）
 *
 *   node tools/refresh-data.mjs --asn          # iptoasn + PeeringDB + bad-asn-list → IP 归属表 → 重算标定
 *   node tools/refresh-data.mjs --city         # DB-IP City Lite → 220 个城市片
 *   node tools/refresh-data.mjs --blocklists   # Spamhaus DROP + IPsum + Tor + blocklist.de → 风险名单包
 *   node tools/refresh-data.mjs --cloud        # AWS/GCP/Cloudflare/Azure 段 → 云厂商段包
 *   node tools/refresh-data.mjs --dbip         # DB-IP ASN Lite → 二源分歧包
 *   node tools/refresh-data.mjs --asn --dry    # 只比对指纹，不下载、不打包、不改文件
 *
 * 三条设计原则：
 *   1. **节奏分开**：iptoasn 每天更新；DB-IP 城市/ASN 每月更新；云厂商段每周；
 *      风险名单每天。每个模式由自己的 workflow 调用。
 *   2. **只有数据真的变了才提交**：产物里的 `generated` / `sourceMonth` 等时间戳每次都会变，
 *      比对指纹时必须先抹掉，不然每天都会「假装变了」提交一次 —— 白触发一次 Cloudflare Pages
 *      重建，还会把 33 MB 城市片的 CDN 缓存全部打失效。
 *   3. **没变就还原**：指纹和 HEAD 一致 → git checkout 回产物，不动构建戳，退出码 0。
 *      `asn` / `city` 变了 → 调 tools/bump-build.mjs 换构建戳（HTML/JS/数据 URL 的缓存戳一起换）。
 *      名单/云段/二源分歧是「包内版本」数据：浏览器先取 no-cache 的 meta，再用 ?v=<generated>
 *      取二进制，所以它们变了**不**换全局构建戳，避免每天把城市 CDN 缓存打失效。
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
const ALL_MODES = ["asn", "city", "blocklists", "cloud", "dbip"];
const modes = ALL_MODES.filter((m) => process.argv.includes("--" + m));
if (!modes.length) {
  console.error("用法：node tools/refresh-data.mjs --asn | --city | --blocklists | --cloud | --dbip [--dry]");
  process.exit(2);
}

const PLAN = {
  asn: {
    what: "ASN 层（iptoasn + PeeringDB + bad-asn-list）",
    steps: ["tools/fetch-asn-tables.mjs", "tools/make-global-pack.mjs", "tools/make-calibration.mjs"],
    products: () => ["data/global-pack.bin", "data/global-asn.js", "data/asn-calib.js"],
    stamp: "build",
  },
  city: {
    what: "城市层（DB-IP City Lite）",
    steps: ["tools/fetch-city-tables.mjs", "tools/make-city-packs.mjs"],
    products: () => {
      const dir = join(root, "data", "city");
      if (!existsSync(dir)) { return []; }
      return readdirSync(dir)
        .filter((f) => f === "index.json" || f.endsWith(".bin"))
        .sort()
        .map((f) => "data/city/" + f);
    },
    stamp: "build",
  },
  blocklists: {
    what: "风险名单层（Spamhaus DROP + IPsum + Tor + blocklist.de）",
    steps: ["tools/fetch-blocklists.mjs", "tools/make-blocklists.mjs"],
    products: () => ["data/blocklists.bin", "data/blocklists.js"],
    stamp: "pack",
  },
  cloud: {
    what: "云厂商段层（AWS + GCP + Cloudflare + Azure）",
    steps: ["tools/fetch-cloud-ranges.mjs", "tools/make-cloud-pack.mjs"],
    products: () => ["data/cloud-pack.bin", "data/cloud-meta.js"],
    stamp: "pack",
  },
  dbip: {
    what: "二源 ASN 分歧层（DB-IP ASN Lite vs iptoasn）",
    steps: ["tools/fetch-asn-dbip.mjs", "tools/make-asn-disagreements.mjs"],
    products: () => ["data/asn-disagree.bin", "data/asn-disagree.js"],
    stamp: "pack",
  },
};

function run(script) {
  console.log(`\n$ node ${script}`);
  const r = spawnSync(process.execPath, [script], { cwd: root, stdio: "inherit" });
  if (r.status !== 0) { throw new Error(`${script} 退出码 ${r.status}`); }
}

/* 指纹：产物里的时间戳每次都变，先抹掉再哈希，只比“数据本身”。
   注意：新增的包用「包内版本」缓存，所以 sourceMonth / comparedAgainst 也一并抹掉。 */
function fp(buf) {
  const body = buf.includes(0)                          /* 二进制片（城市 .bin / 段表 / 新包）直接哈希 */
    ? buf
    : Buffer.from(buf.toString("utf8")
      .replace(/"generated"\s*:\s*"[^"]*"/g, '"generated":"-"')
      .replace(/"fetchedAt"\s*:\s*"[^"]*"/g, '"fetchedAt":"-"')
      .replace(/"sourceMonth"\s*:\s*"[^"]*"/g, '"sourceMonth":"-"')
      .replace(/"comparedAgainst"\s*:\s*"[^"]*"/g, '"comparedAgainst":"-"')
      .replace(/"syncToken"\s*:\s*"[^"]*"/g, '"syncToken":"-"')
      .replace(/"createDate"\s*:\s*"[^"]*"/g, '"createDate":"-"')
      .replace(/"changeNumber"\s*:\s*[^,}\s]+/g, '"changeNumber":"-"'), "utf8");
  return createHash("sha256").update(body).digest("hex").slice(0, 16);
}
function headFp(rel) {
  const r = spawnSync("git", ["show", "HEAD:" + rel], { cwd: root, maxBuffer: 128 * 1024 * 1024 });
  return r.status === 0 ? fp(r.stdout) : null;          /* null = HEAD 里没有（新文件） */
}

let changedAny = false;
let buildChanged = false;

for (const mode of modes) {
  const plan = PLAN[mode];
  if (!dry) { for (const s of plan.steps) { run(s); } }

  const products = plan.products();
  const rows = products.map((rel) => {
    const p = join(root, rel);
    const now = existsSync(p) ? fp(readFileSync(p)) : null;
    const head = headFp(rel);
    return { rel, now, head, same: now !== null && now === head };
  });
  const changed = rows.some((r) => !r.same);
  changedAny = changedAny || changed;

  console.log(`\n${plan.what}：产物 ${rows.length} 个`);
  if (changed) {
    rows.filter((r) => !r.same).forEach((r) => console.log(`  变了 ${r.rel}  HEAD=${r.head || "(新)"} → ${r.now}`));
  } else {
    console.log("  指纹与 HEAD 完全一致，数据没变。");
  }

  if (dry) { continue; }
  if (changed) {
    if (plan.stamp === "build") { buildChanged = true; }
  } else {
    const tracked = rows.filter((r) => r.head).map((r) => r.rel);
    if (tracked.length) {
      const r = spawnSync("git", ["checkout", "--", ...tracked], { cwd: root, stdio: "inherit" });
      if (r.status !== 0) { throw new Error("git checkout 还原产物失败"); }
    }
    console.log(`已把 ${tracked.length} 个产物还原成 HEAD（只有时间戳不同，不算数据变化）。`);
  }
}

if (dry) {
  console.log("\n[干跑] 没动任何文件。");
} else if (buildChanged) {
  run("tools/bump-build.mjs");                          /* 只有 asn / city 变化才换全局缓存戳 */
} else if (changedAny) {
  console.log("\n只更新了包内版本数据（blocklists/cloud/dbip），不换全局构建戳。");
}

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changedAny}\n`);
}
console.log(`\nchanged=${changedAny}`);
