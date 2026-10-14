/*
 * 构建戳 +1（index.html 的 meta[name=build] 与所有 ?v= 一起换）
 *   node tools/bump-build.mjs
 *
 * 为什么存在：脚本/数据的 URL 都带 ?v=<build>，静态托管和 CDN 缓存大文件 ——
 * 不换 URL 就会「新 HTML + 旧 JS」。改过 assets/ data/ index.html 就要换一次，
 * 数据刷新脚本（tools/refresh-data.mjs）也用它，所以放进仓库而不是留在本地。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const file = join(root, "index.html");

/* index.html 是 CRLF：按 LF 处理再还原，避免把整个文件的行尾改掉 */
const crlf = readFileSync(file, "utf8").indexOf("\r\n") >= 0;
let s = readFileSync(file, "utf8").split("\r\n").join("\n");

const cur = (/<meta name="build" content="([^"]+)">/.exec(s) || [])[1];
if (!cur) { throw new Error("index.html 里找不到 meta[name=build]"); }

/* 形如 20261014u：日期 + 字母。同一天就往后数；跨天就从 a 重新开始 */
const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
const m = /^(\d{8})([a-z]+)$/.exec(cur);
let next;
if (m && m[1] === today) {
  next = m[1] + toLetters(fromLetters(m[2]) + 1);
} else if (m) {
  next = today + "a";
} else {
  next = today + "a";                       /* 老格式（非「日期+字母」）一律换成新格式 */
}

/* a→z→aa→ab：过了 z 就得进位续写，不能绕回 a ——
 * 绕回 a 会和今天早些时候的构建戳撞车，浏览器/CDN 命中旧缓存就是「新 HTML + 旧 JS」。 */
function fromLetters(s) {
  let n = 0;
  for (const ch of s) { n = n * 26 + (ch.charCodeAt(0) - 96); }   /* a = 1 … z = 26 */
  return n;
}
function toLetters(n) {
  let s = "";
  while (n > 0) { s = String.fromCharCode(97 + (n - 1) % 26) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

const n = s.split(cur).length - 1;
s = s.split(cur).join(next);
writeFileSync(file, crlf ? s.split("\n").join("\r\n") : s);
console.log(`build ${cur} -> ${next}（${n} 处）`);
