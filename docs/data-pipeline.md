# 数据更新

页面不联网也能跑，是因为所有结论都来自仓库里预计算好的数据包。

## 数据包

| 文件 | 体积 | 内容 |
| --- | --- | --- |
| `data/segments-data.js` | 238 KB | 实测记录：53 组 `o1.*.o3`、13,568 个 /24 的类别 / ASN / 城市 |
| `data/global-pack.bin` | 4.1 MB | IP 归属表 `IPPACK01`：538,889 段「起点 u32 + ASN 下标 u32」 |
| `data/global-asn.js` | 2.9 MB | 79,191 个 ASN 的名称 / 国家 / 类型 |
| `data/asn-calib.js` | 16 KB | 291 个 ASN 的实测住宅占比 |
| `data/city/*.bin` | 32.9 MB | 362 万段城市数据，220 份按 IP 第一段分片加载 |

覆盖范围：IP 归属表是 iptoasn 的可路由段表，覆盖 `1.0.0.0 – 223.255.254.255`（占地址空间 87.1%，即全部已分配可路由段）；`0.0.0.0/8` 与 `224.0.0.0` 起的组播 / 保留段不在表内，查这些地址返回「查不到」。

`data/segments-data.json` 是同一份实测数据的 JSON 版，只给 node 测试用，页面不加载。`build/` 是扫描中间产物（原始 CSV、清单），不进静态站点。

## 手工更新

```powershell
# 实测记录（数据源 ip-api.com 免费接口，100 条/批 + 限速，自动重试）
pwsh -File tools/scan-prefixes.ps1 -PatternFile build/prefixes-all.txt   # → build/prefixmap-all.csv
pwsh -File tools/make-data.ps1 -InputCsv build/prefixmap-all.csv         # → data/segments-data.js

# IP 归属表 + 标定（iptoasn 每日更新）
node tools/fetch-asn-tables.mjs   # iptoasn / PeeringDB / bad-asn-list → build/asn/
node tools/make-global-pack.mjs --eval   # → global-pack.bin + global-asn.js（--eval 用实测数据对拍）
node tools/make-calibration.mjs   # 实测数据 → 每个 ASN 的住宅占比

# 城市数据（DB-IP City Lite，每月月初更新）
node tools/fetch-city-tables.mjs  # 下载当月 dbip-city-lite-YYYY-MM.csv.gz（约 86 MB）
node tools/make-city-packs.mjs    # → data/city/<o1>.bin + index.json
```

要扩大实测记录时，把 `130.*.253` 这种组追加进 `build/prefixes-all.txt` 再跑。单点复查某个 IP：`tools/check-ips.ps1`（ip-api + PTR + 12 个 DNSBL）。

## 自动刷新（GitHub Actions）

四层数据都是一个薄层调用 `tools/refresh-data.mjs`，全部按月跑，同一天串行（`concurrency: refresh-data`）：

| workflow | 频率（UTC） | 干什么 |
| --- | --- | --- |
| `refresh-segments.yml` | 每月 5 号 02:17 | ip-api 逐 /24 实测 → `build/prefixmap-all.csv` → 实测记录 |
| `refresh-asn.yml` | 每月 5 号 03:17 | iptoasn + PeeringDB + bad-asn-list → IP 归属表 → 重算标定 |
| `refresh-city.yml` | 每月 5 号 04:41 | DB-IP City Lite → 220 份城市数据 |
| `refresh-star.yml` | 每月 5 号 05:41 | 顶栏星数 → `data/star.json` |

**为什么按月而不是按上游节奏**：上游里最快的是 iptoasn（每天），但一天里只有约 0.06% 的 IP 换了归属（2026-10-29 抽样 6 万个 IP 对比前一天的数据包：38 个变了，全是 ASN 换号）。按天跑的成本是每天 4.3 MB + 3.1 MB 两个新对象进 git、每天一次 Pages 重建、整站 `?v=` 缓存戳换一遍 —— 收益和成本不成正比。城市源本来一月一版，实测层是标定基准（不是逐日行情），也跟着按月走。

