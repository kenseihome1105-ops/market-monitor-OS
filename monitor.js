const { selectMercariHeadGap_, selectConditionShard_ } = require('./monitor-priority');
const {
  createConditionAttemptBatch_,
  recordConditionAttempt_,
  buildConditionAttemptBatchPayload_
} = require('./condition-attempt-batch');
const FAST_MODE = process.env.MONITOR_FAST_MODE === 'true';
const { chromium } = require('playwright');
const {
  defaultScanOffset_,
  enforceMercariActiveSearchUrl_,
  CURSOR_LOOKAHEAD_ITEMS,
  selectCursorBatch_,
  mergeUniqueItemsById_
} = require('./market-scan-cursor');
const { shouldRetryAppsScriptResult_ } = require('./apps-script-retry');
const {
  buildMarketCompsCacheKey_,
  getOrLoadMarketComps_
} = require('./market-comps-cache');


// ============================================================
// 基本設定
// ============================================================

const MARKET =
  'メルカリ';

const MAX_SEARCH_ITEMS =
  10;

// ============================================================
// Apps Script 通信リトライ設定
//
// Google ContentService の一時404 / HTML応答 / 一時通信失敗で
// 監視全体を落とさないため、同じPOSTを最大5回まで再試行する。
// ============================================================

const APPS_SCRIPT_MAX_ATTEMPTS =
  5;

const APPS_SCRIPT_RETRY_DELAYS_MS =
  [
    0,
    2500,
    6000,
    12000,
    20000
  ];

// ============================================================
// Yahoo Market Comps 設定
//
// 新規Mercari商品だけを対象に、
// Yahooオークション「終了180日間」から
// 類似成約商品を最大30件取得する。
// ============================================================

const MARKET_COMPS_SOURCE_VERSION =
  'yahoo-comps-v3-dbmeta';

const MARKET_COMPS_MAX_ITEMS =
  marketCompsPositiveInt_(
    process.env.COMP_MAX_ITEMS,
    30
  );

const MARKET_COMPS_TIMEOUT_MS =
  marketCompsPositiveInt_(
    process.env.COMP_TIMEOUT_MS,
    60000
  );

const MARKET_COMPS_FALLBACK_CATEGORY_ID =
  String(
    process.env.COMP_CATEGORY_ID ||
    '0'
  ).trim() || '0';


// ============================================================
// 必須Secret
// ============================================================

const INGEST_URL =
  process.env.MARKET_INGEST_URL;

const INGEST_SECRET =
  process.env.MARKET_INGEST_SECRET;


if (
  !INGEST_URL ||
  !INGEST_SECRET
) {

  throw new Error(
    'GitHub Secrets が設定されていません'
  );

}


// ============================================================
// Apps Script共通POST
//
// getConfig / 商品送信 / Market Comps保存を
// 完全に同じ通信方式へ統一する。
//
// Google Apps Script ContentService は
// script.googleusercontent.com へ一時URLを返すことがあるため、
// 一時404 / 5xx / HTML応答 / 通信エラー時だけ
// 新しいPOSTから最大3回まで再試行する。
// ============================================================

function sleep_(
  milliseconds
) {

  return new Promise(
    resolve =>
      setTimeout(
        resolve,
        milliseconds
      )
  );

}


function isRetryableAppsScriptStatus_(
  status
) {

  return [
    404,
    408,
    425,
    429,
    500,
    502,
    503,
    504
  ].includes(
    Number(
      status
    )
  );

}


function looksLikeAppsScriptHtml_(
  text,
  contentType
) {

  const normalizedContentType =
    String(
      contentType ||
      ''
    ).toLowerCase();


  const normalizedText =
    String(
      text ||
      ''
    ).trim();


  return (
    normalizedContentType.includes(
      'text/html'
    )
    ||
    /^<!doctype\s+html/i.test(
      normalizedText
    )
    ||
    /^<html/i.test(
      normalizedText
    )
  );

}


async function postAppsScriptJson(
  payload,
  label
) {
  const startedAt = Date.now();
  try {
    return await postAppsScriptJsonWithRetry_(payload, label);
  } finally {
    console.log(
      '[TIMING] Apps Script POST:',
      JSON.stringify({ label, elapsedMs: Date.now() - startedAt })
    );
  }
}

