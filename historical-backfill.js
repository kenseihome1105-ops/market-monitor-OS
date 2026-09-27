const { chromium } = require('playwright');

// ============================================================
// 利益商品探索AI Historical Backfill
//
// 商品マスター / 利益商品探索AI
//   ↓
// market-ingest: getHistoricalBackfillTargets
//   ↓
// Yahooオークション「終了180日間」
//   ↓
// 過去実売分布 + Historical Market Score
//   ↓
// market-ingest: upsertHistoricalBackfill
//   ↓
// 利益商品探索AI Y:AH
//
// このファイルは「売れた側（相場・需要）」を埋める。
// 現行出品の仕入れ側（Mercari / Yahoo）は次段で同じDB商品へ結合する。
// ============================================================

const INGEST_URL = process.env.MARKET_INGEST_URL;
const INGEST_SECRET = process.env.MARKET_INGEST_SECRET;

const BATCH_LIMIT = positiveInt_(
  process.env.HISTORICAL_BATCH_LIMIT,
  5,
  1,
  10
);

const MAX_SOLD_ITEMS = positiveInt_(
  process.env.HISTORICAL_MAX_SOLD_ITEMS,
  50,
  1,
  50
);

const PAGE_TIMEOUT_MS = positiveInt_(
  process.env.HISTORICAL_PAGE_TIMEOUT_MS,
  60000,
  10000,
  120000
);

const BETWEEN_TARGETS_MS = positiveInt_(
  process.env.HISTORICAL_BETWEEN_TARGETS_MS,
  1500,
  0,
  10000
);

const FORCE =
  String(process.env.HISTORICAL_FORCE || '')
    .trim()
    .toLowerCase() === 'true';

const DRY_RUN =
  String(process.env.HISTORICAL_DRY_RUN || '')
    .trim()
    .toLowerCase() === 'true';

const APPS_SCRIPT_MAX_ATTEMPTS = 5;
const APPS_SCRIPT_RETRY_DELAYS_MS = [
  0,
  2500,
  6000,
  12000,
  20000
];

if (!INGEST_URL || !INGEST_SECRET) {
  throw new Error('GitHub Secrets が設定されていません');
}

// ============================================================
// 共通
// ============================================================

function sleep_(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function positiveInt_(value, fallback, min, max) {
  const n = Number(value);

  if (!Number.isInteger(n)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, n));
}

function clamp_(value, min = 0, max = 1) {
  const n = Number(value);

  if (!Number.isFinite(n)) {
    return min;
  }

  return Math.max(min, Math.min(max, n));
}

function yen_(value) {
  const n = Number(value || 0);

  return Number.isFinite(n)
    ? `¥${Math.round(n).toLocaleString('ja-JP')}`
    : '¥0';
}

function isRetryableAppsScriptStatus_(status) {
  return [
    404,
    408,
    425,
    429,
    500,
    502,
    503,
    504
  ].includes(Number(status));
}

function looksLikeAppsScriptHtml_(text, contentType) {
  const type = String(contentType || '').toLowerCase();
  const body = String(text || '').trim();

  return (
    type.includes('text/html') ||
    /^<!doctype\s+html/i.test(body) ||
    /^<html/i.test(body)
  );
}

async function postAppsScriptJson_(payload, label) {
  let lastError = null;

  for (
    let attempt = 1;
    attempt <= APPS_SCRIPT_MAX_ATTEMPTS;
    attempt++
  ) {
    const delayMs = Number(
      APPS_SCRIPT_RETRY_DELAYS_MS[attempt - 1] || 0
    );

    if (delayMs > 0) {
      console.warn(`[${label}] retry wait: ${delayMs}ms`);
      await sleep_(delayMs);
    }

    console.log(`[${label}] Attempt: ${attempt}/${APPS_SCRIPT_MAX_ATTEMPTS}`);

    let response;

    try {
      response = await fetch(
        INGEST_URL,
        {
          method: 'POST',
          redirect: 'follow',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload)
        }
      );
    } catch (error) {
      lastError = new Error(
        `${label}通信失敗: ${
          error && error.message
            ? error.message
            : String(error)
        }`
      );

      if (attempt < APPS_SCRIPT_MAX_ATTEMPTS) {
        continue;
      }

      throw lastError;
    }

    const text = await response.text();
    const contentType = response.headers.get('content-type') || '';

    if (!response.ok) {
      lastError = new Error(
        `${label} HTTP失敗: ${response.status}`
      );

      if (
        isRetryableAppsScriptStatus_(response.status) &&
        attempt < APPS_SCRIPT_MAX_ATTEMPTS
      ) {
        continue;
      }

      throw lastError;
    }

    let result;

    try {
      result = JSON.parse(text);
    } catch (error) {
      lastError = new Error(
        `${label}応答がJSONではありません`
      );

      const retryableBody =
        looksLikeAppsScriptHtml_(text, contentType) ||
        !String(contentType).toLowerCase().includes('json');

      if (
        retryableBody &&
        attempt < APPS_SCRIPT_MAX_ATTEMPTS
      ) {
        continue;
      }

      console.log(`[${label}] Response head:`, text.slice(0, 1000));
      throw lastError;
    }

    if (result.ok !== true) {
      const errorText = JSON.stringify(result);
      lastError = new Error(`${label}側エラー: ${errorText}`);

      // market-ingest の write lock 競合は一時エラーとして再試行する。
      if (
        result.error === 'busy' &&
        attempt < APPS_SCRIPT_MAX_ATTEMPTS
      ) {
        continue;
      }

      throw lastError;
    }

    return result;
  }

  throw (
    lastError ||
    new Error(`${label} Apps Script通信に失敗しました`)
  );
}

