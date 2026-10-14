/* 页面接线自检：index.html 的 id 是否能满足 assets/app.js 的引用、资源是否都在
   （node test/test-page.mjs，不依赖无头浏览器） */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(root, "index.html"), "utf8");
const app = readFileSync(join(root, "assets", "app.js"), "utf8");
const core = readFileSync(join(root, "assets", "core.js"), "utf8");

let fail = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  if (!cond) fail++;
};

const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
// app.js 自己也会在详情面板里动态插入带 id 的节点（如 heat / copyRow / closeD）
for (const m of app.matchAll(/\sid=\\?["']([A-Za-z0-9_-]+)\\?["']/g)) { ids.add(m[1]); }
const refs = new Set(
  [...app.matchAll(/(?:getElementById\(|\$\(\s*)['"`]([A-Za-z0-9_-]+)['"`]/g)].map((m) => m[1])
);
const missing = [...refs].filter((r) => !ids.has(r));
check("app.js 引用的 id 都有对应节点（静态或动态插入）", missing.length === 0, missing.join(", "));

/* 资源 URL 允许带 ?v=<build> 缓存戳，校验时把查询串去掉再找文件 */
const assets = [...html.matchAll(/(?:src|href)="([^":?]+\.(?:js|css))(?:\?[^"]*)?"/g)].map((m) => m[1]);
const gone = assets.filter((a) => !existsSync(join(root, a)));
check("index.html 引用的本地资源都存在", gone.length === 0, gone.join(", "));
/* 缓存戳：资源版本必须跟 meta[name=build] 一致，否则会出现「新 HTML + 旧 JS」 */
const build = (html.match(/<meta name="build" content="([^"]+)">/) || [])[1];
const stamps = [...html.matchAll(/(?:src|href)="(?:data|assets)\/[^"?]+\?v=([^"]+)"/g)].map((m) => m[1]);
check("meta[name=build] 存在", !!build, String(build));
check(`所有本地脚本都带同一个构建戳（${stamps.length} 个）`,
  stamps.length >= 8 && stamps.every((s) => s === build), [...new Set(stamps)].join(", "));
check("index.html 引用了数据包", assets.includes("data/segments-data.js"), assets.join(", "));
check("index.html 引用了城市包与全球段表", assets.includes("assets/city.js") && assets.includes("assets/sources.js"), assets.join(", "));

// 全球段表 / 城市层的数据文件必须都在（静态托管靠它们兜底）
for (const f of ["data/global-pack.bin", "data/global-asn.js", "data/asn-calib.js", "data/city/index.json"]) {
  check(`存在 ${f}`, existsSync(join(root, f)));
}

// 数据包与核心的约定：字段齐全、每个前缀的 c/i/g 都是 256 位
const data = JSON.parse(readFileSync(join(root, "data", "segments-data.json"), "utf8"));
const badShape = [];
for (const [key, p] of Object.entries(data.prefixes)) {
  const c = String(p.c).split(","), i = String(p.i).split(","), g = String(p.g).split(",");
  if (c.length !== 256 || i.length !== 256 || g.length !== 256) {
    badShape.push(`${key}: c=${c.length} i=${i.length} g=${g.length}`);
  }
}
check(`数据包 ${Object.keys(data.prefixes).length} 个前缀均为 256 位`, badShape.length === 0, badShape.slice(0, 3).join(" | "));

check("core.js 在浏览器里挂到 window.AdvisorCore", /root\.AdvisorCore\s*=/.test(core));

// 语法自检：一个引号写错就能让整页白屏（app.js 挂掉后页面只剩静态文案），
// 所以每个本地 JS 都要能被解析。数据包体量大，只做语法解析不执行。
for (const a of assets.filter((x) => x.endsWith(".js"))) {
  let err = "";
  try {
    new vm.Script(readFileSync(join(root, a), "utf8"), { filename: a });
  } catch (e) {
    err = e.message.split("\n")[0];
  }
  check(`${a} 语法可解析`, !err, err);
}

console.log(fail === 0 ? "\n页面接线自检通过 ✅" : `\n${fail} 项失败 ❌`);
process.exit(fail === 0 ? 0 : 1);
