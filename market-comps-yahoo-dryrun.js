const { chromium } = require('playwright');

/**
 * ============================================================
 * Yahoo 類似成約データ取得 + 相場比較データ連携
 *
 * Version: yahoo-comps-v2
 *
 * 目的
 * ------------------------------------------------------------
 * 仕入候補1商品を対象として、
 * Yahooオークション「終了180日間」から
 * 類似成約商品を最大30件取得。
 *
 * 取得した比較商品を
 *
 *   action: upsertMarketComps
 *
 * で既存 market-ingest Web App に送信し、
 * Google Sheets「相場比較データ」へ保存する。
 *
 *
 * 絶対にしないこと
 * ------------------------------------------------------------
 * ・既存Yahoo監視条件の変更
 * ・市場監視台帳への直接書き込み
 * ・LINE通知
 * ・既存Yahoo parserファイルの変更
 * ・商品マスターへの書き込み
 *
 *
 * 流れ
 * ------------------------------------------------------------
 * 対象商品
 * ↓
 * Yahoo終了180日間検索
 * ↓
 * 最大30件取得
 * ↓
 * 共通比較形式へ正規化
 * ↓
 * market-ingest
 * ↓
 * 相場比較データ
 * ============================================================
 */


const SOURCE_VERSION =
  'yahoo-comps-v2';


/* ============================================================
 * 設定
 * ============================================================
 */

const CONFIG = {

  // ----------------------------------------------------------
  // Yahoo比較検索
  // ----------------------------------------------------------

  query:
    envText_(
      'COMP_QUERY',
      'GUCCI スーツ'
    ),

  categoryId:
    envText_(
      'COMP_CATEGORY_ID',
      '23176'
    ),

  maxItems:
    positiveInt_(
      process.env.COMP_MAX_ITEMS,
      30
    ),

  timeoutMs:
    positiveInt_(
      process.env.COMP_TIMEOUT_MS,
      60000
    ),


  // ----------------------------------------------------------
  // 判定対象商品
  // ----------------------------------------------------------

  target: {

    targetKey:
      envText_(
        'COMP_TARGET_KEY'
      ),

    market:
      envText_(
        'COMP_TARGET_MARKET'
      ),

    conditionId:
      envText_(
        'COMP_TARGET_CONDITION_ID'
      ),

    itemId:
      envText_(
        'COMP_TARGET_ITEM_ID'
      ),

    url:
      envText_(
        'COMP_TARGET_URL'
      ),

    title:
      envText_(
        'COMP_TARGET_TITLE'
      ),

    dbItemId:
      envText_(
        'COMP_TARGET_DB_ID'
      ),

    brand:
      envText_(
        'COMP_TARGET_BRAND'
      ),

    category:
      envText_(
        'COMP_TARGET_CATEGORY'
      ),

    currentPrice:
      positiveNumber_(
        process.env.COMP_TARGET_CURRENT_PRICE
      )
  },


  // ----------------------------------------------------------
  // market-ingest
  // ----------------------------------------------------------

  ingestUrl:
    envText_(
      'MARKET_INGEST_URL'
    ),

  ingestSecret:
    envText_(
      'MARKET_INGEST_SECRET'
    )
};


/* ============================================================
 * Main
 * ============================================================
 */

