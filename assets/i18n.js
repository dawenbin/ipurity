/*
 * i18n.js —— 中英文双语（默认跟浏览器语言走，顶栏可切换，选择记在 localStorage）
 *
 * 做法：**不把 T() 撒到几百个调用点**，而是把界面上渲染出来的文字按**词条表**换成英文：
 *   - 词条表 = 中文正则 → 英文模板（数字用 $1/$2 引用，所以「共 200 行」只要一条）。
 *   - 中文原文一直留在源码和 HTML 里，词条表就是它的对照；切回中文时按记下的原文还原，
 *     不必维护两份文案。**改中文文案 = 改一处 + 顺手改词条表的键**。
 *   - 界面上的文字是 JS 一处一处拼出来的（进度、提示、报告面板…），所以挂了一个
 *     MutationObserver：任何后插入的节点都过一遍词条表，不用在每个 render 末尾手工调。
 *   - 技术值（AS 号、运营商名、DB-IP 城市名、IP、接口原文）里没有中文，词条表不碰它们。
 *   - 国家名走浏览器自带的 Intl.DisplayNames（见 app.js 的 countryName），不进词条表。
 *
 * 加一门语言：在 LANGS 里加一条，再给 ENTRIES 每行补一列。
 */
(function (root, factory) { root.IPI18n = factory(); })(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var STORE = "ipurity.lang";
  var ZH = /[\u4e00-\u9fa5]/;
  /* 「还需要继续替换吗」的判据要在汉字之外再带上中文标点：
     译文里常常留着全角括号 / 全角空格（「Japan（JP）　by IP location」），
     只盯着汉字就会在最后一步提前收手。 */
  var MORE = /[\u4e00-\u9fa5\u3000-\u303f\uff01-\uff60\uffe0-\uffe6]/;
  /* 语言清单。第 1 条是**母语**：词条表和 HTML 里写的就是它，也是匹配用的那一侧
     （母语 = zh，所以词条表第一列是中文正则）。后面的每一条对应词条表里的一列。
     **加一门语言 = 这里加一行 + 每条词条补一列**，引擎不用动。 */
  var LANGS = [
    { code: "zh", name: "中文", short: "中", htmlLang: "zh-CN" },
    { code: "en", name: "English", short: "EN", htmlLang: "en" }
  ];
  var BASE = LANGS[0].code;

  /* 词条：[中文正则, 英文]。数字一律留在捕获组里，英文自己排语序。
     匹配顺序：按正则源长度**从长到短** —— 先长句后碎片，否则「住宅」会把「住宅为主」拆掉。 */
  var ENTRIES = [
    /* ---------- 顶栏 / 骨架 ---------- */
    [/批量甄别住宅 IP/, "Batch-check residential IPs"],
    [/实测记录/, "measured records"],
    [/IP 归属表/, "IP owner table"],
    [/城市数据/, "city data"],
    [/规则 \/ 来源/, "Rules / sources"],
    [/GitHub 仓库 · Star 数/, "GitHub repo · star count"],
    [/① 粘贴清单/, "① Paste your list"],
    [/② 分级结果/, "② Ranking"],
    [/判定/, "Judge"],
    [/联网核验/, "Online check"],
    [/清空/, "Clear"],
    [/导入/, "Import"],
    [/导出排名/, "Export ranking"],
    [/导出枚举/, "Export hosts"],
    [/复制排名/, "Copy ranking"],
    [/重试/, "Retry"],
    [/关闭/, "Close"],
    [/载入中…/, "loading…"],
    [/后台加载中…/, "loading in the background…"],
    [/按需加载/, "on demand"],
    [/未加载/, "not loaded"],
    [/不可用/, "unavailable"],
    [/未加载（需 http:\/\/ 打开）/, "not loaded (open it over http://)"],
    [/加载失败/, "load failed"],
    [/\s*下载/, "loading "],
    [/（按运营商）/, " (carrier-level)"],
    /* 53.9 万段 —— 万 = 10k，得换算，正则换不了，用函数 */
    [/([\d.]+) 万条 · 网上在用的 IP 全收录/, function (m, n) { return (Math.round(parseFloat(n) * 10000 / 1000)) + "k entries · every in-use IP covered"; }],
    [/([\d,]+) 个网段/, "$1 /24 blocks"],
    [/ 段 · /, " blocks · "],
    [/([\d]+) \/ ([\d]+) 份/, "$1 / $2 slices"],
    [/缺数据/, "no data"],

    /* ---------- 输入框与提示 ---------- */
    [/Ctrl\+↵ 判定：离线分级，只看 IP 归属表，不发任何请求/,
      "Ctrl+↵ Judge: offline tiering from the IP owner table only — no network requests"],
    [/抽样核验推荐行（A\/B 级前 12 行）：每行按打码位置抽 3 个 IP 发给 ipwho\.is \/ ip-api，用来认出「挂在运营商下面的机房段」（如 177\.202\.126\.0\/24 挂在 KT 的 AS4766 下、实际是 Ace Data Centers）。抽到机房即整行改判 D。不点就不发请求，已核验过的行不重复查。/,
      "Sample the recommended rows (first 12 of tier A/B): 3 IPs per row, picked by the masked position, sent to ipwho.is / ip-api to catch datacenter blocks that sit inside a carrier's ASN (e.g. 177.202.126.0/24 lives under KT's AS4766 but is really Ace Data Centers). One datacenter hit flips the whole row to tier D. Nothing is sent unless you click, and verified rows are not re-checked."],
    [/粘贴清单后点「判定」，这里会按级别列出结果。/,
      "Paste a list and hit “Judge” — results are listed here by tier."],
    [/没有符合条件的行。换个筛选，或粘贴清单后点「判定」。/,
      "No rows match. Change the filter, or paste a list and hit “Judge”."],
    [/没解析出 IP 段。支持的写法：/, "No IP patterns found. Accepted forms: "],
    [/没解析出 IP 段/, "no IP patterns found"],
    [/、直接粘贴整张表格。/, " · or paste a whole table."],
    [/实测记录缺失：请先运行 /, "measured records missing: run "],
    [/ 生成 /, " to generate "],
    [/。没有它也能用，只是全部落到 IP 归属表估算。/,
      ". Everything else still works without it — every row just falls back to an IP-owner-table estimate."],

    /* ---------- 结果条 / 筛选 / 表头 ---------- */
    [/全部/, "All"],
    [/A 级/, "Tier A"], [/B 级/, "Tier B"], [/C 级/, "Tier C"], [/D 级/, "Tier D"],
    [/未识别\/缺数据/, "Unrecognized"],
    [/推荐行 \(A\+B\)/, "Recommended (A+B)"],
    [/显示全部行 · 排名按行（带 \* 的整行一起排）/, "show every row · ranked per row (a masked pattern ranks as a whole)"],
    [/只看/, "only "],
    [/排名/, "Rank"],
    [/级别/, "Tier"],
    [/IP 模式（整行）/, "IP pattern (whole row)"],
    [/构成 · 住宅/, "Composition · residential"],
    [/主要国家/, "Main country"],
    [/主要城市/, "Main city"],
    [/来源/, "Source"],
    [/得分/, "Score"],
    [/打码行把 254\/256 个取值逐个定位后取最多的那个国家（城市数据 \/ IP 归属表）/,
      "For a masked row: the most common country across all 254/256 values (city data / IP owner table)"],
    [/打码行把 254\/256 个取值逐个定位后取最多的那个城市（城市数据 \/ 实测记录）/,
      "For a masked row: the most common city across all 254/256 values (city data / measured records)"],
    /* 第二排筛选 / 标记列 */
    [/国家/, "Country"],
    [/标记/, "Marks"],
    [/城市/, "City"],
    [/排序/, "Sort"],
    [/对比/, "Compare"],
    [/重置筛选/, "Reset filters"],
    [/筛选城市/, "Filter city"],
    [/全部国家/, "All countries"],
    [/全部标记/, "All marks"],
    [/云厂商段表/, "Cloud ranges"],
    [/云厂商段/, "Cloud ranges"],
    [/风险名单/, "Risk lists"],
    [/二源分歧/, "ASN mismatch"],
    [/任一标记/, "Any mark"],
    [/住宅占比/, "Residential share"],
    [/得分 高→低/, "Score high→low"],
    [/得分 低→高/, "Score low→high"],
    [/住宅占比 高→低/, "Residential share high→low"],
    [/IP 模式/, "IP pattern"],
    [/不对比/, "No comparison"],
    /* 导出 / 分享 / 对比 */
    [/导出 JSON/, "Export JSON"],
    [/分享卡片/, "Share card"],
    [/复制链接/, "Copy link"],
    [/导出本行/, "Export this row"],
    [/展开 64 个 \/24/, "Expand 64 /24 blocks"],
    [/^住宅$/, "Residential"],
    [/^国家 \/ 城市$/, "Country / city"],
    [/^iPurity · 住宅 IP 排名$/, "iPurity · Residential IP ranking"],
    [/^批量甄别住宅 IP · 离线分级$/, "Batch-check residential IPs · offline tiering"],
    [/^数据：实测记录 \/ IP 归属表 \/ 城市数据 \/ 云厂商段 \/ 风险名单 \/ 二源分歧$/,
      "Data: measured records / IP owner table / city data / cloud ranges / risk lists / ASN mismatch"],
    [/^未显示$/, "not shown"],
    [/ · ([\d,]+) 行/, " · $1 rows"],
    [/（截断）/, " (truncated)"],
    [/上次 /, "Previous "],
    [/ → 现在 /, " → now "],
    [/已从链接载入清单/, "Loaded the list from the link"],
    [/已复制分享链接（清单在 # 后面，不会发给服务器）/, "Share link copied (the list stays after # and is never sent to the server)"],
    [/清单太长，链接会超出浏览器\/聊天工具长度限制，请导出 JSON 或分享卡片/,
      "The list is too long for a URL; export JSON or a share card instead"],
    [/链接太长，请导出本行 JSON/, "The link is too long; export this row as JSON"],
    [/已导出 JSON（当前可见 ([\d,]+) 行）/, "JSON exported ($1 visible rows)"],
    [/已导出分享卡片（SVG，可独立打开）/, "Share card exported (a standalone SVG)"],
    [/已导出本行 JSON/, "Row JSON exported"],
    [/已复制本行链接/, "Row link copied"],
    [/分享模块没加载/, "the share module is not loaded"],
    [/没有可分享的清单/, "There is no list to share"],
    [/没有可分享的行/, "There are no rows to share"],
    [/聚合行：按这个 ASN 的全部宣告段算一个整体，不逐 \/24 展开。展开后每行是一个 \/24，会重新走完整判定。/,
      "Aggregate row: graded as one unit over every announced block of this ASN, not one /24 at a time. Expanding adds /24 rows that go through the full grading again."],
    [/这个 ASN 没有标定样本：只按运营商类型给先验，不给级别与得分/,
      "No calibration samples for this ASN: only the carrier-type prior is available, so no tier and no score."],
    [/宣告范围/, "Announced space"],
    [/首个地址/, "First address"],
    [/样例 CIDR/, "Sample CIDRs"],
    [/云厂商段 \/ 风险名单 \/ 二源 ASN 分歧 \/ 联网证据（只标注，不一定改级别）/,
      "Cloud ranges / risk lists / two-source ASN mismatch / live evidence (annotations only — they do not always change the tier)"],
    /* badge 的悬停说明：每个标记各说各的 */
    [/（与这个 ASN 的宣告段交集：([\d,]+) 个整 \/24，占 (\d+)%）/,
      " (overlap with this ASN's announced blocks: $1 fully covered /24s, $2%)"],
    [/（交集 ([\d,]+) 个 \/24，占 (\d+)%）/, " (overlap: $1 /24s, $2%)"],
    [/（([\d,]+) 个 \/24，占 (\d+)%）/, " ($1 /24s, $2%)"],
    [/（整 \/24 覆盖，已改判 D）/, " (full /24 coverage, re-graded D)"],
    [/（部分覆盖：([\d,]+)\/([\d,]+) 个 \/24 整段在厂商段内，未改判）/,
      " (partial coverage: $1/$2 /24s fully inside the provider's ranges, tier unchanged)"],
    [/（整 \/24 覆盖）/, " (full /24 coverage)"],
    [/（部分覆盖，未改判）/, " (partial coverage, tier unchanged)"],
    [/（只标注，不改级别\/得分；命中不等于非住宅）/,
      " (annotations only: tier and score are unchanged; a hit does not mean it is not residential)"],
    [/（不判断谁对）/, " (no verdict on which source is right)"],
    [/联网核验附带 RDAP \/ PTR 证据/, "live-check RDAP / PTR evidence"],
    [/^证据$/, "evidence"],
    /* 标记列的完整句式（片段先翻会把整句拆坏，所以整句单独列） */
    [/云厂商段：/, "Cloud ranges: "],
    [/风险名单：/, "Risk lists: "],
    [/、/, ", "],                    /* 中文顿号：名单 / 城市枚举在英文界面里用逗号 */
    [/二源不一致：DB-IP 说是 AS(\d+)（iPurity 归属表说是 AS(\d+)）/,
      "ASN mismatch: DB-IP says AS$1 (the iPurity owner table says AS$2)"],
    [/二源不一致：DB-IP 说是 AS(\d+)/, "ASN mismatch: DB-IP says AS$1"],
    [/^云厂商 /, "Cloud provider "],
    [/^名单 /, "List "],
    [/^二源 AS(\d+)$/, "ASN mismatch AS$1"],
    [/按这个 ASN 的全部宣告段（([\d,]+) 个 \/24）用 ASN 住宅先验折算；不是逐个 \/24 实测/,
      "Graded as one unit over every announced block of this ASN ($1 /24s) using the ASN residential prior, not measured one /24 at a time"],
    [/这一行的 ([\d,]+) 个取值一个标定样本都没有：数字只能按 ASN 关键词类型给先验/,
      "None of this row's $1 values has a calibration sample: the numbers can only come from the ASN's keyword type prior"],
    [/已展开 ([\d,]+) 个 \/24（AS(\d+) 共 ([\d,]+) 个，按地址均匀取样）/,
      "Expanded $1 /24 blocks (AS$2 has $3 in total, sampled evenly by address)"],
    [/首个地址 ([\d.]+) · ([\d,]+) 个地址/, "First address $1 · $2 addresses"],
    [/展开后每行是一个 \/24，会重新走完整判定。/,
      "Expanding adds /24 rows that go through the full grading again."],

    /* ---------- 表格行 / 分数 / 悬浮 ---------- */
    [/IP 归属表估算：只看得到 ASN，级别是上限/, "IP-owner-table estimate: only the ASN is visible, so the tier is an upper bound"],
    [/ASN 级估算 · 只看得到 ASN，级别是上限/, "ASN-level estimate · only the ASN is visible, tier is an upper bound"],
    [/接口抽样实测 · 命中机房即整行改判/, "sampled live API · any datacenter hit flips the whole row"],
    [/实测 · 该 o1\.\*\.o3 的 256 个网段逐个查过/, "measured · all 256 /24 blocks of this o1.*.o3 were looked up one by one"],
    [/实测 · 该网段的扫描记录/, "measured · scan record for this /24"],
    [/估算/, "est."],
    [/行级得分 0–100（由离线分级算出）。配色：绿 ≥75 · 橙 50–74 · 蓝灰 25–49 · 红 <25/,
      "Row score 0–100 (from the offline tiering). Colours: green ≥75 · orange 50–74 · slate 25–49 · red <25"],
    [/行级得分 0–100（离线分级算出）/, "Row score 0–100 (from the offline tiering)"],
    [/实测记录里没有这一行，级别是用 IP 归属表推的（上限）/,
      "This row is not in the measured records; the tier is inferred from the IP owner table (an upper bound)"],
    [/住宅ISP ≈([\d,]+)/, "residential ISP ≈$1"],
    [/未知 ([\d.]+)%：这一层只看得到 ASN，剩下这一截是住宅还是机房判不出来/,
      "unknown $1%: only the ASN is visible at this layer — the rest cannot be told apart"],
    [/未知 ([\d.]+)%：IP 归属表这一层只看得到 ASN（住宅占比还封顶 90%），剩下的部分是住宅还是机房判不出来/,
      "unknown $1%: the IP owner table only sees the ASN (and its residential share is capped at 90%) — the rest cannot be told apart"],
    [/IP 归属表：按 ASN 住宅先验对 ([\d,]+) 个取值做概率加权折算（≈ 表示不是逐个实测），占比按 ASN 级不确定性封顶 90%/,
      "IP owner table: probability-weighted over all $1 values from the ASN's residential prior (≈ means it was not measured value by value); the share is capped at 90% because of ASN-level uncertainty"],
    [/按 IP 定位 · 城市数据 DB-IP/, "by IP location · DB-IP city data"],
    [/逐值定位取最多 · 城市数据 DB-IP/, "most common per value · DB-IP city data"],
    [/取自扫描记录 · 实测记录/, "from scan records · measured records"],
    [/按 ASN 注册地 · IP 归属表/, "by ASN registration · IP owner table"],
    [/IP 归属表 · iptoasn 归属数据 \+ PeeringDB \+ bad-asn-list/, "IP owner table · iptoasn + PeeringDB + bad-asn-list"],
    [/\s*取值分布 /, " distribution "],
    [/，共 ([\d,]+) 个国家\/地区，其次是 /, ", $1 countries/regions; next: "],
    [/，共 ([\d,]+) 个城市，其次是 /, ", $1 cities; next: "],
    [/城市数据 ([\d]+)\.x 这一段的记录里只有国家、没有城市名/, "city data has only a country for $1.x, no city name"],
    [/DB-IP 城市数据没有 ([\d]+)\.x 这一段（保留段 \/ 未分配段本来就没有记录）/,
      "DB-IP city data has no record for $1.x (reserved and unassigned blocks have none)"],
    [/这一行的城市数据还在拉 · 拉到位会自己补上/, "this row's city data is still loading · it fills in automatically"],
    [/个网段/, " /24 blocks"],
    [/份/, " slices"],
    [/（差 ([\d,]+)）/, " ($1 missing)"],
    [/个取值/, " values"],
    [/个抽样 → /, " sampled → "],
    /* 这几个**不加 ^$ 锚**：它们也会被拼进整句里（复制的排名文本、CSV、报告结论），
       锚死就漏翻。长的先匹配（「（按运营商估算）」比「住宅为主」长），拼出来仍是自然语序。 */
    [/住宅 ISP（可能）/, "residential ISP (likely)"],
    [/住宅ISP/, "residential ISP"],
    [/机房\/云/, "datacenter / cloud"],
    [/商业中转\/机构/, "business / institutional"],
    [/商业\/机构为主/, "business / institutional"],
    [/商业\/机构/, "business / institutional"],
    [/移动网络/, "mobile network"],
    [/移动/, "mobile"],
    [/其他\/不明/, "other / unknown"],
    [/住宅\+商业混合/, "residential + business"],
    [/机房\/机构为主/, "datacenter / institutional"],
    [/机房\/机构/, "datacenter / institutional"],
    [/住宅为主/, "residential"],
    [/（按运营商估算）/, " (carrier-level estimate)"],
    [/（联网核验）/, " (online check)"],
    [/未知（按运营商）/, "unknown (carrier-level)"],
    [/未识别/, "unrecognized"],
    [/未知/, "unknown"]
  ];

  /* ---------- 行详情（点开一行） ---------- */
  ENTRIES.push(
    [/行 ([\d]+) · /, "Row $1 · "],
    [/复制本行候选/, "Copy this row's candidates"],
    [/第 4 段是打码位：按这个网段的 254 个可用地址（1–254）统计，\.0 网络地址 \/ \.255 广播地址已跳过/,
      "The 4th octet is masked: counted over this /24's 254 usable addresses (1–254); .0 (network) and .255 (broadcast) are skipped"],
    /* 不可路由：公网没人宣告这个地址（IP 归属表记成 AS0 / Not routed） */
    [/不可路由/, "Unroutable"],
    /* 未评级：只有运营商关键词类型，一个标定样本都没有 → 不给级别与得分 */
    [/未评级/, "Ungraded"],
    [/按运营商类型判 · 没有样本，不给级别与得分/, "typed by carrier keyword only - no samples, so no tier and no score"],
    [/这个 ASN 一个标定样本都没有：只能按运营商关键词判类型，密度数据不存在，所以不给级别、不算得分、不进推荐/,
      "this ASN has no calibration sample at all, so its type comes from the carrier keyword and no density figure exists - no tier, no score, not recommended"],
    [/未评级：没有样本支撑的分数不该给/, "ungraded: a score with no sample behind it should not be printed"],
    [/住宅 0%（联网核验判定为机房）/, "residential 0% (online check says datacenter)"],
    [/住宅 ≈([\d,]+)\/([\d,]+) · ([\d.]+)%/, "residential ≈$1/$2 · $3%"],
    [/住宅 /, "residential "],
    [/占比封顶 ([\d]+)%/, "share capped at $1%"],
    [/占比已按 ASN 级不确定性封顶：抽样再干净也不代表这个网段一定干净 —— 同一个 ASN 下就有对方机房\/企业客户的段（例如 177\.202\.126\.0\/24 挂在 KT 下面，但整段是 Ace Data Centers 的机房）。/,
      "The share is capped because of ASN-level uncertainty: a clean sample does not make this /24 clean — the same ASN also holds other parties' datacenter and enterprise blocks (e.g. 177.202.126.0/24 sits under KT but the whole block belongs to Ace Data Centers)."],
    [/单个 IP/, "single IP"],
    /* 纯类型先验：一个标定样本都没有，百分比是常数 → 改写类别 */
    [/按类型先验 · /, "typed as "],
    [/清单里的这一行就是一个真实 IP，没有占比可言，直接看它归哪一类；下面那张图画的是它所在网段的 254 个可用地址。/,
      "This row is a single real IP, so there is no share to speak of — it is just classified. The map below covers the 254 usable addresses of the /24 it sits in."],
    [/你粘贴的这一行是一个真实 IP，样本只有它自己 —— 没有占比可言，直接看它归哪一类/,
      "This row is a single real IP, so the sample is just itself — no share to speak of, only which class it falls into"],
    [/实测记录：住宅网段数 \/ 样本数 · 占比/, "measured records: residential /24 blocks / sample size · share"],
    [/IP 归属表折算，不是逐个实测/, "carrier-level conversion, not measured value by value"],
    [/网络地址/, "network address"],
    [/广播地址/, "broadcast address"],
    [/未知 · ([\d.]+)%/, "unknown · $1%"],
    [/落点城市/, "Landing cities"],
    [/这一行的 254\/256 个取值分别落在哪个城市（取前 4）/,
      "Which cities this row's 254/256 values land in (top 4)"],
    [/覆盖 /, "covered "],
    [/落点只是参考，结论以整行为准/, "Landing points are for reference only; the verdict is per row"],
    [/枚举落点 · 住宅 /, "Enumerated hosts · residential "],
    [/ 优先 · 前 /, " preferred · top "],
    [/ASN 分布 · ([\d,]+) 个取值/, "ASN spread · $1 values"],
    [/网段归属/, "/24 owner"],
    [/实测记录（ip-api）· /, "measured record (ip-api) · "],
    [/ 整段归 /, " whole block belongs to "],
    [/城市数据 DB-IP 这一层查不到（这一段 IP 的城市数据可能还没到）/,
      "Not found in the DB-IP city data at this layer (this block's city data may not have arrived yet)"],
    [/，([\d]+)\/([\d]+) = ([\d.]+)% 落在/, ", $1/$2 = $3% fall in "],
    [/第 ([\d]+) 行/, "line $1"]
  );

  /* ---------- 单 IP 实测报告 ---------- */
  ENTRIES.push(
    [/单 IP 实测报告/, "Single-IP live report"],
    [/实测取证/, "Run live lookup"],
    [/重新取证/, "Re-run live lookup"],
    [/清除实测/, "Clear live data"],
    [/取证中…/, "running…"],
    [/查的对象：这一行的代表 IP。走 rdap\.org（注册记录）\+ DoH（PTR \/ Team Cymru）\+ RIPEstat（RIS）\+ Shodan InternetDB，查不到就写「未获取」，不填占位数字。/,
      "Target: this row's representative IP. Uses rdap.org (registry record) + DoH (PTR / Team Cymru) + RIPEstat (RIS) + Shodan InternetDB. Anything unavailable is written as “not fetched” — no placeholder numbers."],
    [/点「实测取证」查这个 IP 的 RDAP 注册记录 · 反向解析 PTR · Team Cymru 与 RIPEstat 两路 BGP · Shodan InternetDB 扫描记录 ——/,
      "Hit “Run live lookup” to query this IP's RDAP registry record · reverse DNS (PTR) · two independent BGP views (Team Cymru and RIPEstat) · Shodan InternetDB scan record — "],
    [/离线库只到 ASN 这一层，认不出同一个 ASN 里的机房段。/,
      "the offline DB only goes down to the ASN, so it cannot spot a datacenter block inside one."],
    [/这一行就是一个真实 IP/, "this row is a single real IP"],
    [/该行枚举结果里排最前的落点/, "the top landing point among this row's enumeration"],
    [/该网段的第一个可用地址/, "the first usable address of this block"],
    [/这一行没有可取证的具体 IP（第 1 段就打码了）。/,
      "This row has no concrete IP to look up (the first octet is masked)."],
    [/取证时间 /, "fetched "],
    [/代表 IP 实测分/, "live score for the representative IP"],
    [/分数明细/, "Score breakdown"],
    [/针对这一个代表 IP 的实测分，不是第三方风险分，也不是上面表格里的行级得分：由离线分级 \+ 联网实测证据逐项加减得来，每一项的来源都列在下面/,
      "Live score for this one representative IP — not a third-party risk score, and not the row-level score in the table above: it adds and subtracts offline tiering and live evidence item by item, each with its source listed below"],
    [/离线分级 (.)（估算）/, "offline tier $1 (est.)"],
    [/IP 归属表（ASN 级估算）/, "IP owner table (ASN-level estimate)"],
    [/实测证据/, "Live evidence"],
    [/离线证据/, "Offline evidence"],
    [/RDAP 注册记录/, "RDAP registry record"],
    [/RDAP 原始记录/, "raw RDAP record"],
    [/（注册局权威）/, " (registry authority)"],
    [/（无 name 字段）/, "(no name field)"],
    [/未获取 —— /, "not fetched — "],
    [/未获取/, "not fetched"],
    [/实测 ASN/, "Live ASN"],
    [/Team Cymru \+ RIPEstat/, "Team Cymru + RIPEstat"],
    [/主机特征/, "Host profile"],
    [/反向解析 PTR/, "Reverse DNS (PTR)"],
    [/无 PTR 记录/, "no PTR record"],
    [/PTR 未获取 —— /, "PTR not fetched — "],
    [/InternetDB 无记录/, "no InternetDB record"],
    [/InternetDB 未获取 —— /, "InternetDB not fetched — "],
    [/有记录，但没扫到端口 \/ 漏洞 \/ 标签/, "has a record, but no ports / vulns / tags were scanned"],
    [/扫到 /, "scanned "],
    [/端口 /, "ports "],
    [/漏洞 ([\d]+) 个/, "vulns $1"],
    [/主机名 /, "hostnames "],
    [/标签 /, "tags "],
    [/（等 ([\d]+) 家）/, " (+$1 more)"],
    [/两路一致/, "both views agree"],
    [/两路不一致/, "the two views disagree"],
    [/Cymru 未获取 · RIPEstat AS/, "Cymru not fetched · RIPEstat AS"],
    [/接口实测（单 IP）/, "API lookup (single IP)"],
    [/接口没给 org/, "the API returned no org"],
    [/接口未提供/, "not provided"],
    [/接口失败/, "API failed"],
    [/接口/, "API"],
    [/整行联网核验/, "Row-level online check"],
    [/这一行的联网核验没成功/, "the row-level online check did not succeed"],
    [/核验没取到数据/, "online check returned nothing"],
    [/离线 ASN/, "Offline ASN"],
    [/该 ASN 住宅占比/, "This ASN's residential share"],
    [/该 ASN 类型先验/, "This ASN's type prior"],
    [/（已用实测记录 \/24 标定）/, " (calibrated from measured /24 blocks)"],
    [/（已用实测 \/24 标定）/, " (calibrated from measured /24 blocks)"],
    [/（没有标定样本：只按类型给先验，不报占比）/,
      " (no calibration samples: type prior only, no share reported)"],
    [/这个 ASN 的实测样本不足，不把常数先验伪装成占比/,
      "This ASN has too few measured samples; a constant prior is not passed off as a share"],
    [/（未标定 · 按类型上限）/, " (uncalibrated · type cap)"],
    [/标定库 asn-calib\.js（用实测记录的 \/24 反推这个 ASN 的住宅占比）/,
      "calibration asn-calib.js (this ASN's residential share inferred from the measured /24 blocks)"],
    [/位置对比（不一致 = 该 IP 在广播）/, "Location comparison (a mismatch means this IP is announced elsewhere)"],
    [/离线库 · 按段查表/, "offline DB · per-block lookup"],
    [/注册地 · 注册局记录/, "registry country · registry record"],
    [/抽样 ([\d]+) 个 IP/, "sampled $1 IPs"],
    [/较干净/, "fairly clean"],
    [/中性/, "neutral"],
    [/偏差/, "poor"],
    [/不可用（机房\/代理）/, "unusable (datacenter/proxy)"],
    [/五个来源都没取到数据（可能是网络或接口限制）。报告里会标「未获取」，不会填假数。/,
      "None of the five sources returned data (network or API limits, most likely). The report will say “not fetched” — no fake numbers."],
    [/取证失败：/, "live lookup failed: "]
  );

  /* ---------- 进度 / 提示 / 结果条 / 导出 ---------- */
  ENTRIES.push(
    [/判定 ([\d]+) 行…/, "judging $1 rows…"],
    [/判定 ([\d]+)\/([\d]+) 行/, "judging $1/$2 rows"],
    [/等 IP 归属表（4\.1 MB，只下一次）…/, "waiting for the IP owner table (4.1 MB, downloaded once)…"],
    [/城市数据 ([\d]+)\/([\d]+) 份…/, "city data $1/$2 files…"],
    [/重拉城市数据 ([\d]+)\/([\d]+)…/, "re-fetching city data $1/$2…"],
    [/联网核验 ([\d]+)\/([\d]+) 行 · /, "online check $1/$2 rows · "],
    [/联网核验 ([\d]+) 行 · 取到 ([\d]+) · 改判 D ([\d]+) 行/, "online check: $1 rows · $2 answered · $3 flipped to tier D"],
    [/联网核验 ([\d]+) 行/, "Online check · $1 rows"],
    [/联网核验 ([\d]+)\/([\d]+) 行取到数据，没抓到机房证据/, "online check answered $1/$2 rows, no datacenter evidence found"],
    [/联网核验：([\d]+) 行推荐段实测是机房，已改判 D/, "online check: $1 recommended rows measured as datacenter — flipped to tier D"],
    [/联网核验出错（判定结论不受影响）：/, "online check failed (the tiering is unaffected): "],
    [/联网核验没成功（/, "Online check did not succeed ("],
    [/接口全部失败/, "all APIs failed"],
    [/），这一行还是 ASN 级估算。/, "); this row is still an ASN-level estimate."],
    [/已判定 ([\d]+) 个模式，(?:<b>)?([\d]+)(?:<\/b>)? 行没认出来/, "judged $1 patterns; $2 line(s) were not recognized"],
    [/IP 归属表没加载：请用 http:\/\/ 打开（静态托管或 python -m http\.server）/,
      "IP owner table not loaded: open this page over http:// (static hosting or python -m http.server)"],
    [/判定出错：/, "judging failed: "],
    [/已导出排名表 CSV（一行 = 你粘贴的一行）/, "Ranking CSV exported (one line = one line you pasted)"],
    [/已导出枚举明细 CSV/, "Host-detail CSV exported"],
    [/没有 A\/B 级结果/, "no tier A/B rows"],
    [/已复制 A\/B 级排名（一行一个）/, "Tier A/B ranking copied (one per line)"],
    [/已复制本行 ([\d,]+) 个枚举落点/, "copied $1 enumerated hosts from this row"],
    [/复制失败，请手动选中/, "copy failed — select the text manually"],
    [/排名 #/, "rank #"],
    [/城市数据都到位了/, "all city data is in"],
    [/补了 ([\d]+) 份城市数据/, "loaded $1 more city data files"],
    [/重拉城市数据失败：/, "re-fetching city data failed: "],
    [/城市数据还在拉：/, "city data still loading: "],
    [/<\/b>没到位（约 ([\d]+) MB）/, "</b> not in yet (about $1 MB)"],
    [/<\/b>城市数据没拉下来（网络失败）/, "</b> city data could not be downloaded (network failure)"],
    [/ —— /, " — "],
    [/ 行<\/b>暂时没有城市/, " row(s)</b> have no city yet"],
    [/ 行<\/b>查不到城市：/, " row(s): no city found — "],
    [/DB-IP 城市数据没有这些段（保留段 \/ 未分配段本来就没有记录）/,
      "DB-IP city data has no records for these blocks (reserved and unassigned blocks have none)"],
    [/DB-IP 城市数据对这些段只记到国家（其中 ([\d]+) 行所在的这一段整段没有数据）/,
      "DB-IP city data records only a country for these blocks ($1 row(s) sit in blocks with no data at all)"],
    [/DB-IP 对这些段的记录里只有国家、没有城市名/, "DB-IP records only a country for these blocks, no city name"],
    [/国旗图（flagcdn\.com）没加载出来，退成国家码/, "Flag image (flagcdn.com) did not load — falling back to the country code"],
    [/数据包生成于 /, "Data pack generated "],
    [/ ｜ IP 归属表 /, " | IP owner table "],
    [/（住宅 /, " (residential "],
    [/% \/ 机房 /, "% / datacenter "],
    [/% \/ 商业 /, "% / business "],
    [/纯静态站点 · 无后端 · 无追踪 · 粘贴内容不上传 · 数据包随仓库发布/,
      "Static site · no backend · no tracking · pasted content is never uploaded · data packs ship with the repo"],
    [/判定口径与数据来源/, "Scoring rules and data sources"]
  );

  /* ---------- 判定核心与联网核验里回显的原因（详情面板 / 报告里会显示） ---------- */
  ENTRIES.push(
    [/不是 4 段格式/, "not a 4-part address"],
    [/多于一个打码段，暂不支持/, "more than one masked octet is not supported yet"],
    [/非法段: /, "invalid octet: "],
    [/第一段被打码，无法定位/, "the first octet is masked, so it cannot be located"],
    [/数据包未加载/, "data pack not loaded"],
    [/打码在第 3 段，需要更细的数据（这一层只到网段）/,
      "the mask is in the 3rd octet, which needs /16-level data (this pack is /24-level)"],
    [/数据包里没有 /, "the data pack has no "],
    [/（需重跑扫描补数据）/, " (re-run the scan to fill it in)"],
    [/IP 归属表没加载/, "IP owner table not loaded"],
    [/ASN 段表里没查到 /, "not found in the IP owner table: "],
    [/  \(小于 \/16 暂不支持\)/, "  (smaller than /16 is not supported yet)"],
    [/接口标记 hosting（机房\/托管）/, "the API flags hosting (datacenter/colo)"],
    [/org\/isp 名称含机房\/机构关键词/, "the org/isp name contains datacenter/institution keywords"],
    [/接口标记 mobile（移动网络）/, "the API flags mobile"],
    [/名称像零售运营商（仍可能是企业段）/, "the name looks like a retail ISP (enterprise blocks are still possible)"],
    [/接口没给出可用信号/, "the API gave no usable signal"],
    [/抽样 ([\d]+)\/([\d]+) 个 IP 命中机房：/, "sampled $1/$2 IPs hit a datacenter: "],
    [/接口返回的 org 是「/, "the API returned org “"],
    [/」——/, "” — "],
    [/。这一段按机房处理（住宅 0%），别当纯净住宅用。/, ". This block is treated as a datacenter (0% residential); do not use it as clean residential."],
    [/接口标记这是移动网络（org「/, "the API flags this as a mobile network (org “"],
    [/」）：手机流量池，不是住宅固网。/, "”): a cellular pool, not fixed-line residential."],
    [/联网核验未发现机房\/移动信号（org「/, "the online check found no datacenter/mobile signal (org “"],
    [/」，/, "”, "],
    [/）。这只能排除「明显机房」，不等于确认是住宅 IP —— 仍是 ASN 级估算。/,
      "). This only rules out an obvious datacenter; it does not confirm a residential IP — still an ASN-level estimate."],
    [/查询失败/, "query failed"],
    [/环境没有 fetch（需要 node 18\+ 或现代浏览器）/, "no fetch in this environment (needs node 18+ or a modern browser)"],
    [/所有接口都失败\/都是 http（https 页面不能用 ip-api）/,
      "every API failed or is http-only (ip-api cannot be used from an https page)"],
    [/第 1 段打码的模式没法抽样/, "a pattern with a masked first octet cannot be sampled"],
    [/单个 IP · /, "single IP · "],
  );

  /* ---------- 导出 CSV 的表头 / 复制出去的文本（不经过 DOM，得单独翻） ---------- */
  ENTRIES.push(
    [/排名,IP模式,主要城市,主要国家,级别,级别说明,数据来源,得分,住宅,住宅%,机房%,商业%,移动%,参考枚举IP\(前([\d]+)\)/,
      "Rank,IP pattern,Main city,Main country,Tier,Tier note,Source,Score,Residential,Residential %,Datacenter %,Business %,Mobile %,Reference hosts (top $1)"],
    [/排名,IP模式,枚举IP,城市,运营商,类别/,
      "Rank,IP pattern,Host IP,City,Carrier,Category"],
    [/排名\tIP模式\(整行\)\t级别\t说明\t得分\t住宅/,
      "Rank\tIP pattern (whole row)\tTier\tNote\tScore\tResidential"],
    [/\t得分 /, "\tscore "],
    [/\t住宅 /, "\tresidential "],
  );

  /* ---------- 标点兜底 ---------- */
  /* 中文标点常常和译文拼在同一个文本节点里（「Japan（JP）　by IP location」这种），
     逐句给译文时很容易漏掉括号和全角空格。这三条是**全局最短**的规则，排在最后补一次：
     长句规则先吃，剩下的全角标点才会落到这里，不会污染已经翻好的句子。 */
  ENTRIES.push(
    [/　/, " "],      /* 全角空格 */
    [/（/, " ("],
    [/）/, ")"]
  );
  /* ---------- 进度 / 失败原因：整句给一份，长的先匹配 ---------- */
  ENTRIES.push(
    [/ 组 · /, " groups · "],

    /* 网段归属那一格：口径必须跟着来源走，实测和 ASN 级估算不能写成同一句话 */
    [/IP 归属表 · 按运营商估算：这个网段归 /, "IP owner table · carrier-level estimate: this /24 belongs to "],
    [/，占比按 ASN 先验折算（不是逐段实测）/, ", share converted from the ASN prior (not measured block by block)"],
    [/各来源说这个 IP 在哪/, "Where each source puts this IP"],

    /* 联网核验 / 实测取证失败：面板上只出现人话，逐家原因挂在悬停里 */
    [/接口都没成功/, "no provider succeeded"],
    [/没接口可试：ip-api 免费版只有 http，https 页面用不了/,
      "nothing to try: ip-api's free tier is http-only, and this page is https"],
    [/超时（([\d]+) 秒没回应）/, "timed out (no response within $1s)"],
    [/超时/, "timed out"],
    [/网络或跨域失败/, "network or CORS failure"],
    [/没拿到返回/, "no response"],
    [/（返回不是 JSON）/, " (not JSON)"],
    [/解析器返回 Status ([\d]+)（没给出答案）/, "the resolver returned Status $1 (no answer)"],
    [/返回的前缀 (.+?) 不包含这个 IP（已忽略）/, "the returned prefix $1 does not contain this IP (ignored)"],
    [/解析链路异常/, "resolver chain returned nonsense"]
  );

  /* 不按词条表走的特例：整块文案按语言各给一份（多行占位符里有制表符和换行，
     按词条匹配太脆）。加语言就在这里再补一个键。 */
  var SPECIAL = {
    "#input": {
      /* 空的时候它就是一份建议帮助：四种写法各给一行，再补三句规则（列不写国家/城市 ——
         那是用户自己的标注，摆在这儿会让人以为工具会拿它当依据）。
         两种语言的排版必须一模一样，所以中英各写一份（DOM 里那份也得跟上）。 */
      placeholder: {
        zh: "198.*.205.197\n" +
          "82.24.73.*\n" +
          "198.3.242.0/24\n" +
          "198.3.243.16\n" +
          "\n" +
          "随便粘：整张表、一列 IP、混着备注的一堆 IP，都认 —— 只读 IP，序号和其它列不看。\n" +
          "198 3 242 16 这种空格分隔也认；打码位也认 ? 和 x（198.?.42.81），CIDR 按它盖住的网段收。\n" +
          "Markdown 的加粗也认（**198.*.42.81**，或者加粗紧贴着运营商名），全角、行尾带端口都照收。\n" +
          "第 2 段打码 → 256 个网段；第 4 段打码 → 254 个可用地址；结论落回整行。",
        en: "198.*.205.197\n" +
          "82.24.73.*\n" +
          "198.3.242.0/24\n" +
          "198.3.243.16\n" +
          "\n" +
          "Paste anything: a whole table, one column, or a pile of IPs mixed with notes — only the IPs are read, and numbering and other columns are ignored.\n" +
          "Space-separated octets (198 3 242 16) work too; a masked octet may also be written ? or x (198.?.42.81), and a CIDR expands to the /24 blocks it covers.\n" +
          "Markdown emphasis is read too (**198.*.42.81**, or bolded right against a carrier name), along with full-width text and a trailing port.\n" +
          "2nd octet masked → 256 /24 blocks; 4th octet masked → 254 usable addresses; the verdict stays on the whole row."
      }
    }
  };

  /* ---------- 引擎 ---------- */
  /* 每种语言编译一份规则表：取词条表的第 n 列，按**正则源长度从长到短**排 ——
     长句先吃、碎片后补，否则「住宅」会把「住宅为主」拆掉。第 0 列是中文本身，不编。 */
  var RULES = {};
  LANGS.forEach(function (L, col) {
    if (col === 0) { return; }
    RULES[L.code] = ENTRIES
      .map(function (e) { return { re: e[0], to: e[col], len: e[0].source.length }; })
      .filter(function (r) { return r.to != null; })       /* 这门语言没给译文就跳过这一条 */
      .sort(function (a, b) { return b.len - a.len; });
  });

  var lang = BASE;
  var paused = 0;
  var ATTRS = ["title", "placeholder", "aria-label"];
  var SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEXTAREA: 1 };
  /* 每个节点/属性记一份**母语原文**（WeakMap，节点回收就跟着回收）。
     有它才能任意往返：zh→en→ja→zh 都不用重新猜原文。 */
  var ORIG = typeof WeakMap === "function" ? new WeakMap() : null;
  var ATTR_ORIG = typeof WeakMap === "function" ? new WeakMap() : null;

  function byCode(code) {
    for (var i = 0; i < LANGS.length; i++) { if (LANGS[i].code === code) { return LANGS[i]; } }
    return null;
  }

  /* 母语 → 目标语言。没有对应词条就原样返回（宁可留中文，也不猜） */
  function translate(s, code) {
    code = code || lang;
    if (code === BASE || typeof s !== "string" || !MORE.test(s)) { return s; }
    var rules = RULES[code];
    if (!rules) { return s; }
    var out = s;
    for (var i = 0; i < rules.length; i++) {
      if (!MORE.test(out)) { break; }
      if (rules[i].re.test(out)) { out = out.replace(rules[i].re, rules[i].to); }
    }
    return out;
  }

  /* 屏幕上这段文字该显示成什么：
     - 是中文（或还留着中文标点）→ 以它为准记成原文，再翻成当前语言；
     - 已经是别的语言 → 用记下的原文翻成当前语言（en → 其它语言走这条）；
     - 记不到原文又已经是译文 → 不碰（多半本来就是 AS 号、运营商名这类技术值）。 */
  function paintText(node) {
    if (!ORIG) { return; }
    var cur = node.nodeValue;
    if (cur == null) { return; }
    var src = ORIG.get(node);
    if (MORE.test(cur)) { ORIG.set(node, cur); src = cur; }
    else if (src == null) { return; }
    var t = translate(src, lang);
    if (t !== cur) { node.nodeValue = t; }
  }

  function attrStore(el, map) {
    var m = map.get(el);
    if (!m) { m = {}; map.set(el, m); }
    return m;
  }

  function paintAttrs(el) {
    if (!ATTR_ORIG || !el.getAttribute) { return; }
    for (var i = 0; i < ATTRS.length; i++) {
      var a = ATTRS[i];
      var cur = el.getAttribute(a);
      if (cur == null) { continue; }
      var store = ATTR_ORIG.get(el);
      var src = store ? store[a] : null;
      if (ZH.test(cur)) { src = attrStore(el, ATTR_ORIG)[a] = cur; }
      else if (src == null) { continue; }
      var t = translate(src, lang);
      if (t !== cur) { el.setAttribute(a, t); }
    }
  }

  function walk(node) {
    if (!node) { return; }
    if (node.nodeType === 3) { paintText(node); return; }
    if (node.nodeType !== 1) { return; }
    if (SKIP[node.tagName] || (node.hasAttribute && node.hasAttribute("data-no-i18n"))) { return; }
    if (node.hidden === true) { return; }
    paintAttrs(node);
    var kids = node.childNodes;
    for (var i = 0; i < kids.length; i++) { walk(kids[i]); }
  }

  function paintSpecial() {
    if (typeof document === "undefined" || !ATTR_ORIG) { return; }
    Object.keys(SPECIAL).forEach(function (sel) {
      var el = document.querySelector(sel);
      if (!el) { return; }
      var spec = SPECIAL[sel];
      Object.keys(spec).forEach(function (a) {
        var store = attrStore(el, ATTR_ORIG);
        if (store[a] == null) { store[a] = el.getAttribute(a) || ""; }
        var next = spec[a][lang];
        el.setAttribute(a, next != null ? next : store[a]);
      });
    });
  }

  /* 规则那张长说明：index.html 里按 data-lang 各写一份，只切显示，不翻译 */
  function syncSheet() {
    if (typeof document === "undefined" || !document.querySelectorAll) { return; }
    var blocks = document.querySelectorAll("#rulesHost [data-lang]");
    for (var i = 0; i < blocks.length; i++) {
      blocks[i].hidden = blocks[i].getAttribute("data-lang") !== lang;
    }
  }

  var TITLE0 = null;
  function paintTitle() {
    if (typeof document === "undefined" || !document.title) { return; }
    if (TITLE0 == null) {
      if (!ZH.test(document.title)) { return; }
      TITLE0 = document.title;
    }
    var t = translate(TITLE0, lang);
    if (document.title !== t) { document.title = t; }
  }

  function apply() {
    if (typeof document === "undefined" || !document.body) { return; }
    paused++;
    try {
      syncSheet();            /* 先切规则页，免得把隐藏的那份也翻掉 */
      paintSpecial();
      walk(document.body);
      paintTitle();
    } finally {
      paused--;
    }
  }

  function set(next) {
    if (!byCode(next)) { next = BASE; }
    if (next === lang) { return lang; }
    lang = next;
    try { localStorage.setItem(STORE, lang); } catch (e) {}
    var L = byCode(lang);
    if (typeof document !== "undefined") {
      document.documentElement.lang = L.htmlLang;
    }
    apply();
    /* 国家名是 Intl 按当前语言现算的（不是词条表），切语言得让表格自己重画一遍 */
    if (typeof document !== "undefined" && typeof CustomEvent === "function") {
      document.dispatchEvent(new CustomEvent("ipurity:lang", { detail: { lang: lang } }));
    }
    return lang;
  }

  function nextLang() {
    for (var i = 0; i < LANGS.length; i++) {
      if (LANGS[i].code === lang) { return LANGS[(i + 1) % LANGS.length]; }
    }
    return LANGS[1] || LANGS[0];
  }

  function toggle() { return set(nextLang().code); }

  /* 按钮显示**切过去**的那门语言（两门语言时就是一个开关） */
  function paintLangBtn() {
    if (typeof document === "undefined" || !document.getElementById) { return; }
    var b = document.getElementById("langBtn");
    if (!b) { return; }
    var n = nextLang();
    b.textContent = n.short || n.name;
    b.title = "Switch to " + n.name;
  }

  function init() {
    if (typeof document === "undefined") { return; }
    try {
      var saved = localStorage.getItem(STORE);
      if (byCode(saved)) { lang = saved; }
      else if (typeof navigator !== "undefined" && navigator.language && !/^zh/i.test(navigator.language)) { lang = "en"; }
    } catch (e) {}
    var b = document.getElementById("langBtn");
    if (b) { b.onclick = function () { toggle(); paintLangBtn(); }; }
    document.documentElement.lang = byCode(lang).htmlLang;
    paintLangBtn();
    apply();
    /* 界面上的中文是 JS 一处一处拼出来的（进度、提示、报告面板…）：挂一个观察器，
       后插入的节点自动过一遍词条表，不用在每个 render 末尾手工调。 */
    if (typeof MutationObserver === "function") {
      new MutationObserver(function (muts) {
        if (paused) { return; }
        for (var i = 0; i < muts.length; i++) {
          var m = muts[i];
          if (m.type === "characterData") { paintText(m.target); continue; }
          for (var j = 0; j < m.addedNodes.length; j++) { walk(m.addedNodes[j]); }
        }
      }).observe(document.body, { childList: true, subtree: true, characterData: true });
    }
  }

  if (typeof document !== "undefined") {
    if (document.body) { init(); } else { document.addEventListener("DOMContentLoaded", init); }
  }

  return {
    langs: LANGS.map(function (L) { return L.code; }),
    get lang() { return lang; },
    /* 当前语言对应的 BCP-47 标记（Intl、<html lang> 用） */
    locale: function () { return byCode(lang).htmlLang; },
    set: set,
    toggle: toggle,
    apply: apply,
    /* 不经过 DOM 的文案（CSV 表头、复制出去的文本、alert）自己调它 */
    t: translate,
    /* 词条表与特例表本身：自检要拿它查「每条都有译文 / 没有重复键」，加语言时也用得上。
       只读，别在运行时改它。 */
    entries: ENTRIES,
    special: SPECIAL
  };
});