async function postAppsScriptJsonWithRetry_(
  payload,
  label
) {

  let lastError =
    null;


  for (
    let attempt = 1;
    attempt <= APPS_SCRIPT_MAX_ATTEMPTS;
    attempt++
  ) {

    const delayMs =
      Number(
        APPS_SCRIPT_RETRY_DELAYS_MS[
          attempt - 1
        ] ||
        0
      );


    if (
      delayMs > 0
    ) {

      console.warn(
        `[${label}] retry wait:`,
        delayMs,
        'ms'
      );


      await sleep_(
        delayMs
      );

    }


    console.log(
      `[${label}] Attempt:`,
      `${attempt}/${APPS_SCRIPT_MAX_ATTEMPTS}`
    );


    let response;


    try {

      response =
        await fetch(
          INGEST_URL,
          {

            method:
              'POST',
            signal: AbortSignal.timeout(payload.action === 'runMarketValuation' ? 390000 : 90000),

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

    } catch (error) {

      lastError =
        new Error(
          `${label}通信失敗: ${
            error &&
            error.message
              ? error.message
              : String(error)
          }`
        );


      console.error(
        `[${label}] fetch error:`,
        lastError.message
      );


      if (
        attempt <
        APPS_SCRIPT_MAX_ATTEMPTS
      ) {

        console.warn(
          `[${label}] 一時通信失敗として再試行します`
        );


        continue;

      }


      throw lastError;

    }


    const text =
      await response.text();


    const contentType =
      response.headers.get(
        'content-type'
      ) || '';


    console.log(
      `[${label}] HTTP:`,
      response.status
    );


    console.log(
      `[${label}] Final URL:`,
      String(response.url || '').split('?')[0]
    );


    console.log(
      `[${label}] Content-Type:`,
      contentType
    );


    if (
      !response.ok
    ) {

      console.log(
        `[${label}] Response head:`,
        text.slice(
          0,
          1200
        )
      );


      lastError =
        new Error(
          `${label} HTTP失敗: ${response.status}`
        );


      if (
        isRetryableAppsScriptStatus_(
          response.status
        )
        &&
        attempt <
        APPS_SCRIPT_MAX_ATTEMPTS
      ) {

        console.warn(
          `[${label}] HTTP ${response.status} を一時エラーとして再試行します`
        );


        continue;

      }


      throw lastError;

    }


    let result;


    try {

      result =
        JSON.parse(
          text
        );

    } catch (error) {

      console.log(
        `[${label}] Response head:`,
        text.slice(
          0,
          1200
        )
      );


      lastError =
        new Error(
          `${label}応答がJSONではありません`
        );


      const retryableBody =
        looksLikeAppsScriptHtml_(
          text,
          contentType
        )
        ||
        !String(
          contentType ||
          ''
        )
          .toLowerCase()
          .includes(
            'json'
          );


      if (
        retryableBody
        &&
        attempt <
        APPS_SCRIPT_MAX_ATTEMPTS
      ) {

        console.warn(
          `[${label}] HTML/非JSON応答を一時エラーとして再試行します`
        );


        continue;

      }


      throw lastError;

    }


    if (
      result.ok !== true
    ) {

      lastError = new Error(
        `${label}側エラー: ${JSON.stringify(result)}`
      );

      if (
        shouldRetryAppsScriptResult_(
          result,
          attempt,
          APPS_SCRIPT_MAX_ATTEMPTS
        )
      ) {

        console.warn(
          `[${label}] Apps Scriptのwrite lock競合を一時エラーとして再試行します`
        );

        continue;

      }

      throw lastError;

    }


    if (
      attempt > 1
    ) {

      console.log(
        `[${label}] ✅ retry success on attempt ${attempt}`
      );

    }


    return result;

  }


  throw (
    lastError ||
    new Error(
      `${label} Apps Script通信に失敗しました`
    )
  );

}


// ============================================================
// 市場監視設定取得
//
// 「市場監視設定」で
// ONになっているMercari条件だけ取得する。
// ============================================================

async function getMercariConfigs() {

  console.log(
    '=============================='
  );


  console.log(
    'Mercari 市場監視設定を取得'
  );


  const result =
    await postAppsScriptJson(
      {

        secret:
          INGEST_SECRET,

        action:
          'getConfig',

        market:
          MARKET

      },

      'Config'
    );


  const configs =
    Array.isArray(
      result.configs
    )
      ? result.configs
      : [];


  const validConfigs =
    [];


  for (
    const config
    of configs
  ) {

    if (
      !config ||
      config.market !== MARKET
    ) {

      console.log(
        '⚠️ Mercari以外の設定をスキップ:',
        config &&
        config.conditionId
          ? config.conditionId
          : 'UNKNOWN'
      );


      continue;

    }


    if (
      !config.conditionId ||
      !config.searchUrl
    ) {

      throw new Error(
        '市場監視設定が不正です: ' +
        JSON.stringify(
          config
        )
      );

    }


    validConfigs.push(
      {
        ...config,
        scanOffset: Number.isInteger(Number(config.scanOffset))
          ? Math.max(0, Number(config.scanOffset))
          : defaultScanOffset_(MARKET)
      }
    );


    console.log(
      '------------------------------'
    );


    console.log(
      `[${validConfigs.length}]`,
      config.conditionId,
      config.searchName || ''
    );


    console.log(
      '監視頻度:',
      config.intervalMinutes,
      '分'
    );


    console.log(
      '検索URL:',
      config.searchUrl
    );

  }


  console.log(
    'Mercari ON条件:',
    validConfigs.length,
    '件'
  );


  return validConfigs;

}


// ============================================================
// Mercari URL → 商品ID
// ============================================================

function parseMercariUrl(
  href
) {

  try {

    const url =
      new URL(
        href,
        'https://jp.mercari.com'
      );


    // ========================================================
    // 通常商品
    // ========================================================

    const normal =
      url.pathname.match(
        /^\/item\/(m\d+)/i
      );


    if (
      normal
    ) {

      return {

        itemId:
          normal[1],

        url:
          `https://jp.mercari.com/item/${normal[1]}`

      };

    }


    // ========================================================
    // Mercari Shops
    // ========================================================

    const shop =
      url.pathname.match(
        /^\/shops\/product\/([A-Za-z0-9_-]+)/i
      );


    if (
      shop
    ) {

      return {

        itemId:
          `shops:${shop[1]}`,

        url:
          `https://jp.mercari.com/shops/product/${shop[1]}`

      };

    }


    return null;


  } catch (error) {

    return null;

  }

}


// ============================================================
// 地域確認などが出た場合だけ押す
// ============================================================

async function dismissRegionGate(
  page
) {

  const patterns = [

    /日本の商品を見る/i,

    /日本で続行/i,

    /日本で見る/i,

    /^続ける$/i,

    /^Continue$/i

  ];


  for (
    const pattern
    of patterns
  ) {

    try {

      const button =
        page
          .getByRole(
            'button',
            {
              name:
                pattern
            }
          )
          .first();


      if (
        await button.isVisible({
          timeout:
            700
        })
      ) {

        await button.click();


        await page.waitForTimeout(
          1500
        );


        console.log(
          '地域確認を処理しました'
        );


        return;

      }

    } catch (error) {

      // ボタンがなければ無視

    }

  }

}


// ============================================================
// 商品が読み込まれるまで軽くスクロール
// ============================================================

async function loadListings(
  page,
  targetCount
) {

  const MIN_SCROLLS = 6;
  const MAX_SCROLLS = 180;
  let scrolls = 0;
  let stableAtBottom = 0;
  let reachedBottom = false;
  let loadedCount = 0;

  while (scrolls < MAX_SCROLLS) {
    const before = await page.evaluate(() => ({
      count: document.querySelectorAll(
        'a[href*="/item/m"], a[href*="/shops/product/"]'
      ).length,
      y: window.scrollY,
      height: document.documentElement.scrollHeight,
      viewport: window.innerHeight
    }));

    loadedCount = before.count;
    if (scrolls >= MIN_SCROLLS && loadedCount >= targetCount) break;

    await page.evaluate(() => {
      window.scrollBy(0, window.innerHeight * 1.5);
    });
    await page.waitForTimeout(500);
    scrolls++;

    const after = await page.evaluate(() => ({
      count: document.querySelectorAll(
        'a[href*="/item/m"], a[href*="/shops/product/"]'
      ).length,
      y: window.scrollY,
      height: document.documentElement.scrollHeight,
      viewport: window.innerHeight
    }));
    loadedCount = after.count;

    if (scrolls >= MIN_SCROLLS && loadedCount >= targetCount) break;

    const atBottom = after.y + after.viewport >= after.height - 20;
    if (atBottom && after.count <= before.count) {
      stableAtBottom++;
    } else {
      stableAtBottom = 0;
    }

    if (stableAtBottom >= 3) {
      reachedBottom = true;
      break;
    }
  }


  await page.evaluate(
    () => {

      window.scrollTo(
        0,
        0
      );

    }
  );

  if (loadedCount < targetCount && !reachedBottom) {
    throw new Error(
      `Mercariの続き位置まで読み込めませんでした: ${loadedCount}/${targetCount}件`
    );
  }

  return { loadedCount, reachedBottom, scrolls, targetCount };

}


// ============================================================
// Mercari商品抽出
// ============================================================

async function extractMercariItems(
  page
) {

  const extracted =
    await page.evaluate(
      () => {

        const yenRegex =
          /[¥￥]\s*([\d,]+)/;


        const anchors =
          Array.from(
            document.querySelectorAll(
              'a[href*="/item/m"], a[href*="/shops/product/"]'
            )
          );


        const results =
          [];

        const rawItemIds = [];

        const seenRawItemIds = new Set();


        for (
          const anchor
          of anchors
        ) {

          const href =
            anchor.href ||
            anchor.getAttribute(
              'href'
            ) ||
            '';


          if (
            !href
          ) {

            continue;

          }

          let itemId = '';
          try {
            const pathname = new URL(href, location.origin).pathname;
            const normal = pathname.match(/^\/item\/(m\d+)/i);
            const shop = pathname.match(/^\/shops\/product\/([A-Za-z0-9_-]+)/i);
            itemId = normal ? normal[1] : shop ? `shops:${shop[1]}` : '';
          } catch (error) {
            itemId = '';
          }

          if (!itemId) continue;
          if (!seenRawItemIds.has(itemId)) {
            seenRawItemIds.add(itemId);
            rawItemIds.push(itemId);
          }


          // ==================================================
          // 商品カード全体っぽい親要素を探す
          // ==================================================

          let node =
            anchor;


          let cardText =
            '';


          for (
            let depth = 0;
            depth < 7 &&
            node;
            depth++
          ) {

            const text =
              String(
                node.innerText ||
                ''
              )
                .replace(
                  /\s+/g,
                  ' '
                )
                .trim();


            if (
              yenRegex.test(
                text
              )
              &&
              text.length < 1000
            ) {

              cardText =
                text;


              break;

            }


            node =
              node.parentElement;

          }


          const priceMatch =
            cardText.match(
              yenRegex
            );


          if (
            !priceMatch
          ) {

            continue;

          }


          const price =
            Number(
              priceMatch[1]
                .replace(
                  /,/g,
                  ''
                )
            );


          if (
            !price
          ) {

            continue;

          }


          // ==================================================
          // タイトル取得
          // ==================================================

          let title =
            String(
              anchor.getAttribute(
                'aria-label'
              ) ||
              ''
            )
              .trim();


          if (
            !title
          ) {

            const image =
              anchor.querySelector(
                'img'
              );


            if (
              image
            ) {

              title =
                String(
                  image.getAttribute(
                    'alt'
                  ) ||
                  ''
                )
                  .trim();

            }

          }


          if (
            !title
          ) {

            title =
              String(
                anchor.innerText ||
                ''
              )
                .replace(
                  /[¥￥]\s*[\d,]+/g,
                  ' '
                )
                .replace(
                  /\s+/g,
                  ' '
                )
                .trim();

          }


          if (
            !title &&
            cardText
          ) {

            title =
              cardText
                .replace(
                  /[¥￥]\s*[\d,]+/g,
                  ' '
                )
                .replace(
                  /\s+/g,
                  ' '
                )
                .trim();

          }


          if (
            !title
          ) {

            continue;

          }


          results.push({

            itemId,

            href,

            title,

            price

          });

        }


        return {
          items: results,
          rawItemIds
        };

      }
    );


  // ========================================================
  // DOM内で同一商品URLが複数あっても1件にする
  // ========================================================

  const map =
    new Map();


  for (
    const row
    of extracted.items
  ) {

    const parsed =
      parseMercariUrl(
        row.href
      );


    if (
      !parsed
    ) {

      continue;

    }


    const existing =
      map.get(
        parsed.itemId
      );


    if (
      !existing
    ) {

      map.set(
        parsed.itemId,
        {

          itemId:
            parsed.itemId,

          url:
            parsed.url,

          title:
            row.title,

          price:
            row.price

        }
      );

    } else {


      // ====================================================
      // タイトル候補が複数ある場合
      // 長い方を優先
      // ====================================================

      if (
        row.title.length >
        existing.title.length
      ) {

        existing.title =
          row.title;

      }


      if (
        row.price
      ) {

        existing.price =
          row.price;

      }

    }

  }


  return {
    items: Array.from(map.values()),
    rawItemIds: extracted.rawItemIds
  };

}


// ============================================================
// Apps Scriptへ商品送信
// ============================================================

async function sendToAppsScript(
  items,
  conditionId
) {

  return postAppsScriptJson(
    {

      secret:
        INGEST_SECRET,

      market:
        MARKET,

      conditionId:
        conditionId,

      includeMarketCompsTargets: !FAST_MODE,
      includeTrackedYahoo: !FAST_MODE,
      items:
        items

    },

    `Ingest ${conditionId}`
  );

}

async function acknowledgeMarketScanCursor_(conditionId, nextOffset, lastItemId, headState) {
  return postAppsScriptJson(
    {
      secret: INGEST_SECRET,
      action: 'ackMarketScanCursor',
      market: MARKET,
      conditionId,
      nextOffset,
      lastItemId: String(lastItemId || ''),
      headState
    },
    `Scan cursor ${conditionId}`
  );
}


// ============================================================
// Yahoo Market Comps
//
// market-comps-yahoo-dryrun.js で確認済みの
// 「Yahoo終了180日間」取得方式を monitor.js に統合。
//
// 重要:
// ・新規Mercari商品(insertedItems)だけを対象にする
// ・既存Mercari監視の成否はYahoo相場取得失敗で壊さない
// ・市場監視台帳へ直接書かない
// ・相場比較データへの書込は market-ingest 経由のみ
// ============================================================

function marketCompsPositiveInt_(
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


function normalizeMarketCompsSpace_(
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


function parseMarketCompsYen_(
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


function escapeMarketCompsRegExp_(
  value
) {

  return String(
    value || ''
  ).replace(
    /[.*+?^${}()|[\]\\]/g,
    '\\$&'
  );

}


function firstMarketCompsYenAfter_(
  text,
  label
) {

  const escaped =
    escapeMarketCompsRegExp_(
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
    ? parseMarketCompsYen_(
        match[1]
      )
    : null;

}


function extractMarketCompsResultCount_(
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


function buildYahooClosedSearchUrl_(
  query,
  categoryId
) {

  if (
    !query
  ) {

    throw new Error(
      'Yahoo Market Comps: 検索語が空です'
    );

  }


  if (
    !categoryId
  ) {

    throw new Error(
      'Yahoo Market Comps: categoryIdが空です'
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


async function extractYahooMarketCompsSummary_(
  page
) {

  const body =
    await page
      .locator(
        'body'
      )
      .innerText();


  const text =
    String(
      body || ''
    );


  return {

    minPrice:
      firstMarketCompsYenAfter_(
        text,
        '最安'
      ),

    averagePrice:
      firstMarketCompsYenAfter_(
        text,
        '平均'
      ),

    maxPrice:
      firstMarketCompsYenAfter_(
        text,
        '最高'
      ),

    resultCount:
      extractMarketCompsResultCount_(
        text
      )

  };

}


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

        } catch (error) {

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


          if (
            !node
          ) {

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
        const anchor
        of anchors
      ) {

        if (
          results.length >=
          limit
        ) {

          break;

        }


        const href =
          absoluteUrl(
            anchor.getAttribute(
              'href'
            )
          );


        if (
          !href
        ) {

          continue;

        }


        const idMatch =
          href.match(
            /\/jp\/auction\/([^/?#]+)/
          );


        if (
          !idMatch
        ) {

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


        if (
          !card
        ) {

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


        if (
          !title
        ) {

          continue;

        }


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
          const state
          of stateCandidates
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


function parseYahooMarketCompsEndDate_(
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
    now.getTime() +
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


function normalizeYahooClosedItems_(
  rawItems,
  query,
  categoryId
) {

  return rawItems
    .map(
      item => {

        const soldPrice =
          parseMarketCompsYen_(
            item.soldPriceText
          );


        const endedAt =
          parseYahooMarketCompsEndDate_(
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
            MARKET_COMPS_SOURCE_VERSION,

          query,

          categoryId

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


function buildMarketCompsTarget_(
  insertedItem,
  config
) {

  const itemId =
    String(
      insertedItem &&
      insertedItem.itemId ||
      ''
    ).trim();


  const market =
    String(
      insertedItem &&
      insertedItem.market ||
      MARKET
    ).trim();


  const targetKey =
    String(
      insertedItem &&
      insertedItem.targetKey ||
      ''
    ).trim()
    ||
    [
      market,
      itemId
    ].join(
      '::'
    );


  return {

    targetKey,

    market,

    conditionId:
      String(
        insertedItem &&
        insertedItem.conditionId ||
        config.conditionId ||
        ''
      ).trim(),

    itemId,

    url:
      String(
        insertedItem &&
        insertedItem.url ||
        ''
      ).trim(),

    title:
      String(
        insertedItem &&
        insertedItem.title ||
        ''
      ).trim(),

    dbItemId:
      String(
        insertedItem &&
        insertedItem.dbItemId ||
        ''
      ).trim(),

    brand:
      String(
        insertedItem &&
        insertedItem.brand ||
        ''
      ).trim(),

    category:
      String(
        insertedItem &&
        insertedItem.category ||
        ''
      ).trim(),

    product:
      String(
        insertedItem &&
        insertedItem.product ||
        ''
      ).trim(),

    model:
      String(
        insertedItem &&
        insertedItem.model ||
        ''
      ).trim(),

    searchKeyword:
      String(
        insertedItem &&
        insertedItem.searchKeyword ||
        ''
      ).trim(),

    subCategory:
      String(
        insertedItem &&
        insertedItem.subCategory ||
        ''
      ).trim(),

    lineModel:
      String(
        insertedItem &&
        insertedItem.lineModel ||
        ''
      ).trim(),

    currentPrice:
      Number(
        insertedItem &&
        insertedItem.currentPrice ||
        insertedItem &&
        insertedItem.price ||
        0
      )

  };

}


function compactMarketCompsQueryText_(
  value
) {

  return String(
    value || ''
  )
    .replace(
      /のサムネイル$/i,
      ''
    )
    .replace(
      /[\/／|｜]+/g,
      ' '
    )
    .replace(
      /\s+/g,
      ' '
    )
    .trim();

}


function buildMarketCompsQuery_(
  insertedItem,
  config
) {

  // 商品マスター AA列「検索キーワード」を最優先。
  // config.searchName は監視条件名なので相場検索には使わない。

  const fromMaster =
    compactMarketCompsQueryText_(
      insertedItem &&
      insertedItem.searchKeyword ||
      ''
    );

  if (
    fromMaster
  ) {

    return fromMaster;
  }


  const brand =
    compactMarketCompsQueryText_(
      insertedItem &&
      insertedItem.brand ||
      ''
    );

  const product =
    compactMarketCompsQueryText_(
      insertedItem &&
      insertedItem.product ||
      ''
    );

  const subCategory =
    compactMarketCompsQueryText_(
      insertedItem &&
      insertedItem.subCategory ||
      ''
    );


  const parts =
    [];

  if (brand) {
    parts.push(
      brand
    );
  }

  if (product) {

    parts.push(
      product
    );

  } else if (
    subCategory
  ) {

    parts.push(
      subCategory
    );
  }


  const fromDbMeta =
    compactMarketCompsQueryText_(
      parts.join(
        ' '
      )
    );

  if (
    fromDbMeta
  ) {

    return fromDbMeta;
  }


  return compactMarketCompsQueryText_(
    insertedItem &&
    insertedItem.title ||
    ''
  );

}


function buildMarketCompsCategoryId_(
  insertedItem
) {

  const category =
    compactMarketCompsQueryText_(
      insertedItem &&
      insertedItem.category ||
      ''
    )
      .normalize(
        'NFKC'
      )
      .toUpperCase();

  const product =
    compactMarketCompsQueryText_(
      insertedItem &&
      insertedItem.product ||
      ''
    )
      .normalize(
        'NFKC'
      )
      .toUpperCase();

  const subCategory =
    compactMarketCompsQueryText_(
      insertedItem &&
      insertedItem.subCategory ||
      ''
    )
      .normalize(
        'NFKC'
      )
      .toUpperCase();


  const allText =
    [
      category,
      product,
      subCategory
    ].join(
      ' '
    );


  if (
    /レディース|WOMEN|WOMAN|LADIES/.test(
      allText
    )
  ) {

    return '0';
  }


  if (
    /スラックス/.test(
      product + ' ' + subCategory
    )
  ) {

    return '2084007077';
  }


  if (
    /メンズスーツ/.test(
      category
    )
    ||
    (
      !/レディース/.test(
        category
      )
      &&
      /(?:スーツ|SUIT)/.test(
        product + ' ' + subCategory
      )
    )
  ) {

    return '2084007041';
  }


  if (
    /(?:チェスターコート|ステンカラーコート|トレンチコート|ダッフルコート|ノーカラーコート)/.test(
      product
    )
  ) {

    return '2084007042';
  }


  if (
    /(?:テーラードジャケット|レザージャケット|スウィングトップ|スカジャン|スタジャン|ボンバージャケット|ダウンジャケット)/.test(
      product
    )
  ) {

    return '23196';
  }


  if (
    /(?:ニット|セーター)/.test(
      product
    )
    &&
    !/カーディガン/.test(
      product
    )
  ) {

    return '2084005282';
  }


  return (
    MARKET_COMPS_FALLBACK_CATEGORY_ID ||
    '0'
  );

}


async function runYahooMarketCompsForTarget_(
  page,
  insertedItem,
  config,
  marketCompsCache
) {

  const target =
    buildMarketCompsTarget_(
      insertedItem,
      config
    );


  const query =
    buildMarketCompsQuery_(
      insertedItem,
      config
    );


  const categoryId =
    buildMarketCompsCategoryId_(
      insertedItem
    );


  if (
    !target.itemId ||
    !target.url ||
    !target.title ||
    !target.currentPrice ||
    !target.dbItemId
  ) {

    throw new Error(
      'Yahoo Market Comps: DB同定済み対象の必須情報が不足しています: ' +
      JSON.stringify(
        target
      )
    );

  }


  if (
    !query
  ) {

    throw new Error(
      'Yahoo Market Comps: 検索語を生成できませんでした'
    );

  }


  const searchUrl =
    buildYahooClosedSearchUrl_(
      query,
      categoryId
    );


  console.log(
    '========================================'
  );


  console.log(
    'Yahoo Market Comps START'
  );


  console.log(
    '対象キー:',
    target.targetKey
  );


  console.log(
    '対象商品:',
    target.title
  );


  console.log(
    'DB商品ID:',
    target.dbItemId
  );


  console.log(
    'DBブランド:',
    target.brand
  );


  console.log(
    'DBカテゴリ:',
    target.category
  );


  console.log(
    'DB商品:',
    target.product
  );


  console.log(
    '検索語:',
    query
  );


  console.log(
    'YahooカテゴリID:',
    categoryId
  );


  console.log(
    '検索URL:',
    searchUrl
  );


  const cacheKey = buildMarketCompsCacheKey_(
    target.dbItemId,
    searchUrl
  );
  const cacheResult = await getOrLoadMarketComps_(
    marketCompsCache,
    cacheKey,
    async () => {
      const response = await page.goto(
        searchUrl,
        {
          waitUntil: 'domcontentloaded',
          timeout: MARKET_COMPS_TIMEOUT_MS
        }
      );

      if (!response) {
        throw new Error(
          'Yahoo Market Comps: HTTPレスポンスを取得できませんでした'
        );
      }

      console.log(
        'Yahoo Market Comps HTTP:',
        response.status()
      );

      if (
        response.status() < 200 ||
        response.status() >= 400
      ) {
        throw new Error(
          `Yahoo Market Comps HTTP Error: ${response.status()}`
        );
      }

      await page.waitForSelector(
        'body',
        { timeout: MARKET_COMPS_TIMEOUT_MS }
      );

      await page.waitForTimeout(2500);

      const pageText = normalizeMarketCompsSpace_(
        await page.locator('body').innerText()
      );

      if (
        !pageText.includes('落札') ||
        (
          !pageText.includes('終了180日間') &&
          !pageText.includes('180日間の落札相場')
        )
      ) {
        throw new Error(
          'Yahoo落札相場ページとして確認できませんでした。安全停止します。'
        );
      }

      const summary = await extractYahooMarketCompsSummary_(page);
      const rawItems = await extractYahooClosedItems_(
        page,
        MARKET_COMPS_MAX_ITEMS
      );

      if (rawItems.length === 0) {
        throw new Error(
          '落札済み商品の取得件数が0件でした。DOM変更の可能性があるため安全停止します。'
        );
      }

      const comparisons = normalizeYahooClosedItems_(
        rawItems,
        query,
        categoryId
      );

      if (comparisons.length === 0) {
        throw new Error(
          '正規化後の比較商品が0件です。安全停止します。'
        );
      }

      return { summary, comparisons };
    }
  );

  const summary = cacheResult.value.summary;
  const comparisons = cacheResult.value.comparisons;

  console.log(
    `Yahoo Market Comps cache: ${cacheResult.cacheHit ? 'HIT' : 'MISS'}`,
    target.dbItemId
  );
  console.log(
    'Yahooページ集計:',
    JSON.stringify(summary)
  );
  console.log(
    'Yahoo比較商品:',
    comparisons.length,
    '件'
  );


  const ingestResult =
    await postAppsScriptJson(
      {

        secret:
          INGEST_SECRET,

        action:
          'upsertMarketComps',

        source:
          'Yahoo closedsearch',

        sourceVersion:
          MARKET_COMPS_SOURCE_VERSION,

        query,

        categoryId,

        target,

        comparisons

      },

      `MarketComps ${target.itemId}`
    );


  if (
    ingestResult.action !==
    'upsertMarketComps'
  ) {

    throw new Error(
      'market-ingest response action が不正です'
    );

  }


  console.log(
    '✅ Yahoo Market Comps SUCCESS',
    target.itemId,
    'received=',
    ingestResult.received,
    'inserted=',
    ingestResult.inserted,
    'updated=',
    ingestResult.updated,
    'skipped=',
    ingestResult.skipped
  );


  return ingestResult;

}


async function runYahooMarketCompsForInsertedItems_(
  page,
  insertedItems,
  config,
  marketCompsCache
) {

  if (
    !Array.isArray(
      insertedItems
    )
    ||
    insertedItems.length === 0
  ) {

    console.log(
      'Yahoo Market Comps: 新規0件のためスキップ'
    );


    return {
      attempted: 0,
      succeeded: 0,
      failed: 0
    };

  }


  console.log(
    '========================================'
  );


  console.log(
    'Yahoo Market Comps対象:',
    insertedItems.length,
    '件'
  );


  let succeeded =
    0;


  let failed =
    0;


  for (
    let i = 0;
    i < insertedItems.length;
    i++
  ) {

    const insertedItem =
      insertedItems[i];


    try {

      console.log(
        `[Market Comps ${i + 1}/${insertedItems.length}]`,
        insertedItem &&
        insertedItem.itemId
          ? insertedItem.itemId
          : 'UNKNOWN'
      );


      await runYahooMarketCompsForTarget_(
        page,
        insertedItem,
        config,
        marketCompsCache
      );


      succeeded++;

    } catch (error) {

      failed++;


      console.error(
        '⚠️ Yahoo Market Comps失敗:',
        insertedItem &&
        insertedItem.itemId
          ? insertedItem.itemId
          : 'UNKNOWN'
      );


      console.error(
        error &&
        error.stack
          ? error.stack
          : error
      );


      // 既存Mercari監視を壊さないため、
      // 比較取得失敗はこの商品だけで止める。
      // 次の商品・次条件のMercari監視は継続する。

    }

  }


  console.log(
    'Yahoo Market Comps結果:',
    'attempted=',
    insertedItems.length,
    'succeeded=',
    succeeded,
    'failed=',
    failed
  );


  return {
    attempted:
      insertedItems.length,
    succeeded,
    failed
  };

}


// ============================================================
// 1条件分のMercari検索
// ============================================================

async function scanMercariCondition(
  page,
  config,
  marketCompsCache
) {

  console.log(
    '=============================='
  );


  console.log(
    '条件:',
    config.conditionId,
    config.searchName || ''
  );


  console.log(
    'Mercari検索ページを開きます'
  );

  // シートURLのstatus設定に依存せず、仕入れ監視は販売中に固定する。
  const activeSearchUrl =
    enforceMercariActiveSearchUrl_(config.searchUrl);

  console.log(
    'Mercari販売中フィルター: status=on_sale'
  );


  await page.goto(
    activeSearchUrl,
    {

      waitUntil:
        'domcontentloaded',

      timeout:
        60000

    }
  );


  await dismissRegionGate(
    page
  );


  await page.waitForTimeout(
    2500
  );


  const scanOffset = Number.isInteger(Number(config.scanOffset))
    ? Math.max(0, Number(config.scanOffset))
    : defaultScanOffset_(MARKET);
  const lastItemId = String(config.lastItemId || '').trim();
  const targetCount = Math.max(
    lastItemId ? scanOffset + MAX_SEARCH_ITEMS + CURSOR_LOOKAHEAD_ITEMS : MAX_SEARCH_ITEMS,
    Number(config.headState && config.headState.offset || 0) + 2 * MAX_SEARCH_ITEMS
  );

  const listingLoadStartedAt = Date.now();
  const listingLoadStats = await loadListings(
    page,
    targetCount
  );
  console.log(
    '[TIMING] Mercari DOM load:',
    JSON.stringify({
      conditionId: config.conditionId,
      elapsedMs: Date.now() - listingLoadStartedAt,
      targetCount,
      loadedCount: listingLoadStats.loadedCount,
      scrolls: listingLoadStats.scrolls,
      reachedBottom: listingLoadStats.reachedBottom
    })
  );


  const extracted =
    await extractMercariItems(
      page
    );

  const itemById = new Map(
    extracted.items.map(item => [item.itemId, item])
  );
  const rawItemIds = extracted.rawItemIds;

  const batch = selectCursorBatch_(
    rawItemIds,
    lastItemId,
    scanOffset,
    MAX_SEARCH_ITEMS
  );

  const headGap = selectMercariHeadGap_(rawItemIds, config.headState || {}, listingLoadStats.reachedBottom);
  const headItems = headGap.headIds
    .map(itemId => itemById.get(itemId))
    .filter(Boolean);
  const continuationItems = batch.items
    .map(itemId => itemById.get(itemId))
    .filter(Boolean);
  const gapItems = headGap.gapIds.map(id => itemById.get(id)).filter(Boolean);
  const items = mergeUniqueItemsById_(headItems, gapItems, continuationItems);


  console.log(
    '取得商品数:',
    items.length
  );
  console.log(
    'Mercariカーソル:',
    JSON.stringify({
      mode: batch.mode,
      storedOffset: scanOffset,
      startOffset: batch.startOffset,
      lastItemId: lastItemId || '',
      rawRowsAvailable: rawItemIds.length,
      headItems: headItems.length,
      newGapItems: gapItems.length,
      pendingHeadGap: headGap.state.snapshotIds.length > 0,
      continuationItems: continuationItems.length
    })
  );


  for (
    const item
    of items
  ) {

    console.log(
      item.itemId,
      item.price,
      item.title
    );

  }


  if (!rawItemIds.length) {

    throw new Error(
      config.conditionId +
      ' 商品を1件も取得できませんでした'
    );

  }


  const result =
    await sendToAppsScript(
      items,
      config.conditionId
    );

  await acknowledgeMarketScanCursor_(
    config.conditionId,
    batch.nextOffset === null
      ? defaultScanOffset_(MARKET)
      : batch.nextOffset,
    batch.items.length
      ? batch.items[batch.items.length - 1]
      : '',
    headGap.state
  );


  console.log(
    '------------------------------'
  );


  console.log(
    '条件ID:',
    config.conditionId
  );


  console.log(
    '受信件数:',
    result.received
  );


  console.log(
    '新規:',
    result.inserted
  );


  console.log(
    '更新:',
    result.updated
  );


  // ========================================================
  // 今後のMarket Comps接続用
  //
  // Apps ScriptがinsertedItemsを返せる場合だけ
  // 新規商品ID一覧をログへ出す。
  // ========================================================

  const insertedItems =
    Array.isArray(
      result.insertedItems
    )
      ? result.insertedItems
      : [];


  console.log(
    'insertedItems件数:',
    insertedItems.length
  );


  console.log(
    'insertedItems:',
    JSON.stringify(
      insertedItems
    )
  );


  // ========================================================
  // DB同定済みMarket Comps対象だけYahooへ流す
  // ========================================================

  const marketCompsStartedAt = Date.now();
  const marketCompsResult = FAST_MODE ? { attempted: 0, succeeded: 0, failed: 0 } : await runYahooMarketCompsForInsertedItems_(
    page,
    insertedItems,
    config,
    marketCompsCache
  );
  console.log(
    '[TIMING] Market Comps batch:',
    JSON.stringify({
      conditionId: config.conditionId,
      elapsedMs: Date.now() - marketCompsStartedAt,
      attempted: marketCompsResult.attempted,
      succeeded: marketCompsResult.succeeded,
      failed: marketCompsResult.failed
    })
  );


  // ========================================================
  // 既存Yahoo追跡レスポンスがある場合は件数だけ表示
  //
  // 大量JSONをログへ丸ごと出さない。
  // ========================================================

  if (
    Array.isArray(
      result.trackedYahoo
    )
  ) {

    console.log(
      'trackedYahoo件数:',
      result.trackedYahoo.length
    );

  }


  return result;

}


// ============================================================
// メイン
// ============================================================

async function main() {

  console.log(
    '=============================='
  );


  console.log(
    'Market Monitor OS START'
  );


  console.log(
    '市場:',
    MARKET
  );


  // ========================================================
  // 市場監視設定からMercariのON条件を取得
  // ========================================================

  if (FAST_MODE) {
    const capability = await postAppsScriptJson({ secret: INGEST_SECRET, action: 'getMonitorCapabilities' }, 'Capabilities');
    if (capability.version !== 'MONITOR_PRIORITY_V1_20261003') throw new Error('Deploy MONITOR_PRIORITY_V1_20261003 before fast monitoring');
  }
  const configs = selectConditionShard_(await getMercariConfigs());
  const budgetStartedAt = Date.now();
  let deferredConditions = 0;


  if (
    configs.length === 0
  ) {

    console.log(
      '=============================='
    );


    console.log(
      'MercariのON監視条件が0件のため終了します'
    );


    return;

  }


  // ========================================================
  // Chromium
  // ========================================================

  const browser =
    await chromium.launch(
      {

        headless:
          true,

        args: [

          '--no-sandbox',

          '--disable-dev-shm-usage'

        ]

      }
    );


  const context =
    await browser.newContext(
      {

        locale:
          'ja-JP',

        timezoneId:
          'Asia/Tokyo',

        viewport: {

          width:
            1440,

          height:
            1200

        },

        userAgent:
          'Mozilla/5.0 (X11; Linux x86_64) ' +
          'AppleWebKit/537.36 (KHTML, like Gecko) ' +
          'Chrome/140.0.0.0 Safari/537.36',

        extraHTTPHeaders: {

          'Accept-Language':
            'ja-JP,ja;q=0.9,en;q=0.8'

        }

      }
    );


  const page =
    await context.newPage();

  const marketCompsCache = new Map();


  try {

    // ======================================================
    // ON条件を順番に監視
    //
    // 1条件が最大3回のApps Script再送でも失敗した場合、
    // その条件だけ失敗として記録して次条件へ進む。
    // ======================================================

    let succeededConditions =
      0;


    const failedConditions =
      [];

    // Record condition attempts locally and acknowledge them once per shard.
    // This fairness signal must never block product scanning/persistence.
    const conditionAttemptBatch =
      createConditionAttemptBatch_();


    for (
      let i = 0;
      i < configs.length;
      i++
    ) {

      if (FAST_MODE && Date.now() - budgetStartedAt > 16 * 60000) {
        deferredConditions = configs.length - i;
        console.warn('MONITOR_BUDGET_DEFERRED:', deferredConditions, 'conditions; saved cursors preserved');
        break;
      }
      const config =
        configs[i];


      console.log(
        '=============================='
      );


      console.log(
        `[条件 ${i + 1}/${configs.length}]`,
        config.conditionId,
        config.searchName || ''
      );


      if (FAST_MODE) {
        recordConditionAttempt_(
          conditionAttemptBatch,
          config.conditionId,
          Date.now()
        );
      }

      try {

        await scanMercariCondition(
          page,
          config,
          marketCompsCache
        );


        succeededConditions++;

      } catch (error) {

        const errorMessage =
          error && error.message
            ? error.message
            : String(error);

        const appsScriptTransientDeferred =
          (
            errorMessage.startsWith('Ingest ') ||
            errorMessage.startsWith('Scan cursor ')
          ) &&
          (
            errorMessage.includes('"error":"busy"') ||
            /HTTP失敗: (404|408|425|429|500|502|503|504)\b/.test(errorMessage) ||
            errorMessage.includes('応答がJSONではありません') ||
            errorMessage.includes('通信失敗:')
          );

        if (appsScriptTransientDeferred) {
          deferredConditions++;
          console.warn(
            '⚠️ Apps Script一時障害。カーソルを進めず次回再走査へ:',
            JSON.stringify({
              conditionId: config.conditionId || 'UNKNOWN',
              searchName: config.searchName || '',
              error: errorMessage
            })
          );
        } else {
          const failure = {

            conditionId:
              config.conditionId ||
              'UNKNOWN',

            searchName:
              config.searchName ||
              '',

            error:
              errorMessage

          };


          failedConditions.push(
            failure
          );


          console.error(
            '⚠️ 条件監視失敗。次の条件へ継続します:',
            JSON.stringify(
              failure
            )
          );


          console.error(
            error &&
            error.stack
              ? error.stack
              : error
          );
        }

      }


      await page.waitForTimeout(
        800
      );

    }


    if (
      FAST_MODE &&
      conditionAttemptBatch.size > 0
    ) {
      const conditionAttemptBatchStartedAt = Date.now();
      try {
        const payload =
          buildConditionAttemptBatchPayload_(
            conditionAttemptBatch,
            INGEST_SECRET
          );

        await postAppsScriptJson(
          payload,
          'Condition attempt batch'
        );

        console.log(
          '[TIMING] Condition attempt batch:',
          JSON.stringify({
            count: payload.attempts.length,
            postCount: 1,
            elapsedMs: Date.now() - conditionAttemptBatchStartedAt
          })
        );
      } catch (error) {
        // Fairness information may lag if Apps Script is busy, but product
        // acquisition/persistence must remain unaffected.
        console.warn(
          '⚠️ Condition attempt batch送信失敗。公平性情報のみ次回へ繰越:',
          JSON.stringify({
            count: conditionAttemptBatch.size,
            error: error && error.message
              ? error.message
              : String(error)
          })
        );
      }
    }


    console.log(
      '=============================='
    );


    console.log(
      'Mercari監視結果:',
      'total=',
      configs.length,
      'succeeded=',
      succeededConditions,
      'failed=',
      failedConditions.length
    );


    if (
      failedConditions.length > 0
    ) {

      console.warn(
        '失敗条件一覧:',
        JSON.stringify(
          failedConditions
        )
      );

    }


    const preservedEmptyConditions = failedConditions.filter(
      failure => failure && failure.error === 'Mercari feed is empty; preserve saved state'
    );
    const fatalFailedConditions = failedConditions.filter(
      failure => !failure || failure.error !== 'Mercari feed is empty; preserve saved state'
    );

    if (preservedEmptyConditions.length > 0) {
      console.warn(
        'Mercari空結果(状態維持・非致命):',
        preservedEmptyConditions.length
      );
    }

    if (FAST_MODE && succeededConditions > 0) {
      await postAppsScriptJson({ secret: INGEST_SECRET, action: 'runProcurementNotifications', markets: [MARKET] }, 'Procurement notifications');
    }
    if (FAST_MODE && fatalFailedConditions.length) throw new Error(`Mercari failed conditions: ${fatalFailedConditions.length}; cursors preserved`);
    console.log('MONITOR_SHARD_SUMMARY:', JSON.stringify({
      conditions: configs.length,
      succeeded: succeededConditions,
      failed: fatalFailedConditions.length,
      preservedEmpty: preservedEmptyConditions.length,
      deferred: deferredConditions
    }));
    if (
      succeededConditions === 0
      &&
      fatalFailedConditions.length > 0
    ) {

      throw new Error(
        '全監視条件が失敗しました: ' +
        JSON.stringify(
          fatalFailedConditions
        )
      );

    }


    if (
      failedConditions.length > 0
    ) {

      console.log(
        '⚠️ Mercari Config Discovery + Monitor PARTIAL SUCCESS'
      );

    } else {

      console.log(
        '✅ Mercari Config Discovery + Monitor SUCCESS'
      );

    }


    console.log(
      '=============================='
    );


  } finally {

    await page.close();


    await context.close();


    await browser.close();

  }

}


// ============================================================
// 実行
// ============================================================

if (require.main === module) main()
  .catch(
    error => {

      console.error(
        'MONITOR ERROR'
      );


      console.error(
        error
      );


      process.exit(
        1
      );

    }
  );


module.exports = { postAppsScriptJson, runYahooMarketCompsForTarget_, scanMercariCondition };
