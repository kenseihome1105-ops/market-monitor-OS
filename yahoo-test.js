const { chromium } = require('playwright');

const YAHOO_URL =
  'https://auctions.yahoo.co.jp/search/search?p=グッチ+スーツ&auccat=23176&va=グッチ+スーツ&aucmaxprice=29000&is_postage_mode=1&dest_pref_code=40&b=1&n=50&s1=new&o1=d';

const MARKET_INGEST_URL = process.env.MARKET_INGEST_URL;
const MARKET_INGEST_SECRET = process.env.MARKET_INGEST_SECRET;

const MARKET = 'ヤフオク';
const CONDITION_ID = 'Y-01';

// 新着発見
const MAX_SEARCH_ITEMS = 10;

// 既存商品の価格追跡
const MAX_TRACKED_ITEMS = 30;


// ============================================================
// 共通
// ============================================================

function clean(text) {

  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim();

}


function sleep(ms) {

  return new Promise(
    resolve => setTimeout(resolve, ms)
  );

}


// ============================================================
// Apps Scriptへ送信
// ============================================================

async function sendToAppsScript(
  items,
  conditionId
) {

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


  const payload = {

    secret:
      MARKET_INGEST_SECRET,

    market:
      MARKET,

    conditionId:
      conditionId,

    items:
      items

  };


  const response =
    await fetch(
      MARKET_INGEST_URL,
      {
        method:
          'POST',

        headers: {
          'Content-Type':
            'application/json'
        },

        body:
          JSON.stringify(
            payload
          ),

        redirect:
          'follow'
      }
    );


  const text =
    await response.text();


  console.log(
    'Apps Script HTTP:',
    response.status
  );


  let result;


  try {

    result =
      JSON.parse(
        text
      );

  } catch (error) {

    console.log(
      'Apps Script Response:',
      text
    );

    throw new Error(
      'Apps Script応答がJSONではありません'
    );

  }


  if (!response.ok) {

    throw new Error(
      'Apps Script HTTP送信失敗: ' +
      response.status
    );

  }


  if (!result.ok) {

    throw new Error(
      'Apps Script応答エラー: ' +
      text
    );

  }


  return result;

}


// ============================================================
// Yahoo検索結果
// 新しい商品を発見する
// ============================================================

async function scanYahooSearch(
  page
) {

  console.log(
    '=============================='
  );

  console.log(
    '① Yahoo新着検索'
  );


  await page.goto(
    YAHOO_URL,
    {
      waitUntil:
        'domcontentloaded',

      timeout:
        60000
    }
  );


  try {

    await page.waitForSelector(
      'li.Product',
      {
        timeout:
          30000
      }
    );

  } catch (error) {

    console.log(
      '商品カード初回待機失敗。1回だけ再読込'
    );


    await page.reload({
      waitUntil:
        'domcontentloaded',

      timeout:
        60000
    });


    await page.waitForSelector(
      'li.Product',
      {
        timeout:
          30000
      }
    );

  }


  await page.waitForTimeout(
    1500
  );


  const items =
    await page.evaluate(
      (MAX_SEARCH_ITEMS) => {

        function cleanText(text) {

          return String(
            text || ''
          )
            .replace(
              /\s+/g,
              ' '
            )
            .trim();

        }


        const cards =
          Array.from(
            document.querySelectorAll(
              'li.Product'
            )
          );


        const results =
          [];

        const seen =
          new Set();


        for (
          const card
          of cards
        ) {

          // ----------------------------------------
          // URL / ID
          // ----------------------------------------

          const auctionAnchors =
            Array.from(
              card.querySelectorAll(
                'a[href*="/jp/auction/"]'
              )
            );


          let href =
            '';

          let itemId =
            '';


          for (
            const anchor
            of auctionAnchors
          ) {

            const candidate =
              anchor.href ||
              '';


            const match =
              candidate.match(
                /\/jp\/auction\/([A-Za-z0-9_-]+)/
              );


            if (match) {

              href =
                candidate;

              itemId =
                match[1];

              break;

            }

          }


          if (
            !href ||
            !itemId ||
            seen.has(itemId)
          ) {

            continue;

          }


          // ----------------------------------------
          // タイトル
          // ----------------------------------------

          const titleCandidates =
            auctionAnchors

              .map(
                anchor => {

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

                }
              )

              .filter(
                text => {

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

                }
              )

              .sort(
                (a, b) =>
                  b.length -
                  a.length
              );


          let title =
            titleCandidates[0] ||
            '';


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


          // ----------------------------------------
          // 現在価格
          // ----------------------------------------

          let price =
            0;


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
                  .replace(
                    /,/g,
                    ''
                  )
              );

          }


          // ----------------------------------------
          // 残り時間
          // ----------------------------------------

          let remainingTime =
            '';


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

            const cardTimeMatch =
              cardText.match(
                /(?:^|\s)(\d+\s*(?:日|時間|分))(?:\s|$)/
              );


            if (cardTimeMatch) {

              remainingTime =
                cleanText(
                  cardTimeMatch[1]
                );

            }

          }


          // ----------------------------------------
          // 安全監査
          // ----------------------------------------

          if (!title) {
            continue;
          }


          if (
            title.length >
            250
          ) {

            continue;

          }


          if (
            !price ||
            price <= 0 ||
            price > 29000
          ) {

            continue;

          }


          if (
            !/^https:\/\/auctions\.yahoo\.co\.jp\/jp\/auction\//
              .test(href)
          ) {

            continue;

          }


          seen.add(
            itemId
          );


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


        return results;

      },

      MAX_SEARCH_ITEMS
    );


  console.log(
    '新着取得:',
    items.length,
    '件'
  );


  items.forEach(
    (item, index) => {

      console.log(
        `${index + 1}.`,
        item.itemId,
        '¥' + item.price,
        item.remainingTime || ''
      );

    }
  );


  if (
    items.length === 0
  ) {

    throw new Error(
      'Yahoo検索結果の商品取得が0件です'
    );

  }


  return items;

}


