# Backfill → Monitor test branch

## Status

The implementation is on codex/backfill-to-monitor-cursor and has not been merged to main. The GitHub branch is not an isolated data environment: the tested workflows used the configured MARKET_INGEST_URL and MARKET_INGEST_SECRET to call the deployed Apps Script v11 endpoint and update the live ledger/cursor state.

## Verification

- Historical Backfill Batch #40 on commit da60b5b selected 5 targets and registered 10 monitor conditions (Mercari and Yahoo for each target); all 10 were accepted.
- Yahoo Test #948 on commit 1174120 completed successfully. It reached all 12 enabled conditions, including all five BF_Y conditions. Each condition was ingested successfully:
  
  | Condition | Received | New | Updated |
  |---|---:|---:|---:|
  | Sullivan leather jacket | 10 | 0 | 10 |
  | Burberry knitwear | 10 | 0 | 10 |
  | Yohji Yamamoto knitwear | 7 | 0 | 7 |
  | Balenciaga sneakers | 6 | 4 | 2 |
  | Cartier watch | 10 | 3 | 7 |

  These counts are per condition; the same listing can appear in more than one search.
- Monitor flow unit workflow #10 on commit 23105b2 passed 37 tests, 0 failures; JavaScript syntax checks passed. Tests cover thrown condition errors and a Yahoo scan result with `ok: false`, and verify later conditions still run. Y-06 succeeded during the live run, so no live search-failure case was reproduced.
- This run verified scanning and ledger/cursor ingestion. It did not verify the final LINE notification path.

## Behavior

- Historical Backfill registers one stable monitor condition per valid market URL and DB product ID before collecting historical pages. Repeated registration is idempotent, and existing rows, including manually disabled rows, are left unchanged.
- Each enabled condition checks a 10-row head lane and a 10-row continuation lane. Item IDs merge the lanes before ingestion, so overlap is processed once.
- Mercari remains newest-first. Its continuation finds the prior raw listing ID in the loaded stream; if the anchor is missing, it restarts at the head and relies on item-ID upsert and notification dedupe for replay.
- Yahoo Auctions stays sorted by shortest time to end (s1=end&o1=a). It validates the saved boundary ID against the prior page, advances by raw result rows, and checks the head on every run.
- The cursor advances only after successful ledger ingestion. Failed ingestion or Yahoo search keeps the saved position available for retry; a failed condition is reported after later conditions finish.
- Backfill normalBuyLimit is passed to Yahoo scanning so the prior ¥29,000 parser ceiling does not exclude higher-priced targets.

## Scheduling and limits

Four workflows share the market-monitor-os-production concurrency group. This branch adds queue: max to all four, preserving up to 100 pending runs instead of replacing the pending run. Before that change reaches main, scheduled main runs can still replace a waiting test-branch run; this happened to Yahoo Test #946 when scheduled main run #947 arrived.

The branch does not change cron expressions, LINE judging, notification dedupe, or Apps Script triggers. Queueing reduces lost pending runs but can build a backlog. One Yahoo test-branch run took about 8 minutes; a main-branch Market Monitor run took about 9 minutes. Monitor pending-queue depth and end-to-end runtime before increasing schedules.

Both marketplaces change while they are being scanned. Anchor rebasing and replay reduce missed items and duplicates, but cannot guarantee a stable snapshot or recover an item that disappears before the crawler reaches it.