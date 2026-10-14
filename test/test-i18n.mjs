/* 多语言自检：界面上的每一句话都得有英文 —— 留一句中文就是中英混排。
   做法是拿 index.html 里真正的文案（中文那半边）和 app.js 拼出来的关键句子过一遍词条表，
   翻完还留汉字的就算漏翻。不跑浏览器，纯文本级检查。
   node test/test-i18n.mjs */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const I18n = require(join(root, "assets", "i18n.js")).IPI18n;

let fail = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  if (!cond) fail++;
};
const en = (s) => I18n.t(s, "en");
/* 词条表的判据和引擎一致：汉字 + 中文标点都算「还没翻」 */
const CJK = /[\u4e00-\u9fa5\u3000-\u303f\uff01-\uff60\uffe0-\uffe6]/;

const htmlRaw = readFileSync(join(root, "index.html"), "utf8");

/* ---------- 1. index.html 里的中文属性（悬停 / 无障碍标签） ---------- */
/* 规则页英文那份是手写的、不走词条表 —— 检查前把它摘掉，免得拿它当「已翻译」的证据 */
/* 规则页两份都是手写的：中文那份只切显示、不走词条表，所以两边都摘掉，
   单独用「中英条数一致 + 英文那份没有中文」来保证。 */
const zhSide = htmlRaw
  .replace(/<div data-lang="en"[\s\S]*?\r?\n\s*<\/div>/, "")
  .replace(/<div data-lang="zh">[\s\S]*?\r?\n\s*<\/div>/, "");
const unesc = (s) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&#x?[0-9a-fA-F]+;/g, " ");
const attrs = [...zhSide.matchAll(/\s(title|aria-label)="([^"]*)"/g)].map((m) => unesc(m[2]));
const leftovers = attrs.filter((a) => CJK.test(a) && CJK.test(en(a)));
check(`index.html 的 title / aria-label 全部有英文（${attrs.filter((a) => CJK.test(a)).length} 条）`,
  leftovers.length === 0, leftovers.map((x) => x.slice(0, 60) + " → " + en(x).slice(0, 80)).join(" ｜ "));

/* ---------- 2. index.html 里的中文正文 ---------- */
const bodyText = zhSide
  .replace(/<script[\s\S]*?<\/script>/g, "\n")
  .replace(/<style[\s\S]*?<\/style>/g, "\n")
  .replace(/<textarea[\s\S]*?<\/textarea>/g, "\n")   /* 占位符走 SPECIAL，下面单独查 */
  .replace(/<!--[\s\S]*?-->/g, "\n")
  .replace(/<[^>]+>/g, "")
  .split(/\r?\n/)
  .map((l) => unesc(l).trim())
  .filter((l) => CJK.test(l));
const bodyBad = bodyText.filter((l) => CJK.test(en(l)));
check(`index.html 的正文全部有英文（${bodyText.length} 段）`,
  bodyBad.length === 0, bodyBad.slice(0, 4).map((x) => x.slice(0, 70) + " → " + en(x).slice(0, 90)).join(" ｜ "));

/* ---------- 3. 输入框占位符（SPECIAL，不走词条表） ---------- */
const ph = ((I18n.special || {})["#input"] || {}).placeholder || {};
check("占位符每种语言都有一份", Object.keys(ph).length === I18n.langs.length, Object.keys(ph).join(","));
Object.keys(ph).forEach((code) => {
  if (code === "zh") { return; }
  check(`占位符 ${code} 全是目标语言`, !CJK.test(ph[code]));
});
const domPh = ((htmlRaw.match(/<textarea id="input"[\s\S]*?placeholder="([\s\S]*?)"><\/textarea>/) || [])[1] || "")
  .replace(/\r\n/g, "\n");
check("占位符与 DOM 里那份一致（两处都改了才不算漏）", domPh === ph.zh);

