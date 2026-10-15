/*
 * 生成 tests.md 测试清单（从自检的实际输出导，不手写）
 *   node tools/make-test-checklist.mjs          # 跑一遍自检并重新生成
 *   node tools/make-test-checklist.mjs --dry     # 只打印，不写文件
 *
 * 为什么是生成的：手写的清单一定会和测试漂移（加了一条断言忘了补文档，
 * 清单就开始骗人）。这里直接把 run-all.mjs 的输出解析成勾选表 ——
 * 每一条断言都是实际跑出来的，通过就打勾，失败就留空并标出来。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/* 每个测试文件：标题 + 单独跑的命令 + 这一节覆盖什么 */
const FILES = {
  "test-page.mjs": {
    title: "页面接线",
    about: "index.html 与 assets/*.js 的接口没断：引用的 id 都存在、本地资源都在、所有脚本带同一个构建戳、九个 js 都能解析。"
  },
  "test-inline.mjs": {
    title: "粘贴清单的清洗与识别",
    about: "把真实粘贴的每一种写法喂进去，看认出几个、有没有漏、有没有凭空造 IP。"
  },
  "test-consistency.mjs": {
    title: "判定与各出口一致",
    about: "同一行在分批算与一口气算之间逐字段一致；表格、CSV、构成条、详情共用同一把尺子。"
  },
  "test-global.mjs": {
    title: "IP 归属表（全球 ASN 段表）",
    about: "53.9 万段能否正确二分查找、标定库有没有压掉大型混合 ASN 的虚高、任意 IPv4 都能给结论。"
  },
  "test-city.mjs": {
    title: "城市数据包",
    about: "220 个 /8 切片能否解析、段表有序、城市索引不越界、枚举取值能定位。"
  },
  "test-online.mjs": {
    title: "联网核验（抽样改判）",
    about: "按打码位置抽样、抽样里只要有一个机房就整行改判 D、接口全挂时不改级别只提示。"
  },
  "test-enrich.mjs": {
    title: "实测取证（单 IP 报告）",
    about: "RDAP / DoH PTR / Team Cymru / RIPEstat / InternetDB 五个来源的解析、前缀校验、分数可追溯、查不到写「未获取」。"
  },
  "test-i18n.mjs": {
    title: "中英词条",
    about: "HTML 正文、占位符、JS 里拼的句子都有英文；英文列不留中文；没有死条目（重复正则）。"
  }
};

const MANUAL = [
  ["版面与交互", [
    "字号只有 `--fs-*` 那 5 档：表格里「住宅」那一格不比「得分」那格粗（历史上被 `sc` 类顶过字号）",
    "语义色只有一套 g/o/b/d/x：住宅占比的橙档与蓝灰档真的有颜色（曾整档没上色）",
    "热力图格子悬浮详情：IP 加粗一行、城市/运营商与类别各一行，格子装不下的都摊在悬浮里",
    "表格 sticky 表头滚动时压住内容",
    "点统计条筛选：全部 / A / B / C / D / 未识别 / 推荐行，每档行数与条上数字一致",
    "详情抽屉：定义格标签一列对齐，构成条宽度加起来 100%",
    "实测取证面板：五个来源合并成两行，一屏装得下",
    "不可路由的行：表格里写「不可路由」，不摆成失败的样子（不是「—」）",
    "中英切换：表格、详情、报告、提示、占位符全部跟着换，英文界面不露中文"
  ]],
  ["导出与复制（自检只验核心函数，不验浏览器下载）", [
    "「导出排名」的 CSV 用 Excel 打开不乱码、列数对齐（运营商名带逗号时必须被引号包住）",
    "「导出枚举」列数对齐，行数多于排名表",
    "「复制排名」粘到记事本里是制表符分隔、能对齐",
    "「复制本行候选」粘出来的行数与提示里的数字一致"
  ]],
  ["数据与网络", [
    "首次打开：IP 归属表（4.1 MB）后台下完，顶部覆盖数字出现",
    "城市分片按需下载：判定后城市/国家两列由空逐块补上，不用点第二次",
    "「联网核验」不点就不发请求（DevTools Network 确认）",
    "「实测取证」对不可路由的行不发请求（本地规则已判，没有可查的持有者）",
    "断网时：离线判定照常出结论，联网核验如实报失败原因"
  ]],
  ["隐私（README 的承诺）", [
    "判定全过程 Network 里没有任何带清单内容的请求",
    "没有 Cookie、没有统计脚本",
    "清单只存在 localStorage（`ippa.input`）",
    "页面能直接 `file://` 打开会被拦（预期行为，数据文件跨域）—— 必须走 http"
  ]]
];

