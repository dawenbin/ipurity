/*
 * tools/fetch-blocklists.mjs —— 拉四个免费名单到 build/blocklists/
 *
 *   node tools/fetch-blocklists.mjs
 *
 *   drop.txt         Spamhaus DROP    CIDR 列表（电信级被劫持/被接管的段）
 *   ipsum.txt        IPsum            聚合列表，格式 "IP<TAB>被几个名单收录"
 *   tor-exits.txt    Tor Project      当前 Tor 出口节点（一个 IP 一行）
 *   blocklistde.txt  blocklist.de     攻击来源 IP（一个 IP 一行）
 *
 * 四个都是免 key 的纯文本下载（注意：Spamhaus / blocklist.de 商用需要各自授权，
 * 详见仓库根目录 NOTICE）。某个源挂了不报错退出 —— 沿用上一次的文件，日志里写明，
 * 免得一个第三方站点抽风就让每天的数据刷新整体失败。
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "build", "blocklists");
mkdirSync(dir, { recursive: true });

const SOURCES = [
  { id: "drop", file: "drop.txt", url: "https://www.spamhaus.org/drop/drop.txt" },
  { id: "ipsum", file: "ipsum.txt", url: "https://raw.githubusercontent.com/stamparm/ipsum/master/ipsum.txt" },
  { id: "tor", file: "tor-exits.txt", url: "https://check.torproject.org/torbulkexitlist" },
  { id: "blocklistde", file: "blocklistde.txt", url: "https://lists.blocklist.de/lists/all.txt" }
];

const UA = "ipurity-blocklist-fetcher/1.0 (+https://github.com/dawenbin/ipurity)";
const log = [];

async function grab(src) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(src.url, { headers: { "user-agent": UA, accept: "text/plain,*/*" } });
      if (!res.ok) { throw new Error("HTTP " + res.status); }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 64) { throw new Error("内容太短（" + buf.length + " 字节），像是错误页"); }
      writeFileSync(join(dir, src.file), buf);
      const sha = createHash("sha256").update(buf).digest("hex").slice(0, 12);
      return { id: src.id, ok: true, bytes: buf.length, sha: sha, note: "已更新" };
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (attempt === 2) {
        const kept = existsSync(join(dir, src.file));
        return { id: src.id, ok: false, error: msg, note: kept ? "沿用上一次的文件" : "没有可用文件（这一源本次跳过）" };
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

for (const s of SOURCES) {
  const r = await grab(s);
  const line = r.ok
    ? `${r.id.padEnd(12)} OK    ${String(r.bytes).padStart(9)} 字节  sha256:${r.sha}  ${s.url}`
    : `${r.id.padEnd(12)} 失败  ${r.error}  → ${r.note}`;
  console.log(line);
  log.push(line);
}

writeFileSync(join(dir, "fetch.log"), log.join("\n") + "\n");
writeFileSync(join(dir, "fetched-at.txt"), new Date().toISOString() + "\n");

const okCount = log.filter((l) => l.includes(" OK ")).length;
console.log(`\n${okCount}/${SOURCES.length} 个源已更新，文件在 build/blocklists/`);
/* 一个都没拉到才算失败；部分失败就走上一次的文件继续打包 */
if (okCount === 0) { process.exit(1); }
