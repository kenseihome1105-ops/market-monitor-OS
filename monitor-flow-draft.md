# Backfill-to-Monitor cursor design

This file describes the current implementation on codex/backfill-to-monitor-cursor. It supersedes the earlier numeric-offset-only draft.

## Flow

1. Historical Backfill selects DB products and creates a stable BF_M or BF_Y condition from each valid market search URL.
2. The registration endpoint adds missing conditions while preserving existing rows and manual OFF states.
3. Each monitor condition checks the first 10 rows and a 10-row continuation window. The two windows merge by listing ID before ingestion.
4. The monitor acknowledges the new cursor only after Apps Script accepts the ledger ingest.

## Cursor rules

- Mercari is newest-first. The crawler records raw listing IDs and resumes after the previous anchor. If the anchor is outside the loaded window or no longer present, it restarts at the head; ledger and notification dedupe absorb replay.
- Yahoo Auctions uses shortest remaining time first (s1=end&o1=a). It fetches the previous page to find the saved boundary listing, rebases the one-based offset, and advances by raw rows rather than only listings that pass title or price filters.
- Yahoo checks the first page every run for urgent auctions, then merges it with the continuation page by item ID.
- Failed ingestion does not advance the cursor. A missing or expired anchor resets to the head.
- Market results change during a scan. These rules reduce offset drift and duplicate work, but do not provide a source-side stable snapshot or guarantee zero omissions.

## Shared workflow queue

The historical backfill, Market Monitor, and Yahoo workflows share one production concurrency group. This branch sets queue: max on the four group members so up to 100 pending runs can remain queued. Queue growth still needs monitoring because the scheduled arrivals are about every 10 minutes across the three recurring workflows, while observed runs take roughly 8–10 minutes.

Until the workflow changes merge to main, main's old concurrency policy can replace a pending test-branch run. A pending Yahoo test run was replaced by a scheduled main Yahoo run during validation.

## Validation and boundary

Yahoo Test #948 ran on the live Apps Script v11 endpoint and reached all 12 conditions, including all five Backfill Yahoo conditions. The live Y-06 request succeeded, so the transient-failure path is covered by the unit test rather than reproduced live.

The test validates marketplace scanning and ledger/cursor ingestion. It does not assert that a final LINE notification was sent. Changes to cron times, LINE judgment/dedupe logic, and Apps Script triggers are outside this branch.