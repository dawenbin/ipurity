# 数据更新

页面不联网也能跑，是因为所有结论都来自仓库里预计算好的数据包。

## 数据包

| 文件 | 体积 | 内容 |
| --- | --- | --- |
| `data/segments-data.js` | 238 KB | 实测记录：53 组 `o1.*.o3`、13,568 个 /24 的类别 / ASN / 城市 |
| `data/global-pack.bin` | 4.1 MB | IP 归属表 `IPPACK01`：539,238 段「起点 u32 + ASN 下标 u32」 |
| `data/global-asn.js` | 2.9 MB | 79,191 个 ASN 的名称 / 国家 / 类型 |
| `data/asn-calib.js` | 16 KB | 291 个 ASN 的实测住宅占比 |
| `data/city/*.bin` | 32.9 MB | 362 万段城市数据，220 份按 IP 第一段分片加载 |
| `data/cloud-pack.bin` + `cloud-meta.js` | 15 KB | `CLOUDPK1`：AWS / GCP / Cloudflare / Azure 的 `/24` 区间、任意覆盖位、整 `/24` 覆盖位 |
| `data/blocklists.bin` + `blocklists.js` | 187 KB | `IPBLK001`：DROP / IPsum / Tor / blocklist.de 的合并区间与来源位 |
| `data/asn-disagree.bin` + `asn-disagree.js` | 97 KB | `ASNDIF01`：iptoasn 与 DB-IP 对同一 `/24` 给出不同 ASN 的区间 |

覆盖范围：IP 归属表是 iptoasn 的可路由段表，覆盖 `1.0.0.0 – 223.255.254.255`（占地址空间 87.1%，即全部已分配可路由段）；`0.0.0.0/8` 与 `224.0.0.0` 起的组播 / 保留段不在表内，查这些地址返回「查不到」。

`data/segments-data.json` 是同一份实测数据的 JSON 版，只给 node 测试用，页面不加载。`build/` 是扫描中间产物（原始 CSV、清单），不进静态站点。

## 手工更新

```powershell
# 实测记录（数据源 ip-api.com 免费接口，100 条/批 + 限速，自动重试）
pwsh -File tools/scan-prefixes.ps1 -Patterns build/prefixes-all.txt   # → build/prefixmap-all.csv
pwsh -File tools/make-data.ps1                                        # → data/segments-data.js

# IP 归属表 + 标定（iptoasn 每日更新）
node tools/fetch-asn-tables.mjs   # iptoasn / PeeringDB / bad-asn-list → build/asn/
node tools/make-global-pack.mjs --eval   # → global-pack.bin + global-asn.js（--eval 用实测数据对拍）
node tools/make-calibration.mjs   # 实测数据 → 每个 ASN 的住宅占比

# 城市数据（DB-IP City Lite，每月月初更新）
node tools/fetch-city-tables.mjs  # 下载当月 dbip-city-lite-YYYY-MM.csv.gz（约 86 MB）
node tools/make-city-packs.mjs    # → data/city/<o1>.bin + index.json

# 云厂商段（每周）
node tools/fetch-cloud-ranges.mjs # AWS / GCP / Cloudflare / Azure → build/cloud/
node tools/make-cloud-pack.mjs    # → data/cloud-pack.bin + cloud-meta.js

# 风险名单（每天）
node tools/fetch-blocklists.mjs   # DROP / IPsum / Tor / blocklist.de → build/blocklists/
node tools/make-blocklists.mjs    # → data/blocklists.bin + blocklists.js

# 二源 ASN 分歧（每月，需先有最新的 global-pack.bin）
node tools/fetch-asn-dbip.mjs     # DB-IP ASN Lite 当月版（失败回退上月）
node tools/make-asn-disagreements.mjs  # → data/asn-disagree.bin + asn-disagree.js
```

要扩大实测记录时，把 `130.*.253` 这种组追加进 `build/prefixes-all.txt` 再跑。单点复查某个 IP：`tools/check-ips.ps1`（ip-api + PTR + 12 个 DNSBL）。

## 自动刷新（GitHub Actions）

上游节奏不一样，拆成五个定时任务，都只是薄薄一层调用 `tools/refresh-data.mjs`：

| workflow | 频率（UTC） | 干什么 | 构建戳 |
| --- | --- | --- | --- |
| `refresh-asn.yml` | 每天 03:17 | iptoasn + PeeringDB + bad-asn-list → IP 归属表 → 重算标定 | 变则换 |
| `refresh-blocklists.yml` | 每天 04:43 | DROP / IPsum / Tor / blocklist.de → 风险名单包 | 不动 |
| `refresh-city.yml` | 每月 5 号 04:41 | DB-IP City Lite → 220 份城市数据 | 变则换 |
| `refresh-cloud.yml` | 每周一 05:29 | AWS / GCP / Cloudflare / Azure → 云厂商段包 | 不动 |
| `refresh-asn-dbip.yml` | 每月 6 号 05:37 | DB-IP ASN Lite 与 IP 归属表对拍 → 二源分歧包 | 不动 |