async function main() {

  printHeader_();


  // ==========================================================
  // 最初に対象商品を検証
  //
  // 比較データだけ取れて対象が不明、
  // という汚れた相場DBを作らない。
  // ==========================================================

  validateTargetConfig_(
    CONFIG
  );


  validateIngestConfig_(
    CONFIG
  );


  console.log(
    '対象キー:',
    CONFIG.target.targetKey
  );

  console.log(
    '対象市場:',
    CONFIG.target.market
  );

  console.log(
    '対象条件ID:',
    CONFIG.target.conditionId
  );

  console.log(
    '対象出品ID:',
    CONFIG.target.itemId
  );

  console.log(
    '対象商品:',
    CONFIG.target.title
  );

  console.log(
    '対象現在価格:',
    CONFIG.target.currentPrice
  );

  console.log(
    '検索語:',
    CONFIG.query
  );

  console.log(
    'YahooカテゴリID:',
    CONFIG.categoryId
  );

  console.log(
    '比較取得上限:',
    CONFIG.maxItems
  );


  const searchUrl =
    buildYahooClosedSearchUrl_(
      CONFIG.query,
      CONFIG.categoryId
    );


  console.log(
    '検索URL:',
    searchUrl
  );


  const browser =
    await chromium.launch({
      headless: true
    });


  try {

    const context =
      await browser.newContext({

        locale:
          'ja-JP',

        timezoneId:
          'Asia/Tokyo',

        viewport: {
          width: 1440,
          height: 1200
        },

        extraHTTPHeaders: {
          'Accept-Language':
            'ja-JP,ja;q=0.9,en;q=0.8'
        }
      });


    const page =
      await context.newPage();


    console.log(
      'Yahoo落札相場ページを取得中...'
    );


    const response =
      await page.goto(
        searchUrl,
        {
          waitUntil:
            'domcontentloaded',

          timeout:
            CONFIG.timeoutMs
        }
      );


    if (!response) {

      throw new Error(
        'YahooからHTTPレスポンスを取得できませんでした'
      );
    }


    console.log(
      'HTTP Status:',
      response.status()
    );


    if (
      response.status() < 200 ||
      response.status() >= 400
    ) {

      throw new Error(
        `Yahoo HTTP Error: ${response.status()}`
      );
    }


    await page.waitForSelector(
      'body',
      {
        timeout:
          CONFIG.timeoutMs
      }
    );


    await page.waitForTimeout(
      2500
    );


    const pageText =
      normalizeSpace_(
        await page
          .locator('body')
          .innerText()
      );


    // ========================================================
    // 安全確認
    //
    // 開催中一覧を落札相場として誤取得しない。
    // ========================================================

    if (
      !pageText.includes(
        '落札'
      )
      ||
      (
        !pageText.includes(
          '終了180日間'
        )
        &&
        !pageText.includes(
          '180日間の落札相場'
        )
      )
    ) {

      throw new Error(
        'Yahoo落札相場ページとして確認できませんでした。安全停止します。'
      );
    }


    const summary =
      await extractYahooSummary_(
        page
      );


    console.log(
      '----------------------------------------'
    );

    console.log(
      'Yahooページ集計'
    );

    console.log(
      JSON.stringify(
        summary,
        null,
        2
      )
    );


    const rawItems =
      await extractYahooClosedItems_(
        page,
        CONFIG.maxItems
      );


    if (
      rawItems.length === 0
    ) {

      throw new Error(
        '落札済み商品の取得件数が0件でした。DOM変更の可能性があるため安全停止します。'
      );
    }


    const comparisons =
      normalizeYahooClosedItems_(
        rawItems,
        CONFIG
      );


    if (
      comparisons.length === 0
    ) {

      throw new Error(
        '正規化後の比較商品が0件です。安全停止します。'
      );
    }


    console.log(
      '----------------------------------------'
    );

    console.log(
      '正規化済み比較商品:',
      comparisons.length,
      '件'
    );


    comparisons.forEach(
      (
        item,
        index
      ) => {

        console.log(
          `[${index + 1}/${comparisons.length}]`
        );

        console.log(
          JSON.stringify(
            item,
            null,
            2
          )
        );

      }
    );


    // ========================================================
    // market-ingestへ送信
    // ========================================================

    console.log(
      '----------------------------------------'
    );

    console.log(
      '相場比較データへ送信開始...'
    );


    const ingestResult =
      await sendMarketCompsToIngest_(
        CONFIG,
        comparisons
      );


    console.log(
      'market-ingest response:'
    );

    console.log(
      JSON.stringify(
        ingestResult,
        null,
        2
      )
    );


    if (
      !ingestResult ||
      ingestResult.ok !== true
    ) {

      throw new Error(
        'market-ingest が成功を返しませんでした'
      );
    }


    if (
      ingestResult.action !==
      'upsertMarketComps'
    ) {

      throw new Error(
        'market-ingest response action が不正です'
      );
    }


    // ========================================================
    // 最終ログ
    // ========================================================

    console.log(
      '========================================'
    );

    console.log(
      '✅ Yahoo Market Comps + INGEST SUCCESS'
    );

    console.log(
      '対象:',
      CONFIG.target.title
    );

    console.log(
      'targetKey:',
      CONFIG.target.targetKey
    );

    console.log(
      '検索:',
      CONFIG.query
    );

    console.log(
      '取得:',
      comparisons.length,
      '件'
    );

    console.log(
      'received:',
      ingestResult.received
    );

    console.log(
      'inserted:',
      ingestResult.inserted
    );

    console.log(
      'updated:',
      ingestResult.updated
    );

    console.log(
      'skipped:',
      ingestResult.skipped
    );

    console.log(
      '既存Yahoo監視変更: なし'
    );

    console.log(
      '市場監視台帳直接書込: なし'
    );

    console.log(
      '========================================'
    );


  } finally {

    await browser.close();
  }
}