/* ---------- 4. app.js / core.js / report.js 拼出来的句子 ---------- */
/* 这些是 JS 一处一处拼的，过不了 HTML 那道关，得点名抽几条最容易漏翻的 */
const live = [
  "实测记录：住宅网段数 / 样本数 · 占比",                            /* 「住宅」那格的口径 */
  "IP 归属表：按 ASN 住宅先验对 254 个取值做概率加权折算（≈ 表示不是逐个实测），占比按 ASN 级不确定性封顶 90%",
  "实测记录里没有这一行，级别是用 IP 归属表推的（上限）",
  "按 IP 定位 · 城市数据 DB-IP",
  "取自扫描记录 · 实测记录",
  "ASN 级估算 · 只看得到 ASN，级别是上限",
  "IP 归属表 · 按运营商估算：这个网段归 AS9318 住宅ISP，占比按 ASN 先验折算（不是逐段实测）",
  "实测记录（ip-api）· 82.24.73.0/24 整段归 住宅ISP · 落在洛杉矶都会区",
  "接口都没成功", "没接口可试：ip-api 免费版只有 http，https 页面用不了",
  "超时（9 秒没回应）", "网络或跨域失败", "解析器返回 Status 2（没给出答案）",
  "接口实测（单 IP）", "未获取 —— 接口都没成功", "各来源说这个 IP 在哪",
  "点「实测取证」查这个 IP 的 RDAP 注册记录 · 反向解析 PTR · Team Cymru 与 RIPEstat 两路 BGP · Shodan InternetDB 扫描记录 ——",
  "离线库只到 ASN 这一层，认不出同一个 ASN 里的机房段。",
  "整行联网核验", "这一行的联网核验没成功", "联网核验没成功（接口都没成功），这一行还是 ASN 级估算。",
  "机房/机构（联网核验）", "该 ASN 类型先验", "位置对比（不一致 = 该 IP 在广播）"
];
const liveBad = live.filter((s) => CJK.test(s) && CJK.test(en(s)));
check(`关键句子全部有英文（${live.length} 句）`, liveBad.length === 0,
  liveBad.map((x) => x.slice(0, 50) + " → " + en(x).slice(0, 70)).join(" ｜ "));

/* ---------- 5. 词条表本身：别留重复键、别留空译文 ---------- */
const entries = I18n.entries || [];
const seen = {}, dup = [];
entries.forEach((e) => {
  const src = e[0].source;
  if (seen[src]) { dup.push(src); }
  seen[src] = true;
});
check("词条表没有重复的正则（重复的短键会永远轮不到，是死条目）", dup.length === 0, dup.join(" ｜ "));
const missing = entries.filter((e) => e[1] == null);
check("每条词条都有英文列", missing.length === 0, missing.map((e) => e[0].source).join(" ｜ "));
const cjkEn = entries
  .filter((e) => typeof e[1] === "string" && CJK.test(e[1]))
  .map((e) => e[0].source + " → " + e[1]);
check("英文列里没有残留中文", cjkEn.length === 0, cjkEn.join(" ｜ "));

/* ---------- 6. 规则页中英两份要一条对一条 ---------- */
const liCount = (lang) => {
  const m = htmlRaw.match(new RegExp(`<div data-lang="${lang}"[\\s\\S]*?</div>`));
  return m ? (m[0].match(/<li>/g) || []).length : 0;
};
check("规则页中英条数一致", liCount("zh") > 0 && liCount("zh") === liCount("en"), `zh ${liCount("zh")} / en ${liCount("en")}`);
const enBlock = (htmlRaw.match(/<div data-lang="en"[\s\S]*?<\/div>/) || [""])[0].replace(/<[^>]+>/g, " ");
check("规则页英文那份没有中文", !CJK.test(enBlock), (enBlock.match(/[\u4e00-\u9fa5]+/g) || []).slice(0, 5).join(" "));

console.log(fail === 0 ? "\n多语言自检通过 ✅" : `\n${fail} 项失败 ❌`);
process.exit(fail === 0 ? 0 : 1);