// ============================================================
// 商品詳細ページ
// 検索結果から消えても現在価格を追跡
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
          45000
      }
    );


    await page.waitForTimeout(
      800
    );


    const detail =
      await page.evaluate(
        () => {

          function cleanText(text) {

            return String(
              text || ''
            )
              .replace(
                /\s+/g,
                ' '
              )
              .trim();

          }


          const bodyText =
            cleanText(
              document.body.innerText
            );


          // ========================================
          // 現在価格
          // ========================================

          let price =
            0;


          let priceMatch =
            bodyText.match(
              /現在\s*([\d,]+)\s*円/
            );


          if (!priceMatch) {

            priceMatch =
              bodyText.match(
                /現在価格\s*([\d,]+)\s*円/
              );

          }


          if (
            priceMatch
          ) {

            price =
              Number(
                priceMatch[1]
                  .replace(
                    /,/g,
                    ''
                  )
              );

          }


          // ========================================
          // 残り時間
          // ========================================

          let remainingTime =
            '';


          const remainingMatch =
            bodyText.match(
              /残り時間\s*(\d+)\s*(日|時間|分)/
            );


          if (
            remainingMatch
          ) {

            remainingTime =
              remainingMatch[1] +
              remainingMatch[2];

          }


          // ========================================
          // 終了日時
          //
          // 例:
          // 9月24日 (木) 22時10分 終了予定
          // ========================================

          let endText =
            '';


          const endMatch =
            bodyText.match(
              /(\d{1,2})月(\d{1,2})日(?:\s*\([^)]+\))?\s*(\d{1,2})時(\d{1,2})分\s*終了予定/
            );


          if (
            endMatch
          ) {

            endText =
              [
                endMatch[1],
                endMatch[2],
                endMatch[3],
                endMatch[4]
              ].join('|');

          }


          // ========================================
          // 終了判定
          // ========================================

          const ended =
            /このオークションは終了しています|オークションは終了しました/
              .test(
                bodyText
              );


          return {

            price,

            remainingTime,

            endText,

            ended

          };

        }
      );


    if (
      detail.ended
    ) {

      console.log(
        '終了済み:',
        trackedItem.itemId
      );

      return null;

    }


    if (
      !detail.price ||
      detail.price <= 0
    ) {

      console.log(
        '価格取得失敗:',
        trackedItem.itemId
      );

      return null;

    }


    let endTime =
      '';


    if (
      detail.endText
    ) {

      const parts =
        detail.endText
          .split('|')
          .map(Number);


      const month =
        parts[0];

      const day =
        parts[1];

      const hour =
        parts[2];

      const minute =
        parts[3];


      const now =
        new Date();


      let year =
        now.getFullYear();


      let candidate =
        new Date(
          year,
          month - 1,
          day,
          hour,
          minute,
          0
        );


      // 年末跨ぎ対策
      if (
        candidate.getTime() <
        now.getTime() -
          1000 * 60 * 60 * 24 * 180
      ) {

        candidate =
          new Date(
            year + 1,
            month - 1,
            day,
            hour,
            minute,
            0
          );

      }


      endTime =
        candidate.toISOString();

    }


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
// Yahoo既存商品の価格追跡
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


  const updateGroups =
    {};


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
      ' / 残り:',
      update.remainingTime || '不明'
    );


    const conditionId =
      trackedItem.conditionId
      ||
      CONDITION_ID;


    if (
      !updateGroups[
        conditionId
      ]
    ) {

      updateGroups[
        conditionId
      ] =
        [];

    }


    updateGroups[
      conditionId
    ].push(
      update
    );


    // Yahoo側への負荷を抑える
    await sleep(
      500
    );

  }


  await page.close();


  // 条件IDごとに台帳へ反映
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
      '価格追跡更新:',
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

  const browser =
    await chromium.launch({
      headless:
        true
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
    // 1. 新着検索
    // ========================================================

    const searchItems =
      await scanYahooSearch(
        searchPage
      );


    // ========================================================
    // 2. 新着を台帳へ登録
    //    同時に既存Yahoo追跡リストを受け取る
    // ========================================================

    console.log(
      '=============================='
    );

    console.log(
      '市場監視台帳へ新着送信'
    );


    const ingestResult =
      await sendToAppsScript(
        searchItems,
        CONDITION_ID
      );


    console.log(
      '受信:',
      ingestResult.received,
      '新規:',
      ingestResult.inserted,
      '更新:',
      ingestResult.updated
    );


    await searchPage.close();


    // ========================================================
    // 3. 既存Yahoo商品を詳細ページで直接追跡
    // ========================================================

    await trackExistingYahooItems(

      context,

      ingestResult.trackedYahoo

    );


    console.log(
      '=============================='
    );

    console.log(
      '✅ Yahoo Discovery + Price Tracking SUCCESS'
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