/* ---------- 跑自检，拿真实输出 ---------- */
const args = process.argv.slice(2);
const run = spawnSync(process.execPath, [join(root, "test", "run-all.mjs")], { encoding: "utf8", cwd: root });
const raw = ((run.stdout || "") + (run.stderr || "")).replace(/\r\n/g, "\n").split("\n");

const sections = [];
let cur = null;
for (const line of raw) {
  const m = /^=====\s+(\S+)\s+=====$/.exec(line);
  if (m) { cur = { file: m[1], cases: [] }; sections.push(cur); continue; }
  if (!cur) { continue; }
  const c = /^(PASS|FAIL)\s+(.*)$/.exec(line);
  if (!c) { continue; }
  const body = c[2].trim();
  const i = body.indexOf("  ");
  cur.cases.push({
    ok: c[1] === "PASS",
    name: (i > 0 ? body.slice(0, i) : body).trim(),
    detail: (i > 0 ? body.slice(i).trim() : "")
  });
}

/* 按 FILES 的顺序排，没登记的排最后 */
const order = Object.keys(FILES);
sections.sort((a, b) => {
  const ia = order.indexOf(a.file), ib = order.indexOf(b.file);
  return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
});

const total = sections.reduce((a, s) => a + s.cases.length, 0);
const failed = sections.reduce((a, s) => a + s.cases.filter((c) => !c.ok).length, 0);

/* 按主题的索引：清单按文件排（跟着测试文件走），但找东西的人想的是「这件事测了吗」。
   这里给一张主题 → 去哪儿找的表，keyword 是断言名里能唯一认出来的片段。 */
const TOPICS = [
  ["粘贴清单的写法", "test-inline.mjs", ["识别条数", "无未识别行", "全部 token 合法", "只取 IP 列"]],
  ["脏格式（全角 / 转义 / 加粗 / 端口 / 表格）", "test-inline.mjs",
    ["全角", "Markdown 转义", "端口", "加粗", "斜体", "星号折成", "反引号", "引号", "全角括号", "制表符", "紧贴运营商", "粘连", "一条不少"]],
  ["打码位与整行身份", "test-inline.mjs", ["x / ? 打码", "行身份保持", "空格分隔四段", "打码位"]],
  ["CIDR 展开", "test-inline.mjs", ["CIDR", "/23", "/16", "/20", "/24"]],
  ["不可路由（私有 / 环回 / 文档段 / 组播）", "test-inline.mjs",
    ["不可路由", "没人宣告", "保留地址", "IPv6 / 域名"]],
  ["级别、得分、占比的口径", "test-consistency.mjs",
    ["住宅形状", "分母", "百分比", "单个 IP 不写占比", "得分都是整数", "住宅占比", "构成条", "尺子"]],
  ["各出口一致（表格 / CSV / 详情 / 构成条）", "test-consistency.mjs",
    ["分批算", "汇总 == analyzeMany", "各级行数", "CSV", "城市"]],
  ["IP 归属表与标定库", "test-global.mjs",
    ["段表", "ASN 元数据", "标定表", "有序", "段表外", "Cymru", "压成", "保持高住宅", "打码行在 IP 归属表"]],
  ["城市数据", "test-city.mjs", ["切片", "index.json", "城市索引", "枚举出"]],
  ["联网核验", "test-online.mjs", ["机房", "抽", "改判", "接口全挂", "https", "限速", "封顶", "probOnly", "X 级"]],
  ["实测取证", "test-enrich.mjs",
    ["RDAP", "PTR", "Cymru", "RIPEstat", "InternetDB", "超时", "未获取", "BGP", "漏洞", "基线分", "分数明细"]],
  ["中英词条", "test-i18n.mjs", ["title", "正文", "占位符", "句子", "词条", "规则页", "重复"]],
  ["页面接线与构建戳", "test-page.mjs", ["id 都有", "本地资源", "构建戳", "语法可解析", "挂到 window"]]
];

