'use strict';

const { chromium } = require('playwright');
const { postAppsScriptJson_, scanTrackedYahooItem, sendToAppsScript } = require('./yahoo-test');
const { prioritizeYahooTargets_ } = require('./monitor-priority');
const secret = process.env.MARKET_INGEST_SECRET;

async function processDeadlineBatch_(targets, scan, ingest, notify) {
  const groups = new Map();
  const failures = [];
  for (let i = 0; i < targets.length; i += 3) {
    const chunk = targets.slice(i, i + 3);
    const updates = await Promise.allSettled(chunk.map(scan));
    updates.forEach((r, index) => {
      const target = chunk[index];
      const end = r.status === 'fulfilled' && r.value ? Date.parse(r.value.endTime || '') : NaN;
      if (r.status !== 'fulfilled' || !r.value || !Number.isFinite(end) || end <= Date.now()) {
        failures.push(target.itemId); return;
      }
      if (!groups.has(target.conditionId)) groups.set(target.conditionId, []);
      groups.get(target.conditionId).push(r.value);
    });
  }
  const confirmedIds = [];
  for (const [conditionId, items] of groups) {
    const result = await ingest(items, conditionId);
    if (!result || result.ok !== true) throw new Error('Yahoo fresh-price ingest failed; no notification');
    confirmedIds.push(...items.map(i => i.itemId));
  }
  if (confirmedIds.length) {
    const result = await notify(confirmedIds);
    if (result.notifications?.failed) throw new Error('LINE send failed');
  }
  return { updated: confirmedIds.length, failedDetails: failures };
}

async function main() {
  const capability = await postAppsScriptJson_({ secret, action: 'getMonitorCapabilities' }, 'Capabilities');
  if (capability.version !== 'MONITOR_PRIORITY_V1_20261003') throw new Error('Deploy MONITOR_PRIORITY_V1_20261003 first');
  const response = await postAppsScriptJson_({ secret, action: 'getYahooDeadlineTargets' }, 'Deadline targets');
  const targets = prioritizeYahooTargets_(response.targets);
  const browser = await chromium.launch({ headless: true });
  const start = Date.now();
  const summary = { total: targets.length, attempted: 0, updated: 0, failedDetails: [], deferred: 0 };
  try {
    const context = await browser.newContext({ locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
    for (let i = 0; i < targets.length; i += 10) {
      if (Date.now() - start > 3 * 60000) break;
      const chunk = targets.slice(i, i + 10);
      await postAppsScriptJson_({ secret, action: 'ackYahooTrackingAttempt', itemIds: chunk.map(t => t.itemId) }, 'Tracking attempt');
      summary.attempted += chunk.length;
      const result = await processDeadlineBatch_(chunk, async target => {
        const url = new URL(target.url);
        if (url.protocol !== 'https:' || url.hostname !== 'auctions.yahoo.co.jp' ||
            url.pathname !== '/jp/auction/' + target.itemId) throw new Error('Invalid Yahoo item URL');
        const page = await context.newPage();
        try { return await scanTrackedYahooItem(page, target); }
        finally { await page.close(); }
      }, (items, conditionId) => sendToAppsScript(items, conditionId, { detailVerified: true }),
      itemIds => postAppsScriptJson_({ secret, action: 'runProcurementNotifications', markets: ['ヤフオク'], itemIds }, 'Deadline notifications'));
      summary.updated += result.updated;
      summary.failedDetails.push(...result.failedDetails);
    }
  } finally { await browser.close(); }
  summary.deferred = targets.length - summary.attempted;
  console.log('YAHOO_DEADLINE_SUMMARY:', JSON.stringify(summary));
  if (summary.failedDetails.length) console.warn('Some detail reads failed/ended; excluded from notifications and retried if still active.');
}

if (require.main === module) main().catch(error => { console.error('YAHOO_DEADLINE_ERROR:', error.message); process.exitCode = 1; });
module.exports = { main, processDeadlineBatch_ };
