<div align="center">

<img src="assets/icon.svg" width="104" alt="iPurity">

# iPurity

**Batch-check residential IPs**

[![License](https://img.shields.io/badge/license-Apache--2.0-111111)](LICENSE) ![Static](https://img.shields.io/badge/static-no%20backend-111111) ![Tracking](https://img.shields.io/badge/tracking-none-111111) ![UI](https://img.shields.io/badge/UI-%E4%B8%AD%E6%96%87%20%7C%20English-111111)

**[Live site](https://ipurity.pages.dev)** &nbsp;·&nbsp; **[Scoring rules](docs/judging-criteria.md)** &nbsp;·&nbsp; **[Data refresh](docs/data-pipeline.md)** &nbsp;·&nbsp; **[JSON format](docs/export-schema.md)** &nbsp;·&nbsp; [中文](README.md) · **English**

![The iPurity interface: your list on the left, the ranking on the right](docs/screenshot.en.png)

</div>

## Use cases

Subscribing to AI services, running a cross-border e-commerce shop, managing TikTok and other social accounts —
what you may need is **batch-checking residential IPs.**

## Scoring rules

The tool only reads IPs: country, city and notes in your list are ignored, and country and city are looked up by
the tool itself. A row with `*` is expanded into 256 ranges (254 when the `*` is in the 4th octet), each one is
classified, and the whole row is then placed in one of four tiers by its residential share:

| Tier | Meaning | Residential share |
| :-- | :-- | :-- |
| **A** | mostly residential | ≥ 58.6% |
| **B** | residential and business | 23.4% – 58.5% |
| **C** | mostly business and institutional | 7.8% – 23.3% |
| **D** | mostly datacenter and institutional | < 7.8% |

A tier marked `est.` is inferred from the IP owner table and is an upper bound only: that table cannot see
the datacenter ranges rented out inside a large carrier, so the residential share is capped at 90%. The full
criteria, the calibration, and what online IP lookup sites actually report are in
[Scoring rules](docs/judging-criteria.md) (Chinese).

It answers one question: which of these IP ranges are residential. If your IPs are all datacenter, or you only
want the city a single IP sits in, it will not help you.

Besides pasting IPs, you can query an ASN directly (for example `AS4766`): one row gives its name, registration
country, segment / CIDR / `/24` counts, residential probability and tier. Expansion samples `/24`s evenly in
address order, capped at 64 per ASN and 128 per session, so a carrier's 180k ranges never flood the page.

Cloud-provider ranges, risk lists and DB-IP ASN disagreements appear as **annotations**. Only a `/24` that is
entirely inside a provider's published ranges is re-graded D; a partial range, a blocklist hit or a two-source
ASN mismatch is annotated without changing the tier or score.

## Data sources

| Data | Source | Coverage | Refresh |
| :-- | :-- | :-- | :-- |
| **Measured records** | ip-api.com free endpoint, one look-up per range | 53 groups, 13,568 ranges | manual |
| **IP owner table** | iptoasn + PeeringDB + bad-asn-list | 539k entries, every in-use IP | daily |
| **City data** | DB-IP City Lite (CC BY 4.0) | 3.62M entries, 33 MB, loaded file by file as needed | monthly |
| **Calibration** | residential share per ASN, inferred from the measured records | 291 ASNs | with the IP owner table |
| **Cloud ranges** | official AWS / Google Cloud / Cloudflare / Azure Service Tags ranges | 694k `/24`s, 15 KB | weekly |
| **Risk lists** | Spamhaus DROP, IPsum, Tor exits, blocklist.de | 21k ranges, 187 KB | daily |
| **ASN disagreement** | DB-IP ASN Lite (CC BY 4.0) compared with the IP owner table per `/24` | 155k `/24`s, 97 KB | monthly |

The data files ship with the repository (see `data/`). The scheduled jobs in `.github/workflows/` refresh each
layer and commit only once the upstream data has actually changed and the self-checks pass. Manual commands and
file formats are in [Data refresh](docs/data-pipeline.md) (Chinese).

Results can be exported as CSV or JSON, rendered as a self-contained SVG share card, or shared as a `#q=` link;
filtering, sorting and comparison with the previous run all happen in the browser. A web manifest and service
worker let the app shell open offline after the first visit (data files are still read on demand). Every new
data file is same-origin and static.

## Privacy

Nothing you paste is uploaded. Grading runs entirely in your browser and only reads this site's own data files:
there is no backend, no analytics and no cookies, and what you paste stays in your browser's localStorage. On
load the page requests only same-origin `data/*`; the three volatile packs (cloud ranges, risk lists, ASN
disagreement) fetch a same-origin metadata file first and then the binary keyed by its in-pack version.

Requests go out only when you click **Online check** or **Run live lookup**, and only for a few sampled IPs,
never for the whole list. The sites involved are `ipwho.is`, `ip-api.com`, `rdap.org`, Cloudflare's and
Google's DoH (for PTR and Team Cymru lookups), `stat.ripe.net` and `internetdb.shodan.io`. Anything a source
does not answer is recorded as “not retrieved” rather than guessed. Flag icons come from `flagcdn.com`, and
those requests carry no referrer.

**Copy link** puts the list in the URL's `#q=` fragment. The fragment is not sent to the server, but browser
history and chat apps may keep it; links longer than 1800 characters after encoding are refused in favour of a
JSON export. Comparison snapshots live only in localStorage (at most 8 snapshots of 1000 rows).

## Contributing

Serve the repository over HTTP to work on it locally (`file://` URLs are blocked from loading the data files):

```powershell
python -m http.server 8080                          # open http://localhost:8080/
node tools/query.mjs "130.*.253.66" "82.24.73.*"    # command-line lookup
node tools/query.mjs "AS4766" --expand 8 --cidrs 10 # aggregate by ASN
```

- Run `node test/run-all.mjs` before opening a pull request; the checks cover page wiring, judging consistency
  and the Chinese/English entries.
- If you disagree with a rule or a data source, open an issue and say which row and which verdict.
- After changing `assets/*.js`, `data/*` or `index.html`, run `node tools/bump-build.mjs` to update the build
  stamp. Script and data URLs carry `?v=<build>`, and a stale stamp means new HTML with old JS.

If this tool is useful to you, [a ⭐](https://github.com/dawenbin/ipurity) helps others find it.

<a href="https://star-history.com/#dawenbin/ipurity&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=dawenbin/ipurity&type=Date&theme=dark">
    <img src="https://api.star-history.com/svg?repos=dawenbin/ipurity&type=Date" width="600" alt="Star history">
  </picture>
</a>

## License

This project is licensed under [Apache-2.0](LICENSE); the documentation is licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The `iPurity` name and icon remain all rights reserved and are not covered by those licences.

Data comes from third parties; licences and attribution are listed in [NOTICE](NOTICE) — the measured records come from the ip-api.com free endpoint, non-commercial use only.