/* ============================================================
 * 対象商品検証
 * ============================================================
 */

function validateTargetConfig_(
  config
) {

  const target =
    config.target;


  if (
    target.market !== 'メルカリ'
    &&
    target.market !== 'ヤフオク'
  ) {

    throw new Error(
      'COMP_TARGET_MARKET は メルカリ または ヤフオク が必要です'
    );
  }


  if (
    !target.itemId
  ) {

    throw new Error(
      'COMP_TARGET_ITEM_ID が未設定です'
    );
  }


  if (
    !target.url
  ) {

    throw new Error(
      'COMP_TARGET_URL が未設定です'
    );
  }


  if (
    !target.title
  ) {

    throw new Error(
      'COMP_TARGET_TITLE が未設定です'
    );
  }


  if (
    !target.currentPrice
  ) {

    throw new Error(
      'COMP_TARGET_CURRENT_PRICE が未設定です'
    );
  }


  /**
   * targetKeyを入力し忘れても
   * 市場 + 出品ID で安定キーを生成する。
   */
  if (
    !target.targetKey
  ) {

    target.targetKey =
      [
        target.market,
        target.itemId
      ].join(
        '::'
      );
  }


  if (
    !config.query
  ) {

    throw new Error(
      'COMP_QUERY が未設定です'
    );
  }


  if (
    !config.categoryId
  ) {

    throw new Error(
      'COMP_CATEGORY_ID が未設定です'
    );
  }
}


/* ============================================================
 * market-ingest設定確認
 * ============================================================
 */

function validateIngestConfig_(
  config
) {

  if (
    !config.ingestUrl
  ) {

    throw new Error(
      'MARKET_INGEST_URL が未設定です'
    );
  }


  if (
    !config.ingestSecret
  ) {

    throw new Error(
      'MARKET_INGEST_SECRET が未設定です'
    );
  }


  if (
    !/^https:\/\/script\.google\.com\//.test(
      config.ingestUrl
    )
  ) {

    throw new Error(
      'MARKET_INGEST_URL の形式が不正です'
    );
  }
}


/* ============================================================
 * market-ingest POST
 * ============================================================
 */

async function sendMarketCompsToIngest_(
  config,
  comparisons
) {

  const payload = {

    secret:
      config.ingestSecret,

    action:
      'upsertMarketComps',

    source:
      'Yahoo closedsearch',

    sourceVersion:
      SOURCE_VERSION,

    query:
      config.query,

    categoryId:
      config.categoryId,

    target: {

      targetKey:
        config.target.targetKey,

      market:
        config.target.market,

      conditionId:
        config.target.conditionId,

      itemId:
        config.target.itemId,

      url:
        config.target.url,

      title:
        config.target.title,

      dbItemId:
        config.target.dbItemId,

      brand:
        config.target.brand,

      category:
        config.target.category,

      currentPrice:
        config.target.currentPrice
    },

    comparisons:
      comparisons
  };


  const response =
    await fetch(
      config.ingestUrl,
      {
        method:
          'POST',

        redirect:
          'follow',

        headers: {
          'Content-Type':
            'application/json'
        },

        body:
          JSON.stringify(
            payload
          )
      }
    );


  const responseText =
    await response.text();


  if (
    !response.ok
  ) {

    throw new Error(
      `market-ingest HTTP ${response.status}: ${responseText}`
    );
  }


  let json;


  try {

    json =
      JSON.parse(
        responseText
      );

  } catch (error) {

    throw new Error(
      'market-ingest のレスポンスがJSONではありません: ' +
      responseText.slice(
        0,
        500
      )
    );
  }


  return json;
}


