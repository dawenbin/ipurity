/* screenshot.mjs —— 重画 README 里那两张界面图（docs/screenshot.png / screenshot.en.png）
 *
 * 界面一改，README 里的图就过时；手工截图又容易两张尺寸、示例清单都不一样。
 * 这个脚本用本机的 Edge / Chrome 无头模式跑一遍演示清单，中英各存一张同尺寸的 PNG。
 *
 * 用法：先起静态服务（python -m http.server 8848），然后
 *   node tools/screenshot.mjs
 *   node tools/screenshot.mjs --url http://localhost:8080/ --width 1440 --height 900
 *   node tools/screenshot.mjs --open "C:\\path\\to\\chrome.exe"
 * 找浏览器的顺序：--open > 环境变量 CHROME_PATH > Edge / Chrome 的常见安装位置。
 * 只依赖 Node 自带的 WebSocket 客户端，不装任何 npm 包。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/* 演示清单：一行一个 IP，四种写法都占上（打码 / CIDR / 单个），级别 A 到 D 都有 */
const LIST = [
  "198.*.205.197", "199.*.22.95", "73.*.42.81", "130.*.253.66", "82.24.73.*",
  "198.3.242.0/24", "24.*.164.53", "111.169.14.*", "177.202.126.*", "124.222.147.52"
].join("\n");

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf("--" + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const URL_BASE = arg("url", process.env.SHOT_URL || "http://127.0.0.1:8848/");
const WIDTH = +arg("width", 1600);
const HEIGHT = +arg("height", 1000);

const BROWSERS = [
  process.env.CHROME_PATH,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium"
];

const exe = arg("open", "") || BROWSERS.find((p) => p && existsSync(p));
if (!exe) {
  console.error("没找到 Edge / Chrome，用 --open 指定浏览器可执行文件");
  process.exit(1);
}

/* ---------- 一个够用的 CDP 客户端（Node 自带 WebSocket） ---------- */
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.waiting = new Map();
    this.listeners = new Set();
    ws.onmessage = (ev) => this._onMessage(JSON.parse(ev.data));
  }
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = () => rej(new Error("连不上 DevTools：" + wsUrl));
    });
    return new CDP(ws);
  }
  _onMessage(msg) {
    if (msg.id) {
      const w = this.waiting.get(msg.id);
      if (!w) { return; }
      this.waiting.delete(msg.id);
      msg.error ? w.rej(new Error(msg.error.message)) : w.res(msg.result);
      return;
    }
    for (const l of [...this.listeners]) { l(msg); }
  }
  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    return new Promise((res, rej) => {
      this.waiting.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  once(method, sessionId) {
    return new Promise((res) => {
      const l = (m) => {
        if (m.method !== method || (sessionId && m.sessionId !== sessionId)) { return; }
        this.listeners.delete(l);
        res(m.params);
      };
      this.listeners.add(l);
    });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 浏览器只把 DevTools 地址写在 stderr 里：等它自己报出端口更稳，别去猜 */
async function launch() {
  const profile = mkdtempSync(join(tmpdir(), "ipurity-shot-"));
  const proc = spawn(exe, [
    "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
    "--no-default-browser-check", "--remote-debugging-port=0",
    "--user-data-dir=" + profile, "about:blank"
  ]);
  const wsUrl = await new Promise((res, rej) => {
    let buf = "";
    const timer = setTimeout(() => rej(new Error("浏览器 30 秒没报出 DevTools 地址")), 30000);
    proc.stderr.on("data", (d) => {
      buf += d.toString();
      const m = buf.match(/ws:\/\/[^\s]+/);
      if (m) { clearTimeout(timer); res(m[0]); }
    });
    proc.on("exit", (code) => { clearTimeout(timer); rej(new Error("浏览器退出，code=" + code)); });
  });
  return { proc, wsUrl };
}

const { proc, wsUrl } = await launch();
const cdp = await CDP.connect(wsUrl);

try {
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const send = (m, p) => cdp.send(m, p, sessionId);
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false
  });
  await send("Page.navigate", { url: URL_BASE });
  await cdp.once("Page.loadEventFired", sessionId);

  /* 数据包要下完（IP 归属表 4.1 MB）再点判定，图里才不会全是「未加载」 */
  await sleep(4000);
  await send("Runtime.evaluate", {
    expression: `document.getElementById("input").value = ${JSON.stringify(LIST)};` +
      `document.getElementById("run").click();`
  });

  const rows = "document.querySelectorAll('#tableHost tbody tr').length";
  for (let i = 0; i < 40; i++) {
    const r = await send("Runtime.evaluate", { expression: rows, returnByValue: true });
    if ((r.result.value || 0) >= LIST.split("\n").length) { break; }
    await sleep(500);
  }
  await sleep(4000);   /* 城市数据是边拉边补的，等它落到表里 */

  async function shot(file) {
    const { data } = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(root, file), Buffer.from(data, "base64"));
    console.log(`${file}  ${WIDTH}x${HEIGHT}  ${Math.round(Buffer.from(data, "base64").length / 1024)} KB`);
  }

  /* 无头浏览器默认跟系统语言（en-US）走，所以两张图都得显式点名要哪门语言。
     走 langBtn 那一下而不是 IPI18n.set()：按钮上那个「切过去」的标签也得跟着翻。 */
  async function useLang(code) {
    const cur = await send("Runtime.evaluate", { expression: "window.IPI18n.lang", returnByValue: true });
    if (cur.result.value === code) { return; }
    await send("Runtime.evaluate", { expression: 'document.getElementById("langBtn").click();' });
    await sleep(2000);
  }

  await useLang("zh");
  await shot("docs/screenshot.png");
  await useLang("en");
  await shot("docs/screenshot.en.png");
} finally {
  cdp.ws.close();
  proc.kill();
}