- **只有数据真的变了才提交**：产物里的 `generated` / `fetchedAt` / `sourceMonth` / `syncToken` / `createDate` / `changeNumber` 每次都变，比对指纹时先抹掉；指纹与 HEAD 一致就把工作区还原、连构建戳都不动。否则每天一次无意义提交会白触发一次静态托管重建。
- **易变包不换构建戳**：`blocklists` / `cloud` / `asn-disagree` 用包内 `generated` 做 URL 版本（加载器先取元数据，再用 `?v=<generated>` 取二进制），所以每天刷新黑名单不会把 33 MB 城市片的 CDN 缓存打失效。只有 `asn` / `city` 与代码变更才调用 `tools/bump-build.mjs`；它同时更新 `index.html` 的 `meta[name=build]`、所有 `?v=` 和 `sw.js` 的 `CACHE` 名。
- **顺序**：刷新 → `node test/run-all.mjs`（不绿就不提交）→ commit + push → 静态托管的 Git 集成自动发布。
- 想先看有没有变化（不下载、不改文件）：`node tools/refresh-data.mjs --asn --dry`（`--blocklists` / `--cloud` / `--dbip` 同理）；手动补跑：Actions 页面点 Run。
- Azure Service Tags 是 best-effort：下载失败时保留旧文件，并在 `cloud-meta.js` 的 `status` 里写 `unavailable`；其余三家全失败才让任务失败。
- DB-IP ASN 只比较**两源都完整覆盖**的 `/24`，输出「ASN 不一致」的区间；不判断谁对。当月 CSV 没发布时自动回退上月。

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

// data/cloud-pack.bin → CLOUDPK1：8B 魔数 + u32 版本 + u32 区间数
//   + starts[] + ends[]（/24 索引 = (a<<16)|(b<<8)|c，含端点）
//   + providerBits[]（aws=1 gcp=2 cloudflare=4 azure=8，任意覆盖）
//   + fullBits[]（providerBits 的子集：这个 /24 被完整覆盖）

// data/blocklists.bin → IPBLK001：8B 魔数 + u32 版本 + u32 段数
//   + starts[] + ends[]（u32 地址）+ bits[]（drop=1 ipsum=2 tor=4 blocklistde=8）

// data/asn-disagree.bin → ASNDIF01：8B 魔数 + u32 版本 + u32 区间数
//   + starts[] + ends[] + otherAsn[]（DB-IP 给出的 ASN）
```

不想开网页时可以直接命令行查：

```powershell
node tools/query.mjs "130.*.253.66" "198.*.42.81" --top 5
node tools/query.mjs "177.202.126.*" --online    # 顺带问问第三方接口
node tools/query.mjs "AS4766"                     # ASN 概览
node tools/query.mjs "AS4766" --expand 8 --cidrs 10  # 均匀展开 8 个 /24 + 列 10 个 CIDR
```

## 已知局限

- IP 归属表是**概率上限**，不是保证：只有 291 个 ASN 有实测标定，其余按名称 / 类型推断，经关键词判为零售 ISP 但没标定的 ASN 仍然是乐观值。
- IP 归属表认不出「运营商 ASN 里的机房客户段」（`177.202.126.0/24` 挂在 KT 的 AS4766 下，实际是 Ace Data Centers 的机房）—— 所以占比封顶 90%，想坐实必须点联网核验。
- 联网核验是**抽样**（一行几个 IP），抽样干净只说明「没抓到机房证据」；关键词判定也有假阳（名字里带 `cloud` / `institute` 的小 ISP 可能被当成机房，宁严不宽）。
- 实测记录层依赖 ip-api 的 hosting / proxy 标记，有假阴假阳；「三否」不等于住宅 IP。
- 免费城市数据对住宅 IP 常定位到运营商出口或注册地，城市只能当排序参考。
- 云厂商段表只覆盖厂商公开的段；租用机房、二级转售、BYOIP 段可能不在表内，所以只有整 `/24` 覆盖才改判。
- 风险名单命中是「这个地址在某名单里」的事实，不等于非住宅：被入侵的家用路由器也可能出现在 blocklist.de；因此只标注、不扣分。
- 二源 ASN 分歧可能来自迁移、更具体的宣告或时间差，只展示两个来源与对比月份，不判断谁对。
- ASN 聚合行的住宅概率来自该 ASN 的标定占比；一个标定样本都没有时只给类型先验，页面标「未评级」，不报级别与得分。
- 最终能不能拿到干净的住宅 IP，还得自己实测。
