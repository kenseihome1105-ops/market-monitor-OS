const { chromium } = require('playwright');
const {
  defaultScanOffset_,
  buildYahooScanUrl_,
  rebaseYahooScanOffset_,
  normalizeYahooContinuationResult_,
  nextYahooScanOffset_,
  mergeUniqueItemsById_,
  runConditionsIndependently_
} = require('./market-scan-cursor');

const MARKET_INGEST_URL = process.env.MARKET_INGEST_URL;
const MARKET_INGEST_SECRET = process.env.MARKET_INGEST_SECRET;

const MARKET = 'ヤフオク';

const MAX_SEARCH_ITEMS = 10;
const MAX_TRACKED_ITEMS = 30;


// ============================================================
// 共通
// ============================================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


// ============================================================
// Apps Script 通信リトライ
//
// Google Apps Script ContentService が一時的に
// HTML / 非JSON / 404 / 5xx / 通信エラーを返した場合でも、
// 監視全体を即終了させず、新しいPOSTで最大5回まで再試行する。
//
// ※ unauthorized / invalid market 等の通常のJSONエラーは再試行しない。
//    Apps Scriptのwrite lock競合(busy)のみ一時エラーとして再試行する。
// ============================================================

const APPS_SCRIPT_MAX_ATTEMPTS = 5;

const APPS_SCRIPT_RETRY_DELAYS_MS = [
  0,
  2500,
  6000,
  12000,
  20000
];

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
  const normalizedContentType =
    String(contentType || '').toLowerCase();

  const normalizedText =
    String(text || '').trim();

  return (
    normalizedContentType.includes('text/html') ||
    /^<!doctype\s+html/i.test(normalizedText) ||
    /^<html/i.test(normalizedText)
  );
}

