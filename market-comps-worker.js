'use strict';

const { chromium } = require('playwright');
const {
  postAppsScriptJson,
  runYahooMarketCompsForTarget_
} = require('./monitor');

const secret = process.env.MARKET_INGEST_SECRET;

async function main() {
  const capability = await postAppsScriptJson(
    {
      secret,
      action: 'getMonitorCapabilities'
    },
    'Capabilities'
  );

  if (
    capability.version !==
    'MONITOR_PRIORITY_V1_20261003'
  ) {
    throw new Error(
      'Deploy MONITOR_PRIORITY_V1_20261003 first'
    );
  }

  const response = await postAppsScriptJson(
    {
      secret,
      action: 'getMarketCompsTargets',
      limit: 12
    },
    'Pending comparisons'
  );

  const browser = await chromium.launch({
    headless: true
  });

  const start = Date.now();
  const failures = [];
  const comparisonAttempts = [];
  const preparedComparisons = [];

  let completed = 0;
  let attempted = 0;

  try {
    const context = await browser.newContext({
      locale: 'ja-JP',
      timezoneId: 'Asia/Tokyo'
    });

    const page = await context.newPage();
    const cache = new Map();

    for (
      const target
      of response.targets || []
    ) {
      if (
        Date.now() - start >
        6 * 60000
      ) {
        break;
      }

      comparisonAttempts.push({
        targetKey: target.targetKey,
        attemptedAt: Date.now()
      });

      attempted++;

      try {
        const prepared =
          await runYahooMarketCompsForTarget_(
            page,
            target,
            target,
            cache,
            {
              deferIngest: true
            }
          );

        if (
          !prepared ||
          prepared.action !== 'prepareMarketComps' ||
          !prepared.payload
        ) {
          throw new Error(
            'MarketComps prepare response is invalid'
          );
        }

        preparedComparisons.push({
          target,
          payload: prepared.payload
        });

      } catch (error) {
        failures.push({
          itemId: target.itemId,
          error: error.message
        });
      }
    }

  } finally {
    await browser.close();
  }

  if (
    preparedComparisons.length > 0
  ) {
    const batchStartedAt =
      Date.now();

    try {
      const batch =
        await postAppsScriptJson(
          {
            secret,
            action:
              'upsertMarketCompsBatch',
            items:
              preparedComparisons.map(
                entry => entry.payload
              )
          },
          'MarketComps batch'
        );

      if (
        batch.action !==
        'upsertMarketCompsBatch'
        ||
        !Array.isArray(
          batch.results
        )
      ) {
        throw new Error(
          'MarketComps batch response is invalid'
        );
      }

      preparedComparisons.forEach(
        (entry, index) => {
          const result =
            batch.results[index];

          if (
            result &&
            result.ok === true
          ) {
            completed++;

            console.log(
              '✅ Yahoo Market Comps BATCH SUCCESS',
              entry.target.itemId,
              'received=',
              result.received,
              'inserted=',
              result.inserted,
              'updated=',
              result.updated,
              'skipped=',
              result.skipped
            );

            return;
          }

          failures.push({
            itemId:
              entry.target.itemId,
            error:
              result &&
              result.error
                ? String(result.error)
                : 'MarketComps batch item failed'
          });
        }
      );

      console.log(
        '[TIMING] MarketComps batch:',
        JSON.stringify({
          count:
            preparedComparisons.length,
          postCount:
            1,
          elapsedMs:
            Date.now() -
            batchStartedAt,
          succeeded:
            completed,
          failed:
            preparedComparisons.length -
            completed
        })
      );

    } catch (error) {
      preparedComparisons.forEach(
        entry => {
          failures.push({
            itemId:
              entry.target.itemId,
            error:
              error &&
              error.message
                ? error.message
                : String(error)
          });
        }
      );

      console.error(
        '❌ MarketComps batch送信失敗:',
        error &&
        error.message
          ? error.message
          : String(error)
      );
    }
  }

  if (
    comparisonAttempts.length > 0
  ) {
    const comparisonAttemptBatchStartedAt =
      Date.now();

    try {
      await postAppsScriptJson(
        {
          secret,
          action: 'ackMarketCompsAttempt',
          attempts: comparisonAttempts
        },
        'Comparison attempt batch'
      );

      console.log(
        '[TIMING] Comparison attempt batch:',
        JSON.stringify({
          count:
            comparisonAttempts.length,
          postCount:
            1,
          elapsedMs:
            Date.now() -
            comparisonAttemptBatchStartedAt
        })
      );

    } catch (error) {
      console.warn(
        '⚠️ Comparison attempt batch送信失敗。公平性情報のみ次回へ繰越:',
        JSON.stringify({
          count:
            comparisonAttempts.length,
          error:
            error && error.message
              ? error.message
              : String(error)
        })
      );
    }
  }

  const valuation =
    await postAppsScriptJson(
      {
        secret,
        action: 'runMarketValuation'
      },
      'Valuation'
    );

  const notifications =
    await postAppsScriptJson(
      {
        secret,
        action: 'runProcurementNotifications',
        markets: ['メルカリ']
      },
      'Procurement notifications'
    );

  console.log(
    'COMPARISON_WORKER_SUMMARY:',
    JSON.stringify({
      pending:
        response.pending,
      attempted,
      prepared:
        preparedComparisons.length,
      completed,
      deferred:
        Math.max(
          0,
          Number(
            response.pending || 0
          ) - attempted
        ),
      failures,
      valuation,
      notifications
    })
  );

  if (
    failures.length ||
    notifications.notifications?.failed
  ) {
    throw new Error(
      'Comparison/notification failures; failed targets remain eligible for retry'
    );
  }
}

if (
  require.main === module
) {
  main().catch(
    error => {
      console.error(
        'COMPARISON_WORKER_ERROR:',
        error.message
      );

      process.exitCode = 1;
    }
  );
}

module.exports = {
  main
};
