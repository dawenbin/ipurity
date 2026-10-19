/*
 * tools/fetch-cloud-ranges.mjs —— 拉四家云厂商的公开 IPv4 段到 build/cloud/
 *
 *   node tools/fetch-cloud-ranges.mjs
 *
 *   aws.json        AWS ip-ranges.json           prefixes[].ip_prefix
 *   gcp.json        GCP cloud.json               prefixes[].ipv4Prefix
 *   cloudflare.txt  Cloudflare ips-v4            一行一个 CIDR
 *   azure.json      Azure Service Tags           官方下载页里的 JSON 链接（best-effort）
 *
 * 这些段是「确定性机房」：整 /24 落在里面，就不可能是住宅 IP。
 * 单源失败沿用上一次的文件（和 fetch-blocklists.mjs 一样），只有 AWS/GCP/Cloudflare
 * 三家都没拉到、也没有旧文件时才退出 1。Azure 的下载链接会轮换，取不到就跳过，
 * 并在 status.json 里写清楚，不影响其他三家。
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "build", "cloud");
mkdirSync(dir, { recursive: true });

const UA = "ipurity-cloud-fetcher/1.0 (+https://github.com/dawenbin/ipurity)";

const SOURCES = [
  {
    id: "aws", file: "aws.json", core: true, type: "json",
    url: "https://ip-ranges.amazonaws.com/ip-ranges.json"
  },
  {
    id: "gcp", file: "gcp.json", core: true, type: "json",
    url: "https://www.gstatic.com/ipranges/cloud.json"
  },
  {
    id: "cloudflare", file: "cloudflare.txt", core: true, type: "text",
    url: "https://www.cloudflare.com/ips-v4"
  },
  {
    id: "azure", file: "azure.json", core: false, type: "json",
    url: "",                                  /* 运行时解析，见 azureUrls() */
    note: "Service Tags 下载链接会轮换；取不到时只跳过 Azure"
  }
];

const AZURE_PAGE = "https://www.microsoft.com/en-us/download/details.aspx?id=56519";
const AZURE_GUID = "71D86715-5596-4529-9B13-DA13A5DE5B63";

function mondayStamp(offsetWeeks) {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  const sinceMonday = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - sinceMonday - offsetWeeks * 7);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
}

/* Azure 的下载页是 HTML，真正的 JSON 文件名带日期。先抓页面找链接；找不到就按
   「最近 8 个周一 + 经典 GUID」试。全都失败就返回空数组，让上层跳过 Azure。 */
async function azureUrls() {
  const out = [];
  try {
    const res = await fetch(AZURE_PAGE, { headers: { "user-agent": UA, accept: "text/html,*/*" } });
    if (res.ok) {
      const html = await res.text();
      const m = html.match(/https:\/\/download\.microsoft\.com\/download\/[^"'\s<>]+?\/ServiceTags_Public_\d{8}\.json/);
      if (m) { out.push(m[0].replace(/&amp;/g, "&")); }
    }
  } catch (e) { /* 页面取不到就走兜底 */ }
  for (let i = 0; i < 8; i++) {
    const url = `https://download.microsoft.com/download/7/1/D/${AZURE_GUID}/ServiceTags_Public_${mondayStamp(i)}.json`;
    if (!out.includes(url)) { out.push(url); }
  }
  return out;
}

async function grab(src) {
  const urls = src.id === "azure" ? await azureUrls() : [src.url];
  if (!urls.length) {
    const kept = existsSync(join(dir, src.file));
    return { id: src.id, ok: false, error: "没有可用的下载链接", note: kept ? "沿用上一次的文件" : "这一源本次跳过" };
  }
  let lastError = "";
  for (const url of urls) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await fetch(url, {
          headers: { "user-agent": UA, accept: src.type === "json" ? "application/json,*/*" : "text/plain,*/*" }
        });
        if (!res.ok) { throw new Error("HTTP " + res.status); }
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < 64) { throw new Error("内容太短（" + buf.length + " 字节），像是错误页"); }
        writeFileSync(join(dir, src.file), buf);
        const sha = createHash("sha256").update(buf).digest("hex").slice(0, 12);
        return { id: src.id, ok: true, url, bytes: buf.length, sha, note: "已更新" };
      } catch (e) {
        lastError = String((e && e.message) || e);
        if (attempt === 1) { await new Promise((r) => setTimeout(r, 2500)); }
      }
    }
  }
  const kept = existsSync(join(dir, src.file));
  return { id: src.id, ok: false, error: lastError, note: kept ? "沿用上一次的文件" : "没有可用文件（这一源本次跳过）" };
}

const log = [];
for (const s of SOURCES) {
  const r = await grab(s);
  const line = r.ok
    ? `${r.id.padEnd(12)} OK    ${String(r.bytes).padStart(9)} 字节  sha256:${r.sha}  ${r.url}`
    : `${r.id.padEnd(12)} 失败  ${r.error}  → ${r.note}`;
  console.log(line);
  log.push({ id: s.id, ok: r.ok, url: r.url || s.url || "", bytes: r.bytes || 0, sha: r.sha || "", error: r.error || "", note: r.note });
}

const fetchedAt = new Date().toISOString();
writeFileSync(join(dir, "status.json"), JSON.stringify({ fetchedAt, sources: log }, null, 2) + "\n");
writeFileSync(join(dir, "fetched-at.txt"), fetchedAt + "\n");

const coreOk = log.filter((r) => r.ok && SOURCES.find((s) => s.id === r.id).core).length;
const coreHave = SOURCES.filter((s) => s.core).filter((s) => existsSync(join(dir, s.file))).length;
console.log(`\n核心源 ${coreOk}/3 已更新；本地可用核心文件 ${coreHave}/3。`);
if (coreHave === 0) { process.exit(1); }
