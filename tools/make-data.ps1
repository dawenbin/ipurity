<#
  make-data.ps1 -- 把扫描结果(prefixmap-classified.csv)压成前端数据包

  用法:
    powershell -File tools/make-data.ps1 -InputCsv build/prefixmap-classified.csv -OutDir data

  输出:
    data/segments-data.json   紧凑数据包(供 API / 二次加工)
    data/segments-data.js     window.SEGMENT_DATA = {...}(供静态页 <script> 直接引用)
#>
param(
    [string]$InputCsv = "build/prefixmap-classified.csv",
    [string]$OutDir   = "data",
    # 数据快照时间：重打包但没有重扫时把原时间传进来，别让界面看起来像刚扫过
    [string]$Generated = ""
)
$ErrorActionPreference = "Stop"

if (-not $Generated) { $Generated = Get-Date -Format "yyyy-MM-dd HH:mm" }

$rows = Import-Csv $InputCsv
if (-not $rows) { throw "读不到 $InputCsv(先跑 tools/scan-prefixes.ps1)" }

# 类别码: 1=住宅ISP 2=机房/云 3=商业中转/机构 4=移动 6=其他
# （曾经在这里给「定位在某个都会区」的 /24 加一位 +8，页面拿它做标记和排序。
#   后来去掉了：那一位只来自每个 /24 探的那一个地址（scan-prefixes.ps1 用 x.1），
#   是单点推整块的结论，没有依据去决定名次。现在类别码就只有这 5 个值。）
$CODE = @{ "ISP" = 1; "DC" = 2; "DCENT" = 3; "MOBILE" = 4; "UNK" = 6 }

$isps = New-Object System.Collections.Generic.List[string]
$cities = New-Object System.Collections.Generic.List[string]
$ispIdx = @{}; $cityIdx = @{}
function Idx($list, $map, $v) {
    if ($null -eq $v) { $v = "" }
    if (-not $map.ContainsKey($v)) { $map[$v] = $list.Count; $list.Add($v) }
    $map[$v]
}

$prefixes = [ordered]@{}
foreach ($g in ($rows | Group-Object prefix)) {
    if (-not $g.Name) { continue }
    $codes = New-Object string[] 256
    $is    = New-Object int[] 256
    $ci    = New-Object int[] 256
    foreach ($r in $g.Group) {
        # 第二段来源兼容: o2v / o2 列, 都没有就从 query(形如 198.3.243.1) 里取
        $o = if ($r.PSObject.Properties['o2v'] -and "$($r.o2v)" -ne "") { [int]$r.o2v }
             elseif ($r.PSObject.Properties['o2'] -and "$($r.o2)" -ne "") { [int]$r.o2 }
             else { [int](($r.query -split '\.')[1]) }
        if ($o -lt 0 -or $o -gt 255) { continue }
        $codes[$o] = [string]$CODE[$r.Cat]
        $is[$o]    = Idx $isps   $ispIdx  $r.isp
        $ci[$o]    = Idx $cities $cityIdx $r.city
    }
    $p = $g.Name -split '\.'
    $prefixes[$g.Name] = @{
        o1 = [int]$p[0]; o3 = [int]$p[2]
        c  = ($codes -join ',')
        i  = ($is -join ',')
        g  = ($ci -join ',')
    }
}

$data = [ordered]@{
    generated = $Generated
    source    = "ip-api.com free (ASN/org/hosting/proxy/mobile/geo)"
    legend    = "c[x] 类别码: 1住宅ISP 2机房/云 3商业中转/机构 4移动 6其他; x = 第二段(0-255)"
    isps      = $isps
    cities    = $cities
    prefixes  = $prefixes
}
$json = $data | ConvertTo-Json -Depth 6 -Compress

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
# 不写 BOM，方便 JSON.parse / Node 读取
$utf8 = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText((Join-Path $OutDir "segments-data.json"), $json, $utf8)
[IO.File]::WriteAllText((Join-Path $OutDir "segments-data.js"), ("window.SEGMENT_DATA=" + $json + ";"), $utf8)

# 自检：每个前缀必须填满 256 个 /24 位
$empty = 0
foreach ($k in $prefixes.Keys) { if (($prefixes[$k].c -split ',').Count -ne 256) { $empty++ } }
if ($empty -gt 0) { Write-Warning "有 $empty 个前缀未填满 256 个 /24，请检查输入 CSV" }
"前缀 $($prefixes.Count) / ISP名 $($isps.Count) / 城市 $($cities.Count) / json $([math]::Round((Get-Item "$OutDir/segments-data.json").Length/1KB,1))KB / 未填满 $empty"