async function postAppsScriptJson_(payload, label) {
  let lastError = null;

  for (
    let attempt = 1;
    attempt <= APPS_SCRIPT_MAX_ATTEMPTS;
    attempt++
  ) {
    const delayMs =
      Number(
        APPS_SCRIPT_RETRY_DELAYS_MS[attempt - 1] ||
        0
      );

    if (delayMs > 0) {
      console.warn(
        `[${label}] retry wait:`,
        delayMs,
        'ms'
      );

      await sleep(delayMs);
    }

    console.log(
      `[${label}] Attempt:`,
      `${attempt}/${APPS_SCRIPT_MAX_ATTEMPTS}`
    );

    let response;

    try {
      response = await fetch(
        MARKET_INGEST_URL,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload),
          redirect: 'follow'
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
    const contentType =
      response.headers.get('content-type') || '';

    console.log(`[${label}] HTTP:`, response.status);
    console.log(`[${label}] Final URL:`, response.url);
    console.log(`[${label}] Content-Type:`, contentType);

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
      console.log(
        `[${label}] Response head:`,
        text.slice(0, 1200)
      );

      lastError = new Error(
        `${label}応答がJSONではありません`
      );

      const retryableBody =
        looksLikeAppsScriptHtml_(text, contentType) ||
        !String(contentType || '')
          .toLowerCase()
          .includes('json');

      if (
        retryableBody &&
        attempt < APPS_SCRIPT_MAX_ATTEMPTS
      ) {
        console.warn(
          `[${label}] HTML/非JSON応答を一時エラーとして再試行します`
        );
        continue;
      }

      throw lastError;
    }

    if (result.ok !== true) {
      const errorText = JSON.stringify(result);
      lastError = new Error(`${label}側エラー: ${errorText}`);

      if (
        result.error === 'busy' &&
        attempt < APPS_SCRIPT_MAX_ATTEMPTS
      ) {
        console.warn(
          `[${label}] Apps Scriptのwrite lock競合を一時エラーとして再試行します`
        );
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
// Apps Script送信
// ============================================================

async function sendToAppsScript(items, conditionId) {

  if (!MARKET_INGEST_URL) {
    throw new Error('MARKET_INGEST_URL が設定されていません');
  }

  if (!MARKET_INGEST_SECRET) {
    throw new Error('MARKET_INGEST_SECRET が設定されていません');
  }

  return postAppsScriptJson_(
    {
      secret: MARKET_INGEST_SECRET,
      market: MARKET,
      conditionId,
      items
    },
    `Ingest ${conditionId}`
  );
}

async function acknowledgeMarketScanCursor_(conditionId, nextOffset, lastItemId) {
  return postAppsScriptJson_(
    {
      secret: MARKET_INGEST_SECRET,
      action: 'ackMarketScanCursor',
      market: MARKET,
      conditionId,
      nextOffset,
      lastItemId: String(lastItemId || '')
    },
    `Scan cursor ${conditionId}`
  );
}


// ============================================================
// 市場監視設定取得
//
// market-ingest の getConfig を使用し、
// 「市場監視設定」で ON のYahoo条件だけ取得する。
//
// 検索URL / 条件IDはコードへ固定しない。
// ============================================================

async function getYahooConfigs() {

  if (!MARKET_INGEST_URL) {
    throw new Error(
      'MARKET_INGEST_URL が設定されていません'
    );
  }

  if (!MARKET_INGEST_SECRET) {
    throw new Error(
      'MARKET_INGEST_SECRET が設定されていません'
    );
  }


  console.log(
    '=============================='
  );

  console.log(
    '市場監視設定を取得'
  );


  const result =
    await postAppsScriptJson_(
      {
        secret:
          MARKET_INGEST_SECRET,

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


  const validConfigs = [];


  for (
    let i = 0;
    i < configs.length;
    i++
  ) {

    const config =
      configs[i];


    if (
      !config ||
      config.market !== MARKET
    ) {

      console.log(
        '⚠️ Yahoo以外の設定をスキップ:',
        config && config.conditionId
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
        JSON.stringify(config)
      );

    }


    validConfigs.push(
      {
        ...config,
        scanOffset: Number.isInteger(Number(config.scanOffset))
          ? Math.max(1, Number(config.scanOffset))
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
    'Yahoo ON条件:',
    validConfigs.length,
    '件'
  );


  return validConfigs;

}


// ============================================================
// Yahoo検索結果
//
// 役割:
// 終了時間が近い出品を優先し、各条件の先頭と継続位置を走査する。
//
// Yahoo検索側が一時的に取得不能でも
// 既存商品の詳細追跡は止めない。
// ============================================================

async function scanYahooSearch(
  page,
  config,
  requestedOffset
) {

  const conditionId =
    config.conditionId;

  const searchName =
    config.searchName || '';

  const searchUrl =
    config.searchUrl;

  const scanOffset = Number.isInteger(Number(requestedOffset))
    ? Math.max(1, Number(requestedOffset))
    : Number.isInteger(Number(config.scanOffset))
      ? Math.max(1, Number(config.scanOffset))
      : defaultScanOffset_(MARKET);
  const pagedSearchUrl = buildYahooScanUrl_(
    searchUrl,
    scanOffset,
    MAX_SEARCH_ITEMS
  );


  console.log(
    '=============================='
  );

  console.log(
    '条件:',
    conditionId,
    searchName
  );

  console.log(
    '① Yahoo終了時間が近い順検索'
  );


  let cardFound = false;
  let everyAttemptWasSuccessfulEmptyPage = true;


  for (
    let attempt = 1;
    attempt <= 3;
    attempt++
  ) {

    try {

      console.log(
        `検索試行 ${attempt}/3`
      );


      let response = null;

      if (attempt === 1) {

        response = await page.goto(
          pagedSearchUrl,
          {
            waitUntil: 'domcontentloaded',
            timeout: 60000
          }
        );

      } else {

        response = await page.reload({
          waitUntil: 'domcontentloaded',
          timeout: 60000
        });

      }


      const status =
        response && typeof response.status === 'function'
          ? Number(response.status())
          : 0;

      console.log(
        'Yahoo検索HTTP:',
        status || 'NO_RESPONSE'
      );

      if (
        status < 200 ||
        status >= 400
      ) {

        everyAttemptWasSuccessfulEmptyPage = false;

        // 最終のHTTPエラー応答だけ、404の原因確認用に安全な範囲で記録する。
        // 検索語を含むクエリ文字列はログへ出さず、再試行・カーソル処理も変更しない。
        if (response && status >= 400 && attempt === 3) {
          const diagnostic = {
            status
          };

          try {
            diagnostic.responsePath = new URL(response.url()).pathname;
          } catch (error) {
            diagnostic.responsePath = '';
          }

          try {
            diagnostic.title = await page.title();
          } catch (error) {
            diagnostic.title = '';
          }

          try {
            diagnostic.bodySnippet = (await page.locator('body').innerText({ timeout: 2000 }))
              .replace(/\s+/g, ' ')
              .replace(/https?:\/\/\S+/g, '[URL]')
              .slice(0, 240);
          } catch (error) {
            diagnostic.bodySnippet = '[本文を取得できません]';
          }

          console.warn(
            'Yahoo検索HTTPエラー詳細:',
            JSON.stringify(diagnostic)
          );
        }

      } else {

        await page.waitForTimeout(
          3000
        );


        const count =
          await page.locator(
            'li.Product'
          ).count();


        console.log(
          '商品カード数:',
          count
        );


        if (count > 0) {

          cardFound = true;

          break;

        }

      }


    } catch (error) {

      everyAttemptWasSuccessfulEmptyPage = false;

      console.log(
        '検索試行失敗:',
        error.message
      );

    }


    await sleep(
      3000
    );

  }


  if (!cardFound) {

    console.log(
      '⚠️ Yahoo新着検索は今回取得できませんでした'
    );

    console.log(
      '⚠️ 既存商品の価格追跡は継続します'
    );

    return {
      ok: false,
      failureReason: everyAttemptWasSuccessfulEmptyPage
        ? 'NO_PRODUCT_CARDS'
        : 'SEARCH_RETRY_FAILED',
      items: [],
      rawRowsRead: 0,
      rawItemIds: [],
      lastRawItemId: ''
    };

  }


  const configuredMaxBuyPrice = Number(config.normalBuyLimit);
  const maxBuyPrice = Number.isFinite(configuredMaxBuyPrice) && configuredMaxBuyPrice > 0
    ? configuredMaxBuyPrice
    : 29000;

  const pageResult =
    await page.evaluate(
      ({ MAX_SEARCH_ITEMS, maxBuyPrice }) => {

        function cleanText(text) {

          return String(text || '')
            .replace(/\s+/g, ' ')
            .trim();

        }


        const cards =
          Array.from(
            document.querySelectorAll(
              'li.Product'
            )
          ).slice(0, MAX_SEARCH_ITEMS);


        const results = [];
        const rawItemIds = [];

        const seen = new Set();


        for (const card of cards) {

          // ====================================================
          // URL / 商品ID
          // ====================================================

          const auctionAnchors =
            Array.from(
              card.querySelectorAll(
                'a[href*="/jp/auction/"]'
              )
            );


          let href = '';
          let itemId = '';


          for (const anchor of auctionAnchors) {

            const candidate =
              anchor.href || '';


            const match =
              candidate.match(
                /\/jp\/auction\/([A-Za-z0-9_-]+)/
              );


            if (match) {

              href = candidate;
              itemId = match[1];

              break;

            }

          }

          rawItemIds.push(itemId);


          if (
            !href ||
            !itemId ||
            seen.has(itemId)
          ) {
            continue;
          }


          // ====================================================
          // タイトル
          // ====================================================

          const titleCandidates =
            auctionAnchors

              .map(anchor => {

                return cleanText(

                  anchor.getAttribute(
                    'title'
                  )

                  ||

                  anchor.getAttribute(
                    'aria-label'
                  )

                  ||

                  anchor.innerText

                  ||

                  ''

                );

              })

              .filter(text => {

                if (!text) {
                  return false;
                }


                if (
                  text === '送料無料' ||
                  text === '鑑定付き' ||
                  text === 'New!!' ||
                  text === 'ウォッチ'
                ) {
                  return false;
                }


                if (
                  /^(現在|即決)\s*[\d,]+円/
                    .test(text)
                ) {
                  return false;
                }


                return true;

              })

              .sort(
                (a, b) =>
                  b.length - a.length
              );


          let title =
            titleCandidates[0] || '';


          if (!title) {

            const image =
              card.querySelector(
                'img[alt]'
              );


            if (image) {

              title =
                cleanText(
                  image.getAttribute(
                    'alt'
                  )
                );

            }

          }


          const cardText =
            cleanText(
              card.innerText
            );


          // ====================================================
          // 検索結果価格
          // ====================================================

          let price = 0;


          let priceMatch =
            cardText.match(
              /現在\s*([\d,]+)\s*円/
            );


          if (!priceMatch) {

            priceMatch =
              cardText.match(
                /即決\s*([\d,]+)\s*円/
              );

          }


          if (priceMatch) {

            price =
              Number(
                priceMatch[1]
                  .replace(/,/g, '')
              );

          }


          // ====================================================
          // 残り時間
          // ====================================================

          let remainingTime = '';


          const remainingElement =
            card.querySelector(
              '.Product__timeRemaining, [class*="timeRemaining"]'
            );


          if (remainingElement) {

            remainingTime =
              cleanText(

                remainingElement.innerText

                ||

                remainingElement.textContent

                ||

                ''

              );

          }


          if (!remainingTime) {

            const timeInfo =
              card.querySelector(
                '.Product__timeInfo, [class*="timeInfo"]'
              );


            const timeInfoText =
              cleanText(

                timeInfo
                  ? (
                      timeInfo.innerText
                      ||
                      timeInfo.textContent
                      ||
                      ''
                    )
                  : ''

              );


            const timeMatch =
              timeInfoText.match(
                /(\d+\s*(?:日|時間|分))/
              );


            if (timeMatch) {

              remainingTime =
                cleanText(
                  timeMatch[1]
                );

            }

          }


          if (!remainingTime) {

            const fallback =
              cardText.match(
                /(?:^|\s)(\d+\s*(?:日|時間|分))(?:\s|$)/
              );


            if (fallback) {

              remainingTime =
                cleanText(
                  fallback[1]
                );

            }

          }


          // ====================================================
          // 安全監査
          // ====================================================

          if (!title) {
            continue;
          }


          if (title.length > 250) {
            continue;
          }


          if (
            !price ||
            price <= 0 ||
            price > maxBuyPrice
          ) {
            continue;
          }


          if (
            !/^https:\/\/auctions\.yahoo\.co\.jp\/jp\/auction\//
              .test(href)
          ) {
            continue;
          }


          seen.add(itemId);


          results.push({

            itemId,

            url:
              href,

            title,

            price,

            remainingTime

          });


          if (
            results.length >=
            MAX_SEARCH_ITEMS
          ) {
            break;
          }

        }


        return {
          items: results,
          rawRowsRead: cards.length,
          rawItemIds
        };

      },

      { MAX_SEARCH_ITEMS, maxBuyPrice }
    );


  console.log(
    '仕入判定対象取得:',
    pageResult.items.length,
    '件'
  );


  pageResult.items.forEach(
    (item, index) => {

      console.log(
        `${index + 1}.`,
        item.itemId,
        '¥' + item.price,
        item.remainingTime || ''
      );

    }
  );


  const lastRawItemId = pageResult.rawItemIds
    .slice()
    .reverse()
    .find(Boolean) || '';

  return {
    ok: true,
    items: pageResult.items,
    rawRowsRead: pageResult.rawRowsRead,
    rawItemIds: pageResult.rawItemIds,
    lastRawItemId
  };

}


// ============================================================
// Yahoo詳細ページ
//
// 10/10 Dry Runを通過した方式。
//
// h1の商品タイトルから
// 本体の「入札する / 今すぐ落札」までだけを見る。
//
// おすすめ商品エリアの価格は読まない。
// ============================================================

async function scanTrackedYahooItem(
  page,
  trackedItem
) {

  try {

    await page.goto(
      trackedItem.url,
      {
        waitUntil:
          'domcontentloaded',

        timeout:
          60000
      }
    );


    await page.waitForTimeout(
      2500
    );


    const detail =
      await page.evaluate(
        () => {

          function clean(text) {

            return String(text || '')
              .replace(/\s+/g, ' ')
              .trim();

          }


          function isAfter(a, b) {

            return Boolean(
              b.compareDocumentPosition(a) &
              Node.DOCUMENT_POSITION_FOLLOWING
            );

          }


          function isBefore(a, b) {

            return Boolean(
              b.compareDocumentPosition(a) &
              Node.DOCUMENT_POSITION_PRECEDING
            );

          }


          const bodyText =
            clean(
              document.body.innerText
            );


          // ==================================================
          // 終了済み判定
          // ==================================================

          const ended =
            /このオークションは終了しています|オークションは終了しました/
              .test(
                bodyText
              );


          if (ended) {

            return {
              ended: true
            };

          }


          // ==================================================
          // 商品タイトル
          // ==================================================

          const h1 =
            Array.from(
              document.querySelectorAll(
                'h1'
              )
            )
              .find(el =>
                clean(el.innerText)
              );


          if (!h1) {

            return {
              ended: false,
              ok: false,
              reason: 'H1_NOT_FOUND'
            };

          }


          // ==================================================
          // 本体アクションボタン
          // ==================================================

          const actionCandidates =
            Array.from(
              document.querySelectorAll(
                'button, a'
              )
            )
              .filter(el => {

                if (
                  !isAfter(
                    el,
                    h1
                  )
                ) {
                  return false;
                }


                const text =
                  clean(
                    el.innerText
                  );


                return (
                  text === '入札する' ||
                  text === '今すぐ落札' ||
                  text === '落札する' ||
                  text === '購入する' ||
                  text === '購入手続きへ' ||
                  text.startsWith(
                    '入札する'
                  ) ||
                  text.startsWith(
                    '今すぐ落札'
                  )
                );

              });


          const actionButton =
            actionCandidates[0]
            ||
            null;


          // ==================================================
          // おすすめ欄の開始位置
          // ==================================================

          const recommendationWords = [
            'この商品も注目されています',
            '見た目が似ている商品',
            'お探しの商品からのおすすめ',
            '似た商品を見る',
            'ブランドランキング'
          ];


          const recommendationHeading =
            Array.from(
              document.querySelectorAll(
                'h2, h3, h4'
              )
            )
              .filter(el => {

                if (
                  !isAfter(
                    el,
                    h1
                  )
                ) {
                  return false;
                }


                const text =
                  clean(
                    el.innerText
                  );


                return recommendationWords.some(
                  word =>
                    text.includes(
                      word
                    )
                );

              })[0]
            ||
            null;


          const boundary =
            actionButton
            ||
            recommendationHeading
            ||
            null;


          // ==================================================
          // 本体価格候補
          // ==================================================

          const allElements =
            Array.from(
              document.querySelectorAll(
                'body *'
              )
            );


          const candidates = [];


          for (
            let index = 0;
            index < allElements.length;
            index++
          ) {

            const el =
              allElements[index];


            if (
              el === h1 ||
              !isAfter(
                el,
                h1
              )
            ) {
              continue;
            }


            if (
              boundary &&
              !isBefore(
                el,
                boundary
              )
            ) {
              continue;
            }


            const text =
              clean(
                el.innerText
              );


            if (
              !text ||
              text.length > 100
            ) {
              continue;
            }


            const match =
              text.match(
                /^(現在|価格|即決)\s*([\d,]+)\s*円(?:\s*[（(][^）)]*[）)])?$/
              );


            if (!match) {
              continue;
            }


            const label =
              match[1];


            const price =
              Number(
                match[2]
                  .replace(/,/g, '')
              );


            if (
              !Number.isFinite(
                price
              ) ||
              price <= 0
            ) {
              continue;
            }


            candidates.push({

              label,

              price,

              sourceText:
                text,

              domIndex:
                index,

              textLength:
                text.length

            });

          }


          if (
            candidates.length === 0
          ) {

            return {

              ended: false,

              ok: false,

              reason:
                'MAIN_PRICE_NOT_FOUND',

              title:
                clean(
                  h1.innerText
                ),

              actionButton:
                actionButton
                  ? clean(
                      actionButton.innerText
                    )
                  : ''

            };

          }


          // ==================================================
          // 重複排除
          // ==================================================

          const uniqueMap =
            new Map();


          for (
            const candidate
            of candidates
          ) {

            const key =
              `${candidate.label}:${candidate.price}`;


            const previous =
              uniqueMap.get(
                key
              );


            if (
              !previous ||
              candidate.textLength <
              previous.textLength
            ) {

              uniqueMap.set(
                key,
                candidate
              );

            }

          }


          const uniqueCandidates =
            Array.from(
              uniqueMap.values()
            );


          // ==================================================
          // 価格優先順位
          //
          // 現在 → 価格 → 即決
          // ==================================================

          const priority = {
            '現在': 1,
            '価格': 2,
            '即決': 3
          };


          uniqueCandidates.sort(
            (a, b) => {

              const priorityDiff =
                priority[a.label] -
                priority[b.label];


              if (
                priorityDiff !== 0
              ) {
                return priorityDiff;
              }


              return (
                a.domIndex -
                b.domIndex
              );

            }
          );


          const selected =
            uniqueCandidates[0];


          // ==================================================
          // 残り時間
          // ==================================================

          let remainingTime = '';


          const remainingMatch =
            bodyText.match(
              /残り時間\s*(\d+)\s*(日|時間|分)/
            );


          if (remainingMatch) {

            remainingTime =
              remainingMatch[1] +
              remainingMatch[2];

          }


          // ==================================================
          // 終了予定時刻
          //
          // 半角()・全角（）の両方に対応。
          // 例:
          // 9月24日 (木) 22時10分 終了予定
          // 9月24日（木）22時10分 終了予定
          // ==================================================

          let endParts = null;


          const endMatch =
            bodyText.match(
              /(\d{1,2})月(\d{1,2})日(?:\s*[（(][^）)]*[）)])?\s*(\d{1,2})時\s*(\d{1,2})分\s*終了予定/
            );


          if (endMatch) {

            endParts = {

              month:
                Number(
                  endMatch[1]
                ),

              day:
                Number(
                  endMatch[2]
                ),

              hour:
                Number(
                  endMatch[3]
                ),

              minute:
                Number(
                  endMatch[4]
                )

            };

          }


          return {

            ended: false,

            ok: true,

            price:
              selected.price,

            priceLabel:
              selected.label,

            sourceText:
              selected.sourceText,

            title:
              clean(
                h1.innerText
              ),

            actionButton:
              actionButton
                ? clean(
                    actionButton.innerText
                  )
                : '',

            remainingTime,

            endParts

          };

        }
      );


    // ========================================================
    // 終了済み
    // ========================================================

    if (
      detail &&
      detail.ended
    ) {

      console.log(
        '終了済み:',
        trackedItem.itemId
      );

      return null;

    }


    // ========================================================
    // 本体価格を安全に取得できなかった場合
    //
    // 台帳にも送らない
    // LINEにも進ませない
    // ========================================================

    if (
      !detail ||
      !detail.ok ||
      !detail.price ||
      detail.price <= 0
    ) {

      console.log(
        '⚠️ 本体価格取得失敗:',
        trackedItem.itemId,
        detail
          ? detail.reason
          : 'UNKNOWN'
      );


      return null;

    }


    const previousPrice =
      Number(
        trackedItem.currentPrice
        ||
        0
      );


    // ========================================================
    // 安全弁
    //
    // 「現在」「価格」のオークション価格は
    // 原則として下がらない。
    //
    // 以前の価格より低い値が取れた場合は
    // おすすめ商品などの誤取得とみなし更新しない。
    //
    // 「即決」は出品者の価格変更があり得るため除外。
    // ========================================================

    if (
      detail.priceLabel !== '即決' &&
      previousPrice > 0 &&
      detail.price < previousPrice
    ) {

      console.log(
        '🛑 異常価格を拒否:',
        trackedItem.itemId,
        previousPrice,
        '→',
        detail.price,
        'ラベル:',
        detail.priceLabel
      );


      return null;

    }


    // ========================================================
    // 終了日時
    //
    // Yahooは日本時間。
    // Node側のタイムゾーンに依存させず +09:00 を明示。
    // ========================================================

    let endTime = '';


    if (
      detail.endParts
    ) {

      const nowJstYear =
        Number(
          new Intl.DateTimeFormat(
            'en',
            {
              timeZone:
                'Asia/Tokyo',

              year:
                'numeric'
            }
          ).format(
            new Date()
          )
        );


      let year =
        nowJstYear;


      const pad =
        n =>
          String(n)
            .padStart(
              2,
              '0'
            );


      let iso =
        `${year}-` +
        `${pad(detail.endParts.month)}-` +
        `${pad(detail.endParts.day)}T` +
        `${pad(detail.endParts.hour)}:` +
        `${pad(detail.endParts.minute)}:00+09:00`;


      let candidate =
        new Date(
          iso
        );


      const now =
        new Date();


      // 年末→年始をまたぐ出品への安全対応
      if (
        candidate.getTime() <
        now.getTime() -
        1000 * 60 * 60 * 24 * 180
      ) {

        year++;


        iso =
          `${year}-` +
          `${pad(detail.endParts.month)}-` +
          `${pad(detail.endParts.day)}T` +
          `${pad(detail.endParts.hour)}:` +
          `${pad(detail.endParts.minute)}:00+09:00`;

      }


      endTime = iso;

    }


    console.log(
      '詳細取得:',
      trackedItem.itemId,
      '¥' + detail.price,
      'ラベル:',
      detail.priceLabel,
      '残り:',
      detail.remainingTime || '不明',
      '終了:',
      endTime || '未取得'
    );


    return {

      itemId:
        trackedItem.itemId,

      url:
        trackedItem.url,

      title:
        trackedItem.title,

      price:
        detail.price,

      remainingTime:
        detail.remainingTime,

      endTime

    };


  } catch (error) {

    console.log(
      '詳細追跡失敗:',
      trackedItem.itemId,
      error.message
    );


    return null;

  }

}


// ============================================================
// 既存Yahoo商品の価格追跡
// ============================================================

async function trackExistingYahooItems(
  context,
  trackedYahoo
) {

  console.log(
    '=============================='
  );

  console.log(
    '② Yahoo既存商品の価格追跡'
  );


  const targets =
    Array.isArray(
      trackedYahoo
    )
      ? trackedYahoo.slice(
          0,
          MAX_TRACKED_ITEMS
        )
      : [];


  console.log(
    '追跡対象:',
    targets.length,
    '件'
  );


  if (
    targets.length === 0
  ) {
    return;
  }


  const updateGroups = {};


  const page =
    await context.newPage();


  for (
    let i = 0;
    i < targets.length;
    i++
  ) {

    const trackedItem =
      targets[i];


    console.log(
      `[${i + 1}/${targets.length}]`,
      trackedItem.itemId
    );


    const update =
      await scanTrackedYahooItem(
        page,
        trackedItem
      );


    if (!update) {
      continue;
    }


    console.log(
      '価格:',
      trackedItem.currentPrice,
      '→',
      update.price,
      '/ 残り:',
      update.remainingTime || '不明'
    );


    const conditionId =
      trackedItem.conditionId;


    if (!conditionId) {

      console.log(
        '⚠️ conditionIdなしの追跡商品をスキップ:',
        trackedItem.itemId
      );

      continue;

    }


    if (
      !updateGroups[
        conditionId
      ]
    ) {

      updateGroups[
        conditionId
      ] = [];

    }


    updateGroups[
      conditionId
    ].push(
      update
    );


    await sleep(
      500
    );

  }


  await page.close();


  for (
    const [
      conditionId,
      items
    ]
    of Object.entries(
      updateGroups
    )
  ) {

    if (
      items.length === 0
    ) {
      continue;
    }


    const result =
      await sendToAppsScript(
        items,
        conditionId
      );


    console.log(
      '追跡更新:',
      conditionId,
      '件数:',
      items.length,
      'updated:',
      result.updated
    );

  }

}


// ============================================================
// メイン
// ============================================================

async function main() {

  // ========================================================
  // 市場監視設定からYahooのON条件を取得
  // ========================================================

  const configs =
    await getYahooConfigs();


  if (
    configs.length === 0
  ) {

    console.log(
      '=============================='
    );

    console.log(
      'YahooのON監視条件が0件のため終了します'
    );

    return;

  }


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

        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
          'AppleWebKit/537.36 (KHTML, like Gecko) ' +
          'Chrome/140.0.0.0 Safari/537.36'

      });


    const searchPage =
      await context.newPage();


    // ========================================================
    // ① ON条件を順番に新着検索
    //
    // 各条件ごとにmarket-ingestへ接続し、
    // 新着0件でもtrackedYahooを取得する。
    // ========================================================

    const trackedYahooMap =
      new Map();


    const conditionFailures = await runConditionsIndependently_(
      configs,
      async (config, i) => {


      console.log(
        '=============================='
      );

      console.log(
        `[条件 ${i + 1}/${configs.length}]`,
        config.conditionId,
        config.searchName || ''
      );


      const storedScanOffset = Number.isInteger(Number(config.scanOffset))
        ? Math.max(1, Number(config.scanOffset))
        : defaultScanOffset_(MARKET);
      const storedLastItemId = String(config.lastItemId || '').trim();


      // 毎回先頭10行も確認し、新着・終了間近の出品を拾う。
      const headResult =
        await scanYahooSearch(
          searchPage,
          config,
          defaultScanOffset_(MARKET)
        );

      let scanOffset = storedScanOffset;
      let cursorMode = 'HEAD';
      let coverageResult = headResult;
      let lookbackResult = null;

      if (storedScanOffset > defaultScanOffset_(MARKET)) {
        if (storedLastItemId) {
          const lookbackOffset = Math.max(
            defaultScanOffset_(MARKET),
            storedScanOffset - MAX_SEARCH_ITEMS
          );
          lookbackResult = await scanYahooSearch(
            searchPage,
            config,
            lookbackOffset
          );

          if (!lookbackResult.ok) {
            cursorMode = 'LOOKBACK_FAILED';
            coverageResult = lookbackResult;
          } else {
            const rebased = rebaseYahooScanOffset_(
              storedScanOffset,
              storedLastItemId,
              lookbackOffset,
              lookbackResult.rawItemIds
            );
            scanOffset = rebased.offset;
            cursorMode = rebased.mode;
            coverageResult = scanOffset === defaultScanOffset_(MARKET)
              ? headResult
              : await scanYahooSearch(searchPage, config, scanOffset);
          }
        } else {
          // 旧形式のoffsetだけでは、変動した検索結果を安全に再開できない。
          scanOffset = defaultScanOffset_(MARKET);
          cursorMode = 'RESET_ANCHOR_MISSING';
          coverageResult = headResult;
        }
      }

      const unresolvedCoverageResult = coverageResult;
      coverageResult = normalizeYahooContinuationResult_(
        headResult,
        lookbackResult,
        coverageResult
      );

      if (
        coverageResult !== unresolvedCoverageResult &&
        coverageResult.endOfResults === true
      ) {
        cursorMode = 'END_OF_RESULTS';
        scanOffset = defaultScanOffset_(MARKET);

        console.warn(
          'Yahoo継続位置に商品カードがありません。結果終端としてカーソルを先頭へ戻します:',
          config.conditionId
        );
      }

      console.log(
        'Yahooカーソル:',
        JSON.stringify({
          mode: cursorMode,
          storedOffset: storedScanOffset,
          scanOffset,
          lastItemId: coverageResult.endOfResults
            ? ''
            : storedLastItemId
        })
      );

      const searchItems = mergeUniqueItemsById_(
        headResult.ok ? headResult.items : [],
        coverageResult.ok ? coverageResult.items : []
      );


      // ======================================================
      // market-ingestへ接続
      // ======================================================

      console.log(
        '=============================='
      );

      console.log(
        '市場監視台帳へ接続:',
        config.conditionId
      );


      const ingestResult =
        await sendToAppsScript(
          searchItems,
          config.conditionId
        );

      if (coverageResult.ok) {
        const nextOffset = nextYahooScanOffset_(
          scanOffset,
          coverageResult.rawRowsRead
        );
        await acknowledgeMarketScanCursor_(
          config.conditionId,
          nextOffset,
          coverageResult.lastRawItemId
        );
      } else {
        // 取得に失敗した場合は保存済み位置を維持し、次回同じ位置から再試行する。
        console.warn(
          'Yahoo検索失敗。保存済みカーソルを維持します:',
          config.conditionId,
          cursorMode,
          storedScanOffset
        );
      }


      console.log(
        '新着受信:',
        ingestResult.received,
        '新規:',
        ingestResult.inserted,
        '更新:',
        ingestResult.updated
      );


      const trackedYahoo =
        Array.isArray(
          ingestResult.trackedYahoo
        )
          ? ingestResult.trackedYahoo
          : [];


      // trackedYahoo側にconditionIdが無い場合でも、
      // 今回問い合わせた条件IDを安全なフォールバックとして付与する。
      for (
        let j = 0;
        j < trackedYahoo.length;
        j++
      ) {

        const trackedItem =
          trackedYahoo[j];


        if (!trackedItem) {
          continue;
        }


        const normalizedConditionId =
          trackedItem.conditionId
          ||
          config.conditionId;


        const normalizedItem = {
          ...trackedItem,
          conditionId:
            normalizedConditionId
        };


        const itemKey =
          normalizedItem.itemId
          ||
          normalizedItem.url;


        if (!itemKey) {

          console.log(
            '⚠️ itemId / URLなしの追跡商品をスキップ:',
            normalizedConditionId
          );

          continue;

        }


        const key =
          `${normalizedConditionId}::${itemKey}`;


        trackedYahooMap.set(
          key,
          normalizedItem
        );

      }


      await sleep(
        500
      );

      const failedStages = [];
      if (!headResult.ok) failedStages.push('先頭');
      if (lookbackResult && !lookbackResult.ok) {
        failedStages.push('カーソル再確認');
      }
      if (
        !coverageResult.ok &&
        coverageResult !== headResult &&
        coverageResult !== lookbackResult
      ) {
        failedStages.push('継続位置');
      }

      if (failedStages.length > 0) {
        return {
          ok: false,
          error: 'Yahoo検索に失敗: ' + failedStages.join(', ')
        };
      }

      return { ok: true };
      },
      failure => {
        console.error(
          '⚠️ 条件監視失敗。後続条件へ継続します:',
          JSON.stringify(failure)
        );
      }
    );


    await searchPage.close();


    // ========================================================
    // ② 既存商品の詳細価格追跡
    //
    // 複数条件から返ったtrackedYahooを重複排除したうえで、
    // 既存の安全な詳細価格取得ロジックへ渡す。
    // ========================================================

    const trackedYahoo =
      Array.from(
        trackedYahooMap.values()
      );


    console.log(
      '=============================='
    );

    console.log(
      '統合追跡対象:',
      trackedYahoo.length,
      '件'
    );


    await trackExistingYahooItems(
      context,
      trackedYahoo
    );

    if (conditionFailures.length > 0) {
      console.error(
        '失敗条件一覧:',
        JSON.stringify(conditionFailures)
      );
      throw new Error(
        `Yahoo監視条件${conditionFailures.length}件に失敗しました。` +
        '後続条件の走査と既存商品の追跡は完了しています。'
      );
    }


    console.log(
      '=============================='
    );


    console.log(
      '✅ Yahoo Config Discovery + Safe Price Tracking SUCCESS'
    );


  } finally {

    await browser.close();

  }

}


// ============================================================
// 実行
// ============================================================

main()
  .catch(
    error => {

      console.error(
        'YAHOO MONITOR ERROR'
      );


      console.error(
        error
      );


      process.exit(
        1
      );

    }
  );