- **顺序不能反**：标定库要用当月的实测 CSV 反推住宅占比，所以实测排在 ASN 之前；四份数据都按 5 号的时间先后排队。
- **实测层有下限**：ip-api 是逐个 /24 发的请求，限速或断流时脚本只会丢批次（CSV 少行）。少于预期行数的 98% 就直接失败、什么都不提交 —— 宁可不刷新，也不拿半份实测去覆盖标定基准。
- **冻结行数跟着数据走**：`test/test-inline.mjs` 里 `pasted-list-5.txt` 的各级行数（A/B/C/D/X）是哨兵，数据一换就会动。实测层刷新时先跑 `UPDATE_EXPECT=1 node test/test-inline.mjs` 把它按当月数据重算写回，提交里能看见哪一级挪了几行；判定口径和解析层的改动不走这条路，仍然要自己改数。
- **只有数据真的变了才提交**：产物里的 `generated` 时间戳每次都变，比对指纹时先把它抹掉；指纹与 HEAD 一致就把工作区还原、连构建戳都不动。否则一次无意义提交会白触发一次静态托管重建，还会把 33 MB 城市数据的 CDN 缓存全部打失效（这些 URL 都带 `?v=<build>`）。
- **变了才换构建戳**：`tools/bump-build.mjs` 把 `index.html` 的 `meta[name=build]` 与所有 `?v=` 一起换，这套戳同时是页面 / 数据 URL 的缓存戳。
- **顺序**：刷新 → `node test/run-all.mjs`（不绿就不提交）→ commit + push → 静态托管的 Git 集成自动发布。
- 想先看有没有变化（不下载、不改文件）：`node tools/refresh-data.mjs --asn --dry`；想看当月有没有新数据再决定跑不跑：`node tools/refresh-data.mjs --segments --dry`。
- 手动补跑：Actions 页面点 Run。要小样本试跑实测层，用 `SCAN_PATTERNS=build/patterns-new.txt SCAN_CSV=build/tmp/scan.csv node tools/refresh-data.mjs --segments`（Windows 上把 `pwsh` 换成 `powershell` 也行，脚本两边的临时目录和 curl 名字都做了兼容）。

## 数据包格式

```js
// data/segments-data.js → window.SEGMENT_DATA
{ generated, source, legend, isps: [], cities: [],
  prefixes: { "198.*.42": { o1: 198, o3: 42, c: "1,1,3,…", i: "12,12,7,…", g: "5,5,…" } } }
// c[x] = 第二段为 x 的 /24 类别码（1 住宅ISP / 2 机房·云 / 3 商业中转·机构 / 4 移动 / 6 其他）
// i[x] / g[x] = 对应的 isps / cities 数组下标
// generated = 扫描快照时间：重打包但没重扫时用 -Generated 把原时间传进来。

// 2026-10 删掉了「都会区标记」（metro）：数据包里曾有一个 metro 元数据块，
// 类别码上还挂过一位 +8 表示「扫描时这个 /24 定位在洛杉矶都会区」。
// 删的原因：那一bit 只来自每个 /24 探的**一个**地址（scan-prefixes.ps1 用 x.1 探测），
//   是单点推整块的结论，却是排序键的第 4 位 —— 实测 53 行里有 32 行的名次由它决定，
//   等于拿一个扫描副产品去决定「两行住宅质量相同」时谁排前面。
// 重建数据包：node 无需，直接 tools/make-data.ps1 -InputCsv build/prefixmap-all.csv（见上）

// data/global-pack.bin → IPPACK01：8B 魔数 + u32 版本 + u32 段数 + u32 ASN 数
//   + u32 覆盖右边界 + 段起点 u32 数组 + ASN 下标 u32 数组

// data/city/<o1>.bin → CITYPK02：u32 起点 + u16 城市下标 + JSON 尾巴（城市名表）
```

不想开网页时可以直接命令行查：

```powershell
node tools/query.mjs "130.*.253.66" "198.*.42.81" --top 5
node tools/query.mjs "177.202.126.*" --online    # 顺带问问第三方接口
```

## 已知局限

- IP 归属表是**概率上限**，不是保证：只有 291 个 ASN 有实测标定，其余按名称 / 类型推断，经关键词判为零售 ISP 但没标定的 ASN 仍然是乐观值。
- IP 归属表认不出「运营商 ASN 里的机房客户段」（`177.202.126.0/24` 挂在 KT 的 AS4766 下，实际是 Ace Data Centers 的机房）—— 所以占比封顶 90%，想坐实必须点联网核验。
- 联网核验是**抽样**（一行几个 IP），抽样干净只说明「没抓到机房证据」；关键词判定也有假阳（名字里带 `cloud` / `institute` 的小 ISP 可能被当成机房，宁严不宽）。
- 实测记录层依赖 ip-api 的 hosting / proxy 标记，有假阴假阳；「三否」不等于住宅 IP。
- 免费城市数据对住宅 IP 常定位到运营商出口或注册地，城市只能当排序参考。
- 最终能不能拿到干净的住宅 IP，还得自己实测。
