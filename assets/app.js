/* app.js —— 静态页交互：粘贴 → 清洗 → 分级 → 候选段 */
(function () {
  "use strict";
  var Core = window.AdvisorCore;
  var DATA = window.SEGMENT_DATA || null;
  var World = window.IPWorld || null;          // IP 归属表（ASN 全量段表 + 标定）
  var City = window.CityPacks || null;         // 城市数据（按 IP 第一段分片加载）
  var Online = window.IPOnline || null;        // 联网核验（可选，点了才联网）
  var Cloud = window.CloudPacks || null;       // 云厂商段包（同源静态文件）
  var Blocklists = window.IPBlocklists || null;// 风险名单包（同源静态文件）
  var AsnDiff = window.IPAsnDiff || null;      // 二源 ASN 分歧包（同源静态文件）
  var Enrich = window.IPEnrich || null;        // RDAP / PTR 轻量证据（点了才联网）
  var History = window.IPHistory || null;      // 对比快照（localStorage）
  var Share = window.IPShare || null;          // SVG 分享卡 / URL hash
  var worldState = "idle";                     // idle | loading | ready | failed
  var state = {
    items: [], asnTokens: [], rows: [], ranked: [], counts: {},
    filter: "all", active: null, unmatched: [],
    country: "", city: "", flag: "all", sort: { key: "rank", dir: 1 },
    compareId: null, compareMap: null, expanded: {}
  };
  var cityLoaded = {};                         // o1 → true（已 load 过的城市数据）

  var $ = function (id) { return document.getElementById(id); };
  /* 不经过 DOM 的文案（复制到剪贴板的文本、alert）自己翻一次；DOM 里的由 i18n.js 的观察器兜底 */
  function T(s) {
    var I = window.IPI18n;
    return I && I.t ? I.t(s) : s;
  }
  function toast(msg) {
    var t = $("toast"); t.textContent = msg; t.classList.add("on");
    clearTimeout(t._h); t._h = setTimeout(function () { t.classList.remove("on"); }, 1800);
  }
  var TIER_NAME = { A: "住宅为主", B: "住宅+商业混合", C: "商业/机构为主", D: "机房/机构为主", X: "未识别" };
  var CATCLS = { 1: "isp", 2: "dc", 3: "biz", 4: "mob", 6: "" };
  /* 全站一套语义色：住宅=绿 · 移动=橙 · 商业/机构=蓝灰 · 机房/代理=红 · 未知/没证据=灰。
     类别词（住宅ISP / 机房/云 …）到哪都带自己的颜色，扫一眼就知道是什么。 */
  var CAT_TONE = { 1: "g", 2: "d", 3: "b", 4: "o", 6: "x" };
  function tone(t) { return "t-" + (t || "x"); }
  var TIER_TONE = { A: "g", B: "o", C: "b", D: "d", X: "x" };

  function en() { return String((window.IPI18n && IPI18n.locale) ? IPI18n.locale() : "zh-CN").indexOf("en") === 0; }
  /* 只有「跨多段的打码行」（第 2/3 段打码 = 256 个取值散在整个 /8）才谈得上分布：
     「256 个取值里有 218 个落在美国」是有信息量的；第 4 段打码是一个网段、单 IP 是一个地址，
     它们写「1/1 = 100%」只是噪声。 */
  function hasDist(r) { return (r.starPos === 1 || r.starPos === 2) && r.sampled > 1; }
  /* 「这一行是估算还是实测」只在「来源」列说一次 —— 那张表里 来源 = IP 归属表 ⟺ approx = true，
     两种状态一一对应，级别列再挂一个「估算」徽标就是同一件事说两遍。
     级别列只留一个例外：不可路由的地址没人宣告，那不是「估算」，是根本没得判。 */

  /* 国旗用图片，不用 emoji：Windows 的 Segoe UI Emoji 里没有国旗字形，
     🇺🇸 会退成「US」两个字母（会跟「只显示中文名」的要求打架）。拿不到图就只剩中文名。 */
  var CC_ALIAS = { UK: "gb", EL: "gr", AN: "nl" };
  function flagImg(cc) {
    cc = String(cc || "").toUpperCase();
    if (!/^[A-Z]{2}$/.test(cc)) { return ""; }
    var code = CC_ALIAS[cc] || cc.toLowerCase();
    return '<img class="flag" data-cc="' + cc + '" src="https://flagcdn.com/w20/' + code + '.png" ' +
      'srcset="https://flagcdn.com/w40/' + code + '.png 2x" width="20" height="15" alt="" ' +
      'loading="lazy" referrerpolicy="no-referrer">';
  }
  /* 国家名交给浏览器本地化表，不自己维护一份 250 行的映射；语言跟着界面语言走，
     切换语言时重挂一次（Intl 的实例是钉死在创建时的 locale 上的）。 */
  var regionNames = null;
  var regionLang = "";
  function countryName(cc) {
    cc = String(cc || "").toUpperCase();
    if (!cc) { return ""; }
    var want = (window.IPI18n && IPI18n.locale) ? IPI18n.locale() : "zh-CN";
    if (regionNames === null || regionLang !== want) {
      regionLang = want;
      try { regionNames = new Intl.DisplayNames([want], { type: "region" }); } catch (e) { regionNames = false; }
    }
    if (regionNames) { try { return regionNames.of(cc) || cc; } catch (e) {} }
    return cc;
  }
  function countryCell(r) {
    var co = r.country;
    if (!co || !co.cc) { return '<span class="mono-s">—</span>'; }
    var why = countryName(co.cc) + "（" + co.cc + "）　" + co.src +
      "　取值分布 " + co.count + "/" + co.n + " = " + co.pct + "%" +
      (co.kinds > 1 ? "，共 " + co.kinds + " 个国家/地区，其次是 " + co.second : "");
    /* 表格里只放国旗（窄、好扫），国名 / 占比 / 来源都进悬停 */
    return '<span title="' + esc(why) + '">' + flagImg(co.cc) + "</span>";
  }
  /* 城市名的唯一渲染入口：一律 DB-IP 原文（英文），一份清单里不会一会儿中文一会儿英文。
     要换口径（比如以后接中文库）只改 core.cityLabel 一处。 */
  function citySpan(name, title) {
    var out = Core.cityLabel(name);
    if (!out) { return ""; }
    return "<span" + (title ? ' title="' + esc(title) + '"' : "") + ">" + esc(out) + "</span>";
  }
  /* 城市列 = 工具自己解析出来的落点城市（和国旗同一套规则、同一个数据源）。
     粘贴清单里的城市/国家标注一律丢弃：那份标注是对方的，不是实测的。 */
  function cityCell(r) {
    if (r.asnRow) {
      return '<span class="mono-s" title="ASN 聚合行不展开城市；在详情里展开单个 /24 后才有城市">—</span>';
    }
    var ci = r.city;
    if (!ci || !ci.city) {
      /* 三种「—」不是一回事：库里整段没有 / 这一行跨的 /8 太多还没拉 / 拉到了但记录里只有国家没有城市 */
      var o1 = String(r.pattern).split(".")[0];
      var loaded = City && City.has && City.has(o1);
      var why = loaded
        ? "城市数据 " + o1 + ".x 这一段的记录里只有国家、没有城市名"
        : (cityMissed[o1]
          ? "DB-IP 城市数据没有 " + o1 + ".x 这一段（保留段 / 未分配段本来就没有记录）"
          : "这一行的城市数据还在拉 · 拉到位会自己补上");
      return '<span class="mono-s" title="' + esc(why) + '">—</span>';
    }
    var why = Core.cityLabel(ci.city) + "　" + ci.src +
      "　取值分布 " + ci.count + "/" + ci.n + " = " + ci.pct + "%" +
      (ci.kinds > 1 ? "，共 " + ci.kinds + " 个城市，其次是 " + Core.cityLabel(ci.second) : "");
    return citySpan(ci.city, why);
  }

  /* 「来源」这一列的口径只写一份：表格悬停、详情定义格共用 */
  function rowSrcName(r) {
    if (r.source === "云厂商段表") { return "云厂商段表"; }
    if (r.asnRow) { return "IP 归属表"; }
    return r.source === "联网核验" ? "联网核验" : (r.source === "全球ASN" ? "IP 归属表" : "实测记录");
  }
  function rowSrcWhy(r) {
    if (r.source === "云厂商段表") { return "整 /24 落在厂商公开段内 · 确定性机房"; }
    if (r.asnRow) { return "IP 归属表 · 按这个 ASN 的全部宣告段聚合"; }
    if (r.source === "联网核验") { return "接口抽样实测 · 命中机房即整行改判"; }
    if (r.source === "全球ASN") { return "ASN 级估算 · 只看得到 ASN，级别是上限"; }
    return (r.starPos === 1 || r.starPos === 2)
      ? "实测 · 该 o1.*.o3 的 256 个网段逐个查过" : "实测 · 该网段的扫描记录";
  }

  /* ---------- 数据包 ---------- */
  function initData() {
    if (!DATA) {
      if ($("tableHost")) {
        $("tableHost").innerHTML = '<div class="empty">实测记录缺失：请先运行 <code>tools/make-data.ps1</code> 生成 <code>data/segments-data.js</code>。没有它也能用，只是全部落到 IP 归属表估算。</div>';
      }
    } else {
    var keys = Object.keys(DATA.prefixes || {});
    if ($("genAt")) { $("genAt").textContent = "数据包生成于 " + (DATA.generated || "?") + " · " + (DATA.source || ""); }
    }
    initPacks();
    initWorld();
  }

  /* 三个新增证据包并行加载。它们都是同源静态文件；任何一个失败都不阻断判定，
     只是那一层标记不出现（页面上写「未加载」，不假装空结果）。 */
  var packsP = null;
  function initPacks() {
    if (packsP) { return packsP; }
    var jobs = [];
    if (Cloud && Cloud.load) { jobs.push(Cloud.load()); }
    if (Blocklists && Blocklists.load) { jobs.push(Blocklists.load()); }
    if (AsnDiff && AsnDiff.load) { jobs.push(AsnDiff.load()); }
    packsP = jobs.length
      ? Promise.all(jobs).catch(function () { return []; })
      : Promise.resolve([]);
    return packsP;
  }

  function providerMeta(id) {
    var m = Cloud && Cloud.meta ? Cloud.meta() : null;
    var ps = (m && m.providers) || [];
    for (var i = 0; i < ps.length; i++) { if (ps[i].id === id) { return ps[i]; } }
    return null;
  }
  function providerLabel(id) {
    var p = providerMeta(id);
    return p ? (p.label || p.id) : String(id).toUpperCase();
  }
  function providerName(id) {
    var p = providerMeta(id);
    return p ? (p.name || p.label || p.id) : String(id);
  }
  function sourceName(id) {
    var m = Blocklists && Blocklists.meta ? Blocklists.meta() : null;
    var ss = (m && m.sources) || [];
    for (var i = 0; i < ss.length; i++) { if (ss[i].id === id) { return ss[i].name || id; } }
    return String(id);
  }

  /* 单行（IP 模式）套三层证据。云段可能改判，名单 / 二源分歧只标注。 */
  function applyEvidence(r) {
    if (!r || !r.ok) { return r; }
    if (Cloud && Cloud.ready && Cloud.ready()) { Core.applyCloud(r, Cloud); }
    if (Blocklists && Blocklists.ready && Blocklists.ready()) { Core.applyBlocklist(r, Blocklists); }
    if (AsnDiff && AsnDiff.ready && AsnDiff.ready()) { Core.applyAsnDiff(r, AsnDiff); }
    return r;
  }

  /* ASN 聚合行不能逐个 /24 查（可能十几万个），用「ASN 声明段 × 证据段」的交集粗算。 */
  function applyAsnEvidence(r) {
    if (!r || !r.ok || !r.asnProfile || !World || !World.rangesOf) { return r; }
    var ranges = World.rangesOf(r.asn);
    if (!ranges || !ranges.length) { return r; }
    if (Cloud && Cloud.ready && Cloud.ready() && Cloud.overlapRanges) {
      var ov = Cloud.overlapRanges(ranges);
      var cShare = ov && ov.blocks24 ? Math.round(100 * ov.full / ov.blocks24) : 0;
      /* 聚合行的「特征」门槛：交集不到 1% 的 /24 只说明这个 ASN 边缘蹭到云段，
         不该给整条 ASN 挂一个云厂商 badge。 */
      if (ov && ov.any && cShare >= 1) {
        var ids = Object.keys(ov.byProvider || {});
        var fullIds = ids.filter(function (id) { return ov.byProvider[id].full > 0; });
        r.cloud = {
          ids: ids, fullIds: fullIds,
          providers: ids.map(function (id) { return { id: id, label: providerLabel(id), name: providerName(id) }; }),
          fullProviders: fullIds.map(function (id) { return { id: id, label: providerLabel(id), name: providerName(id) }; }),
          count: ov.blocks24, any: ov.any, full: ov.full,
          share: cShare, network: "", scope: "asn", override: false, sampled: !!ov.sampled
        };
      }
    }
    if (Blocklists && Blocklists.ready && Blocklists.ready() && Blocklists.overlapRanges) {
      var bl = Blocklists.overlapRanges(ranges);
      var bPct = r.sampled && bl ? Math.round(100 * bl.blocks24 / r.sampled) : 0;
      if (bl && bl.hits && bPct >= 1) {
        var bids = Object.keys(bl.bySource || {});
        r.blocklist = {
          ids: bids,
          sources: bids.map(function (id) {
            return { id: id, name: sourceName(id), count: bl.bySource[id].blocks24, hits: bl.bySource[id].hits };
          }),
          count: bl.blocks24, hits: bl.hits, sampled: r.sampled, pct: bPct, scope: "asn", range: "",
          note: "只统计这个 ASN 宣告段与名单区间有交集的 /24 数；不是逐 IP 命中数"
        };
      }
    }
    if (AsnDiff && AsnDiff.ready && AsnDiff.ready() && AsnDiff.overlapRanges) {
      var df = AsnDiff.overlapRanges(ranges);
      if (df && df.blocks24) {
        var list = Object.keys(df.byAsn || {}).map(function (a) { return df.byAsn[a]; })
          .sort(function (a, b) { return b.blocks24 - a.blocks24; });
        var top = list[0];
        var pct = r.sampled ? Math.round(100 * top.blocks24 / r.sampled) : 0;
        var notable = pct >= 10;
        if (notable) {
          var names = (AsnDiff.meta && AsnDiff.meta() && AsnDiff.meta().names) || {};
          var otherName = names[top.asn] || ((World.byNumber && World.byNumber(top.asn)) || {}).name || "";
          r.asnDiff = {
            otherAsn: top.asn, otherName: otherName, count: top.blocks24,
            sampled: r.sampled, pct: pct,
            others: list.slice(0, 3), scope: "asn", notable: true,
            note: "按 ASN 宣告段与二源分歧段的交集粗算"
          };
        }
      }
    }
    return r;
  }

  /* IP 归属表：后台拉段表（4.1 MB）+ ASN 元数据（2.9 MB）+ 标定表（16 KB），失败就降级 */
  function initWorld() {
    if (!World || !World.load) { return Promise.resolve(false); }
    worldState = "loading";
    /* 下载期间报字节数：段表 4.1 MB + ASN 元数据 2.9 MB，慢线路下要好几秒 */
    worldP = World.load({
      onProgress: function (name, got, total) {
        var pct = downloadPct(got, total);
        if (busy) { setProgress(pct, 100, "下载 IP 归属表 " + pct + "%"); }
      }
    })
      .then(function (ok) {
        if (!ok) { throw new Error("加载失败"); }
        worldState = "ready";
        var cov = World.coverage() || { pct: {} };
        if ($("genAt")) {
          $("genAt").textContent = ($("genAt").textContent || "") +
            " ｜ IP 归属表 " + (World.meta().generated || "?") + "（住宅 " + (cov.pct[1] || 0) + "% / 机房 " +
            (cov.pct[2] || 0) + "% / 商业 " + (cov.pct[3] || 0) + "%）";
        }
        return true;
      })
      .catch(function () {
        worldState = "failed";
        return false;
      });
    return worldP;
  }
  var worldP = null;

  /* 实测记录里没有这个键 → 这一行要靠 IP 归属表；顺手把要用的城市数据拉下来 */
  function needsWorld(pattern) {
    return !DATA || !DATA.prefixes || !DATA.prefixes[Core.patternKey(pattern)];
  }
  /* 城市数据（每个 /8 一片，平均 150 KB）：① 有了它「城市」列才有落点城市；② 「国家」列也改用
     DB-IP 的定位国而不是 ASN 注册国。清单用到的第一段一次拉到底 —— 判定不等它，边拉边补。 */
  var cityMissed = {};   /* o1 → 城市数据确实没有这一段（404），别拉第二遍；网络失败不算，留给重试 */
  var cityLoading = false;   /* 只是为了措辞：拉取中 / 拉失败 */
  var CITY_BATCH = 16;   /* 一批 16 个请求：CDN 扛得住，进度条也动得起来 */
  /* 拉城市数据：成功记 cityLoaded，没数据记 cityMissed ——「这一段没有数据」和「还没拉」是两件事。
     每片到位就回调 onSlice(o1)：页面只重算那一个 /8 的行，不用等整批拉完再算。 */
  function loadCitySlices(o1s, onProgress, onSlice) {
    if (!City || !City.load || !o1s.length) { return Promise.resolve(0); }
    var queue = o1s.slice(), done = 0, okAll = 0;
    function batch() {
      var chunk = queue.splice(0, CITY_BATCH);
      if (!chunk.length) { return Promise.resolve(okAll); }
      return Promise.all(chunk.map(function (o1) {
        return City.load(o1).then(function (ok) {
          if (ok) { cityLoaded[o1] = true; okAll++; if (onSlice) { onSlice(o1); } }
          else if (!City.missReason || City.missReason(o1) !== "error") { cityMissed[o1] = true; }
          done++;
          if (onProgress) { onProgress(done, o1s.length); }
          return ok;
        });
      })).then(batch);
    }
    return batch();
  }
  /* 这一份清单用到、但还没拉（也没确认没数据）的 /8 */
  function itemO1s(items) {
    var seen = {}, out = [];
    (items || []).forEach(function (it) {
      var o1 = String(it.pattern || "").split(".")[0];
      if (!(+o1 > 0 && +o1 <= 255) || seen[o1]) { return; }
      seen[o1] = 1;
      if (!cityLoaded[o1] && !cityMissed[o1]) { out.push(o1); }
    });
    return out;
  }
  /* 城市数据的数字只讲「这份清单要不要」：库本身 220 份 / 33 MB，跟当前清单无关。
     以前顶栏写「已载入 46 / 256 份（还有 132 份没拉）」—— 46 是所有清单累加的、
     132 是本单没拉的、256 是库上限，三个分母混在一起，只能让人以为还差 210 份。
     这里三档分开数（已取 / 库里没数据 / 本单还没拉），分母一律是本单用到的第一段。 */
  function cityScope() {
    var seen = {}, need = [];
    (state.items || []).forEach(function (it) {
      var o1 = String(it.pattern || "").split(".")[0];
      if (!(+o1 > 0 && +o1 <= 255) || seen[o1]) { return; }
      seen[o1] = 1; need.push(o1);
    });
    var took = 0, noData = 0, pending = [];
    need.forEach(function (o1) {
      if (cityLoaded[o1]) { took++; }
      else if (cityMissed[o1]) { noData++; }
      else { pending.push(o1); }
    });
    return { need: need, took: took, noData: noData, pending: pending };
  }
  /* 城市数据到位的处理：只重算这一个 /8 的行（国家 / 城市两列），攒到下一帧一起重绘。
     判定本来就不等城市数据（分级只看 ASN），所以这是同一趟里的补写，不是第二趟加载。 */
  function recomputePlaces(o1) {
    var touched = 0;
    state.rows.forEach(function (r) {
      if (!r.ok || String(r.pattern).split(".")[0] !== String(o1)) { return; }
      r.country = Core.countryHist(r, { world: World, cityPack: City });
      r.city = Core.cityHist(r, { data: DATA, cityPack: City });
      touched++;
    });
    return touched;
  }
  /* 重绘节流：180 份到位 = 180 次重排 200 行 DOM，不节流会抖。250ms 一次足够跟手 */
  var repaintP = null;
  function scheduleRepaint() {
    if (repaintP) { return; }
    repaintP = setTimeout(function () {
      repaintP = null;
      state.counts = Core.countRows(state.rows);
      state.ranked = Core.rankRows(state.rows);
      renderChips(); renderTable();
    }, 250);
  }
  function stopRepaint() {
    if (repaintP) { clearTimeout(repaintP); repaintP = null; }
  }

  /* ---------- 渲染 ---------- */
  /* 筛选就是那排统计本身：点 A 级只看 A，点「未识别」只看没判出来的，再点一下回到全部 */
  function visibleRows() {
    var list = Core.filterRows(state.ranked, {
      tier: state.filter, country: state.country, city: state.city, flag: state.flag
    });
    return Core.sortRows(list, state.sort.key, state.sort.dir);
  }

  function renderChips() {
    var c = state.counts, rec = (c.A || 0) + (c.B || 0);
    /* 只留能直接决定排序数字：各级行数 + 推荐行数。
       枚举样本这类每行都有的汇总（加起来也没法用）不在这里重复。 */
    $("chips").innerHTML =
      chip("all", "", "全部", state.ranked.length, "显示全部行 · 排名按行（带 * 的整行一起排）") +
      chip("a", "a", "A 级", c.A || 0) + chip("b", "b", "B 级", c.B || 0) +
      chip("c", "c", "C 级", c.C || 0) + chip("d", "d", "D 级", c.D || 0) +
      chip("x", "x", "未识别/缺数据", (c.fail || 0),
        "没给出级别的行：未评级（这个 ASN 没有标定样本，只有关键词类型）+ 不可路由（没人宣告）+ 数据包里没有的段") +
      chip("ab", "", "推荐行 (A+B)", rec);
  }
  function chip(f, cls, k, v, tip) {
    return '<button class="chip' + (state.filter === f ? " on" : "") + '" data-f="' + f +
      '" title="' + (tip || "只看" + k) + '">' +
      (cls ? '<span class="dot ' + cls + '"></span>' : "") +
      '<span class="k">' + k + '</span><span class="v">' + v + "</span></button>";
  }

  /* 第二排筛选：国家 / 标记 / 城市 / 排序 / 对比。数据都从当前结果现算，
     不另存一份；改筛选只重绘表格，不动底层排名。 */
  function renderFilters() {
    var host = $("filters");
    if (!host) { return; }
    if (!state.rows.length) { host.hidden = true; return; }
    var wasHidden = host.hidden;
    host.hidden = false;
    /* 这块默认 hidden，i18n 的 walk 会跳过隐藏节点；第一次露出来时补翻一次 */
    if (wasHidden && window.IPI18n && IPI18n.apply) { IPI18n.apply(); }
    var countryCounts = {}, cityCounts = {};
    state.rows.forEach(function (r) {
      if (r.country && r.country.cc) { countryCounts[r.country.cc] = (countryCounts[r.country.cc] || 0) + 1; }
      if (r.city && r.city.city) { cityCounts[r.city.city] = (cityCounts[r.city.city] || 0) + 1; }
    });
    var countries = Object.keys(countryCounts).sort(function (a, b) {
      return (countryCounts[b] - countryCounts[a]) || (a < b ? -1 : 1);
    });
    var sel = $("fCountry");
    if (sel) {
      sel.innerHTML = '<option value="">全部国家</option>' + countries.map(function (cc) {
        return '<option value="' + cc + '"' + (state.country === cc ? " selected" : "") + ">" +
          esc(countryName(cc) + " (" + cc + " · " + countryCounts[cc] + ")") + "</option>";
      }).join("");
    }
    var ff = $("fFlag");
    if (ff) {
      ff.innerHTML = [
        ["all", "全部标记"], ["cloud", "云厂商段"], ["risk", "风险名单"], ["diff", "二源分歧"], ["any", "任一标记"]
      ].map(function (x) {
        return '<option value="' + x[0] + '"' + (state.flag === x[0] ? " selected" : "") + ">" + x[1] + "</option>";
      }).join("");
    }
    var cities = Object.keys(cityCounts).sort(function (a, b) { return cityCounts[b] - cityCounts[a]; }).slice(0, 300);
    var list = $("cityList");
    if (list) { list.innerHTML = cities.map(function (c) { return '<option value="' + esc(c) + '"></option>'; }).join(""); }
    var ci = $("fCity");
    if (ci && ci.value !== state.city) { ci.value = state.city; }
    var fs = $("fSort");
    if (fs) {
      var sortVal = state.sort.key + ":" + state.sort.dir;
      fs.innerHTML = [
        ["rank:1", "排名"], ["tier:1", "级别 ↑"], ["tier:-1", "级别 ↓"],
        ["score:-1", "得分 高→低"], ["score:1", "得分 低→高"],
        ["pct:-1", "住宅占比 高→低"], ["country:1", "国家"], ["city:1", "城市"], ["pattern:1", "IP 模式"]
      ].map(function (x) {
        return '<option value="' + x[0] + '"' + (sortVal === x[0] ? " selected" : "") + ">" + x[1] + "</option>";
      }).join("");
    }
    var fp = $("fFlagPreview");
    if (fp) { fp.innerHTML = state.country ? flagImg(state.country) : ""; }
  }

  function bindFilters() {
    var fc = $("fCountry"), ff = $("fFlag"), ci = $("fCity"), fs = $("fSort");
    if (fc) { fc.addEventListener("change", function () { state.country = fc.value; renderFilters(); renderTable(); }); }
    if (ff) { ff.addEventListener("change", function () { state.flag = ff.value; renderTable(); }); }
    if (ci) { ci.addEventListener("input", function () { state.city = ci.value.trim(); renderTable(); }); }
    if (fs) {
      fs.addEventListener("change", function () {
        var p = fs.value.split(":");
        state.sort = { key: p[0], dir: p[1] === "-1" ? -1 : 1 };
        renderTable();
      });
    }
    var rs = $("fReset");
    if (rs) {
      rs.addEventListener("click", function () {
        state.country = ""; state.city = ""; state.flag = "all";
        state.filter = "all"; state.sort = { key: "rank", dir: 1 };
        renderChips(); renderFilters(); renderTable();
      });
    }
    var ss = $("snapSel");
    if (ss) {
      ss.addEventListener("change", function () {
        state.compareId = ss.value || null;
        var snap = state.compareId && History ? History.get(state.compareId) : null;
        state.compareMap = snap ? History.diff(state.rows, snap) : null;
        renderTable();
      });
    }
    /* 表头点一下排序：同一列再点一次换方向。排序只影响显示，state.ranked 不动。 */
    var th = $("tableHost");
    if (th) {
      th.addEventListener("click", function (e) {
        var el = e.target && e.target.closest ? e.target.closest("th[data-sort]") : null;
        if (!el) { return; }
        var key = el.getAttribute("data-sort");
        if (state.sort.key === key) { state.sort.dir = state.sort.dir === 1 ? -1 : 1; }
        else { state.sort = { key: key, dir: 1 }; }
        renderFilters(); renderTable();
      });
    }
  }

  var SRC_SHORT = { drop: "DROP", ipsum: "IPsum", tor: "Tor", blocklistde: "BLDE" };
  function sourceShort(id) { return SRC_SHORT[id] || String(id); }

  /* 每个 badge 带自己的 title：三个证据层混在一个 title 里，悬停时看不出是哪一层命中 */
  function markBadges(r) {
    var out = [];
    if (r.cloud) {
      var cids = (r.cloud.fullIds && r.cloud.fullIds.length) ? r.cloud.fullIds : (r.cloud.ids || []);
      /* 跨多个 /24 的行：整段覆盖不到 1% 就不挂 badge（仍留在 JSON / 详情里）。
         单个 IP 或单个 /24 照常显示 —— 那一个地址确实在厂商段内。 */
      var cTiny = r.cloud.count > 1 && !r.cloud.override && r.cloud.share < 1;
      if (cids.length && !cTiny) {
        var cfull = !!(r.cloud.fullIds && r.cloud.fullIds.length);
        /* 一行 256 个 /24 里只有 1 个整段落在厂商段内 → 加 ?，别让 badge 看起来像整行改判 */
        var cpart = r.cloud.scope === "asn" ? (r.cloud.share < 50) : !r.cloud.override;
        out.push({
          cls: "cloud",
          text: cids.map(providerLabel).join("+") + (cpart ? "?" : ""),
          title: "云厂商段：" + cids.map(providerName).join("、") +
            (r.cloud.scope === "asn"
              ? "（与这个 ASN 的宣告段交集：" + r.cloud.full + " 个整 /24，占 " + r.cloud.share + "%）"
              : (r.cloud.override
                ? "（整 /24 覆盖，已改判 D）"
                : (cfull
                  ? "（部分覆盖：" + r.cloud.full + "/" + r.cloud.count + " 个 /24 整段在厂商段内，未改判）"
                  : "（部分覆盖，未改判）")))
        });
      }
    }
    if (r.blocklist && r.blocklist.ids && r.blocklist.ids.length) {
      out.push({
        cls: "risk",
        text: r.blocklist.ids.map(sourceShort).join("+"),
        title: "风险名单：" + r.blocklist.ids.map(sourceName).join("、") +
          (r.blocklist.scope === "asn"
            ? "（交集 " + r.blocklist.count + " 个 /24，占 " + r.blocklist.pct + "%）"
            : "（只标注，不改级别/得分；命中不等于非住宅）")
      });
    }
    if (r.asnDiff) {
      out.push({
        cls: "diff", text: "AS" + r.asnDiff.otherAsn,
        title: "二源不一致：DB-IP 说是 AS" + r.asnDiff.otherAsn +
          (r.asnDiff.otherName ? " " + r.asnDiff.otherName : "") +
          (r.asnDiff.scope === "asn" ? "（" + r.asnDiff.count + " 个 /24，占 " + r.asnDiff.pct + "%）" : "") +
          "（不判断谁对）"
      });
    }
    if (r.onlineEvidence) { out.push({ cls: "ev", text: "证据", title: "联网核验附带 RDAP / PTR 证据" }); }
    return out;
  }
  function markCell(r) {
    var marks = markBadges(r);
    if (!marks.length) { return '<span class="mono-s">—</span>'; }
    var shown = marks.slice(0, 2).map(function (m) {
      return '<span class="mk ' + m.cls + '" title="' + esc(T(m.title || "")) + '">' + esc(m.text) + "</span>";
    }).join("");
    if (marks.length > 2) {
      shown += '<span class="mk" title="' + esc(T(marks.slice(2).map(function (m) { return m.title; }).join("　"))) + '">+' +
        (marks.length - 2) + "</span>";
    }
    return '<div class="marks">' + shown + "</div>";
  }

  function renderTable() {
    var rows = visibleRows();
    if (!rows.length) {
      $("tableHost").innerHTML = '<div class="empty">没有符合条件的行。换个筛选，或粘贴清单后点「判定」。</div>';
      return;
    }
    /* 「住宅占比」和「构成」本来就是同一件事（住宅 = 构成里那块绿的），合成一列 */
    function sh(key, label, title) {
      var on = state.sort.key === key;
      var mark = on ? (state.sort.dir === 1 ? " ↑" : " ↓") : "";
      return '<th data-sort="' + key + '" class="sortable"' +
        (title ? ' title="' + esc(title) + '"' : "") + ">" + label + mark + "</th>";
    }
    var html = '<table><thead><tr>' +
      sh("rank", "排名") + sh("tier", "级别") + sh("pattern", "IP 模式（整行）") + sh("pct", "构成 · 住宅") +
      sh("country", "主要国家", "打码行把 254/256 个取值逐个定位后取最多的那个国家（城市数据 / IP 归属表）") +
      sh("city", "主要城市", "打码行把 254/256 个取值逐个定位后取最多的那个城市（城市数据 / 实测记录）") +
      '<th>来源</th><th title="云厂商段 / 风险名单 / 二源 ASN 分歧 / 联网证据（只标注，不一定改级别）">标记</th>' +
      sh("score", "得分") + '<th></th></tr></thead><tbody>';
    rows.forEach(function (r, i) {
      if (!r.ok) {
        /* 不可路由不是「没判出来」：地址没人宣告，这个问题对它没意义，别摆成失败的样子 */
        var badTier = r.reserved ? '<span class="tier X" title="公网没人宣告这个地址，不可路由，不参与排名与得分"><i></i>不可路由</span>'
          : '<span class="tier X"><i></i>—</span>';
        html += '<tr data-i="' + r.index + '" class="rowin" style="animation-delay:' + Math.min(i * 12, 400) + 'ms">' +
          '<td class="mono-s">' + r.rank + cmpMark(r) + '</td><td>' + badTier + '</td>' +
          '<td><b>' + r.pattern + '</b></td><td colspan="6" class="mono-s">' + r.reason + '</td><td></td></tr>';
        return;
      }
      /* 宽度走 core 的共享算法：详情里那条放大的构成条用的是同一个函数 */
      var widths = Core.shareWidths(r);
      var stack = "";
      [1, 2, 3, 4, 6].forEach(function (k) {
        if (widths[k] <= 0) { return; }
        /* 住宅段是 IP 归属表推算时，段自己的提示也带 ≈，别让人以为是实测计数 */
        var n = Core.catCount(r, k);
        stack += '<i class="' + CATCLS[k] + '" style="width:' + widths[k] + '%;background:var(--' + (CATCLS[k] || "unk") +
          ')" title="' + Core.CAT_NAME[k] + " " + n + '"></i>';
      });
      if (widths.unk > 0) {
        stack += '<i class="unk" style="width:' + widths.unk + '%;background:var(--unk)" title="未知 ' + widths.unk +
          '%：这一层只看得到 ASN，剩下这一截是住宅还是机房判不出来"></i>';
      }
      /* 全表统一成一个形状：`[≈]住宅数 / 样本数 · 占比%`
         —— 实测记录给实测计数；IP 归属表是按 ASN 先验折算的（带 ≈）；单个真实 IP 的样本就是它自己（分母 1）。 */
      var homeTxt = (r.asnRow && !Core.priorOnly(r))
        ? ("≈" + r.pctIsp + "% · " + r.sampled + " 个 /24")
        : Core.homeTxt(r);
      var homeTitle = r.asnRow
        ? "按这个 ASN 的全部宣告段（" + r.sampled + " 个 /24）用 ASN 住宅先验折算；不是逐个 /24 实测"
        : (r.probOnly
          ? (Core.priorOnly(r)
            ? "这一行的 " + r.sampled + " 个取值一个标定样本都没有：数字只能按 ASN 关键词类型给先验" +
              "（判为零售 ISP 就一律 100%），是个常数，跟这些地址实际怎样无关 —— 所以这里写类别，不写占比，" +
              "这一行也因此不给级别、不进排名"
            : "IP 归属表：按 ASN 住宅先验对 " + r.sampled + " 个取值做概率加权折算（≈ 表示不是逐个实测），占比按 ASN 级不确定性封顶 90%")
          : (r.singleHost ? "你粘贴的这一行是一个真实 IP，样本只有它自己 —— 没有占比可言，直接看它归哪一类"
            : "实测记录：住宅网段数 / 样本数 · 占比"));
      /* 颜色跟着「这一格的数是哪种数」走：单 IP 和纯先验行没有占比，颜色跟类别；
         有折算依据的行才按住宅占比分档。这里只借语义色的 t-* 上色 —— 别再挂 sc：
         那是得分那一格的字号，两条规则撞上这一格的 13px 会被顶成 14px/700。 */
      var catTone = CAT_TONE[r.host24 ? r.host24.cat : 6];
      if (Core.priorOnly(r)) { catTone = CAT_TONE[Core.topCat(r)]; }
      var ispCell = '<div class="tcell"><div class="stack">' + stack + '</div>' +
        '<span class="share t-' + (r.singleHost || Core.priorOnly(r) ? catTone : Core.shareBand(Core.homePct(r))) + '" title="' + esc(homeTitle) + '">' +
        esc(homeTxt) + '</span></div>';
      /* 来源列只说「这份判断的数据从哪来」；核验结论是另一回事，附在悬停里，不往来源上贴 */
      var srcText = rowSrcWhy(r) + (r.online
        ? "　联网核验：" + (r.online.ok
          ? r.online.checked + "/" + r.online.sampled + " 个抽样 → " + r.online.verdict
          : "没取到数据，这一行仍是分级估算")
        : "");
      var srcCell = '<span title="' + esc(srcText) + '">' + rowSrcName(r) + "</span>";
      /* 来源列不折行：加一列「标记」后它被挤成「IP 归 / 属表」，读起来像两个词 */
      /* 未评级：只有运营商类型、一个标定样本都没有 → 不给级别、不给得分。
         这跟「不可路由」是同一类处理（值本身没有依据，就不拿它下结论），
         但这一行仍然告诉你它是什么类型 —— 那部分是真数出来的。 */
      var tierCell = r.ungraded
        ? '<span class="tier X" title="这个 ASN 一个标定样本都没有：只能按运营商关键词判类型，密度数据不存在，所以不给级别、不算得分、不进推荐"><i></i>未评级</span>'
        : '<span class="tier ' + r.tier + '"><i></i>' + r.tier + '</span>';
      var scoreCell = r.ungraded
        ? '<span class="mono-s" title="未评级：没有样本支撑的分数不该给">—</span>'
        : '<b class="sc ' + Core.scoreBand(r.score) + '" title="行级得分 0–100（由离线分级算出）。配色：绿 ≥75 · 橙 50–74 · 蓝灰 25–49 · 红 <25">' +
          Math.round(r.score) + '</b>';
      html += '<tr data-i="' + r.index + '" class="rowin' + (state.active === r.index ? " active" : "") + '" style="animation-delay:' + Math.min(i * 12, 400) + 'ms">' +
        '<td class="mono-s"><b>' + r.rank + '</b>' + cmpMark(r) + '</td>' +
        '<td>' + tierCell + '</td>' +
        /* 级别药丸和「住宅」那一格已经说清是不是机房，不再往 IP 上贴第三个标签 */
        '<td><b>' + r.pattern + '</b></td>' +
        '<td>' + ispCell + '</td>' +
        '<td>' + countryCell(r) + '</td>' +
        '<td>' + cityCell(r) + '</td>' +
        '<td class="mono-s src">' + srcCell + '</td>' +
        '<td>' + markCell(r) + '</td>' +
        '<td class="mono-s">' + scoreCell + '</td>' +
        '<td class="mono-s">▸</td></tr>';
    });
    html += "</tbody></table>";
    if (state.unmatched.length) {
      html += '<p class="hint" style="padding:0 9px 9px">未识别 ' + state.unmatched.length + ' 行，例如：' +
        state.unmatched.slice(0, 3).map(function (u) { return "第 " + u.line + " 行 <code>" + esc(u.text.slice(0, 40)) + "</code>"; }).join("、") + '</p>';
    }
    $("tableHost").innerHTML = html;
    paintCityHint();
    Array.prototype.forEach.call($("tableHost").querySelectorAll("tbody tr"), function (tr) {
      tr.addEventListener("click", function () { showDetail(+tr.getAttribute("data-i")); });
    });
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]; }); }

  /* 抽屉做成两层：上面 .dbar 是钉住不动的标题行（这一行是谁 + 两个动作），
     下面 .dscroll 是唯一一条连续滚动的正文区。标题行在滚动区外面，
     所以滚动时它一动都不动，正文也不会从它底下钻出来。 */
  function drawer(title, acts, bodyHtml) {
    return '<div class="dbar"><h2>' + title + "</h2><span>" + acts + "</span></div>" +
      '<div class="dscroll">' + bodyHtml + "</div>";
  }

  /* 热力图的一个格子：颜色定类别，城市 / 运营商 / 类别这些格子里放不下的字塞进 data-*，
     鼠标停上去由 #tip 摊开显示 —— 详情里那段 40 行的枚举清单就是这么省掉的。 */
  function cell(ip, cls, i, city, org, cat) {
    return '<i class="' + cls + '" style="animation-delay:' + (i * 0.9) + 'ms" data-ip="' + esc(ip) +
      '" data-l2="' + esc([city, org].filter(Boolean).join(" · ")) +
      '" data-l3="' + esc(cat || "") + '"></i>';
  }
  var tipEl = null;
  function tipMove(ev) {
    if (!tipEl || tipEl.style.display === "none") { return; }
    var w = tipEl.offsetWidth, h = tipEl.offsetHeight;
    var x = ev.clientX + 14, y = ev.clientY + 16;
    if (x + w > window.innerWidth - 8) { x = ev.clientX - w - 14; }
    if (y + h > window.innerHeight - 8) { y = ev.clientY - h - 12; }
    tipEl.style.left = x + "px"; tipEl.style.top = y + "px";
  }
  function tipHide() { if (tipEl) { tipEl.style.display = "none"; } }
  function tipBind(heat) {
    heat.addEventListener("mouseover", function (ev) {
      var t = ev.target;
      if (!t || t.tagName !== "I" || !t.getAttribute("data-ip")) { return; }
      if (!tipEl) { tipEl = document.createElement("div"); tipEl.id = "tip"; document.body.appendChild(tipEl); }
      tipEl.innerHTML = "<b>" + esc(t.getAttribute("data-ip")) + "</b>" +
        "<span>" + esc(t.getAttribute("data-l2") || "") + "</span>" +
        '<span class="mono-s">' + esc(t.getAttribute("data-l3") || "") + "</span>";
      tipEl.style.display = "block";
      tipMove(ev);
    });
    heat.addEventListener("mousemove", tipMove);
    heat.addEventListener("mouseleave", tipHide);
  }

  function expandedCount() {
    var n = 0;
    for (var k in state.expanded) { if (Object.prototype.hasOwnProperty.call(state.expanded, k)) { n += state.expanded[k]; } }
    return n;
  }

  function expandAsnRow(r) {
    if (!World || !World.blocks24Of) { toast("IP 归属表没加载，没法展开"); return; }
    if (state.expanded[r.asn]) { toast("这个 ASN 已经展开过了"); return; }
    var room = 128 - expandedCount();
    if (room <= 0) { toast("一次会话最多展开 128 个 /24，先清空再试"); return; }
    var patterns = Core.expandAsn(r.asn, { world: World, cap: 64 });
    if (!patterns.length) { toast("这个 ASN 没有可展开的 /24"); return; }
    patterns = patterns.slice(0, Math.min(64, room));
    var base = state.rows.length;
    var newRows = patterns.map(function (p, i) {
      var item = { index: base + i + 1, sourceLine: r.sourceLine, raw: r.raw, pattern: p };
      var x = applyEvidence(Core.analyzeItem(item, DATA, { world: World, cityPack: City }));
      x.asnExpandedFrom = r.asn;
      return x;
    });
    state.expanded[r.asn] = patterns.length;
    state.rows = state.rows.concat(newRows);
    state.counts = Core.countRows(state.rows);
    state.ranked = Core.rankRows(state.rows);
    renderChips(); renderTable();
    toast("已展开 " + patterns.length + " 个 /24（AS" + r.asn + " 共 " + r.asnProfile.blocks24 + " 个，按地址均匀取样）");
    var cityWant = itemO1s(newRows);
    if (cityWant.length) {
      loadCitySlices(cityWant, null, function (o1) {
        if (recomputePlaces(o1)) { scheduleRepaint(); }
      }).then(function () {
        stopRepaint();
        state.counts = Core.countRows(state.rows);
        state.ranked = Core.rankRows(state.rows);
        renderChips(); renderTable();
      });
    }
  }

  /* ASN 聚合行的详情：概览 + 展开按钮；没有热力图（聚合行不是一个 /24）。 */
  function showAsnDetail(r, host) {
    var p = r.asnProfile;
    var tierTone = TIER_TONE[r.tier] || "x";
    var verdict = r.ungraded
      ? '<div class="verdict x">' +
        '<b class="v1">未评级</b>' +
        '<b class="v1">' + esc(Core.CAT_NAME[p.type] || "未知") + "</b>" +
        '<span class="v2">这个 ASN 没有标定样本：只按运营商类型给先验，不给级别与得分</span></div>'
      : '<div class="verdict ' + tone(tierTone) + '">' +
        '<b class="v1">' + r.tier + "</b>" +
        '<b class="v1">' + esc(r.tierText) + "</b>" +
        '<span class="v2">住宅 ≈' + r.pctIsp + "% · " + p.blocks24 + " 个 /24</span>" +
        '<span class="scpill" title="行级得分 0–100（离线分级算出）">得分 <b class="sc ' + Core.scoreBand(r.score) + '">' + r.score + "</b></span></div>";

    var defs = [];
    defs.push(["ASN", "<b>AS" + p.asn + "</b> " + esc(p.name), p.cc ? countryName(p.cc) + "（" + p.cc + "）" : ""]);
    defs.push(["类型", esc(Core.CAT_NAME[p.type] || "未知"), "名称关键词 + PeeringDB info_type + bad-asn-list"]);
    defs.push(["住宅占比",
      p.calibrated
        ? "<b>" + Math.round(p.probability * 100) + "%</b> （已用实测 /24 标定）"
        : "<b>未评级</b> （没有标定样本：只按类型给先验，不报占比）",
      p.calibrated ? "标定库 asn-calib.js" : "这个 ASN 的实测样本不足，不把常数先验伪装成占比"]);
    defs.push(["宣告范围",
      p.segments + " 段 · " + p.cidrs + " CIDR · " + p.blocks24 + " 个 /24",
      "首个地址 " + p.firstIp + (p.addresses ? " · " + p.addresses + " 个地址" : "")]);
    defs.push(["来源", "IP 归属表", rowSrcWhy(r)]);
    if (r.cloud) {
      defs.push(["云厂商段",
        esc(r.cloud.ids.map(providerName).join(" / ")) + " · 覆盖 " + r.cloud.any + "/" + r.cloud.count + " 个 /24" +
          (r.cloud.sampled ? "（抽样）" : ""),
        markTitle(r)]);
    }
    if (r.blocklist) {
      defs.push(["风险名单",
        esc(r.blocklist.ids.map(sourceName).join(" / ")) + " · " + r.blocklist.count + " 段交集",
        markTitle(r)]);
    }
    if (r.asnDiff) {
      defs.push(["二源分歧",
        "DB-IP AS" + r.asnDiff.otherAsn + (r.asnDiff.otherName ? " " + esc(r.asnDiff.otherName) : "") +
          " · " + r.asnDiff.count + " 个 /24",
        markTitle(r)]);
    }
    var kv = '<dl class="defs">' + defs.map(function (d) {
      return "<dt>" + esc(d[0]) + "</dt><dd>" + d[1] +
        (d[2] ? '<span class="dwhy">' + esc(d[2]) + "</span>" : "") + "</dd>";
    }).join("") + "</dl>";
    var samples = (p.sampleCidrs || []).map(function (c) {
      return '<span class="cchip" title="这个 ASN 的样例 CIDR">' + esc(c) + "</span>";
    }).join("");
    var body = '<div class="dbd">' + verdict +
      '<p class="mono-s" style="margin:0 0 10px">聚合行：按这个 ASN 的全部宣告段算一个整体，不逐 /24 展开。' +
      "展开后每行是一个 /24，会重新走完整判定。</p>" + kv +
      (samples ? '<div class="crow"><span class="mono-s">样例 CIDR</span>' + samples + "</div>" : "") +
      "</div>";
    host.innerHTML = drawer("#" + r.rank + " · AS" + p.asn,
      '<button id="expandAsn">展开 64 个 /24</button> ' +
      '<button class="ghost" id="copyRowLink">复制链接</button> ' +
      '<button class="ghost" id="exportRow">导出本行</button> ' +
      '<button class="ghost" id="closeD">关闭</button>',
      body);
    $("closeD").onclick = closeDetail;
    var btn = $("expandAsn");
    if (btn) { btn.onclick = function () { expandAsnRow(r); }; }
    if ($("copyRowLink")) {
      $("copyRowLink").onclick = function () {
        if (!Share) { toast("分享模块没加载"); return; }
        var url = Share.shareUrl(r.pattern, { base: location.origin + location.pathname });
        if (url) { copy(url, "已复制本行链接"); } else { toast("链接太长，请导出本行 JSON"); }
      };
    }
    if ($("exportRow")) {
      $("exportRow").onclick = function () {
        download("ipurity-row-" + r.index + ".json", Core.toJson([r], buildExportMeta()),
          { mime: "application/json;charset=utf-8", bom: false });
        toast("已导出本行 JSON");
      };
    }
    if (window.IPReport && IPReport.mount) {
      var repHost = document.createElement("div");
      host.querySelector(".dscroll").appendChild(repHost);
      IPReport.mount(repHost, r, { world: World });
    }
  }

  function showDetail(index) {
    var r = state.rows.filter(function (x) { return x.index === index; })[0];
    if (!r) { return; }
    tipHide();
    state.active = index;
    renderTable();
    var host = $("detailHost");
    if (!r.ok) {
      host.innerHTML = drawer("行 " + r.index + " · " + esc(r.pattern),
        '<button class="ghost" id="closeD">关闭</button>',
        '<div class="dbd"><p class="mono-s">' + esc(r.reason) + "</p></div>");
      $("closeD").onclick = closeDetail; return;
    }
    if (r.asnRow) { showAsnDetail(r, host); return; }

    /* 布局：结论先行（.verdict 一块大字），下面是标签对齐的定义格（.defs），
       再往下才是证据（标签 / 归属 / 候选）。同类信息只用一种呈现。 */
    var tierTone = TIER_TONE[r.tier] || "x";
    var vHome = r.singleHost ? "" : "住宅 " + Core.homeTxt(r);
    if (r.online && r.online.verdict === "DC") { vHome = "住宅 0%（联网核验判定为机房）"; }
    /* 未评级：没有级别也没有得分 —— 那两样都建立在「这个 ASN 的住宅密度」上，
       而这一类行只有一个关键词类型。写类别 + 一句为什么，比给个空级别诚实。 */
    var verdict = r.ungraded
      ? '<div class="verdict x">' +
        '<b class="v1">未评级</b>' +
        '<b class="v1">' + esc(Core.CAT_NAME[Core.topCat(r)] || "未知") + "</b>" +
        '<span class="v2" title="这个 ASN 一个标定样本都没有，密度数据不存在">按运营商类型判 · 没有样本，不给级别与得分</span>' +
        "</div>"
      : '<div class="verdict ' + tone(tierTone) + '">' +
        '<b class="v1">' + r.tier + "</b>" +
        "<b class=\"v1\">" + esc(r.tierText) + "</b>" +
        (vHome ? '<span class="v2">' + esc(vHome) + "</span>" : "") +
        '<span class="scpill" title="行级得分 0–100（离线分级算出）">得分 <b class="sc ' + Core.scoreBand(r.score) + '">' + r.score + "</b></span>" +
        "</div>";
    /* 定义格：标签一列对齐，值一列 —— 不再是一串挤在一起的行内文本。
       这里只放「有数据支撑的事实」：来源、口径、得分。不摆「建议拿哪个 IP」——
       工具只看到 /24 这一层，挑不出更该拿的那个，给了就是假精确。 */
    var defs = [];
    defs.push(["来源", rowSrcName(r), rowSrcWhy(r)]);
    if (r.cloud || r.blocklist || r.asnDiff || r.onlineEvidence) {
      var markVals = [];
      if (r.cloud) { markVals.push("云厂商 " + esc(r.cloud.ids.map(providerName).join(" / "))); }
      if (r.blocklist) { markVals.push("名单 " + esc(r.blocklist.ids.map(sourceName).join(" / "))); }
      if (r.asnDiff) { markVals.push("二源 AS" + r.asnDiff.otherAsn); }
      if (r.onlineEvidence) { markVals.push("RDAP / PTR 证据"); }
      defs.push(["标记", markVals.join(" · "), markTitle(r)]);
    }
    /* 说明统一成一句话：<口径> · <数据源>［，<分布>］。
       分布只在真的枚举过多个取值时给 —— 单个 IP / 单个网段写它没有意义。 */
    function distWhy(o, how, what) {
      if (!o || !o.src) { return "城市数据 DB-IP 这一层查不到（这一段 IP 的城市数据可能没加载）"; }
      return (how || o.src) + (hasDist(r) ? "，" + o.count + "/" + o.n + " = " + o.pct + "% 落在" + what : "");
    }
    var ccName = r.country && r.country.cc ? countryName(r.country.cc) : "";
    defs.push(["主要国家", r.country && r.country.cc ? flagImg(r.country.cc) + countryName(r.country.cc) : "—",
      distWhy(r.country, r.country ? r.country.src : "", ccName)]);
    var cityName = r.city && r.city.city ? Core.cityLabel(r.city.city) : "";
    defs.push(["主要城市", r.city && r.city.city ? citySpan(r.city.city, null) : "—",
      r.city ? distWhy(r.city, r.city.src, cityName) : distWhy(null)]);
    /* 「网段归属」和其它格一个形状：值 = 运营方，口径写进 dwhy。
       口径必须对得上数据来源：实测记录里逐个网段查过的才叫实测记录；
       没命中的行只有 ASN 这一层 —— 那种情况下说「整段归 X」等于把估算说成事实。 */
    if (r.host24 && (r.singleHost || r.starPos === 3)) {
      defs.push(["网段归属", "<b>" + esc(r.host24.isp) + "</b>",
        r.probOnly
          ? "IP 归属表 · 按运营商估算：这个网段归 " + (r.host24.asn ? "AS" + r.host24.asn + " " : "") +
            Core.CAT_NAME[r.host24.cat] + "，占比按 ASN 先验折算（不是逐段实测）"
          : "实测记录（ip-api）· " + r.host24.network + " 整段归 " + Core.CAT_NAME[r.host24.cat]]);
    }
    /* 构成条：表格那一列的放大版 —— 同一套颜色、同一套宽度算法，段上直接写名字/个数/占比。
       窄到写不下的段交给下面那行图例（每个数字只有一个出处，不重复第二遍）。 */
    var compBar = "";
    if (!r.singleHost) {
      var wd = Core.shareWidths(r);
      var ck = [1, 2, 3, 4, 6].concat(wd.unk > 0 ? ["unk"] : []).filter(function (k) { return wd[k] > 0; });
      var cName = function (k) { return k === "unk" ? "未知" : Core.CAT_NAME[k]; };
      var cCnt = function (k) { return k === "unk" ? "" : Core.catCount(r, k); };
      var cCls = function (k) { return k === "unk" ? "unk" : (CATCLS[k] || "unk"); };
      var cTitle = function (k) {
        if (k === "unk") { return "未知 " + wd[k] + "%：IP 归属表这一层只看得到 ASN（住宅占比还封顶 90%），剩下的部分是住宅还是机房判不出来"; }
        return cName(k) + " " + cCnt(k) + " · " + wd[k] + "%（" + (r.probOnly ? "IP 归属表折算，不是逐个实测" : "实测记录") + "）";
      };
      if (ck.length) {
        var narrow = ck.filter(function (k) { return wd[k] < 14; });
        compBar = '<div class="comp"><div class="cbar">' + ck.map(function (k) {
          var cnt = cCnt(k);
          var txt = k === "unk"
            ? (wd[k] >= 16 ? "<em>未知</em>" + wd[k] + "%" : "")
            : wd[k] >= 32 ? "<em>" + cName(k) + "</em>" + cnt + " · " + wd[k] + "%"
              : wd[k] >= 14 ? cnt + " · " + wd[k] + "%" : "";
          return '<i class="' + cCls(k) + '" style="width:' + wd[k] + "%;background:var(--" +
            cCls(k) + ')" title="' + esc(cTitle(k)) + '">' + txt + "</i>";
        }).join("") + "</div>" +
          (narrow.length
            ? '<div class="clegend">' + narrow.map(function (k) {
              return '<span title="' + esc(cTitle(k)) + '"><i style="background:var(--' + cCls(k) + ')"></i>' +
                cName(k) + (cCnt(k) ? " " + cCnt(k) : "") + " · " + wd[k] + "%</span>";
            }).join("") + "</div>"
            : "") + "</div>";
      }
    }
    var kv = '<dl class="defs">' + defs.map(function (d) {
      return "<dt>" + esc(d[0]) + "</dt><dd>" + d[1] + (d[2] ? '<span class="dwhy">' + esc(d[2]) + "</span>" : "") + "</dd>";
    }).join("") + "</dl>";
    /* 长解释一律塞进标签的 title：要看看得到，平时不占版面 */
    var chips2 = "";
    function rtag(t, text, why) {
      return '<span class="rtag ' + t + '" title="' + esc(why) + '">' + esc(text) + "</span>";
    }
    if (r.capped) {
      chips2 += rtag("o", "占比封顶 " + Math.round((Core.ASN_CONF_CAP || 0.9) * 100) + "%",
        "占比已按 ASN 级不确定性封顶：抽样再干净也不代表这个网段一定干净 —— 同一个 ASN 下就有对方机房/企业客户的段" +
        "（例如 177.202.126.0/24 挂在 KT 下面，但整段是 Ace Data Centers 的机房）。");
    }
    if (r.singleHost) {
      chips2 += rtag("b", "单个 IP",
        "清单里的这一行就是一个真实 IP，没有占比可言，直接看它归哪一类；下面那张图画的是它所在网段的 254 个可用地址。");
    }
    if (r.online) {
      var on = r.online;
      var onWhy = (on.provider ? on.provider + "：" : "") + (r.onlineNote || on.why || "") +
        (on.org ? "（org " + on.org + "）" : "");
      chips2 += on.ok
        ? rtag(on.verdict === "DC" ? "d" : "b", "联网核验 " + on.checked + "/" + on.sampled + " → " + on.verdict, onWhy)
        : rtag("o", "核验没取到数据", onWhy);
    }
    if (chips2) { kv += '<div class="rtags">' + chips2 + "</div>"; }

    /* 这一行是不是 IP 归属表算出来的：用 asnHist 判断，别用 source —— 联网核验会把
       source 改成「联网核验」，但枚举/热力图还是 IP 归属表那套数据 */
    var fromGlobal = !!(r.asnHist && Object.keys(r.asnHist).length);
    /* 颜色含义由上面那条构成条负责（名字就在段上），热力图不再另外加图例 */
    var body;
    /* 单个真实 IP 这一行就是一个地址，图里画的是它所在的那整个网段（254 个可用地址）——
       跟「第 4 段打码」同一种画法：这一行的结论本来就来自这个网段的记录。 */
    var single = r.singleHost;
    if (fromGlobal) {
      /* 单个 IP 的取值数是 1，图却要铺满它那个网段：这里的分布按网段里那 254 个地址现数一遍 */
      var hist = r.asnHist, histN = r.sampled;
      if (single) {
        hist = {}; histN = 0;
        var p24 = r.pattern.split(".");
        for (var v4 = 1; v4 <= 254; v4++) {
          var e4 = (World && World.asnOf) ? World.asnOf(p24[0] + "." + p24[1] + "." + p24[2] + "." + v4) : null;
          if (!e4) { continue; }
          hist[e4.asn] = (hist[e4.asn] || 0) + 1;
          histN++;
        }
      }
      var asns = Object.keys(hist).map(function (a) { return [a, hist[a]]; })
        .sort(function (a, b) { return b[1] - a[1]; }).slice(0, 6);
      body = '<div class="heat" id="heat"></div>' +
        '<p class="mono-s" style="margin-top:8px">ASN 分布 · ' + (histN || 256) + ' 个取值</p>' +
        '<div class="cands asn">' + asns.map(function (p) {
          var e = World && World.byNumber ? World.byNumber(p[0]) : null;
          return '<div class="c"><span class="mono-s">AS' + p[0] + "</span><b>" + p[1] + "/" + (histN || 256) + "</b><span>" +
            esc(e ? e.name : "") + "</span><span class='mono-s' title=\"" + esc(e ? e.name : "") + "\">" +
            esc(e ? e.cc + " · " + Core.CAT_NAME[e.t] : "") + "</span></div>";
        }).join("") + "</div>" +
        (r.cityTop && r.cityTop.length
          ? '<div class="crow"><span class="mono-s" title="这一行的 254/256 个取值分别落在哪个城市（取前 4）">落点城市</span>' +
            r.cityTop.slice(0, 4).map(function (c) {
              return '<span class="cchip" title="' + esc(c.city + "　这一行里有 " + c.count + " 个取值落在这里") + '">' +
                citySpan(c.city, null) + "<em>×" + c.count + "</em></span>";
            }).join("") +
            (r.covered < (r.sampled || 256)
              ? '<span class="mono-s">覆盖 ' + r.covered + "/" + (r.sampled || 256) + "</span>" : "") + "</div>"
          : "");
    } else {
      body = '<div class="heat" id="heat"></div>';
    }

    var cands = Core.sortCandidates(r.candidates);
    /* 枚举落点那一整块（40 行）不再印在详情里：它就是热力图每个格子的悬浮详情（见 tipBind），
       一行一格，鼠标停上去就摊开。要整张清单点标题里的「复制本行候选」或「导出枚举」。 */

    /* 标题行只负责「这是哪一行」：级别/得分都在下面 .verdict 里，不重复第二遍 */
    host.innerHTML = drawer("#" + r.rank + " · " + esc(r.pattern),
      /* 单个 IP 没有枚举出来的候选可复制，这个按钮就别摆出来了 */
      (cands.length ? '<button id="copyRow">复制本行候选</button> ' : "") +
      '<button class="ghost" id="copyRowLink">复制链接</button> ' +
      '<button class="ghost" id="exportRow">导出本行</button> ' +
      '<button class="ghost" id="closeD">关闭</button>',
      '<div class="dbd">' + verdict + compBar + kv + body + "</div>");

    if ($("heat")) {
      var h = "";
      if (fromGlobal) {
        /* IP 归属表：每个取值的颜色按 ASN 类型，住宅概率高的直接画绿 */
        var parts = r.pattern.split(".");
        /* 打码在第 4 段、或者这一行本来就是单个 IP：画它那个网段的 254 个可用地址 */
        var pos = r.starPos < 0 ? 3 : r.starPos;
        var hFrom = pos === 3 ? 1 : 0, hTo = pos === 3 ? 254 : 255;
        for (var y2 = hFrom; y2 <= hTo; y2++) {
          var q = parts.slice(); q[pos] = String(y2);
          var ipx = q.join(".");
          var e = World && World.asnOf ? World.asnOf(ipx) : null;
          var p = e ? World.prob(e) : 0;
          var cls = !e ? "" : p >= 0.5 ? "isp" : p > 0 ? "mob" : (CATCLS[e.t] || "");
          var hit = City && City.has(+parts[0]) ? City.lookupIp(ipx) : null;
          h += cell(ipx, cls, y2,
            (hit ? Core.cityLabel(hit.city) : ""),
            e ? "AS" + e.asn + " " + e.name : "",
            T(e ? (Core.CAT_NAME[e.t] || "未知") : "未获取"));
        }
      } else {
        /* 实测记录：第 2 段打码 = 256 个网段各一格；第 4 段打码 = 同一个网段的 254 个可用地址。 */
        var codes = DATA.prefixes[r.key].c.split(","), cities = DATA.prefixes[r.key].g.split(","), isps = DATA.prefixes[r.key].i.split(",");
        /* 单个 IP 同样按它所在的那个网段画（实测记录是 /24 粒度，整段一个类别） */
        var one24 = r.starPos === 3 || r.singleHost;
        var hLo = one24 ? 1 : 0, hHi = one24 ? 254 : 255;
        for (var y = hLo; y <= hHi; y++) {
          /* 一个网段一格：实测记录按 /24 存，索引是打码那一位的「段内序号」 */
          var idx = one24 ? r.host24.o2 : y;
          var code = +codes[idx] || 0, cat = code & 7;
          var city = DATA.cities[+cities[idx]] || "", isp = DATA.isps[+isps[idx]] || "";
          var ip2 = one24 ? r.o1 + "." + r.host24.o2 + "." + r.o3 + "." + y : r.o1 + "." + y + "." + r.o3 + ".1";
          h += cell(ip2, CATCLS[cat] || "", y,
            Core.cityLabel(city), isp, T(Core.CAT_NAME[cat] || "未知"));
        }
      }
      $("heat").innerHTML = h;
      tipBind($("heat"));
    }
    $("closeD").onclick = closeDetail;
    if ($("copyRowLink")) {
      $("copyRowLink").onclick = function () {
        if (!Share) { toast("分享模块没加载"); return; }
        var url = Share.shareUrl(r.pattern, { base: location.origin + location.pathname });
        if (url) { copy(url, "已复制本行链接"); } else { toast("链接太长，请导出本行 JSON"); }
      };
    }
    if ($("exportRow")) {
      $("exportRow").onclick = function () {
        download("ipurity-row-" + r.index + ".json", Core.toJson([r], buildExportMeta()),
          { mime: "application/json;charset=utf-8", bom: false });
        toast("已导出本行 JSON");
      };
    }
    if ($("copyRow")) {
      $("copyRow").onclick = function () {
        copy(T("排名 #" + r.rank + "  " + r.pattern + "  [" + r.tier + " " + r.tierText + "]  住宅 " + Core.homeTxt(r)) + "\n" +
          cands.map(function (c) { return c.ip + "  " + Core.cityLabel(c.city) + "  " + c.isp; }).join("\n"),
          "已复制本行 " + cands.length + " 个枚举落点");
      };
    }
    /* 单 IP 实测报告：拿这一行的代表落点去 RDAP / DoH(PTR·Cymru) 取证，
       页面默认不联网，点报告里的「实测取证」才发请求。 */
    if (window.IPReport && IPReport.mount) {
      var repHost = document.createElement("div");
      host.querySelector(".dscroll").appendChild(repHost);
      IPReport.mount(repHost, r, { world: World });
    }
    /* 不要再对抽屉调 scrollIntoView：它自己就是滚动容器，浏览器会顺手把里面滚一段，
       开出来就是「正文顶到标题行上面去了」的样子。抽屉本来就整块可见，不需要滚。 */
  }
  function closeDetail() { tipHide(); state.active = null; $("detailHost").innerHTML = ""; renderTable(); }

  function copy(text, msg) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast(msg); }, function () { fallback(); });
    } else { fallback(); }
    function fallback() {
      var ta = document.createElement("textarea");
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); toast(msg); } catch (e) { toast("复制失败，请手动选中"); }
      document.body.removeChild(ta);
    }
  }
  function download(name, text, opts) {
    opts = opts || {};
    var bom = opts.bom !== false;                 /* CSV \u4fdd\u7559 BOM\uff1bJSON / SVG \u4e0d\u8981 */
    var mime = opts.mime || "text/csv;charset=utf-8";
    var blob = new Blob([bom ? "\ufeff" + text : text], { type: mime });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
  }

  /* ---------- 主流程 ---------- */
  /* 进度条：判定要按 256（或 254）个取值逐行枚举，几百行的清单不可能一瞬间算完。
     以前是一口气算完再渲染 —— 中间浏览器没机会重绘，看着就像卡死了。 */
  var CHUNK_ROWS = 6;   /* 每帧算几行：太大进度条不动，太小总时长被帧率拖长 */
  function nextTick(fn) {
    if (typeof requestAnimationFrame === "function") { requestAnimationFrame(function () { fn(); }); }
    else { setTimeout(fn, 0); }
  }
  /* 状态只有一条：进度条（可能没有）＋ 一句话，放在结果区顶上那一行里。
     没话说时整行收起 —— 标题行（② 分级结果）永远是干净的。 */
  var statText = "";
  function syncStat() {
    var line = $("statline"), p = $("prog"), tx = $("stat");
    if (!line) { return; }
    if (tx && tx.textContent !== statText) { tx.textContent = statText; }
    line.hidden = !(statText || (p && !p.hidden));
  }
  function setStat(text) { statText = text || ""; syncStat(); }
  function setProgress(done, total, text) {
    var p = $("prog"), b = $("progBar");
    if (p && b) {
      if (done === null) { p.hidden = true; }
      else {
        p.hidden = false;
        b.style.width = (total > 0 ? Math.round(100 * done / total) : 100) + "%";
      }
    }
    if (text) { statText = text; }
    syncStat();
  }
  /* 下载进度：压缩传输时拿到的字节数可能超过 content-length，所以封在 1–99 之间，
     100% 只由「这一阶段做完」来表示 */
  function downloadPct(got, total) {
    if (!(total > 0)) { return 0; }
    return Math.max(1, Math.min(99, Math.round(100 * got / total)));
  }
  /* 逐行判定：算几行让出一帧，进度条才动得了 */
  function analyzeChunked(items, what) {
    var rows = [], i = 0;
    return new Promise(function (resolve) {
      function step() {
        var stop = Math.min(items.length, i + CHUNK_ROWS);
        for (; i < stop; i++) { rows.push(applyEvidence(Core.analyzeItem(items[i], DATA, { world: World, cityPack: City }))); }
        setProgress(i, items.length, what + " " + i + "/" + items.length + " 行");
        if (i < items.length) { nextTick(step); } else { resolve(rows); }
      }
      step();
    });
  }
  /* 城市列的「—」只有三种来路：进度里还没拉到的片 / 网络没拉下来的片 / DB-IP 对这一段
     本来就只有国家没有城市。这一行只在真需要说明时出现，拉齐且查得到就不占版面。 */
  function paintCityHint() {
    var el = $("cityHint");
    if (!el) { return; }
    var s = cityScope();
    if (!s.need.length) { el.hidden = true; el.innerHTML = ""; return; }
    var noCity = state.rows.filter(function (r) { return r.ok && !r.city && !r.asnRow; });
    var noSlice = noCity.filter(function (r) { return !City.has(String(r.pattern).split(".")[0]); }).length;
    var html = "";
    if (s.pending.length) {
      html = cityLoading
        ? "城市数据还在拉：<b>" + s.pending.length + " 份</b>没到位（约 " + Math.round(s.pending.length * 0.15) + " MB）"
        : "<b>" + s.pending.length + " 份</b>城市数据没拉下来（网络失败）";
      if (noCity.length) { html += " —— <b>" + noCity.length + " 行</b>暂时没有城市"; }
      if (!cityLoading) { html += ' <button class="sm" id="fillCities">重试</button>'; }
    } else if (noCity.length) {
      /* 两种「查不到」分开说：整段库里没有（保留/未分配段） / 段在但记录里只有国家 */
      html = "<b>" + noCity.length + " 行</b>查不到城市：" + (noSlice === noCity.length
        ? "DB-IP 城市数据没有这些段（保留段 / 未分配段本来就没有记录）"
        : (noSlice
          ? "DB-IP 城市数据对这些段只记到国家（其中 " + noSlice + " 行所在的这一段整段没有数据）"
          : "DB-IP 对这些段的记录里只有国家、没有城市名"));
    }
    el.hidden = !html;
    el.innerHTML = html;
    var b = $("fillCities");
    if (b) { b.onclick = retryCities; }
  }
  /* 只补「网络没拉下来」的片（City 里记两次 404 不会重试，所以不会死循环） */
  function retryCities() {
    if (busy) { return; }
    var want = itemO1s(state.items || []);
    if (!want.length) { toast("城市数据都到位了"); return; }
    busy = true; $("run").disabled = true;
    cityLoading = true;
    setProgress(0, want.length, "重拉城市数据 0/" + want.length + "…");
    loadCitySlices(want,
      function (n, total) {
        setProgress(n, total, "重拉城市数据 " + n + "/" + total + "…");
        paintCityHint();
      },
      function (o1) { if (recomputePlaces(o1)) { scheduleRepaint(); } })
      .then(function (okN) {
        cityLoading = false;
        stopRepaint();
        state.counts = Core.countRows(state.rows); state.ranked = Core.rankRows(state.rows);
        paintCityHint();
        busy = false; $("run").disabled = false;
        setProgress(null); setStat("");
        renderChips(); renderTable();
        if (state.active !== null && state.active !== undefined) { showDetail(state.active); }
        toast("补了 " + okN + " 份城市数据");
      })
      .catch(function (e) {
        cityLoading = false;
        busy = false; $("run").disabled = false; setProgress(null); setStat("");
        paintCityHint();
        toast("重拉城市数据失败：" + (e && e.message ? e.message : e));
      });
  }

  /* ASN token → 一条聚合行。索引接在 IP 行之后，方便详情/导出按 index 找。 */
  function buildAsnRows(tokens, offset) {
    var out = [];
    (tokens || []).forEach(function (t, i) {
      var r = Core.analyzeAsn(t.asn, { world: World });
      r.index = offset + i + 1;
      r.sourceLine = t.sourceLine;
      r.raw = t.rawLine || t.raw;
      applyAsnEvidence(r);
      out.push(r);
    });
    return out;
  }

  function run() {
    if (busy) { return; }
    var rep = Core.parseWithReport($("input").value);
    state.items = rep.items; state.unmatched = rep.unmatched;
    state.asnTokens = rep.asns || [];
    /* 新的一单从「全部」开始，别把上一单的筛选/排序带过来 */
    state.filter = "all"; state.country = ""; state.city = ""; state.flag = "all";
    state.sort = { key: "rank", dir: 1 }; state.compareId = null; state.compareMap = null;
    if (!rep.items.length && !state.asnTokens.length) {
      state.rows = []; state.ranked = []; state.counts = {};
      $("chips").innerHTML = ""; setStat("");
      $("tableHost").innerHTML = '<div class="empty">没解析出 IP 段或 ASN。支持的写法：<code>198.*.42.81</code>、<code>198.3.242.0/24</code>、<code>AS4766</code>，或直接粘贴整张表格。</div>';
      setExportEnabled(false);
      paintVerifyBtn();
      return;
    }
    var gaps = rep.items.filter(function (it) { return needsWorld(it.pattern); }).length;
    var needWorld = gaps > 0 || state.asnTokens.length > 0;
    var totalRows = rep.items.length + state.asnTokens.length;
    busy = true;
    $("run").disabled = true; $("verify").disabled = true;
    setProgress(0, totalRows, "判定 " + totalRows + " 行…");

    /* 一趟跑完：① 需要的话等 IP 归属表和三个证据包 ② 判定 ------------
       ③ 城市数据边拉边补。判定不等城市数据（分级只看 ASN），所以结论先出来，
       城市/国家两列随城市数据到位逐块补上，不用点第二次。 */
    var waitWorld = (needWorld && worldState === "loading" && worldP) ? worldP : Promise.resolve(true);
    if (needWorld && worldState === "loading") { setStat("等 IP 归属表（4.1 MB，只下一次）…"); }
    var waitPacks = initPacks();
    var cityWant = itemO1s(rep.items);
    Promise.all([waitWorld, waitPacks])
      .then(function () { return analyzeChunked(rep.items, "判定"); })
      .then(function (ipRows) {
        var rows = ipRows.concat(buildAsnRows(state.asnTokens, rep.items.length));
        state.rows = rows;
        state.counts = Core.countRows(rows);
        state.ranked = Core.rankRows(rows);
        state.active = null; $("detailHost").innerHTML = "";
        setExportEnabled(true);
        renderChips(); renderFilters(); renderTable();
        try { localStorage.setItem("ippa.input", $("input").value); } catch (e) {}
        if (History && History.push) {
          try { History.push(state.rows, $("input").value); } catch (e) {}
          renderSnapshots();
        }
        if (rep.unmatched.length) {
          toast("已判定 " + rep.items.length + " 个模式 / " + state.asnTokens.length + " 个 ASN，" + rep.unmatched.length + " 行没认出来");
        }
        if (needWorld && worldState === "failed") {
          toast("IP 归属表没加载：请用 http:// 打开（静态托管或 python -m http.server）");
        }
        if (!cityWant.length) { return 0; }
        cityLoading = true;
        setProgress(0, cityWant.length, "城市数据 0/" + cityWant.length + " 份…");
        return loadCitySlices(cityWant,
          function (n, total) {
            setProgress(n, total, "城市数据 " + n + "/" + total + " 份…");
            paintCityHint();
          },
          function (o1) { if (recomputePlaces(o1)) { scheduleRepaint(); } });
      })
      .then(function () {
        cityLoading = false;
        stopRepaint();
        state.counts = Core.countRows(state.rows);
        state.ranked = Core.rankRows(state.rows);
        paintCityHint();
        renderChips(); renderFilters(); renderTable(); renderSnapshots();
      })
      .catch(function (e) { toast("判定出错：" + (e && e.message ? e.message : e)); })
      .then(function () { setProgress(null); setStat(""); busy = false; $("run").disabled = false; paintVerifyBtn(); paintCityHint(); });
  }
  var busy = false;

  function setExportEnabled(on) {
    ["export", "exportCand", "copyAll", "exportJson", "shareCard", "shareLink"].forEach(function (id) {
      var b = $(id);
      if (b) { b.disabled = !on; }
    });
  }

  /* 导出跟随当前筛选；「全部」按老口径导推荐行（A+B），「未识别」没有可导的东西 */
  function currentTiers() {
    var f = state.filter;
    if (f === "all" || f === "ab") { return ["A", "B"]; }
    return [f.toUpperCase()];
  }
  function exportCsv() {
    var csv = Core.toCsv(state.ranked, currentTiers(), 3);
    var stamp = new Date().toISOString().slice(0, 10);
    download("ip-ranking-" + stamp + ".csv", csv);
    toast("已导出排名表 CSV（一行 = 你粘贴的一行）");
  }
  function exportCand() {
    var csv = Core.toCsvCandidates(state.ranked, currentTiers(), 25);
    var stamp = new Date().toISOString().slice(0, 10);
    download("ip-candidates-" + stamp + ".csv", csv);
    toast("已导出枚举明细 CSV");
  }
  function copyAll() {
    var out = [];
    state.ranked.forEach(function (r) {
      if (!r.ok || (r.tier !== "A" && r.tier !== "B")) { return; }
      out.push("#" + r.rank + "\t" + r.pattern + "\t" + r.tier + "\t" + r.tierText +
        T("\t得分 ") + r.score + T("\t住宅 ") + Core.homeTxt(r));
    });
    if (!out.length) { toast("没有 A/B 级结果"); return; }
    copy(T("排名\tIP模式(整行)\t级别\t说明\t得分\t住宅") + "\n" + out.join("\n"),
      "已复制 A/B 级排名（一行一个）");
  }

  /* ---------- 导出 / 分享 / 对比 ---------- */
  function buildExportMeta() {
    var b = document.querySelector('meta[name="build"]');
    var cm = Cloud && Cloud.meta ? Cloud.meta() : null;
    var bm = Blocklists && Blocklists.meta ? Blocklists.meta() : null;
    var dm = AsnDiff && AsnDiff.meta ? AsnDiff.meta() : null;
    return {
      build: b ? b.getAttribute("content") : "",
      generated: new Date().toISOString(),
      filter: { tier: state.filter, country: state.country, city: state.city, flag: state.flag, sort: state.sort },
      sources: {
        segments: DATA ? { generated: DATA.generated, source: DATA.source } : null,
        world: World && World.meta ? World.meta() : null,
        cloud: cm ? {
          generated: cm.generated, source: cm.source,
          providers: (cm.providers || []).map(function (p) { return { id: p.id, name: p.name, url: p.url, license: p.license }; })
        } : null,
        blocklists: bm ? {
          generated: bm.generated, source: bm.source,
          sources: (bm.sources || []).map(function (s) { return { id: s.id, name: s.name, bit: s.bit, url: s.url, license: s.license }; })
        } : null,
        asnDisagree: dm ? {
          generated: dm.generated, source: dm.source, license: dm.license,
          sourceMonth: dm.sourceMonth, ranges: dm.ranges, blocks24: dm.blocks24
        } : null,
        city: City && City.attribution ? City.attribution : ""
      }
    };
  }

  function exportJson() {
    var rows = visibleRows();
    var stamp = new Date().toISOString().slice(0, 10);
    download("ipurity-" + stamp + ".json", Core.toJson(rows, buildExportMeta()),
      { mime: "application/json;charset=utf-8", bom: false });
    toast("已导出 JSON（当前可见 " + rows.length + " 行）");
  }

  function shareCard() {
    if (!Share) { toast("分享模块没加载"); return; }
    var rows = visibleRows().slice(0, 8);
    if (!rows.length) { toast("没有可分享的行"); return; }
    var b = document.querySelector('meta[name="build"]');
    var labels = {
      title: T("iPurity · 住宅 IP 排名"),
      subtitle: T("批量甄别住宅 IP · 离线分级"),
      rank: T("排名"), pattern: T("IP 模式"), score: T("得分"),
      residential: T("住宅"), place: T("国家 / 城市"), marks: T("标记"),
      footer: T("数据：实测记录 / IP 归属表 / 城市数据 / 云厂商段 / 风险名单 / 二源分歧"),
      more: T("未显示")
    };
    var svg = Share.card(rows, {
      generated: new Date().toISOString().slice(0, 10),
      build: b ? b.getAttribute("content") : "",
      labels: labels
    });
    download("ipurity-card-" + new Date().toISOString().slice(0, 10) + ".svg",
      svg, { mime: "image/svg+xml;charset=utf-8", bom: false });
    toast("已导出分享卡片（SVG，可独立打开）");
  }

  function shareLink() {
    if (!Share) { toast("分享模块没加载"); return; }
    var text = $("input").value;
    if (!String(text || "").trim()) { toast("没有可分享的清单"); return; }
    var url = Share.shareUrl(text, { base: location.origin + location.pathname });
    if (!url) { toast("清单太长，链接会超出浏览器/聊天工具长度限制，请导出 JSON 或分享卡片"); return; }
    copy(url, "已复制分享链接（清单在 # 后面，不会发给服务器）");
  }

  function renderSnapshots() {
    var wrap = $("snapWrap"), sel = $("snapSel");
    if (!wrap || !sel) { return; }
    var list = History && History.list ? History.list() : [];
    if (!list.length) {
      wrap.hidden = true; sel.innerHTML = "";
      state.compareId = null; state.compareMap = null;
      return;
    }
    var wasHidden = wrap.hidden;
    wrap.hidden = false;
    var opts = ['<option value="">' + T("不对比") + "</option>"];
    list.forEach(function (s) {
      var d = new Date(s.at);
      var p2 = function (n) { return (n < 10 ? "0" : "") + n; };
      var label = (d.getMonth() + 1) + "-" + d.getDate() + " " + p2(d.getHours()) + ":" + p2(d.getMinutes()) +
        " · " + s.rows.length + " 行" + (s.truncated ? "（截断）" : "");
      opts.push('<option value="' + esc(s.id) + '"' + (state.compareId === s.id ? " selected" : "") + ">" + esc(label) + "</option>");
    });
    sel.innerHTML = opts.join("");
    if (wasHidden && window.IPI18n && IPI18n.apply) { IPI18n.apply(); }
  }

  function cmpMark(r) {
    var d = state.compareMap && state.compareMap[String(r.pattern)];
    if (!d || d.status === "same") { return ""; }
    var prevT = d.prev && d.prev.tier ? d.prev.tier : "—";
    var nowT = d.now.tier || "—";
    var prevS = d.prev && d.prev.score != null ? d.prev.score : "—";
    var nowS = d.now.score != null ? d.now.score : "—";
    var title = "上次 " + prevT + " / " + prevS + " → 现在 " + nowT + " / " + nowS;
    if (d.status === "improved") { return '<span class="cmp g" title="' + esc(title) + '">↑</span>'; }
    if (d.status === "worsened") { return '<span class="cmp d" title="' + esc(title) + '">↓</span>'; }
    if (d.status === "score-up" || d.status === "score-down") { return '<span class="cmp x" title="' + esc(title) + '">~</span>'; }
    if (d.status === "new") { return '<span class="cmp x" title="上次没有这一行">+</span>'; }
    return "";
  }

  /* ---------- 事件 ---------- */
  /* ---------- 联网核验：抽样几个 IP 问免费接口，把「ASN 里的机房段」挑出来 ----------
     IP 归属表只认得 ASN：177.202.126.0/24 挂在 AS4766（KT）下面，但那个网段的 org 是
     Ace Data Centers —— 只有接口才知道。
     「判定」全程离线（只拉本站自己的数据文件），这里是另一个按钮：默认不发请求。
     拆开是因为这一步是唯一依赖第三方的地方 —— 不点就不发，判定结论也不会因为接口
     抽风/限流而变。点它只核验推荐行（A/B）的前 ONLINE_ROWS 行，打码行抽 3 个 IP，
     所以请求数是可控的（≤ ONLINE_ROWS × 3），已核验过的行不重复查。 */
  var ONLINE_SAMPLES = 3, ONLINE_ROWS = 12, EVIDENCE_ROWS = 6;
  function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* 联网核验分两段：
     ① 抽样问 ip-api/ipwho（每行 3 个 IP）—— 把「ASN 里的机房段」挑出来；
     ② 对仍没底的行（未评级 / 封顶 / 只有 ASN 估算）再取代表 IP 的 RDAP + PTR，
        给抽屉和报告补两条可追溯证据。证据预算 6 行，总请求仍 ≤ 12×3 + 6×3。 */
  function verifyRows(rows) {
    if (!Online || !Online.checkPattern || !rows.length) { return Promise.resolve({ got: 0, evidence: 0 }); }
    var i = 0, got = 0, evidence = 0, budget = EVIDENCE_ROWS;
    /* 代表 IP 的 RDAP + PTR。置信度够高的行（实测记录 / 已被云段钉死）不查。 */
    function evidenceStep(r) {
      var want = budget > 0 && Enrich && Enrich.lookupRowEvidence && window.IPReport &&
        !(r.online && r.online.verdict === "DC") && Core.confidenceRank(r) <= 2;
      var tgt = want ? IPReport.targetOf(r) : null;
      if (!tgt || !tgt.ip) { i++; return step(); }
      budget--;
      return Enrich.lookupRowEvidence(tgt.ip, { timeoutMs: 9000 })
        .then(function (ev) { r.onlineEvidence = ev; evidence++; })
        .catch(function () { /* 取证失败不编数据，也不阻断下一行 */ })
        .then(function () { return delay(450); })
        .then(function () { i++; return step(); });
    }
    function step() {
      if (i >= rows.length) { return Promise.resolve(); }
      var r = rows[i];
      setProgress(i, rows.length, "联网核验 " + (i + 1) + "/" + rows.length + " 行 · " + r.pattern);
      /* ASN 聚合行不抽样（没有可展开的主机），直接取代表 IP 的 RDAP/PTR */
      if (r.asnRow) { return evidenceStep(r); }
      return Online.checkPattern(r.pattern, {
        maxSamples: ONLINE_SAMPLES,
        httpsOnly: location.protocol === "https:",
        timeoutMs: 9000
      }).then(function (v) {
        Core.applyOnline(r, v);
        if (r.online && r.online.ok) { got++; }
        return evidenceStep(r);
      });
    }
    return step().then(function () {
      state.counts = Core.countRows(state.rows);
      state.ranked = Core.rankRows(state.rows);
      renderChips(); renderFilters();
      if (state.active != null) { showDetail(state.active); } else { renderTable(); }
      return { got: got, evidence: evidence };
    });
  }
  /* 越没底的行越先核验：未评级/纯先验 → 封顶 → 只有 ASN 估算 → 实测记录。
     A/B 和未评级都进池子；已经核验过的行不再查。 */
  function verifyTargets() {
    return state.ranked.filter(function (r) {
      return r.ok && (r.tier === "A" || r.tier === "B" || r.ungraded) && !(r.online && r.online.ok);
    }).sort(function (a, b) {
      var ca = Core.confidenceRank(a), cb = Core.confidenceRank(b);
      if (ca !== cb) { return ca - cb; }
      return (a.rank || 0) - (b.rank || 0);
    }).slice(0, ONLINE_ROWS);
  }
  /* 按钮自己带行数：有得查就是亮的，查完就熄 —— 不用另写一行说明。 */
  function paintVerifyBtn() {
    var b = $("verify");
    if (!b) { return; }
    var n = (busy || !state.rows.length) ? 0 : verifyTargets().length;
    b.disabled = !n;
    b.textContent = n ? "联网核验 " + n + " 行" : "联网核验";
  }
  function verifyOnline() {
    if (busy) { return; }
    var targets = verifyTargets();
    if (!targets.length) { return; }
    busy = true;
    $("run").disabled = true; $("verify").disabled = true;
    setProgress(0, targets.length, "联网核验 0/" + targets.length + " 行…");
    verifyRows(targets)
      .catch(function (e) {
        toast("联网核验出错（判定结论不受影响）：" + (e && e.message ? e.message : e));
        return { got: 0, evidence: 0 };
      })
      .then(function (res) {
        var got = (res && res.got) || 0, ev = (res && res.evidence) || 0;
        var dc = targets.filter(function (r) { return r.source === "联网核验" && r.tier === "D"; }).length;
        setStat("联网核验 " + targets.length + " 行 · 取到 " + got + " · 改判 D " + dc + " 行" +
          (ev ? " · RDAP/PTR " + ev + " 行" : ""));
        if (dc) { toast("联网核验：" + dc + " 行推荐段实测是机房，已改判 D"); }
        else { toast("联网核验 " + got + "/" + targets.length + " 行取到数据，没抓到机房证据"); }
      })
      .then(function () { setProgress(null); busy = false; $("run").disabled = false; paintVerifyBtn(); });
  }

  initData();

  /* PWA：只在 http(s) 下注册。Service Worker 只缓存同源文件，
     跨域请求（flagcdn / GitHub / RDAP / DoH）一律不拦截。 */
  if ("serviceWorker" in navigator && /^https?:$/.test(location.protocol)) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("sw.js").catch(function () {});
    });
  }

  /* ---------- 顶栏 Star 数 ----------
     走 GitHub 官方接口（api.github.com 的 stargazers_count）—— 星数是多少就是多少，
     不落后一天。官方接口允许跨域，但匿名按 IP 限流（60 次/小时），所以拿到的数字
     在 localStorage 里存 6 小时：这段时间内刷新页面直接用缓存，不再打接口。
     限流 / 断网时退回本站自己的 data/star.json（定时任务每天刷一次），
     两条路都没有就只留图标 —— 不显示 0，也不编数字。 */
  var STAR_API = "https://api.github.com/repos/dawenbin/ipurity";
  var STAR_FILE = "data/star.json";
  var STAR_TTL = 6 * 3600 * 1000;
  function paintStars(n) {
    var b = $("ghStars");
    if (!b || typeof n !== "number" || !isFinite(n)) { return; }
    b.textContent = n >= 1000 ? Math.round(n / 100) / 10 + "k" : String(n);
    b.hidden = false;
  }
  function starFallback() {
    fetch(STAR_FILE)
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { if (j) { paintStars(j.stars); } })
      .catch(function () {});
  }
  function loadStars() {
    if (!$("ghStars") || !window.fetch) { return; }
    var cached = null;
    try { cached = JSON.parse(localStorage.getItem("ipurity.stars") || "null"); } catch (e) { cached = null; }
    var known = cached && typeof cached.n === "number";
    if (known) { paintStars(cached.n); }
    if (known && Date.now() - cached.at < STAR_TTL) { return; }
    fetch(STAR_API, { headers: { Accept: "application/vnd.github+json" } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j || typeof j.stargazers_count !== "number") { throw new Error("no stars"); }
        paintStars(j.stargazers_count);
        try { localStorage.setItem("ipurity.stars", JSON.stringify({ n: j.stargazers_count, at: Date.now() })); } catch (e) {}
      })
      .catch(function () { if (!known) { starFallback(); } });
  }
  loadStars();

  /* 链接里的清单优先于 localStorage：分享出去的那一份就是要看的那一份 */
  var fromHash = false;
  if (Share && Share.decodeShare) {
    var hashInput = Share.decodeShare(location.hash);
    if (hashInput) { $("input").value = hashInput; fromHash = true; }
  }
  if (!fromHash) {
    try {
      var saved = localStorage.getItem("ippa.input");
      if (saved) { $("input").value = saved; }
    } catch (e) {}
  }
  $("run").addEventListener("click", run);
  $("verify").addEventListener("click", verifyOnline);
  bindFilters();
  if (fromHash) {
    setTimeout(function () { run(); toast("已从链接载入清单"); }, 0);
  }
  /* 国旗是第三方图床（flagcdn.com）—— 有些网络到不了，图片加载失败就退成两字母国家码，
     别在「国家」那一列留一个破图标。error 不冒泡，所以挂在捕获阶段。 */
  document.addEventListener("error", function (e) {
    var img = e.target;
    if (!img || img.tagName !== "IMG" || !img.classList || !img.classList.contains("flag")) { return; }
    var span = document.createElement("span");
    span.className = "ccfb";
    span.textContent = img.getAttribute("data-cc") || "";
    span.title = "国旗图（flagcdn.com）没加载出来，退成国家码";
    img.parentNode.replaceChild(span, img);
  }, true);
  $("input").addEventListener("keydown", function (e) { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { run(); } });
  $("clear").addEventListener("click", function () {
    $("input").value = ""; state.rows = []; state.ranked = []; state.items = []; state.counts = {}; state.unmatched = [];
    state.asnTokens = []; state.filter = "all"; state.country = ""; state.city = ""; state.flag = "all";
    state.sort = { key: "rank", dir: 1 }; state.compareId = null; state.compareMap = null; state.expanded = {};
    $("chips").innerHTML = ""; setStat(""); $("detailHost").innerHTML = "";
    renderFilters(); renderSnapshots();
    $("tableHost").innerHTML = '<div class="empty">粘贴清单后点「判定」，这里会按级别列出结果。</div>';
    setExportEnabled(false);
    paintVerifyBtn();
    try { localStorage.removeItem("ippa.input"); } catch (e) {}
  });
  $("file").addEventListener("change", function (e) {
    var f = e.target.files && e.target.files[0];
    if (!f) { return; }
    var fr = new FileReader();
    fr.onload = function () { $("input").value = String(fr.result); run(); };
    fr.readAsText(f, "utf-8");
  });
  /* 统计即筛选：点哪一档就看哪一档，点中的那一下不再点就是取消 */
  $("chips").addEventListener("click", function (e) {
    var b = e.target && e.target.closest ? e.target.closest("button.chip") : null;
    if (!b) { return; }
    var f = b.getAttribute("data-f");
    state.filter = (f !== "all" && state.filter === f) ? "all" : f;
    renderChips(); renderTable();
  });
  $("export").addEventListener("click", exportCsv);
  $("exportCand").addEventListener("click", exportCand);
  $("copyAll").addEventListener("click", copyAll);
  $("exportJson").addEventListener("click", exportJson);
  $("shareCard").addEventListener("click", shareCard);
  $("shareLink").addEventListener("click", shareLink);

  /* 切中英文：表格里的国家名是 Intl 按语言现算的，词条表管不到，所以整块重画一遍。
     其它文字（表格标题、报告面板、提示）由 i18n.js 的观察器就地替换，不用重画。 */
  document.addEventListener("ipurity:lang", function () {
    if (!state.ranked.length) { return; }
    renderChips(); renderFilters(); renderSnapshots();
    renderTable();
    if (state.active !== null && state.active !== undefined) { showDetail(state.active); }
  });

  /* 规则 / 来源说明：默认收起，点按钮才浮出来（一屏原则，不占版面） */
  var rulesHost = $("rulesHost");
  function toggleRules(on) {
    if (!rulesHost) { return; }
    var show = on == null ? rulesHost.hidden : on;
    rulesHost.hidden = !show;
    /* 说明是整块「解锁」出来的（只改了 hidden 属性，没有插入节点），观察器看不到 ——
       英文模式下在这里补一次翻译，否则第一次打开会是一整页中文。 */
    if (show && window.IPI18n && IPI18n.apply) { IPI18n.apply(); }
  }
  $("rulesBtn").addEventListener("click", function () { toggleRules(); });
  $("rulesClose").addEventListener("click", function () { toggleRules(false); });
  rulesHost.addEventListener("click", function (e) { if (e.target === rulesHost) { toggleRules(false); } });
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") { return; }
    if (!rulesHost.hidden) { toggleRules(false); } else if (state.active != null) { closeDetail(); }
  });
})();