// ============================================================
// market-ingest
// ============================================================

async function getTargets_() {
  return postAppsScriptJson_(
    {
      secret: INGEST_SECRET,
      action: 'getHistoricalBackfillTargets',
      limit: BATCH_LIMIT,
      force: FORCE
    },
    'Historical targets'
  );
}

async function saveSummary_(target, summary) {
  if (DRY_RUN) {
    console.log(
      `[DRY RUN] 保存スキップ ${target.dbItemId}:`,
      JSON.stringify(summary)
    );
    return { ok: true, dryRun: true };
  }

  return postAppsScriptJson_(
    {
      secret: INGEST_SECRET,
      action: 'upsertHistoricalBackfill',
      dbItemId: target.dbItemId,
      summary
    },
    `Historical save ${target.dbItemId}`
  );
}

// ============================================================
// Yahoo終了180日間 parser
// 既存 Market Comps の抽出ルールを基礎にしている。
// ============================================================

async function extractYahooClosedItems_(page, limit) {
  return page.evaluate(
    ({ limit }) => {
      function clean(value) {
        return String(value || '')
          .replace(/\u00a0/g, ' ')
          .replace(/[ \t]+/g, ' ')
          .replace(/\n{3,}/g, '\n\n')
          .trim();
      }

      function absoluteUrl(href) {
        try {
          return new URL(href, location.href).href;
        } catch (error) {
          return '';
        }
      }

      function findCard(anchor) {
        let node = anchor;

        for (let depth = 0; depth < 10; depth++) {
          node = node.parentElement;

          if (!node) {
            break;
          }

          const text = clean(node.innerText);

          if (
            text.includes('落札') &&
            text.includes('終了') &&
            text.length <= 5000
          ) {
            return node;
          }
        }

        return null;
      }

      function bestTitle(card, itemHref) {
        const links = Array.from(card.querySelectorAll('a'));

        const candidates = links
          .filter(link => {
            const href = absoluteUrl(link.getAttribute('href'));

            return (
              href &&
              href.split('#')[0] === itemHref.split('#')[0]
            );
          })
          .map(link =>
            clean(
              link.innerText ||
              link.getAttribute('aria-label') ||
              link.getAttribute('title')
            )
          )
          .filter(text => text && text.length >= 4)
          .sort((a, b) => b.length - a.length);

        if (candidates.length) {
          return candidates[0];
        }

        const heading = card.querySelector('h1,h2,h3,h4');
        return heading ? clean(heading.innerText) : '';
      }

      const anchors = Array.from(
        document.querySelectorAll('a[href*="/jp/auction/"]')
      );

      const seen = new Set();
      const results = [];

      for (const anchor of anchors) {
        if (results.length >= limit) {
          break;
        }

        const href = absoluteUrl(anchor.getAttribute('href'));

        if (!href) {
          continue;
        }

        const idMatch = href.match(/\/jp\/auction\/([^/?#]+)/);

        if (!idMatch) {
          continue;
        }

        const itemId = idMatch[1];

        if (seen.has(itemId)) {
          continue;
        }

        const card = findCard(anchor);

        if (!card) {
          continue;
        }

        const text = clean(card.innerText);
        const priceMatch = text.match(/落札\s*([\d,]+)\s*円/);
        const endMatch = text.match(
          /(\d{1,2}\/\d{1,2})\s+(\d{1,2}:\d{2})\s*終了/
        );

        if (!priceMatch || !endMatch) {
          continue;
        }

        const title = bestTitle(card, href);

        if (!title) {
          continue;
        }

        seen.add(itemId);

        results.push({
          itemId,
          url: href.split('#')[0],
          title,
          price: Number(String(priceMatch[1]).replace(/,/g, '')) || 0,
          endDateLabel: endMatch[1],
          endTimeLabel: endMatch[2]
        });
      }

      return results;
    },
    { limit }
  );
}

// ============================================================
// 集計 / Historical Market Score
// ============================================================

function quantile_(sortedValues, q) {
  if (!sortedValues.length) {
    return 0;
  }

  if (sortedValues.length === 1) {
    return sortedValues[0];
  }

  const position = (sortedValues.length - 1) * q;
  const base = Math.floor(position);
  const rest = position - base;
  const next = sortedValues[base + 1];

  if (next === undefined) {
    return sortedValues[base];
  }

  return (
    sortedValues[base] +
    rest * (next - sortedValues[base])
  );
}

function buildHistoricalScore_(target, stats) {
  const sampleCount = stats.sampleCount;
  const medianPrice = stats.medianPrice;
  const q25Price = stats.q25Price;
  const q75Price = stats.q75Price;
  const buyLimit = Number(target.normalBuyLimit || 0);
  const adoptedSale = Number(target.adoptedSalePrice || 0);

  if (
    sampleCount <= 0 ||
    medianPrice <= 0
  ) {
    return {
      score: 0,
      judgement: '過去実売0件・後回し'
    };
  }

  // ① 実売量 25点
  const volumeScore =
    clamp_(sampleCount / 20) * 25;

  // ② サンプル信頼度 10点
  const sampleScore =
    clamp_(sampleCount / 12) * 10;

  // ③ 中央売価 ÷ 通常仕入上限 25点
  // 通常仕入上限がDB側で利益条件を織り込んでいるため、
  // ここでは「過去市場が仕入上限より十分上にあるか」を見る。
  let medianSpreadScore = 0;

  if (buyLimit > 0) {
    const ratio = medianPrice / buyLimit;
    medianSpreadScore =
      clamp_((ratio - 1.0) / 1.5) * 25;
  }

  // ④ 25%値 ÷ 通常仕入上限 20点
  // 中央値だけでなく、弱めに売れたゾーンでも利益余地が残るか。
  let q25SpreadScore = 0;

  if (buyLimit > 0 && q25Price > 0) {
    const ratio = q25Price / buyLimit;
    q25SpreadScore =
      clamp_((ratio - 1.0) / 1.5) * 20;
  }

  // ⑤ 価格安定性 15点
  // IQRが中央値に対して小さいほど安定。
  const iqr = Math.max(0, q75Price - q25Price);
  const iqrRatio = medianPrice > 0
    ? iqr / medianPrice
    : 1;
  const stabilityScore =
    clamp_(1 - (iqrRatio / 1.0)) * 15;

  // ⑥ DB想定売価との整合 5点
  // 過去中央値がDB想定の50%以上なら満点へ近づける。
  let dbPlausibilityScore = 0;

  if (adoptedSale > 0) {
    const ratio = medianPrice / adoptedSale;
    dbPlausibilityScore =
      clamp_(ratio / 0.8) * 5;
  }

  const score = Math.round(
    volumeScore +
    sampleScore +
    medianSpreadScore +
    q25SpreadScore +
    stabilityScore +
    dbPlausibilityScore
  );

  let judgement;

  if (score >= 70 && sampleCount >= 5) {
    judgement = '過去市場強い・仕入側検証へ';
  } else if (score >= 50 && sampleCount >= 3) {
    judgement = '過去市場あり・要ライブ検証';
  } else {
    judgement = '過去市場弱い・優先度低';
  }

  return {
    score,
    judgement
  };
}

function summarizeHistorical_(target, items) {
  const prices = items
    .map(item => Number(item.price || 0))
    .filter(price => Number.isFinite(price) && price > 0)
    .sort((a, b) => a - b);

  if (!prices.length) {
    return {
      soldCount: 0,
      sampleCount: 0,
      minPrice: 0,
      q25Price: 0,
      medianPrice: 0,
      q75Price: 0,
      maxPrice: 0,
      historicalScore: 0,
      judgement: '過去実売0件・後回し',
      state: '0件'
    };
  }

  const stats = {
    sampleCount: prices.length,
    minPrice: prices[0],
    q25Price: Math.round(quantile_(prices, 0.25)),
    medianPrice: Math.round(quantile_(prices, 0.50)),
    q75Price: Math.round(quantile_(prices, 0.75)),
    maxPrice: prices[prices.length - 1]
  };

  const score = buildHistoricalScore_(target, stats);

  return {
    // Yahooの1ページから安全に確認できた実売件数。
    // 50件を上限とし、ページ上の曖昧な総件数表示は採用しない。
    soldCount: prices.length,
    sampleCount: prices.length,
    minPrice: stats.minPrice,
    q25Price: stats.q25Price,
    medianPrice: stats.medianPrice,
    q75Price: stats.q75Price,
    maxPrice: stats.maxPrice,
    historicalScore: score.score,
    judgement: score.judgement,
    state: '取得済'
  };
}

// ============================================================
// 1商品
// ============================================================

async function runTarget_(page, target) {
  const url = String(target.yahooHistoricalUrl || '').trim();

  if (!target.dbItemId) {
    throw new Error('DB商品IDがありません');
  }

  if (!url) {
    throw new Error(`${target.dbItemId}: 相場URL_Yahoo180 がありません`);
  }

  console.log('========================================');
  console.log('DB商品ID:', target.dbItemId);
  console.log('ブランド:', target.brand || '');
  console.log('カテゴリ:', target.category || '');
  console.log('商品:', target.product || '');
  console.log('Exploration Priority:', target.explorationPriority || 0);
  console.log('検索語:', target.searchKeyword || '');
  console.log('仕入URL Mercari:', target.mercariBuyUrl || '');
  console.log('仕入URL Yahoo:', target.yahooBuyUrl || '');
  console.log('相場URL Yahoo180:', url);

  const response = await page.goto(
    url,
    {
      waitUntil: 'domcontentloaded',
      timeout: PAGE_TIMEOUT_MS
    }
  );

  if (!response) {
    throw new Error(`${target.dbItemId}: Yahoo HTTPレスポンスなし`);
  }

  const status = response.status();
  console.log('Yahoo HTTP:', status);

  if (status < 200 || status >= 400) {
    throw new Error(`${target.dbItemId}: Yahoo HTTP ${status}`);
  }

  await page.waitForSelector('body', { timeout: PAGE_TIMEOUT_MS });
  await page.waitForTimeout(2200);

  const bodyText = String(
    await page.locator('body').innerText()
  ).replace(/\u00a0/g, ' ');

  const looksLikeClosedSearch =
    bodyText.includes('終了180日間') ||
    bodyText.includes('180日間の落札相場') ||
    bodyText.includes('落札相場');

  if (!looksLikeClosedSearch) {
    throw new Error(
      `${target.dbItemId}: Yahoo落札相場ページとして確認できません`
    );
  }

  const items = await extractYahooClosedItems_(
    page,
    MAX_SOLD_ITEMS
  );

  const summary = summarizeHistorical_(target, items);

  console.log('実売サンプル:', summary.sampleCount);
  console.log('25%値:', yen_(summary.q25Price));
  console.log('中央値:', yen_(summary.medianPrice));
  console.log('75%値:', yen_(summary.q75Price));
  console.log('Historical Score:', summary.historicalScore);
  console.log('Historical判定:', summary.judgement);

  await saveSummary_(target, summary);

  return summary;
}

// ============================================================
// main
// ============================================================

async function main() {
  console.log('========================================');
  console.log('Historical Backfill START');
  console.log('Batch limit:', BATCH_LIMIT);
  console.log('Max sold items:', MAX_SOLD_ITEMS);
  console.log('Force:', FORCE);
  console.log('Dry run:', DRY_RUN);
  console.log('========================================');

  const targetResult = await getTargets_();
  const targets = Array.isArray(targetResult.targets)
    ? targetResult.targets
    : [];

  console.log('今回対象:', targets.length);
  console.log('未処理候補:', targetResult.remaining || 0);

  if (!targets.length) {
    console.log('Historical Backfill: 対象なし');
    return;
  }

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage'
    ]
  });

  const context = await browser.newContext({
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    viewport: {
      width: 1440,
      height: 1200
    }
  });

  const page = await context.newPage();

  let success = 0;
  let failed = 0;
  const errors = [];

  try {
    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];

      try {
        await runTarget_(page, target);
        success++;
      } catch (error) {
        failed++;
        const message =
          error && error.message
            ? error.message
            : String(error);

        errors.push({
          dbItemId: target.dbItemId,
          error: message
        });

        console.error(
          `[${target.dbItemId}] Historical Backfill ERROR:`,
          message
        );
      }

      if (
        i < targets.length - 1 &&
        BETWEEN_TARGETS_MS > 0
      ) {
        await sleep_(BETWEEN_TARGETS_MS);
      }
    }
  } finally {
    await browser.close();
  }

  console.log('========================================');
  console.log('Historical Backfill END');
  console.log('成功:', success);
  console.log('失敗:', failed);

  if (errors.length) {
    console.log('失敗一覧:', JSON.stringify(errors, null, 2));
  }

  console.log('========================================');

  // 一部失敗でも成功分は保存済み。
  // 全件失敗した時だけWorkflowを赤にする。
  if (success === 0 && failed > 0) {
    throw new Error('Historical Backfill が全件失敗しました');
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
