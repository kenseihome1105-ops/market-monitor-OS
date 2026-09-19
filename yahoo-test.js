const { chromium } = require('playwright');

const YAHOO_URL =
  'https://auctions.yahoo.co.jp/search/search?p=グッチ+スーツ&auccat=23176&va=グッチ+スーツ&aucmaxprice=29000&is_postage_mode=1&dest_pref_code=40&b=1&n=50&s1=new&o1=d';

const MARKET_INGEST_URL = process.env.MARKET_INGEST_URL;
const MARKET_INGEST_SECRET = process.env.MARKET_INGEST_SECRET;

const MARKET = 'ヤフオク';
const CONDITION_ID = 'Y-01';

const MAX_SEARCH_ITEMS = 10;
const MAX_TRACKED_ITEMS = 30;


// ============================================================
// 共通
// ============================================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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


  const payload = {
    secret: MARKET_INGEST_SECRET,
    market: MARKET,
    conditionId,
    items
  };


  const response = await fetch(
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


  const text = await response.text();

  let result;


  try {

    result = JSON.parse(text);

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
      'Apps Script HTTP失敗: ' +
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
//
// 役割:
// 新しい出品を発見する。
//
// Yahoo検索側が一時的に取得不能でも
// 既存商品の詳細追跡は止めない。
// ============================================================

async function scanYahooSearch(page) {

  console.log(
    '=============================='
  );

  console.log(
    '① Yahoo新着検索'
  );


  let cardFound = false;


  for (
    let attempt = 1;
    attempt <= 3;
    attempt++
  ) {

    try {

      console.log(
        `検索試行 ${attempt}/3`
      );


      if (attempt === 1) {

        await page.goto(
          YAHOO_URL,
          {
            waitUntil: 'domcontentloaded',
            timeout: 60000
          }
        );

      } else {

        await page.reload({
          waitUntil: 'domcontentloaded',
          timeout: 60000
        });

      }


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


    } catch (error) {

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

    return [];

  }


  const items =
    await page.evaluate(
      (MAX_SEARCH_ITEMS) => {

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
          );


        const results = [];

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


  return items;

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
          // ここでは取得できた場合だけ返す。
          // 取得できない場合も価格追跡は止めない。
          // ==================================================

          let endParts = null;


          const endMatch =
            bodyText.match(
              /(\d{1,2})月(\d{1,2})日(?:\s*\([^)]+\))?\s*(\d{1,2})時(\d{1,2})分\s*終了予定/
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
    // ① 新着発見
    // ========================================================

    const searchItems =
      await scanYahooSearch(
        searchPage
      );


    // ========================================================
    // market-ingestへ接続
    //
    // 新着0件でもtrackedYahooを取得するため送信。
    // ========================================================

    console.log(
      '=============================='
    );

    console.log(
      '市場監視台帳へ接続'
    );


    const ingestResult =
      await sendToAppsScript(
        searchItems,
        CONDITION_ID
      );


    console.log(
      '新着受信:',
      ingestResult.received,
      '新規:',
      ingestResult.inserted,
      '更新:',
      ingestResult.updated
    );


    await searchPage.close();


    // ========================================================
    // ② 既存商品の詳細価格追跡
    // ========================================================

    await trackExistingYahooItems(

      context,

      ingestResult.trackedYahoo

    );


    console.log(
      '=============================='
    );


    console.log(
      '✅ Yahoo Discovery + Safe Price Tracking SUCCESS'
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
