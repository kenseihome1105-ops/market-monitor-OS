# Backfill → Monitor test draft

This draft connects each returned Historical Backfill target to the existing
Mercari and Yahoo monitor configuration flow. It is prepared for an isolated
GitHub branch and Apps Script review. It has not been deployed or run against
the live spreadsheet.

## Draft behavior

- A Backfill batch registers one stable condition per available market URL and
  DB product ID before historical pages are scraped. Repeated registration is
  idempotent. Existing rows, including a manually disabled row, are left alone.
- The Apps Script source adds the `市場監視走査状態` sheet when the first
  registration or cursor acknowledgment is received. It stores the condition,
  DB product ID, buy limit, next offset, last item ID, and update time.
- Each condition runs two 10-row lanes: the current head for new/urgent items,
  and a saved continuation for broad coverage. Item IDs merge the lanes before
  ingest, so overlap is handled once. Continuation state advances only after
  ledger ingest succeeds.
- Mercari continuation locates the previous raw listing ID in the newly loaded
  result stream. If it moved within the bounded lookahead, the scan resumes
  after it. If it is missing, the scan restarts at the head; item-ID upsert and
  notification dedupe absorb replay. Mercari stays newest-first.
- Yahoo remains sorted by shortest time to end (`s1=end&o1=a`), which the live
  search page labels “残り時間の短い順”. Its continuation validates the saved
  boundary ID against the preceding raw page and rebases the one-based offset.
  The cursor advances by raw result rows, even when no rows pass the title or
  buy-price filters. A missing boundary restarts from the head. The head lane
  checks imminent auctions every workflow run.
- Both feeds change while they are being scanned. This reduces silent skips and
  recovers through replay, but cannot recover an auction that ends before any
  scan reaches it or guarantee a stable snapshot without a source-side cursor.
- Backfill's `normalBuyLimit` is returned to the Yahoo scanner so the old
  ¥29,000 parser ceiling does not exclude higher-priced Backfill targets.
  Manual Yahoo conditions without a stored limit retain the existing ceiling.
- Workflow cron schedules, LINE judging, notification dedupe, and Apps Script
  triggers are unchanged. The four workflows sharing the production concurrency
  group use `queue: max` in this test draft, keeping their serialized order while
  retaining up to 100 pending runs instead of replacing the previous pending
  run.

## Verification

Run `npm test` from this folder. The private Apps Script draft has a separate
mock-sheet test:

```bash
node --test private-appscript/market-ingest-cursor.test.js
```

Before production, compare the measured workflow runtime with the additional
head-page and anchor-validation requests. The current monitor workflows still
process all enabled conditions sequentially, so sustained queue growth must be
checked before changing the cron frequency.
