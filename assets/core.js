/*
 * core.js —— IP 段清洗 + 住宅纯净度判定核心（零依赖，浏览器 / Node 通用）
 *
 * 数据包结构（data/segments-data.js）：
 *   { generated, source, legend, isps[], cities[], metro{ tag, zh, en },
 *     prefixes{ "198.*.42": { o1, o3, c, i, g } } }
 *   c[x] = 类别码：1 住宅ISP / 2 机房·云 / 3 商业中转·机构 / 4 移动 / 6 其他；+8 = 标记区域位
 *   x = 第二段(0-255)，即 /24 下标；i[] / g[] 为 isps / cities 索引
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) { module.exports = factory(); }
  else { root.AdvisorCore = factory(); }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var CAT = { ISP: 1, DC: 2, BIZ: 3, MOB: 4, UNK: 6 };
  var CAT_NAME = { 1: "住宅ISP", 2: "机房/云", 3: "商业中转/机构", 4: "移动网络", 6: "其他/不明" };
  /* 有些文案不经过 DOM（导出 CSV、复制出去的文本、alert），词条表够不着，得自己调一次。
     node 里没有 window → 原样返回，自检跑的还是中文。 */
  function T(s) {
    var I = typeof window !== "undefined" && window.IPI18n;
    return I && I.t ? I.t(s) : s;
  }

  /* IP 归属表是 ASN 级估算：同一个 ASN 内部一定有例外段（对方机房的客户、企业专线），
     所以抽样再干净也不给「100% 住宅」这种说法，占比封顶 90%，行上标 approx。
     典型翻车例子：177.202.126.0/24 挂在 AS4766（Korea Telecom）下，整段其实是
     「Ace Data Centers II, LLC」的机房段 —— 光看 ASN 只会判成住宅。 */
  var ASN_CONF_CAP = 0.9;
  /* 标记区域位（metro）：数据包扫描时定位在某个都会区的网段带这一位。
     名字、★ 标记都写在数据包自己的 metro 里（见 tools/make-data.ps1）——
     换一个都会区只改数据和流水线，这里和前端都不用动。 */
  var METRO_BIT = 8;
  /* 第 4 段打码（82.24.73.*）= 这个网段的可用主机地址 1–254
     （.0 是网络地址、.255 是广播地址，都不是能拿的主机） */
  var HOST_LO = 1, HOST_HI = 254;
  var TOKEN = /^(\d{1,3}|\*)(?:\.(\d{1,3}|\*)){3}$/;
  var CIDR = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;
  /* 清单里 IP 常被 Markdown 加粗：**198.*.42.81**、*198.*.42.81*，
     或者加粗紧贴着后面的运营商名（**111.169.14.1**BIGLOBE）。这两种只在
     token **以 * 开头**时才去认 —— 不然普通文字里的数字会被误抓成 IP。 */
  var BOLD_TOKEN = /^\*{1,2}((?:\d{1,3}|\*)(?:\.(?:\d{1,3}|\*)){3})(?:\*{1,2})?(?=$|[^.\d*])/;
  var BOLD_CIDR = /^\*{1,2}(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2})(?:\*{1,2})?(?=$|[^.\d*])/;

  /* 城市名一律用 DB-IP 的原文（英文）—— 不做本地化：译名表永远收不全，
     一份清单里就会中英混排（Albuquerque + Absecon 这种），还得跟着库更新维护。
     全站只有这一个显示入口，以后要加什么口径也只改这里。 */
  function cityLabel(name) {
    return String(name == null ? "" : name).trim();
  }
  /* ---------- 1. 清洗：各种脏格式归一化 ---------- */
  function normalize(text) {
    return String(text == null ? "" : text)
      .replace(/\uFEFF/g, "")                       // BOM
      .replace(/[\u00A0\u3000\u2007\u202F]/g, " ")  // 不换行/全角空格
      .replace(/[\uFF10-\uFF19]/g, function (c) {   // 全角数字 ０-９ → 0-9
        return String.fromCharCode(c.charCodeAt(0) - 0xFEE0);
      })
      .replace(/\\\*/g, "*")                        // Markdown 转义的 \*
      .replace(/\\\./g, ".")                        // \.
      .replace(/[．。｡]/g, ".")                     // 全角句点
      .replace(/[＊ｘ×]/g, "*")                     // 全角星号/乘号（半角 x 在 token 级处理，避免破坏英文城市名）
      .replace(/[│┃]/g, "|")                        // 全角竖线
      /* 段间空格：只吃行内的空格/制表符。这里**不能**用 \s —— 清单里
         「BIGLOBE Inc.」这种行尾带点的写法很常见，\s 会把换行一起吃掉，
         下一行就跟这行粘成一行，那一行的 IP 会无声无息地少掉一个。 */
      .replace(/[^\S\r\n]*\.[^\S\r\n]*/g, ".")
      .replace(/[，、；]/g, " ")
      .replace(/[（(]/g, " ")
      .replace(/[）)]/g, " ");
  }

  /* ---------- 2. 解析：整段粘贴 → 模式列表 + 未识别行报告 ---------- */
  function parseWithReport(text) {
    var lines = normalize(text).split(/\r?\n/);
    var items = [], unmatched = [], seen = {}, duplicates = 0, blank = 0;

    for (var i = 0; i < lines.length; i++) {
      var t = lines[i].trim();
      if (!t) { blank++; continue; }
      if (!/\d/.test(t)) { continue; }                 // 表头 / “提取” / 纯文字行
      if (/^[#\-\s=*_.]+$/.test(t)) { continue; }
      // 整行既没有点也没有星号时，只可能是“空格分隔的四段”，否则按界面噪声丢弃
      // （如“已选 0 条数据：”“1 提取”“共 200 条”）
      if (!/[.*]/.test(t) &&
          !/(^|\s)(\d{1,3}|\*)\s+(\*|\d{1,3})\s+(\d{1,3}|\*)\s+(\d{1,3}|\*)(\s|$)/.test(t)) { continue; }

      var toks = t.split(/[\s,\t|;]+/).filter(Boolean);
      var found = null, isCidr = false;

      for (var j = 0; j < toks.length; j++) {
        var tk = toks[j].replace(/^[`'"]+|[`'"]+$/g, "").replace(/:\d{1,5}$/, "");   // 去引号/端口
        if (CIDR.test(tk)) { found = tk; isCidr = true; break; }
        if (TOKEN.test(tk)) { found = tk; break; }
        /* 换一种写法再认一遍：打码位写成 ? 或 x（198.?.42.81），
           两个以上星号折成一个（198.**.42.81 这种野写法）。 */
        var q = tk.replace(/\?/g, "*").replace(/[xX×]/g, "*").replace(/\*{2,}/g, "*");
        if (CIDR.test(q)) { found = q; isCidr = true; break; }
        if (TOKEN.test(q)) { found = q; break; }
        // 还被 Markdown 强调符包着 / 紧贴着说明文字
        var mc = q.match(BOLD_CIDR);
        if (mc) { found = mc[1]; isCidr = true; break; }
        var mt = q.match(BOLD_TOKEN);
        if (mt) { found = mt[1]; break; }
      }

      if (!found) {                                     // 退路：空格分隔的四段
        var m2 = t.match(/(^|\s)(\d{1,3}|\*)\s+(\*|\d{1,3})\s+(\d{1,3}|\*)\s+(\d{1,3}|\*)(\s|$)/);
        if (m2) { found = [m2[2], m2[3], m2[4], m2[5]].join("."); }
      }
      if (!found) { unmatched.push({ line: i + 1, text: t }); continue; }

      var patterns;
      if (isCidr) {
        var mm = found.match(CIDR);
        var bits = +mm[5], o1 = +mm[1], o2 = +mm[2], o3 = +mm[3], n;
        patterns = [];
        if (bits < 16) {
          unmatched.push({ line: i + 1, text: t + "  (小于 /16 暂不支持)" });
          continue;
        }
        /* 粒度统一到 /24（跟打码位一样）：一个 CIDR 展开成它覆盖的那些 /24，
           /16 → 256 个，/20 → 16 个，/24 及更长（都落在同一个网段里）→ 1 个。
           地址按无符号 32 位算，第 4 段落在哪都不影响 /24 —— 不做 o3+1 那种进位。 */
        var base = ((o1 << 24) | (o2 << 16) | (o3 << 8)) >>> 0;
        n = bits >= 24 ? 1 : Math.min(Math.pow(2, 24 - bits), 256);
        for (var k = 0; k < n; k++) {
          var a = (base + k * 256) >>> 0;
          patterns.push(((a >>> 24) & 255) + "." + ((a >>> 16) & 255) + "." + ((a >>> 8) & 255) + ".*");
        }
      } else {
        patterns = [found];
      }

      for (var p = 0; p < patterns.length; p++) {
        if (seen[patterns[p]]) { duplicates++; continue; }
        seen[patterns[p]] = 1;
        items.push({ index: items.length + 1, sourceLine: i + 1, raw: t, pattern: patterns[p] });
      }
    }
    return { items: items, unmatched: unmatched, duplicateCount: duplicates, blankLines: blank, lineCount: lines.length };
  }

  function parseInput(text) { return parseWithReport(text).items; }
  function isValidPattern(p) { return TOKEN.test(String(p)); }

  /* ---------- 3. 判定 ---------- */
  function analyze(pattern, data, opts) {
    opts = opts || {};
    var res = {
      pattern: pattern, ok: false, reason: "", tier: "", tierText: "", found: false, starPos: -1,
      host4: null, singleHost: false, counts: { 1: 0, 2: 0, 3: 0, 4: 0, 6: 0 },
      pctIsp: 0, dcHeavy: false, candidates: [], metroCount: 0, host24: null
    };
    var parts = String(pattern).split(".");
    if (parts.length !== 4) { res.reason = "不是 4 段格式"; return res; }
    for (var i = 0; i < 4; i++) {
      var v = parts[i];
      if (v === "*") {
        if (res.starPos >= 0) { res.reason = "多于一个打码段，暂不支持"; return res; }
        res.starPos = i;
      } else if (!/^\d{1,3}$/.test(v) || +v > 255) { res.reason = "非法段: " + v; return res; }
    }
    if (res.starPos === 0) { res.reason = "第一段被打码，无法定位"; return res; }
    if (!data || !data.prefixes) { res.reason = "数据包未加载"; return res; }

    var key, o2;
    if (res.starPos === 1) { key = parts[0] + ".*." + parts[2]; o2 = null; res.host4 = +parts[3]; }
    else if (res.starPos === 3) { key = parts[0] + ".*." + parts[2]; o2 = +parts[1]; }
    else if (res.starPos === -1) { key = parts[0] + ".*." + parts[2]; o2 = +parts[1]; res.host4 = +parts[3]; res.singleHost = true; }
    else { res.reason = "打码在第 3 段，需要 /16 级数据包（当前按 /24 收录）"; return res; }

    var p = data.prefixes[key];
    if (!p) { res.reason = "数据包里没有 " + key + "（需重跑扫描补数据）"; return res; }
    res.found = true; res.key = key; res.o1 = p.o1; res.o3 = p.o3;

    var codes = String(p.c).split(","), ispsArr = String(p.i).split(","), citiesArr = String(p.g).split(",");
    var lo = (o2 === null) ? 0 : o2, hi = (o2 === null) ? 255 : o2;
    /* 落在标记区域里的网段数：图例那行「有没有圈」和排序都用它，所以和热度图同一把尺子 ——
       数的是这一行画出来的那些网段里有几个带 +8 位（不是只数住宅候选段）。 */
    for (var x = lo; x <= hi; x++) {
      var codeX = +codes[x] || 0;
      var base = codeX & 7;
      if (res.counts[base] === undefined) { base = 6; }
      res.counts[base]++;
      if (codeX & METRO_BIT) { res.metroCount++; }
    }
    res.sampled = hi - lo + 1;
    /* 第 4 段打码：这一段是「这个网段的 254 个可用地址」。
       实测数据本身是 /24 粒度，同一个网段里 254 个主机同类，所以样本数按 254 算。 */
    if (res.starPos === 3) {
      var cat3 = (+codes[o2] || 0) & 7;
      if (res.counts[cat3] === undefined) { cat3 = 6; }
      for (var k3 in res.counts) { res.counts[k3] = 0; }
      res.counts[cat3] = HOST_HI - HOST_LO + 1;
      res.sampled = HOST_HI - HOST_LO + 1;
      res.hostRange = HOST_LO + "-" + HOST_HI;
    }
    res.pctIsp = Math.round(100 * res.counts[1] / res.sampled);

    if (o2 !== null) {
      var codeS = +codes[o2] || 0;
      res.host24 = {
        o2: o2, cat: codeS & 7, metro: !!(codeS & METRO_BIT),
        city: data.cities[+citiesArr[o2]] || "", isp: data.isps[+ispsArr[o2]] || "",
        network: res.o1 + "." + o2 + "." + res.o3 + ".0/24"
      };
    }

    var isp = res.counts[1], dc = res.counts[2];
    if (res.singleHost) {
      var sc = res.host24.cat;
      res.tier = sc === CAT.ISP ? "A" : sc === CAT.DC ? "D" : sc === CAT.MOB ? "B" : sc === CAT.BIZ ? "C" : "X";
      res.tierText = CAT_NAME[sc] || "未知";
      res.dcHeavy = sc === CAT.DC;
      res.ok = true;
      return res;
    }
    if (isp >= 150) { res.tier = "A"; res.tierText = "住宅为主"; }
    else if (isp >= 60) { res.tier = "B"; res.tierText = "住宅+商业混合"; }
    else if (isp >= 20) { res.tier = "C"; res.tierText = "商业/机构为主"; }
    else { res.tier = "D"; res.tierText = "机房/机构为主"; }
    res.dcHeavy = dc >= 100;
    res.ok = true;

    if (o2 === null) {
      for (var y = 0; y < 256; y++) {
        var code = +codes[y] || 0;
        if ((code & 7) !== CAT.ISP) { continue; }
        var cCity = data.cities[+citiesArr[y]] || "";
        var cand = {
          ip: res.o1 + "." + y + "." + res.o3 + "." + res.host4,
          network: res.o1 + "." + y + "." + res.o3 + ".0/24",
          city: cCity,
          isp: data.isps[+ispsArr[y]] || "",
          metro: !!(code & METRO_BIT)
        };
        res.candidates.push(cand);
      }
    }
    return res;
  }

  /* 单行判定：实测数据优先；这里没有这个网段时交给 IP 归属表（任意 IPv4 都能回答）。
     单独抽出来是给页面用的 —— 页面要按帧分批算，中间好把进度画出来（analyzeMany 是一口气算完）。 */
  function analyzeItem(item, data, opts) {
    opts = opts || {};
    var r = analyze(item.pattern, data);
    if (!r.ok && opts.world && opts.world.ready && opts.world.ready()) {
      var g = analyzeGlobal(item.pattern, { world: opts.world, city: opts.cityPack || null });
      if (g.ok) { r = g; } else if (!r.reason) { r.reason = g.reason; }
    }
    r.index = item.index;
    r.sourceLine = item.sourceLine;
    r.raw = item.raw;
    r.country = countryHist(r, { world: opts.world, cityPack: opts.cityPack });
    r.city = cityHist(r, { data: data, cityPack: opts.cityPack });
    return r;
  }

  /* 各级行数：表格上方那排数字的唯一出处（页面分批算完也调它汇总） */
  function countRows(rows) {
    var counts = { A: 0, B: 0, C: 0, D: 0, X: 0, fail: 0 };
    (rows || []).forEach(function (r) {
      if (r && r.ok) { counts[r.tier] = (counts[r.tier] || 0) + 1; } else { counts.fail++; }
    });
    return counts;
  }

  function analyzeMany(items, data, opts) {
    var rows = items.map(function (item) { return analyzeItem(item, data, opts); });
    return { rows: rows, counts: countRows(rows) };
  }

  /* ---------- 3c. 每行的「国家」：优先城市数据（DB-IP 定位国），没加载时退回 IP 归属表的 ASN 注册国 ----------
     打码行把 256（或 254）个取值逐个定位后取最多的那个；单个真实 IP 就只有它自己。
     两个来源在悬停里写清楚，免得把「ASN 注册国」当成「IP 所在地」。 */
  function countryHist(r, opts) {
    opts = opts || {};
    if (!r || !r.ok) { return null; }
    var parts = String(r.pattern).split(".");
    if (parts.length !== 4) { return null; }
    var world = opts.world, city = opts.cityPack || null;
    var o1 = +parts[0];
    var from, to;
    if (r.starPos === 3) { from = HOST_LO; to = HOST_HI; }
    else if (r.starPos < 0) { from = to = +parts[3]; }
    else { from = 0; to = 255; }
    var hist = {}, n = 0, viaCity = 0, viaAsn = 0, miss = 0;
    for (var v = from; v <= to; v++) {
      var q = parts.slice();
      if (r.starPos >= 0) { q[r.starPos] = String(v); }
      var ip = q.join(".");
      var cc = "";
      var hit = (city && city.has && city.has(o1) && city.lookupIp) ? city.lookupIp(ip) : null;
      if (hit && hit.country) { cc = hit.country; viaCity++; }
      else {
        var e = (world && world.asnOf) ? world.asnOf(ip) : null;
        if (e && e.cc) { cc = e.cc; viaAsn++; } else { miss++; }
      }
      n++;
      cc = String(cc || "").toUpperCase();
      if (cc) { hist[cc] = (hist[cc] || 0) + 1; }
    }
    var top = Object.keys(hist).map(function (k) { return { cc: k, count: hist[k] }; })
      .sort(function (a, b) { return b.count - a.count; });
    if (!top.length) { return null; }
    return {
      cc: top[0].cc, count: top[0].count, n: n,
      pct: n ? Math.round(100 * top[0].count / n) : 0,
      kinds: top.length,
      second: top[1] ? top[1].cc : "",
      viaCity: viaCity, viaAsn: viaAsn, miss: miss,
      src: viaCity >= viaAsn ? "按 IP 定位 · 城市数据 DB-IP" : "按 ASN 注册地 · IP 归属表"
    };
  }

  /* ---------- 3d. 每行的「城市」：和「国家」同一套规则（城市数据优先，其次实测记录） ----------
     打码行取枚举取值里最多的那个城市（悬停里给占比），单个真实 IP 就取它自己。
     查不到就返回 null，UI 写「—」—— 不猜。 */
  function cityHist(r, opts) {
    opts = opts || {};
    if (!r || !r.ok) { return null; }
    var parts = String(r.pattern).split(".");
    if (parts.length !== 4) { return null; }
    var slice = opts.cityPack || null, data = opts.data || null;
    var o1 = +parts[0], hist = {}, n = 0, viaSlice = 0, viaPack = 0, covered = 0;
    var from, to;
    if (r.starPos === 3) { from = HOST_LO; to = HOST_HI; }
    else if (r.starPos < 0) { from = to = +parts[3]; }
    else { from = 0; to = 255; }
    /* 实测记录的兜底：同一次扫描给每个网段都记了城市，不用再下城市数据 */
    var packCities = null;
    if (data && data.prefixes && r.key && data.prefixes[r.key]) {
      packCities = String(data.prefixes[r.key].g).split(",");
    }
    for (var v = from; v <= to; v++) {
      var q = parts.slice();
      if (r.starPos >= 0) { q[r.starPos] = String(v); }
      var ip = q.join(".");
      var name = "";
      var hit = (slice && slice.has && slice.has(o1) && slice.lookupIp) ? slice.lookupIp(ip) : null;
      if (hit && hit.city) { name = hit.city; viaSlice++; }
      else if (packCities) {
        var idx = (r.starPos === 3 || r.starPos < 0) ? +parts[1] : v;
        name = data.cities[+packCities[idx]] || "";
        if (name) { viaPack++; }
      }
      n++;
      if (name) { hist[name] = (hist[name] || 0) + 1; covered++; }
    }
    var top = Object.keys(hist).map(function (k) { return { city: k, count: hist[k] }; })
      .sort(function (a, b) { return b.count - a.count; });
    if (!top.length) { return null; }
    return {
      city: top[0].city, count: top[0].count, n: n, top: top.slice(0, 4),
      pct: n ? Math.round(100 * top[0].count / n) : 0,
      kinds: top.length, second: top[1] ? top[1].city : "",
      viaSlice: viaSlice, viaPack: viaPack, covered: covered,
      /* 单个真实 IP 只有它自己一个取值，谈不上「取最多」—— 和国家那一列用同一句话 */
      src: r.singleHost ? "按 IP 定位 · 城市数据 DB-IP"
        : (viaSlice >= viaPack ? "逐值定位取最多 · 城市数据 DB-IP" : "取自扫描记录 · 实测记录")
    };
  }

  /* ---------- 3b. IP 归属表判定：查不到实测数据时的兜底，靠“任意 IP → ASN”的段表 + 城市数据 ----------
     打码位同样要把 256 种取值枚举完，但结论仍然落回整行。
     ASN 层是估算：同一 ASN 内既有住宅池也有企业段，所以出的级别标 approx，行上标 source。 */
  function analyzeGlobal(pattern, opts) {
    opts = opts || {};
    var world = opts.world, city = opts.city || null;
    var res = {
      pattern: pattern, ok: false, reason: "", tier: "", tierText: "", found: true, starPos: -1,
      host4: null, singleHost: false, counts: { 1: 0, 2: 0, 3: 0, 4: 0, 6: 0 },
      pctIsp: 0, dcHeavy: false, candidates: [], metroCount: 0,
      host24: null, source: "全球ASN", approx: true, asnHist: {}, homeShare: 0
    };
    if (!world || !world.ready || !world.ready()) { res.reason = "IP 归属表没加载"; return res; }

    var parts = String(pattern).split(".");
    if (parts.length !== 4) { res.reason = "不是 4 段格式"; return res; }
    for (var i = 0; i < 4; i++) {
      var v = parts[i];
      if (v === "*") {
        if (res.starPos >= 0) { res.reason = "多于一个打码段，暂不支持"; return res; }
        res.starPos = i;
      } else if (!/^\d{1,3}$/.test(v) || +v > 255) { res.reason = "非法段: " + v; return res; }
    }
    if (res.starPos === 0) { res.reason = "第一段被打码，无法定位"; return res; }

    function cityOf(ipStr) {
      if (!city || !city.lookupIp || !city.has || !city.has(+ipStr.split(".")[0])) { return ""; }
      var hit = city.lookupIp(ipStr);
      return hit ? hit.city || "" : "";
    }

    /* 单个确定 IP：直接用这个 IP 的 ASN 类型定级 */
    if (res.starPos === -1) {
      var ip0 = parts.join(".");
      var e0 = world.asnOf(ip0);
      if (!e0) { res.reason = "ASN 段表里没查到 " + ip0; return res; }
      var raw0 = world.prob(e0);
      var p0 = Math.min(raw0, ASN_CONF_CAP);
      res.capped = raw0 > ASN_CONF_CAP;
      var c0 = cityOf(ip0);
      res.singleHost = true;
      res.host4 = +parts[3];
      res.counts = { 1: 0, 2: 0, 3: 0, 4: 0, 6: 0 };
      res.counts[e0.t] = 1;
      res.sampled = 1;
      res.asnHist[e0.asn] = 1;
      res.host24 = {
        o2: +parts[1], cat: e0.t, metro: false, city: c0, isp: e0.name,
        network: parts[0] + "." + parts[1] + "." + parts[2] + ".0/24",
        asn: e0.asn, prob: p0
      };
      /* 类型来自关键词 + PeeringDB：机房 / 移动 / 机构 这三种判得最稳，先认；
         住宅 ISP 与「类型不明」则交给标定占比，套跟打码行同一把尺子，
         免得出现「其他/不明」却写着 82% 住宅、或「住宅 ISP」实际占比只有 10% 这种自相矛盾。 */
      var cat = e0.t;
      if (cat !== CAT.DC && cat !== CAT.MOB && cat !== CAT.BIZ) {
        if (p0 >= 0.586) { cat = CAT.ISP; }
        else if (p0 >= 0.234) { cat = CAT.BIZ; }
        else if (p0 > 0) { cat = CAT.DC; }
      }
      res.tier = cat === CAT.ISP ? "A" : cat === CAT.DC ? "D" : cat === CAT.MOB ? "B" : cat === CAT.BIZ ? "C" : "X";
      res.tierText = cat === CAT.ISP ? "住宅为主（按运营商估算）"
        : cat === CAT.DC ? "机房/机构为主（按运营商估算）"
          : cat === CAT.MOB ? "移动网络（按运营商）"
            : cat === CAT.BIZ ? "商业/机构为主（按运营商估算）" : "未知（按运营商）";
      res.dcHeavy = cat === CAT.DC;
      res.host24.cat = cat;
      res.pctIsp = Math.round(100 * p0);
      res.counts[1] = Math.round(p0);
      res.homeShare = p0;
      /* 单个 IP 在 IP 归属表给的是「这个 ASN 的住宅概率」，不是采样计数，UI 要按概率显示 */
      res.probOnly = true;
      res.ok = true;
      return res;
    }

    /* 打码行：枚举取值逐个查 ASN + 城市，再按占比定级。
       第 4 段打码 → 只枚举这个网段的可用主机 1–254（.0 网络地址 / .255 广播地址跳过）；
       第 2/3 段打码 → 0–255 全覆盖（那是网段维度，不是主机维度）。 */
    var from = res.starPos === 3 ? HOST_LO : 0;
    var to = res.starPos === 3 ? HOST_HI : 255;
    var span = to - from + 1;
    if (res.starPos === 3) { res.hostRange = HOST_LO + "-" + HOST_HI; }
    var sumP = 0, hardIsp = 0, covered = 0, cityCounts = {};
    for (var x = from; x <= to; x++) {
      var q = parts.slice();
      q[res.starPos] = String(x);
      var ip = q.join(".");
      var entry = world.asnOf(ip);
      if (!entry) { continue; }
      var pRaw = world.prob(entry);
      var p = Math.min(pRaw, ASN_CONF_CAP);
      if (pRaw > ASN_CONF_CAP) { res.capped = true; }
      /* 一个段里 256 个取值可能落在不同 ASN 上，逐一加权 */
      res.counts[entry.t] = (res.counts[entry.t] || 0) + 1;
      if (p > 0) { hardIsp++; }
      sumP += p;
      res.asnHist[entry.asn] = (res.asnHist[entry.asn] || 0) + 1;

      var cityName = cityOf(ip);
      if (cityName) { covered++; cityCounts[cityName] = (cityCounts[cityName] || 0) + 1; }
      if (p > 0) {
        res.candidates.push({
          ip: ip, network: ip.split(".").slice(0, 3).join(".") + ".0/24",
          city: cityName, isp: entry.name, metro: false,
          asn: entry.asn, prob: Math.round(100 * p) / 100
        });
      }
    }
    res.sampled = span;
    res.covered = covered;
    res.cityTop = Object.keys(cityCounts).map(function (k) { return { city: k, count: cityCounts[k] }; })
      .sort(function (a, b) { return b.count - a.count; }).slice(0, 8);
    /* 每个取值的 p 都已封顶，均值也必然 <= 封顶值；再夹一次只是抹掉浮点噪声
       （否则 254 个 0.9 相加会算出 0.9000000000000038 > 0.9） */
    res.homeShare = Math.min(sumP / span, ASN_CONF_CAP);
    res.counts[1] = Math.round(sumP);
    res.pctIsp = Math.round(100 * res.homeShare);
    /* IP 归属表的「住宅个数」是概率加权出来的（254 个地址 × 0.9），不是实测计数，
       UI 要按概率显示，别写成「229/254」 */
    res.probOnly = true;
    var share = res.homeShare;
    if (share >= 0.586) { res.tier = "A"; res.tierText = "住宅为主（按运营商估算）"; }
    else if (share >= 0.234) { res.tier = "B"; res.tierText = "住宅+商业混合（按运营商估算）"; }
    else if (share >= 0.078) { res.tier = "C"; res.tierText = "商业/机构为主（按运营商估算）"; }
    else { res.tier = "D"; res.tierText = "机房/机构为主（按运营商估算）"; }
    res.dcHeavy = res.counts[2] >= 150;
    res.hardIsp = hardIsp;
    res.ok = true;
    return res;
  }

  function _catName(c) { return CAT_NAME[c]; }

  /* ---------- 3c. 联网核验结果盖到行上（可选，默认不联网） ----------
     IP 归属表只认得 ASN，认不出「ASN 里的机房客户段」。联网核验拿接口返回的
     org/isp/托管标记把这种段挑出来：只要抽样里有一个是机房，整行改判 D。 */
  function applyOnline(res, online) {
    if (!res || !online) { return res; }
    res.online = {
      verdict: online.verdict || "UNK",
      provider: online.provider || "",
      org: online.org || "",
      isp: online.isp || "",
      city: online.city || "",
      sampled: online.sampled || 0,
      checked: online.checked || 0,
      dc: online.dc || 0,
      why: online.why || "",
      ok: !!online.ok
    };
    res.onlineSamples = online.samples || [];
    if (!online.ok) {
      res.onlineNote = "联网核验没成功（" + (online.error || "接口都没成功") + "），这一行还是 ASN 级估算。";
      return res;
    }
    var who = res.online.org || res.online.isp || "接口没给 org";
    if (online.verdict === "DC") {
      var n = res.sampled || (online.checked || 1);
      res.tier = "D"; res.tierText = "机房/机构（联网核验）";
      res.dcHeavy = true; res.approx = false; res.source = "联网核验"; res.verified = true;
      res.counts = { 1: 0, 2: n, 3: 0, 4: 0, 6: 0 };
      res.pctIsp = 0; res.homeShare = 0;
      res.candidates = [];
      res.onlineNote = "接口返回的 org 是「" + who + "」——" + online.why +
        "。这一段按机房处理（住宅 0%），别当纯净住宅用。";
    } else if (online.verdict === "MOBILE") {
      res.tier = "B"; res.tierText = "移动网络（联网核验）";
      res.source = "联网核验"; res.verified = true;
      res.onlineNote = "接口标记这是移动网络（org「" + who + "」）：手机流量池，不是住宅固网。";
    } else {
      res.verified = true;
      res.onlineNote = "联网核验未发现机房/移动信号（org「" + who + "」，" + online.why +
        "）。这只能排除「明显机房」，不等于确认是住宅 IP —— 仍是 ASN 级估算。";
    }
    return res;
  }

  function sortCandidates(list) {
    return list.slice().sort(function (a, b) {
      if (a.metro !== b.metro) { return a.metro ? -1 : 1; }
      if (a.city !== b.city) { return a.city < b.city ? -1 : 1; }
      return a.ip < b.ip ? -1 : 1;
    });
  }

  /* ---------- 4. 排名：以“你粘贴的那一行（带 *）”为单位 ----------
     第 2 段被打码时，内部要把 256 种可能全部枚举出来统计，但结论必须落回这一行本身：
     排序键 = 级别 → 得分 → 住宅占比 → 落在标记区域里的网段数 → 模式字面量。 */
  var TIER_ORDER = { A: 0, B: 1, C: 2, D: 3, X: 4 };
  var TIER_BONUS = { A: 60, B: 30, C: 10, D: 0, X: 0 };

  /* 0–100 的质量分。级别占大头（A 60 / B 30 / C 10 / D 0），住宅占比 30 分，
     机房占比扣 10 分，另外 IP 归属表估算（上限）扣 5 分 —— 跟级别排序保持一致，不会出现
     “排名靠后分数反而高”的怪事。 */
  function rowScore(r) {
    if (!r || !r.ok) { return 0; }
    var n = r.sampled || 0;
    var ispPct = n ? 100 * r.counts[1] / n : 0;
    var dcPct = n ? 100 * r.counts[2] / n : 0;
    var s = (TIER_BONUS[r.tier] || 0) + 0.3 * ispPct + 0.1 * (100 - dcPct) - (r.approx ? 5 : 0);
    /* 整数分：表格、详情、CSV、复制文本都用这一个数，免得出现「表里 92、导出 91.4」 */
    return Math.round(Math.max(0, Math.min(100, s)));
  }

  /* 得分配色分档：表格 / 详情 / 实测报告共用同一把尺子
     绿 ≥75 较干净 · 橙 50–74 中性 · 蓝灰 25–49 偏差 · 红 <25 不可用 */
  function scoreBand(n) { return n >= 75 ? "g" : n >= 50 ? "o" : n >= 25 ? "b" : "d"; }

  /* ---------- 构成条的宽度：表格里的小条和详情里的大条共用同一个算法 ----------
     实测记录按计数画；IP 归属表那一段是概率加权值（counts[1] 已折算过），其余类别按剩余宽度缩放，
     免得出现「条子 20% 绿、数字写 ≈90%」这种自相矛盾。 */
  function shareWidths(r) {
    var c = (r && r.counts) || {}, sampled = (r && r.sampled) || 1, w = {};
    if (r && r.probOnly) {
      var restSum = 0;
      [2, 3, 4, 6].forEach(function (k) { restSum += c[k] || 0; });
      var restW = Math.max(0, 100 - Math.round(100 * (c[1] || 0) / sampled));
      w[1] = Math.round(100 * (c[1] || 0) / sampled);
      [2, 3, 4, 6].forEach(function (k) { w[k] = restSum > 0 ? Math.round(restW * (c[k] || 0) / restSum) : 0; });
      /* IP 归属表只看得到 ASN（住宅占比还封顶 90%）：剩下那一截是「看不出来」，
         单独画成灰色的未知段 —— 不是没颜色的空白，也不写「其他/不明」（那等于替它下了结论）。 */
      w.unk = Math.max(0, 100 - w[1] - w[2] - w[3] - w[4] - w[6]);
    } else {
      [1, 2, 3, 4, 6].forEach(function (k) { w[k] = Math.round(100 * (c[k] || 0) / sampled); });
      w.unk = 0;   /* 实测记录：每个取值都有类别，没有看不出来的部分 */
    }
    return w;
  }
  /* 某一类在这一行里的个数文案：IP 归属表的住宅是折算值，带 ≈（别让人当成实测计数） */
  function catCount(r, k) {
    if (r && r.probOnly && k === 1) { return "≈" + homeNum(r); }
    return String(Math.round(((r && r.counts ? r.counts[k] : 0) || 0)));
  }

  /* 住宅占比配色分档：跟着级别线走（A ≥58 / B ≥23 / C >0 / D =0），和级别药丸同色 */
  function shareBand(p) { return p >= 58 ? "g" : p >= 23 ? "o" : p > 0 ? "b" : "d"; }

  /* ---------- 「住宅」那一格的唯一出处（表格 / 详情 / 报告 / CSV 共用） ----------
     - 打码行（样本 = 256 个网段或 254 个主机）：`[≈]住宅数/样本数 · 占比%`
     - 单个真实 IP：样本只有它自己，谈占比没意义 → 直接写它属于哪一类
     - ≈ 的含义：这个数不是一个个数出来的，是按 ASN 住宅先验折算的（按运营商） */
  function homePct(r) {
    var den = (r && r.sampled) || 1;
    if (r && r.pctIsp != null) { return r.pctIsp; }
    return Math.round(100 * ((r && r.counts ? r.counts[1] : 0) || 0) / den);
  }
  function homeNum(r) {
    var v = ((r && r.counts ? r.counts[1] : 0) || 0);
    if (!r || !r.probOnly) { return String(Math.round(v)); }
    return String(Math.round(v * 10) / 10);
  }
  function homeTxt(r) {
    if (r && r.singleHost) {
      return "单个 IP · " + (CAT_NAME[r.host24 ? r.host24.cat : 6] || "未知");
    }
    return (r && r.probOnly ? "≈" : "") + homeNum(r) + "/" + ((r && r.sampled) || 1) + " · " + homePct(r) + "%";
  }

  function rankRows(rows) {
    var list = rows.slice().sort(function (a, b) {
      var ta = TIER_ORDER[a.ok ? a.tier : "X"], tb = TIER_ORDER[b.ok ? b.tier : "X"];
      if (ta !== tb) { return ta - tb; }
      if (a.ok && b.ok) {
        var sa = rowScore(a), sb = rowScore(b);
        if (sb !== sa) { return sb - sa; }
        if (b.pctIsp !== a.pctIsp) { return b.pctIsp - a.pctIsp; }
        if ((b.metroCount || 0) !== (a.metroCount || 0)) { return (b.metroCount || 0) - (a.metroCount || 0); }
      }
      return String(a.pattern) < String(b.pattern) ? -1 : 1;
    });
    for (var i = 0; i < list.length; i++) {
      list[i].rank = i + 1;
      list[i].score = rowScore(list[i]);
    }
    return list;
  }

  /* 「建议拿」这一格：只给一个能直接拿的 IP —— 网段没法直接拿，给了也没用。
     整行就是一个真实 IP → 就是它；
     第 2 段打码 → 256 个取值排出来，给排最前的那个住宅落点；
     整行是一整个网段（第 4 段打码 / 网段写法）→ 数据只到网段这一层，
     里面哪个地址都一样，挑不出更该拿的，这一格就留空。 */
  function takeIp(r) {
    if (!r || !r.ok) { return ""; }
    if (r.singleHost) { return String(r.pattern); }
    if (r.starPos === 1) {
      var c = sortCandidates(r.candidates)[0];
      return c ? c.ip : "";
    }
    return "";
  }
  /* 上面那一格的口径：为什么是它，或者为什么没有 */
  function takeWhy(r) {
    if (!r || !r.ok) { return "这一行还没判定出来"; }
    if (r.singleHost) { return "整行就这一个 IP，拿这个"; }
    if (r.starPos === 1) {
      var n = sortCandidates(r.candidates).length;
      return n
        ? "整行 " + n + " 个住宅落点里排最前的那个，其余在下面的热度图上"
        : "整行枚举出的 " + (r.sampled || 256) + " 个落点里没有住宅段，这一行不给建议";
    }
    return "整行是一整个网段的 254 个可用地址，数据里它们没有差别，挑不出更该拿的那个";
  }

  /* 实测数据包是按 o1.*.o3 收录的：给出这个模式下要查的键（查不到就得走 IP 归属表） */
  function patternKey(pattern) {
    var p = String(pattern).split(".");
    if (p.length !== 4 || p[0] === "*") { return ""; }
    if (p[1] === "*") { return p[0] + ".*." + p[2]; }          // 第 2 段打码
    return p[0] + ".*." + p[2];                                // 第 3 段打码 / 单个真实 IP
  }

  function csvCell(v) { var s = String(v == null ? "" : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }

  function pct(a, b) { return b ? Math.round(1000 * a / b) / 10 : 0; }

  /* 行级排名表（主产物）：一行 = 你粘贴的一行，不带具体枚举结果 */
  function toCsv(rows, tiers, perRow) {
    perRow = perRow || 3;
    var out = [T("排名,IP模式,主要城市,主要国家,级别,级别说明,数据来源,得分,住宅,住宅%,机房%,商业%,移动%,建议拿的 IP,参考枚举IP(前" + perRow + ")")];
    rows.forEach(function (r) {
      if (!r.ok || (tiers && tiers.length && tiers.indexOf(r.tier) < 0)) { return; }
      var n = r.sampled || 0;
      var picks = sortCandidates(r.candidates).slice(0, perRow)
        .map(function (c) { return c.ip + (c.metro ? "★" : ""); }).join(" / ");
      out.push([
        r.rank || r.index, r.pattern, csvCell(cityLabel(r.city ? r.city.city : "")),
        r.country ? r.country.cc : "", r.tier, T(r.tierText),
        r.source || T("实测记录"), r.score,
        csvCell(homeTxt(r)), homePct(r),
        pct(r.counts[2], n), pct(r.counts[3], n), pct(r.counts[4], n),
        takeIp(r), csvCell(picks)
      ].join(","));
    });
    return out.join("\n");
  }

  /* 枚举明细（附件产物）：一行 = 打码模式下某一种第 2 段取值的落点 */
  function toCsvCandidates(rows, tiers, perRow) {
    perRow = perRow || 25;
    var out = [T("排名,IP模式,枚举IP,城市,运营商,类别,都会区标记")];
    rows.forEach(function (r) {
      if (!r.ok || (tiers && tiers.length && tiers.indexOf(r.tier) < 0)) { return; }
      if (r.singleHost) {
        out.push([r.rank || r.index, r.pattern, r.pattern, csvCell(r.host24.city),
                  csvCell(r.host24.isp), T(CAT_NAME[r.host24.cat] || ""), r.host24.metro ? 1 : 0].join(","));
        return;
      }
      sortCandidates(r.candidates).slice(0, perRow).forEach(function (c) {
        out.push([r.rank || r.index, r.pattern, c.ip, csvCell(c.city),
                  csvCell(c.isp), T(CAT_NAME[1]), c.metro ? 1 : 0].join(","));
      });
    });
    return out.join("\n");
  }

  return {
    CAT: CAT, CAT_NAME: CAT_NAME, METRO_BIT: METRO_BIT,
    ASN_CONF_CAP: ASN_CONF_CAP,
    normalize: normalize, parseWithReport: parseWithReport, parseInput: parseInput,
    isValidPattern: isValidPattern, analyze: analyze, analyzeGlobal: analyzeGlobal,
    analyzeItem: analyzeItem, analyzeMany: analyzeMany, countRows: countRows,
    applyOnline: applyOnline,
    sortCandidates: sortCandidates, toCsv: toCsv, toCsvCandidates: toCsvCandidates,
    rankRows: rankRows, rowScore: rowScore, takeIp: takeIp, takeWhy: takeWhy,
    scoreBand: scoreBand,
    patternKey: patternKey,
    countryHist: countryHist, cityHist: cityHist,
    cityLabel: cityLabel,
    homeTxt: homeTxt, homeNum: homeNum, homePct: homePct, shareBand: shareBand,
    shareWidths: shareWidths, catCount: catCount
  };
});
