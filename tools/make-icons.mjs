/*
 * tools/make-icons.mjs —— 把 assets/icon.svg 渲染成 PWA 需要的 192 / 512 PNG
 *
 *   node tools/make-icons.mjs
 *
 * 只在需要更新图标时手动跑一次（产物提交进仓库，CI 不跑）。
 * 用本机 Edge / Chrome 的无头截图，不装任何 npm 包。
 */
import { existsSync, mkdirSync, rmSync, writeFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = join(root, "build", "tmp", "icons");
mkdirSync(tmp, { recursive: true });

const BROWSERS = [
  process.env.CHROME_PATH,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser"
].filter(Boolean);
const browser = BROWSERS.find((p) => existsSync(p));
if (!browser) {
  console.error("找不到 Edge / Chrome。用 CHROME_PATH 指定浏览器路径，或手动把 icon.svg 导出成 192/512 PNG。");
  process.exit(2);
}

const svgUrl = pathToFileURL(join(root, "assets", "icon.svg")).href;

for (const size of [192, 512]) {
  const html = join(tmp, "icon-" + size + ".html");
  const out = join(root, "assets", "icon-" + size + ".png");
  writeFileSync(html,
    '<!doctype html><html><head><meta charset="utf-8"><style>' +
    'html,body{margin:0;padding:0;background:transparent;overflow:hidden}' +
    'img{display:block;width:' + size + "px;height:" + size + "px}" +
    '</style></head><body><img src="' + svgUrl + '" alt=""></body></html>\n');
  const r = spawnSync(browser, [
    "--headless=new", "--disable-gpu", "--hide-scrollbars",
    "--force-device-scale-factor=1", "--virtual-time-budget=1500",
    "--window-size=" + size + "," + size,
    "--screenshot=" + out,
    pathToFileURL(html).href
  ], { stdio: "inherit" });
  if (r.status !== 0 || !existsSync(out) || statSync(out).size < 100) {
    console.error("渲染 " + size + "px 图标失败");
    process.exit(1);
  }
  console.log("→ assets/icon-" + size + ".png（" + Math.round(statSync(out).size / 1024) + " KB）");
}

rmSync(tmp, { recursive: true, force: true });
