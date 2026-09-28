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
- Each market scan sends at most 10 listings from the saved offset. The offset
  advances only after the ledger ingest succeeds. An exhausted result resets
  to the top for the next pass. Mercari stops without advancing if it cannot
  load the requested range before its scroll safety limit.
- The saved position is numeric. If the marketplace inserts or removes results
  ahead of that position, the page can shift. Ledger dedupe suppresses repeat
  ingest, and the next pass starts at the top again, but this draft cannot
  guarantee zero omissions during a changing feed. An item that disappears
  before the crawler reaches it cannot be recovered from the active listing.
- Yahoo is intentionally sorted by shortest remaining time, not newest listing.
  The Backfill URL builder uses `s1=end&o1=a`; the live Yahoo search page labels
  that setting “残り時間の短い順”. Yahoo pages with `b`/`n` pagination retain
  that ordering. Because auctions disappear as they end, numeric offsets can
  shift during a sweep and may skip a listing that expires before its range is
  reached. Dedupe and restarting from the top on exhaustion reduce repeats but
  cannot guarantee zero omissions in a changing feed. Mercari remains
  newest-first.
- Backfill's `normalBuyLimit` is returned to the Yahoo scanner so the old
  ¥29,000 parser ceiling does not exclude higher-priced Backfill targets.
  Manual Yahoo conditions without a stored limit retain the existing ceiling.
- LINE judging, notification dedupe, existing time schedules, concurrency
  groups, and Apps Script triggers are unchanged.

## Verification

Run `npm test` from this folder. The private Apps Script draft has a separate
mock-sheet test:

```bash
node --test private-appscript/market-ingest-cursor.test.js
```

Do not enable this draft in production until the Yahoo sort and the projected
workflow duration have been checked against the actual enabled-condition
count. The current monitor workflows still process all enabled conditions
sequentially.
