/*
 * 生成「测试批次的预期结果」清单
 *   node tools/make-batch-expected.mjs
 *
 * 为什么是生成的：预期值手抄一定会错（改一次判定口径，抄下来的表就开始骗人）。
 * 这里拿 test/batch-test.txt 真跑一遍，把结果写成勾选表 —— 你在浏览器里粘同一份，
 * 逐行对着这张表核。表里是**离线判定**的结果（不含联网核验，那是你点按钮才发生的）。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const Core = require(join(root, "assets/core.js"));
const World = require(join(root, "assets/sources.js"));
const City = require(join(root, "assets/city.js"));

World.putPack(readFileSync(join(root, "data/global-pack.bin")));
World.setMeta(JSON.parse(readFileSync(join(root, "data/global-asn.js"), "utf8")
  .match(/window\.GLOBAL_ASN\s*=\s*([\s\S]*?);?\s*$/)[1]));
const cal = readFileSync(join(root, "data/asn-calib.js"), "utf8").match(/window\.ASN_CALIB\s*=\s*([\s\S]*?);?\s*$/);
if (cal) { World.setCalib(JSON.parse(cal[1])); }
/* 城市分片按需加载：切片不在磁盘上就当没加载，如实写「—」 */
for (const f of ["198", "50", "171", "82", "73", "207", "69", "8", "1", "43"]) {
  try { City.put(+f, readFileSync(join(root, "data/city", f + ".bin"))); } catch (e) { /* 切片不在就跳过 */ }
}

const batchPath = join(root, "test/batch-test.txt");
const text = readFileSync(batchPath, "utf8");
const rep = Core.parseWithReport(text);
const res = Core.analyzeMany(rep.items, null, { world: World, cityPack: City });
const ranked = Core.rankRows(res.rows);

/* 解析来源行：让清单按批次文件里的小节分组，而不是按排名顺序 —— 核的时候好找 */
const byLine = {};
ranked.forEach((r) => { (byLine[r.sourceLine] = byLine[r.sourceLine] || []).push(r); });
const lines = text.replace(/\r\n/g, "\n").split("\n");
const groups = [];
let cur = null;
lines.forEach((line, i) => {
  const t = line.trim();
  if (/^#/.test(t)) {
    /* 只有「# ---------- 标题 ----------」那种带横线的才是分节标题；
       文件头那些纯 `# 说明…` 不是分组，别让它们占一节。 */
    if (!/-{2,}/.test(t)) { return; }
    const title = t.replace(/^#+/, "").replace(/-{2,}/g, " ").trim();
    if (title) { cur = { title, rows: [] }; groups.push(cur); }
    return;
  }
  if (!t) { return; }
  const hit = byLine[i + 1];
  if (!hit) { return; }
  if (!cur) { cur = { title: "(未分组)", rows: [] }; groups.push(cur); }
  hit.forEach((r) => cur.rows.push({ input: t, r }));
});
/* 组内按「你粘的顺序」排，不按排名 —— 核的时候从上往下对着看，不用来回跳 */
groups.forEach((g) => g.rows.sort((a, b) => a.r.sourceLine - b.r.sourceLine || a.r.rank - b.r.rank));

const srcName = (r) => r.source === "联网核验" ? "联网核验" : (r.source === "全球ASN" ? "IP 归属表" : (r.source || "实测记录"));
const cell = (v) => (v === undefined || v === null || v === "") ? "—" : String(v);

const out = [];
out.push("# 测试批次的预期结果");
out.push("");
out.push("对着这张表核：把 [`test/batch-test.txt`](batch-test.txt) 整份粘进页面点「判定」，逐行比。");
out.push("");
out.push("> 本文件由 `node tools/make-batch-expected.mjs` 从批次文件**真跑一遍**生成，请勿手改。");
out.push("> 表里是**离线判定**的结果 ——「联网核验」「实测取证」是你点按钮才发生的，不在这里。");
out.push("");
out.push(`**批次规模**：${rep.items.length} 行结果 · 未识别 ${rep.unmatched.length} · 重复（同一写法出现多次只算一条）${rep.duplicateCount}`);
out.push("");
out.push(`**统计条应该是**：全部 ${rep.items.length} · A ${res.counts.A} · B ${res.counts.B} · C ${res.counts.C} · D ${res.counts.D} · 未识别/缺数据 ${res.counts.fail} · 推荐行（A+B）${res.counts.A + res.counts.B}`);
out.push("");
out.push("> 说明：`#` 开头的注释行不参与判定，也不会出现在「未识别」里。");
out.push("> 打码行（`198.*.42.81`）和 CIDR（`198.3.242.0/24`）会展开成多个 /24，所以结果行数多于你粘的行数。");
out.push("");
out.push("---");
out.push("");

for (const g of groups) {
  out.push(`## ${g.title}`);
  out.push("");
  out.push("| # | 你粘的 | 级别 | 级别说明 | 住宅 | 主要城市 | 来源 | 得分 |");
  out.push("| --: | :-- | :-- | :-- | :-- | :-- | :-- | --: |");
  for (const { input, r } of g.rows) {
    const tier = r.reserved ? "不可路由" : (r.ok ? r.tier : "—");
    const why = r.reserved ? "不参与排名与得分" : (r.ok ? r.tierText : (r.reason || ""));
    const home = r.reserved ? "不可路由" : Core.homeTxt(r);
    const city = (r.city && r.city.city) || "—";
    out.push(`| ${r.rank} | \`${input}\` → \`${r.pattern}\` | **${tier}** | ${why} | ${home} | ${cell(city)} | ${r.reserved ? "—" : srcName(r)} | ${Core.rowScore(r)} |`);
  }
  out.push("");
}

out.push("---");
out.push("");
out.push("## 怎么算通过");
out.push("");
out.push("- 表里每一行的**级别**和**得分**跟页面上一致 → 判定层没问题。");
out.push("- 页面顶上统计条的数字 == 上面「统计条应该是」那一行 → 汇总没问题。");
out.push("- 结果行数 == 批次规模里的数字 → 解析层没漏行（一行多个 IP 也要全收）。");
out.push("- 出现任何「未识别」都是 bug（这批里没有该认不出的东西）。");
out.push("");
out.push("## 界面上自检覆盖不到、值得顺手看的");
out.push("");
out.push("- 详情面板**不再有**「建议拿」那一格（工具只看到 /24 这一层，挑不出更该拿的那个）。");
out.push("- 不可路由的行排在最末，级别那格写「不可路由」，不是「—」。");
out.push("- 「未识别/缺数据」那格的数字 = 12（这批全是不可路由），点它能筛出这 12 行。");
out.push("- 导出的排名 CSV 里**没有**「建议拿的 IP」这一列，列数仍然对齐。");
out.push("- 中英切换：`不可路由` ↔ `Unroutable`，`级别说明`、`来源`、`得分` 一列都不留中文。");

writeFileSync(join(root, "test", "batch-test.expected.md"), out.join("\n"));
console.log(`test/batch-test.expected.md 已生成：${rep.items.length} 行结果 / ${groups.length} 个分组 / 未识别 ${rep.unmatched.length}`);
