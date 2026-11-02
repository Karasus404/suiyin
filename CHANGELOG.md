# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning follows [SemVer](https://semver.org/).

## [1.4.0] - 2026-11-02

### Added
- `去重` command: merges records that share type, amount and note within a 3 minute window into
  the earliest one. Exists because the Feishu record API turned out not to support idempotent
  writes; see below.
- Post-write duplicate check. After a record is stored, the query that computes the running total
  also looks for a twin (same type / amount / note, within 90 s) and appends a one-line notice to
  the receipt. No extra request, no extra latency.
- `APP_DEDUPE_CHECK` (default on) to switch that check off.
- `EMPTY_FIELDS` guard: when the API returns records whose `fields` are all empty — which Feishu
  does when a Base has advanced permissions enabled and the app is only "can edit" — the reply now
  says so and points at the permission setting, instead of rendering a ledger full of `¥0.00`.

### Changed
- Write timeouts no longer report as "记账失败". A timed-out write may well have landed, so the
  reply now says the record may already be saved and asks the user to check `明细` before resending.
  The old wording invited a resend, which is one of the ways duplicates were created.

### Findings
- `client_token` on Feishu's create-record API does not provide idempotency. Tested on a real Base
  with the same token sent twice: as a query parameter on `records`, and in the body of
  `records/batch_create`. Both produced two distinct `record_id`s. The parameter is documented but
  silently ignored, so idempotency has to live above the storage layer.
- The in-process `MsgId` cache only covers redeliveries that land on the same function instance.

## [1.3.0] - 2026-11-01

### Changed
- `APP_STATS_BUDGET_MS` default raised from 900 to 1500 ms. A cross-cloud query to Feishu takes
  about 1.3 s, so the previous budget always expired and the "today total" line never appeared.

## [1.2.0] - 2026-11-01

### Added
- `诊断` (diagnostics) command: reports channel, storage backend, cloud region, token latency and
  query latency separately, so a slow setup can be attributed to cold start, credentials or the
  network path.
- Per-call timeouts on the Feishu store (`add` / `list` / `remove` / `probe`).

### Changed
- `APP_FEISHU_TIMEOUT_MS` default raised from 2600 to 3800 ms. Measured latency from a cloud
  function in Guangzhou to `open.feishu.cn` is ~1.3 s per request; a 2600 ms ceiling was cutting
  successful calls off at the edge.
- Timeout reply reworded to cover both writes and deletes ("the command may already have run").

### Fixed
- `删1` (delete latest) now reuses the `record_id` cached in instance memory after a write, and
  deletes in a single request. The previous two-step flow needed ~5.2 s at observed latency and
  always hit the 5 s platform ceiling.
- `删N` no longer fetches 200 records when only N are needed.

## [1.1.0] - 2026-11-01

### Added
- Message de-duplication by `MsgId`: a redelivered message (platform retries when the reply takes
  longer than 5 s) replays the cached reply instead of writing a second record or deleting twice.
- Per-stage latency logging (`store.add`, stats query, command query).

### Changed
- The reply is composed as soon as the record is written. The "today/month total" line is computed
  with a separate budget and simply omitted when it does not fit, instead of delaying the receipt.
- Timeout reply reworded.

## [1.0.0] - 2026-11-01

### Added
- Initial release.
- Plain-text bookkeeping over WeCom (self-built app) and WeChat Official Account / sandbox account,
  auto-detected from the request signature.
- AES-256-CBC message encryption, XML envelope building, `echostr` verification.
- Parser for `25 lunch`, `+3000 salary`, category tags, quantifier handling, income/expense inference.
- Commands: month summary, today, yesterday, recent list, delete latest, help.
- Feishu Bitable storage adapter with token caching, plus local `json` / `memory` backends.
- Adapters for Tencent SCF function URL events and CloudBase / Alibaba FC3 shapes.
- Local HTTP server and simulator, 8-point pre-flight check, remote probe, zip packer.
- 136 assertions in the test suite (no network, no credentials required).