const out = [];
out.push("# iPurity 测试清单");
out.push("");
out.push("全量自检一条命令：`node test/run-all.mjs`（提交 PR 前必跑）。");
out.push("");
out.push("> 本文件由 `node tools/make-test-checklist.mjs` 从自检**实际输出**生成，请勿手改 ——");
out.push("> 手写的清单一定会和测试漂移（加了断言忘了补文档，清单就开始骗人）。");
out.push("> 改了测试就重新生成一次。");
out.push("");
out.push(`**当前状态**：${sections.length} 个测试文件 · **${total} 条断言** · ` +
  (failed ? `**${failed} 条失败 ❌**` : "全部通过 ✅"));
out.push("");
out.push("## 按文件");
out.push("");
for (const s of sections) {
  const meta = FILES[s.file] || { title: s.file };
  out.push(`- **${meta.title}** —— ${s.cases.length} 条 · \`${s.file}\``);
}
out.push(`- **人工验证**（自检覆盖不到的：版面、下载、隐私）`);
out.push("");
out.push("## 按主题");
out.push("");
out.push("清单本身按测试文件排，但找东西时想的是「这件事测了没」—— 这张表是给这种情况的。");
out.push("");
out.push("| 主题 | 条数 | 在哪儿 |");
out.push("| :-- | --: | :-- |");
for (const [topic, file, keys] of TOPICS) {
  const sec = sections.find((s) => s.file === file);
  if (!sec) { continue; }
  const hits = sec.cases.filter((c) => keys.some((k) => c.name.indexOf(k) >= 0));
  const bad = hits.filter((c) => !c.ok).length;
  out.push(`| ${topic} | ${hits.length}${bad ? ` ❌${bad}` : ""} | \`${file}\` |`);
}
out.push("");
out.push("---");
out.push("");

for (const s of sections) {
  const meta = FILES[s.file] || { title: s.file, about: "" };
  const bad = s.cases.filter((c) => !c.ok).length;
  out.push(`## ${meta.title}`);
  out.push("");
  if (meta.about) { out.push(meta.about); out.push(""); }
  out.push(`\`${s.file}\` · ${s.cases.length} 条${bad ? ` · **${bad} 条失败**` : ""} · 单独跑：\`node test/${s.file}\``);
  out.push("");
  for (const c of s.cases) {
    out.push(`- [${c.ok ? "x" : " "}] ${c.name}${c.detail ? ` — \`${c.detail}\`` : ""}`);
  }
  out.push("");
}

out.push("---");
out.push("");
out.push("## 人工验证");
out.push("");
out.push("自检是 Node 里跑的，下面这些在浏览器里 —— 改过 UI / CSS / 数据包就得过一遍。");
out.push("");
out.push("起本地静态服务（`file://` 打开会被浏览器拦住数据文件）：");
out.push("");
out.push("```powershell");
out.push("python -m http.server 8080      # 打开 http://localhost:8080/");
out.push("```");
out.push("");
for (const [title, items] of MANUAL) {
  out.push(`### ${title}`);
  out.push("");
  for (const it of items) { out.push(`- [ ] ${it}`); }
  out.push("");
}

const md = out.join("\n");
if (args.includes("--dry")) {
  process.stdout.write(md);
} else {
  writeFileSync(join(root, "tests.md"), md);
  console.log(`tests.md 已生成：${sections.length} 个文件 / ${total} 条断言 / ${failed} 条失败`);
}
process.exit(failed ? 1 : 0);
