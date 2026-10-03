# Fresh listings and deadline monitoring

Deploy Apps Script `MONITOR_PRIORITY_V1_20261003` before merging this change. Fast workers check the server capability and stop if the deployment is older. Full replacement Apps Script files are supplied separately; they do not belong in this public repository.

## Workers

| Workflow | Schedule requested (UTC) | Purpose |
| --- | --- | --- |
| Market Monitor Test | Every 10 minutes, starting at minute 7 | Mercari active/newest-first search, new-listing gap, saved older continuation |
| Yahoo Test | Every 10 minutes, starting at minute 2 | Yahoo ending-soon search and saved continuation |
| Market Valuation Batch | Every 10 minutes, starting at minute 4 | Persist up to 12 pending sold-comparison targets, valuation, Mercari notifications |
| Yahoo Deadline Monitor | Every 5 minutes, starting at minute 3 | Fresh detail prices/end times for auctions within 90 minutes and unknown deadlines; notify only within 60 minutes |
| Historical Backfill Batch | Existing four-hour schedule | Register sourcing conditions from completed historical targets |

GitHub schedules request execution; actual starts can be delayed. These intervals do not guarantee exact notification time or complete coverage of listings that appear and disappear between polls.

Mercari and Yahoo discovery each use four stable condition shards, at most two simultaneous jobs per marketplace. A condition's head, new-gap and older-continuation lanes are each at most ten raw IDs. Overlapping IDs are ingested once. During unfinished gap catch-up, the completed head checkpoint moves only to the captured starting head; arrivals during catch-up remain eligible for the next gap. Empty/failed retrievals do not erase the saved gap/cursor.

Discovery budgets stop starting new conditions after 16 minutes. Conditions are ordered by oldest attempt and resume from their saved state on the next run. A failed condition is recorded before scanning so it cannot repeatedly consume all time ahead of other conditions. Work left over is logged explicitly.

Each worker type has its own concurrency group. Discovery, valuation and deadline monitoring keep the active run and only the newest pending tick. Superseded timer ticks are coalesced; saved listing work stays in Apps Script. The two historical backfill workflows share a separate group. They retain their existing queued batch behavior and no longer wait behind sourcing crawls.

## Deadline safety and delivery

The deadline worker follows all eligible known auctions, without the former permanent first-30 selection. It limits individual work batches to ten items and detail reads to three simultaneous pages. A three-minute scan budget rotates unfinished/failed attempts through stored timestamps. Active auctions can extend their deadline: fresh detail end times are saved before notification.

Only successfully read, active auction details with a valid future end time are ingested by this worker. Only successfully persisted IDs enter that batch's notification request. Apps Script additionally requires a detail confirmation and current-price check no older than 15 minutes. The notification interval is strictly `0 < remaining milliseconds <= 60 minutes`; the final minute is included.

Profit policy, master matching, gender/category valuation and notification key rules are unchanged. LINE requests use the existing `pushLine_` implementation. A short durable reservation prevents concurrent senders from sending the same notification at once; network sends run outside the shared sheet-write lock. Success is recorded in the existing notification log. A process dying after LINE accepts a request and before success persistence remains an ambiguous delivery outcome; this change does not claim exactly-once delivery across such a crash.

## Deployment and verification

1. Replace the existing four Apps Script files containing `marketIngestDoPostOS_`, `refreshProcurementCandidateViewOS`, `sendFinalProcurementLineNotificationsOS`, and `runProductionMarketAutomationOS` with the supplied full replacements. Preserve one definition of each function. Save all four, then update the existing web-app deployment to a new version.
2. Run the read-only `diagnoseMonitorNotificationFlowOS` and retain `MONITOR_FLOW_DIAGNOSIS`. It reports installed trigger handler names and current filtering counts; it sends no LINE and changes no triggers.
3. Merge this PR after deployment is confirmed. Cancel obsolete queued runs from the previous shared production group. Resume discovery, valuation and the deadline worker on main.
4. Inspect `MONITOR_SHARD_SUMMARY`, `YAHOO_SHARD_SUMMARY`, `COMPARISON_WORKER_SUMMARY`, `YAHOO_DEADLINE_SUMMARY`, `MARKET_COMPS_BATCH_IO`, `PROCUREMENT_VIEW_REFRESH`, and `FINAL_LINE_SUMMARY`. Deferred work and detail failures are reported, not counted as completed.
5. Confirm spreadsheet view freshness and a real notification when an eligible listing exists. A green collector run alone does not prove the notification path.

The existing `runProductionMarketAutomationOS` trigger remains valid and shares the valuation lease with the new worker. This change does not create or delete Apps Script triggers.
