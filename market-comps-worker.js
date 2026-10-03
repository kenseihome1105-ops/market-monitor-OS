'use strict';

const { chromium } = require('playwright');
const { postAppsScriptJson, runYahooMarketCompsForTarget_ } = require('./monitor');
const secret = process.env.MARKET_INGEST_SECRET;

async function main() {
  const capability = await postAppsScriptJson({ secret, action: 'getMonitorCapabilities' }, 'Capabilities');
  if (capability.version !== 'MONITOR_PRIORITY_V1_20261003') throw new Error('Deploy MONITOR_PRIORITY_V1_20261003 first');
  const response = await postAppsScriptJson({ secret, action: 'getMarketCompsTargets', limit: 12 }, 'Pending comparisons');
  const browser = await chromium.launch({ headless: true });
  const start = Date.now();
  const failures = [];
  let completed = 0;
  let attempted = 0;
  try {
    const context = await browser.newContext({ locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
    const page = await context.newPage();
    const cache = new Map();
    for (const target of response.targets || []) {
      if (Date.now() - start > 6 * 60000) break;
      await postAppsScriptJson({ secret, action: 'ackMarketCompsAttempt', targetKey: target.targetKey }, 'Comparison attempt');
      attempted++;
      try {
        await runYahooMarketCompsForTarget_(page, target, target, cache);
        completed++;
      } catch (error) {
        failures.push({ itemId: target.itemId, error: error.message });
      }
    }
  } finally { await browser.close(); }
  const valuation = await postAppsScriptJson({ secret, action: 'runMarketValuation' }, 'Valuation');
  const notifications = await postAppsScriptJson({ secret, action: 'runProcurementNotifications', markets: ['メルカリ'] }, 'Procurement notifications');
  console.log('COMPARISON_WORKER_SUMMARY:', JSON.stringify({ pending: response.pending, attempted, completed, deferred: Math.max(0, Number(response.pending || 0) - attempted), failures, valuation, notifications }));
  if (failures.length || notifications.notifications?.failed) throw new Error('Comparison/notification failures; failed targets remain eligible for retry');
}

if (require.main === module) main().catch(error => { console.error('COMPARISON_WORKER_ERROR:', error.message); process.exitCode = 1; });
module.exports = { main };
