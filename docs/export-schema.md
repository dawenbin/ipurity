# JSON 导出格式

页面上的「导出 JSON」直接下载一个 UTF-8、无 BOM 的 `.json` 文件，内容由 `Core.toJson()` 生成。
它只序列化展示需要的字段，不包含内部行对象（完整 `enrich`、`asnProfile` 的区间表等都不会出现）。

```json
{
  "schema": "ipurity-export/v1",
  "generated": "2026-10-19T08:12:33.000Z",
  "build": "20261019a",
  "sources": {
    "measured": "2026-10-15",
    "global": "2026-10-18",
    "city": "2026-10",
    "cloud": "2026-10-19",
    "blocklists": "2026-10-19",
    "asnDiff": "2026-10"
  },
  "filter": { "tier": "ab", "country": "US", "city": "", "flag": "any", "sort": "score", "dir": -1 },
  "rows": []
}
```

`filter` 是导出时的可见范围；为 `null` 表示没有筛选 / 排序，导出的是全部成功判定的行。
CSV 仍沿用旧口径（默认只导出 A+B，按列名取列），JSON 导出的是**当前可见行**，两者不完全等价。

## 行对象

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `rank` | number \| null | 底层排名；筛选和排序不改变它 |
| `pattern` | string | 原始模式，例如 `198.*.42.81`、`AS4766` |
| `kind` | `"ip"` \| `"pattern"` \| `"asn"` | 单 IP / 打码模式 / ASN 聚合行 |
| `sourceLine` | number \| null | 该行来自输入的哪一行 |
| `ok` | boolean | 是否判定成功 |
| `reserved` | boolean | 不可路由（保留 / 组播 / 私网等），不参与排名与得分 |
| `ungraded` | boolean | 没有标定样本，只给类型先验；此时 `tier` 为空、`score` 为 `null` |
| `tier` | `"A"` \| `"B"` \| `"C"` \| `"D"` \| `""` | 级别 |
| `tierText` | string | 级别的中文说明，例如「住宅为主」 |
| `score` | number \| null | 0–100 的等级得分；未评级 / 失败为 `null` |
| `source` | string | `实测记录` / `全球ASN` / `联网核验` / `云厂商段表` |
| `approx` | boolean | 是否为概率估算；`true` 当且仅当 `source === "全球ASN"` |
| `home` | string | 住宅格的展示文本 |
| `homePct` | number \| null | 住宅占比（0–100） |
| `counts` | object \| null | `{ "1": 住宅, "2": 机房, "3": 商业, "4": 移动, "6": 其他 }` |
| `country` | object \| null | `{ cc, count, n, pct, src }` |
| `city` | object \| null | `{ city, count, n, pct, src }`；ASN 行为 `null` |
| `cloud` | object \| null | 云厂商段命中：见下 |
| `blocklist` | object \| null | 风险名单命中：见下 |
| `asnDiff` | object \| null | 二源 ASN 分歧：见下 |
| `asnProfile` | object \| null | ASN 聚合行的概览：见下 |
| `online` | object \| null | 联网核验结论 |
| `onlineEvidence` | object \| null | RDAP / PTR 附带证据 |
| `candidates` | array | 最多 3 个参考落点 `{ ip, city, isp }` |
| `note` | string | 失败原因或核验备注 |

### `cloud`

```json
{
  "ids": ["aws"], "fullIds": ["aws"],
  "count": 1, "any": 1, "full": 1, "share": 100,
  "network": "52.94.76.0/24", "override": true
}
```

- `ids` / `fullIds`：命中的厂商（任意覆盖 / 整 `/24` 覆盖）。
- `count` / `any` / `full`：样本数、命中数、整 `/24` 覆盖数；打码行跨 256 个 `/24` 时用来算 `share`。
- `override === true` 表示这一行因此被改判为 `D`，`source` 会变成「云厂商段表」。

### `blocklist`

```json
{ "ids": ["drop", "tor"], "count": 2, "sampled": 254, "range": "1.2.3.4 – 1.2.3.9" }
```

`ids` 取值：`drop`、`ipsum`、`tor`、`blocklistde`。命中也**不会**改变 `tier` / `score` / `counts`。

### `asnDiff`

```json
{ "otherAsn": 138421, "otherName": "", "count": 1, "sampled": 1, "pct": 100 }
```

表示 DB-IP 对同一 `/24` 给出的 ASN 与 IP 归属表不同。它同样只是标注，不改变级别与得分。

### `asnProfile`（仅 `kind === "asn"`）

```json
{
  "asn": 4766, "name": "KIXS-AS-KR Korea Telecom", "cc": "KR", "type": 1,
  "calibrated": false, "probability": 0.9,
  "segments": 1836, "cidrs": 5346, "blocks24": 181191, "firstIp": "1.96.0.0"
}
```

`calibrated === false` 时页面与该行都会标「未评级」：概率只是类型先验，不构成级别。

### `onlineEvidence`

```json
{
  "ip": "198.3.243.16", "at": "2026-10-19T08:10:00.000Z",
  "rdap": { "ok": true, "found": true, "name": "...", "range": "...", "country": "US", "url": "..." },
  "ptr": { "ok": true, "found": true, "ptr": "cpe-..." }
}
```

只包含实际拿到的字段；查不到时 `ok: false` 并带 `error`，不会出现占位数字。

## 兼容策略

- `schema` 是唯一的版本判据；`v1` 内只增加可选字段，不改变已有字段含义。
- 解析方应忽略不认识的字段。
- 布尔字段始终是布尔值，缺失的来源字段是 `null` 或 `""`，不使用 `NaN` / `undefined`。
- `approx === true` 当且仅当 `source === "全球ASN"`；这是页面与测试共同守卫的不变量。

## 其他导出

- **CSV**：列顺序固定，最后一列是「名单/云段/二源标记」（分号分隔，例如 `cloud:aws;bl:tor;diff:AS138421`）；带 BOM，方便 Excel 直接打开。
- **SVG 分享卡**：自包含，只用 hex 色板，不引用外部字体 / 图片 / CSS 变量；最多 8 行。
- **分享链接**：`#q=<encodeURIComponent(清单)>`，编码后超过 1800 字符拒绝生成，避免被聊天工具截断。
