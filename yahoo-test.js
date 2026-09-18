const { chromium } = require('playwright');

const YAHOO_URL =
  'https://auctions.yahoo.co.jp/search/search?p=グッチ+スーツ&auccat=23176&va=グッチ+スーツ&aucmaxprice=29000&is_postage_mode=1&dest_pref_code=40&b=1&n=50&s1=new&o1=d';

const MARKET_INGEST_URL =
  process.env.MARKET_INGEST_URL;

const MARKET_INGEST_SECRET =
  process.env.MARKET_INGEST_SECRET;

const CONDITION_ID = 'Y-01';
const MARKET = 'ヤフオク';
const MAX_ITEMS = 10;


// ==========================================
// Apps Scriptへ送信
// ==========================================

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
      'Apps Script応答解析失敗: ' +
      text
    );

  }

  return result;
}


// ==========================================
// Yahoo取得
// ==========================================

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

    await page.waitForTimeout(5000);

    console.log(
      '現在URL:',
      page.url()
    );

    console.log(
      'ページタイトル:',
      await page.title()
    );


    // ------------------------------------------
    // 遅延描画対策
    // ------------------------------------------

    for (
      let i = 0;
      i < 5;
      i++
    ) {

      await page.evaluate(
        () => {

          window.scrollBy(
            0,
            window.innerHeight * 1.5
          );

        }
      );

      await page.waitForTimeout(
        1000
      );

    }


    // ------------------------------------------
    // 商品取得
    // ------------------------------------------

    const items =
      await page.evaluate(
        (MAX_ITEMS) => {

          const anchors =
            Array.from(
              document.querySelectorAll(
                'a[href*="/jp/auction/"]'
              )
            );

          const results = [];
          const seen = new Set();

          for (
            const a of anchors
          ) {

            const href =
              a.href || '';

            const match =
              href.match(
                /\/jp\/auction\/([A-Za-z0-9_-]+)/
              );

            if (!match) {
              continue;
            }

            const itemId =
              match[1];

            if (
              seen.has(itemId)
            ) {
              continue;
            }


            // ----------------------------------
            // 商品カードらしき親要素を探す
            // ----------------------------------

            let node = a;

            let bestText = '';

            for (
              let i = 0;
              i < 7 && node;
              i++
            ) {

              const candidate =
                (node.innerText || '')
                  .replace(
                    /\s+/g,
                    ' '
                  )
                  .trim();

              if (
                candidate.length >
                bestText.length
              ) {

                bestText =
                  candidate;

              }

              node =
                node.parentElement;

            }


            // ----------------------------------
            // 価格
            // ----------------------------------

            const priceMatch =
              bestText.match(
                /(?:¥|￥)\s*([\d,]+)/
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
              !price ||
              price <= 0
            ) {
              continue;
            }


            // ----------------------------------
            // タイトル
            // ----------------------------------

            let title =
              (
                a.innerText ||
                a.getAttribute(
                  'aria-label'
                ) ||
                ''
              )
                .replace(
                  /\s+/g,
                  ' '
                )
                .trim();

            if (
              !title
            ) {

              title =
                bestText
                  .replace(
                    /(?:¥|￥)\s*[\d,]+.*$/,
                    ''
                  )
                  .trim();

            }

            if (
              !title
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


    // ------------------------------------------
    // ログ
    // ------------------------------------------

    console.log(
      '取得商品数:',
      items.length
    );

    items.forEach(
      (item, index) => {

        console.log(
          `${index + 1}.`,
          item.itemId,
          item.price,
          item.title
        );

      }
    );


    if (
      items.length === 0
    ) {

      throw new Error(
        'Yahoo商品を取得できませんでした'
      );

    }


    // ------------------------------------------
    // Apps Scriptへ送信
    // ------------------------------------------

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