/* ============================================================
 * Yahoo終了済み検索URL
 * ============================================================
 */

function buildYahooClosedSearchUrl_(
  query,
  categoryId
) {

  if (!query) {

    throw new Error(
      '検索語が空です'
    );
  }


  if (!categoryId) {

    throw new Error(
      'categoryIdが空です'
    );
  }


  return (
    'https://auctions.yahoo.co.jp/' +
    'closedsearch/closedsearch/' +
    encodeURIComponent(
      query
    ) +
    '/' +
    encodeURIComponent(
      categoryId
    ) +
    '?n=50'
  );
}


/* ============================================================
 * Yahooページ上部集計
 * ============================================================
 */

async function extractYahooSummary_(
  page
) {

  const body =
    await page
      .locator('body')
      .innerText();


  const text =
    String(
      body || ''
    );


  return {

    minPrice:
      firstYenAfter_(
        text,
        '最安'
      ),

    averagePrice:
      firstYenAfter_(
        text,
        '平均'
      ),

    maxPrice:
      firstYenAfter_(
        text,
        '最高'
      ),

    resultCount:
      extractResultCount_(
        text
      )
  };
}


/* ============================================================
 * Yahoo落札済み商品抽出
 * ============================================================
 */

async function extractYahooClosedItems_(
  page,
  limit
) {

  return await page.evaluate(
    ({ limit }) => {

      function clean(
        value
      ) {

        return String(
          value || ''
        )
          .replace(
            /\u00a0/g,
            ' '
          )
          .replace(
            /[ \t]+/g,
            ' '
          )
          .replace(
            /\n{3,}/g,
            '\n\n'
          )
          .trim();
      }


      function absoluteUrl(
        href
      ) {

        try {

          return new URL(
            href,
            location.href
          ).href;

        } catch (e) {

          return '';
        }
      }


      function findCard(
        anchor
      ) {

        let node =
          anchor;


        for (
          let depth = 0;
          depth < 10;
          depth++
        ) {

          node =
            node.parentElement;


          if (!node) {

            break;
          }


          const text =
            clean(
              node.innerText
            );


          if (
            text.includes(
              '落札'
            )
            &&
            text.includes(
              '終了'
            )
            &&
            text.length <= 5000
          ) {

            return node;
          }
        }


        return null;
      }


      function bestTitle(
        card,
        itemHref
      ) {

        const links =
          Array.from(
            card.querySelectorAll(
              'a'
            )
          );


        const candidates =
          links
            .filter(
              link => {

                const href =
                  absoluteUrl(
                    link.getAttribute(
                      'href'
                    )
                  );


                return (
                  href
                  &&
                  href.split('#')[0] ===
                  itemHref.split('#')[0]
                );
              }
            )
            .map(
              link =>
                clean(
                  link.innerText
                  ||
                  link.getAttribute(
                    'aria-label'
                  )
                  ||
                  link.getAttribute(
                    'title'
                  )
                )
            )
            .filter(
              text =>
                text &&
                text.length >= 4
            )
            .sort(
              (
                a,
                b
              ) =>
                b.length -
                a.length
            );


        if (
          candidates.length
        ) {

          return candidates[0];
        }


        const heading =
          card.querySelector(
            'h1,h2,h3,h4'
          );


        return heading
          ? clean(
              heading.innerText
            )
          : '';
      }


      const anchors =
        Array.from(
          document.querySelectorAll(
            'a[href*="/jp/auction/"]'
          )
        );


      const seen =
        new Set();


      const results =
        [];


      for (
        const anchor of anchors
      ) {

        if (
          results.length >= limit
        ) {

          break;
        }


        const href =
          absoluteUrl(
            anchor.getAttribute(
              'href'
            )
          );


        if (!href) {

          continue;
        }


        const idMatch =
          href.match(
            /\/jp\/auction\/([^/?#]+)/
          );


        if (!idMatch) {

          continue;
        }


        const itemId =
          idMatch[1];


        if (
          seen.has(
            itemId
          )
        ) {

          continue;
        }


        const card =
          findCard(
            anchor
          );


        if (!card) {

          continue;
        }


        const text =
          clean(
            card.innerText
          );


        const priceMatch =
          text.match(
            /落札\s*([\d,]+)\s*円/
          );


        const endMatch =
          text.match(
            /(\d{1,2}\/\d{1,2})\s+(\d{1,2}:\d{2})\s*終了/
          );


        if (
          !priceMatch ||
          !endMatch
        ) {

          continue;
        }


        const title =
          bestTitle(
            card,
            href
          );


        if (!title) {

          continue;
        }


        /**
         * 長い状態名を先に見る。
         */
        const stateCandidates = [

          '新品、未使用',

          '未使用に近い',

          '目立った傷や汚れなし',

          'やや傷や汚れあり',

          '傷や汚れあり',

          '全体的に状態が悪い',

          '未使用'
        ];


        let condition =
          '';


        for (
          const state of stateCandidates
        ) {

          if (
            text.includes(
              state
            )
          ) {

            condition =
              state;

            break;
          }
        }


        const bidMatch =
          text.match(
            /(?:入札|入札件数)\s*[:：]?\s*(\d+)/
          );


        seen.add(
          itemId
        );


        results.push({

          itemId,

          url:
            href.split('#')[0],

          title,

          soldPriceText:
            priceMatch[1],

          endDateLabel:
            endMatch[1],

          endTimeLabel:
            endMatch[2],

          condition,

          bidCount:
            bidMatch
              ? Number(
                  bidMatch[1]
                )
              : null
        });
      }


      return results;

    },
    {
      limit
    }
  );
}


/* ============================================================
 * Yahoo比較商品 → 共通形式
 * ============================================================
 */

function normalizeYahooClosedItems_(
  rawItems,
  config
) {

  return rawItems
    .map(
      item => {

        const soldPrice =
          parseYenNumber_(
            item.soldPriceText
          );


        const endedAt =
          parseYahooEndDate_(
            item.endDateLabel,
            item.endTimeLabel
          );


        return {

          comparisonMarket:
            'ヤフオク',

          comparisonType:
            '成約',

          comparisonItemId:
            item.itemId,

          comparisonUrl:
            item.url,

          comparisonTitle:
            item.title,

          comparisonPrice:
            soldPrice,

          shipping:
            null,

          comparisonTotal:
            soldPrice,

          currency:
            'JPY',

          jpyTotal:
            soldPrice,

          endedAt,

          condition:
            item.condition ||
            '未取得',

          bidCount:
            item.bidCount,

          source:
            'Yahoo closedsearch',

          version:
            SOURCE_VERSION,

          query:
            config.query,

          categoryId:
            config.categoryId
        };
      }
    )
    .filter(
      item =>
        item.comparisonItemId
        &&
        item.comparisonUrl
        &&
        item.comparisonTitle
        &&
        item.comparisonPrice
    );
}


/* ============================================================
 * Yahoo終了日時
 * ============================================================
 */

function parseYahooEndDate_(
  md,
  hm
) {

  const mdMatch =
    String(
      md || ''
    ).match(
      /^(\d{1,2})\/(\d{1,2})$/
    );


  const hmMatch =
    String(
      hm || ''
    ).match(
      /^(\d{1,2}):(\d{2})$/
    );


  if (
    !mdMatch ||
    !hmMatch
  ) {

    return null;
  }


  const month =
    Number(
      mdMatch[1]
    );


  const day =
    Number(
      mdMatch[2]
    );


  const hour =
    Number(
      hmMatch[1]
    );


  const minute =
    Number(
      hmMatch[2]
    );


  const now =
    new Date();


  const currentYear =
    Number(
      new Intl.DateTimeFormat(
        'en-US',
        {
          timeZone:
            'Asia/Tokyo',

          year:
            'numeric'
        }
      ).format(
        now
      )
    );


  let year =
    currentYear;


  let timestamp =
    Date.UTC(
      year,
      month - 1,
      day,
      hour - 9,
      minute,
      0
    );


  if (
    timestamp >
    now.getTime()
      +
      24 * 60 * 60 * 1000
  ) {

    year -= 1;


    timestamp =
      Date.UTC(
        year,
        month - 1,
        day,
        hour - 9,
        minute,
        0
      );
  }


  const date =
    new Date(
      timestamp
    );


  if (
    isNaN(
      date.getTime()
    )
  ) {

    return null;
  }


  return date.toISOString();
}


/* ============================================================
 * Yahoo集計helper
 * ============================================================
 */

function firstYenAfter_(
  text,
  label
) {

  const escaped =
    escapeRegExp_(
      label
    );


  const match =
    String(
      text || ''
    ).match(
      new RegExp(
        escaped +
        '\\s*([\\d,]+)\\s*円'
      )
    );


  return match
    ? parseYenNumber_(
        match[1]
      )
    : null;
}


function extractResultCount_(
  text
) {

  const matches =
    [
      ...String(
        text || ''
      ).matchAll(
        /([\d,]+)\s*件/g
      )
    ];


  if (
    !matches.length
  ) {

    return null;
  }


  const numbers =
    matches
      .map(
        match =>
          Number(
            String(
              match[1]
            ).replace(
              /,/g,
              ''
            )
          )
      )
      .filter(
        Number.isFinite
      );


  return numbers.length
    ? Math.max(
        ...numbers
      )
    : null;
}


/* ============================================================
 * 共通helper
 * ============================================================
 */

function envText_(
  name,
  fallback = ''
) {

  const value =
    process.env[name];


  if (
    value === undefined ||
    value === null ||
    String(value).trim() === ''
  ) {

    return String(
      fallback || ''
    ).trim();
  }


  return String(
    value
  ).trim();
}


function positiveNumber_(
  value
) {

  const number =
    Number(
      String(
        value == null
          ? ''
          : value
      )
        .replace(
          /,/g,
          ''
        )
        .replace(
          /[¥￥円\s]/g,
          ''
        )
    );


  return (
    Number.isFinite(
      number
    )
    &&
    number > 0
  )
    ? number
    : 0;
}


function parseYenNumber_(
  value
) {

  const number =
    Number(
      String(
        value == null
          ? ''
          : value
      )
        .replace(
          /,/g,
          ''
        )
        .replace(
          /[¥￥円\s]/g,
          ''
        )
    );


  return Number.isFinite(
    number
  )
    ? number
    : null;
}


function normalizeSpace_(
  value
) {

  return String(
    value || ''
  )
    .replace(
      /\u00a0/g,
      ' '
    )
    .replace(
      /\s+/g,
      ' '
    )
    .trim();
}


function positiveInt_(
  value,
  fallback
) {

  const number =
    Number(
      value
    );


  if (
    !Number.isInteger(
      number
    )
    ||
    number <= 0
  ) {

    return fallback;
  }


  return number;
}


function escapeRegExp_(
  value
) {

  return String(
    value || ''
  ).replace(
    /[.*+?^${}()|[\]\\]/g,
    '\\$&'
  );
}


function printHeader_() {

  console.log(
    '========================================'
  );

  console.log(
    'Yahoo Market Comps + Market Ingest'
  );

  console.log(
    'Version:',
    SOURCE_VERSION
  );

  console.log(
    '========================================'
  );
}


/* ============================================================
 * 実行
 * ============================================================
 */

main()
  .catch(
    error => {

      console.error(
        '========================================'
      );

      console.error(
        '❌ Yahoo Market Comps FAILED'
      );

      console.error(
        error &&
        error.stack
          ? error.stack
          : error
      );

      console.error(
        '========================================'
      );


      process.exitCode =
        1;
    }
  );
