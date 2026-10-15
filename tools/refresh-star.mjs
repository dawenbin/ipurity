/* refresh-star.mjs —— 取仓库星数，写进 data/star.json（页面顶栏那个数字的唯一出处）
 *
 * 为什么落成文件而不是页面直接调 GitHub 接口：
 *   - 匿名接口每个 IP 每小时只有 60 次，被限流时页面上就只剩一个图标；
 *   - 站点一直写着「不发第三方请求」，这个数字属于仓库自己的数据，走本站域名最干净。
 *
 * 用法：node tools/refresh-star.mjs                    （匿名额度，够用）
 *      GITHUB_TOKEN=xxx node tools/refresh-star.mjs    （定时任务里用，不占匿名额度）
 * 星数没变就什么都不写 —— 免得每天白触发一次 Pages 重建。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(root, "data", "star.json");
const REPO = "dawenbin/ipurity";

const headers = { Accept: "application/vnd.github+json", "User-Agent": "ipurity-refresh-star" };
if (process.env.GITHUB_TOKEN) { headers.Authorization = "Bearer " + process.env.GITHUB_TOKEN; }

const api = process.env.GITHUB_API_URL || "https://api.github.com";
const res = await fetch(`${api}/repos/${REPO}`, { headers });
if (!res.ok) {
  console.error(`GitHub 接口返回 HTTP ${res.status}，本次不更新`);
  process.exit(1);
}
const stars = (await res.json()).stargazers_count;
if (!Number.isInteger(stars) || stars < 0) {
  console.error(`星数不是整数（${stars}），本次不更新`);
  process.exit(1);
}

let prev = null;
try { prev = JSON.parse(readFileSync(OUT, "utf8")); } catch (e) {}
let changed = false;
if (prev && prev.stars === stars) {
  console.log(`星数没变（${stars}），不写文件`);
} else {
  const next = { stars: stars, updated: new Date().toISOString().slice(0, 10) };
  writeFileSync(OUT, JSON.stringify(next, null, 2) + "\n");
  changed = true;
  console.log(`${prev ? prev.stars : "—"} → ${stars}`);
}

/* 定时任务用它判断要不要提交：changed=true 才 commit（沿用 refresh-data.mjs 的口径） */
if (process.env.GITHUB_OUTPUT) {
  writeFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\n`, { flag: "a" });
}
