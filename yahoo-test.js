const { chromium } = require('playwright');

const YAHOO_URL =
  'https://auctions.yahoo.co.jp/search/search?p=グッチ+スーツ&auccat=23176&va=グッチ+スーツ&aucmaxprice=29000&is_postage_mode=1&dest_pref_code=40&b=1&n=50&s1=new&o1=d';

const MARKET_INGEST_URL =
  process.env.MARKET_INGEST_URL;

const MARKET_INGEST_SECRET =
  process.env.MARKET_INGEST_SECRET;

const MARKET = 'ヤフオク';
const CONDITION_ID = 'Y-01';
const MAX_ITEMS = 10;


// ============================================================
// Apps Scriptへ送信
// ============================================================

async function sendToAppsScript(items) {

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
    secret: MARKET_INGEST_SECRET,
    market: MARKET,
    conditionId: CONDITION_ID,
    items: items
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

  const text =
    await response.text();

  console.log(
    'Apps Script HTTP:',
    response.status
  );

  console.log(
    'Apps Script Response:',
    text
  );

  let result;

  try {

    result =
      JSON.parse(text);

  } catch (error) {

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
        locale: 'ja-JP',
        timezoneId: 'Asia/Tokyo',

        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
          'AppleWebKit/537.36 (KHTML, like Gecko) ' +
          'Chrome/140.0.0.0 Safari/537.36'
      });

    const page =
      await context.newPage();

    console.log(
      'Yahoo!オークションを開きます'
    );

    await page.goto(
      YAHOO_URL,
      {
        waitUntil: 'domcontentloaded',
        timeout: 60000
      }
    );

    await page.waitForSelector(
      'li.Product',
      {
        timeout: 60000
      }
    );

    await page.waitForTimeout(
      2000
    );

    console.log(
      '現在URL:',
      page.url()
    );

    console.log(
      'ページタイトル:',
      await page.title()
    );


    // ========================================================
    // 1商品 = li.Product 単位で取得
    // ========================================================

    const items =
      await page.evaluate(
        (MAX_ITEMS) => {

          function clean(text) {

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

          for (
            const card of cards
          ) {

            const auctionAnchors =
              Array.from(
                card.querySelectorAll(
                  'a[href*="/jp/auction/"]'
                )
              );


            // --------------------------------------------
            // URL / 出品ID
            // --------------------------------------------

            let href = '';
            let itemId = '';

            for (
              const anchor of auctionAnchors
            ) {

              const candidate =
                anchor.href || '';

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


            // --------------------------------------------
            // タイトル
            // 同じ商品カード内部だけを見る
            // --------------------------------------------

            const titleCandidates =
              auctionAnchors
                .map(
                  anchor => {

                    return clean(
                      anchor.getAttribute('title') ||
                      anchor.getAttribute('aria-label') ||
                      anchor.innerText ||
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
                    b.length - a.length
                );


            let title =
              titleCandidates[0] || '';


            // タイトルリンクで取れない場合
            // img altを補助使用
            if (!title) {

              const image =
                card.querySelector(
                  'img[alt]'
                );

              if (image) {

                title =
                  clean(
                    image.getAttribute(
                      'alt'
                    )
                  );

              }

            }


            // --------------------------------------------
            // 現在価格
            // 必ず同じ li.Product の中だけ
            // --------------------------------------------

            const cardText =
              clean(
                card.innerText
              );

            let price = 0;

            let priceMatch =
              cardText.match(
                /現在\s*([\d,]+)\s*円/
              );

            // 現在価格がない場合だけ即決価格
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


            // --------------------------------------------
            // 安全フィルター
            // --------------------------------------------

            if (!title) {
              continue;
            }

            // 検索結果ページ全体を誤取得した場合の防止
            if (
              title.length > 250
            ) {
              continue;
            }

            if (
              !price ||
              price <= 0
            ) {
              continue;
            }

            // Y-01は29,000円以下
            if (
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
              itemId: itemId,
              url: href,
              title: title,
              price: price
            });


            if (
              results.length >=
              MAX_ITEMS
            ) {
              break;
            }

          }

          return results;

        },

        MAX_ITEMS
      );


    // ========================================================
    // 取得結果ログ
    // ========================================================

    console.log(
      '取得商品数:',
      items.length
    );

    items.forEach(
      (item, index) => {

        console.log(
          '--------------------'
        );

        console.log(
          `${index + 1}. ID:`,
          item.itemId
        );

        console.log(
          'タイトル:',
          item.title
        );

        console.log(
          '現在価格:',
          item.price
        );

        console.log(
          'URL:',
          item.url
        );

      }
    );


    // ========================================================
    // 送信前の最終安全監査
    // ========================================================

    if (
      items.length === 0
    ) {

      throw new Error(
        'Yahoo商品を取得できませんでした'
      );

    }

    const suspicious =
      items.filter(
        item => {

          return (
            !item.itemId ||
            !item.url ||
            !item.title ||
            item.title.length > 250 ||
            !item.price ||
            item.price <= 0 ||
            item.price > 29000
          );

        }
      );

    if (
      suspicious.length > 0
    ) {

      throw new Error(
        '不自然なYahoo商品データを検出したため送信中止'
      );

    }


    console.log(
      '✅ parser安全監査OK'
    );

    console.log(
      '市場監視台帳へ送信します'
    );


    // ========================================================
    // market-ingestへ送信
    // ========================================================

    const result =
      await sendToAppsScript(
        items
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

    console.log(
      '=============================='
    );

    console.log(
      '✅ Yahoo Market Monitor SUCCESS'
    );


  } finally {

    await browser.close();

  }

}


main().catch(
  error => {

    console.error(
      'YAHOO MONITOR ERROR'
    );

    console.error(
      error
    );

    process.exit(1);

  }
);
