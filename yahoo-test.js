const { chromium } = require('playwright');

const YAHOO_URL =
  'https://auctions.yahoo.co.jp/search/search?p=グッチ+スーツ&auccat=23176&va=グッチ+スーツ&aucmaxprice=29000&is_postage_mode=1&dest_pref_code=40&b=1&n=50&s1=new&o1=d';

const MAX_ITEMS = 10;

function normalizeText(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function main() {

  const browser = await chromium.launch({
    headless: true
  });

  try {

    const context = await browser.newContext({
      locale: 'ja-JP',
      timezoneId: 'Asia/Tokyo',
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
        'AppleWebKit/537.36 (KHTML, like Gecko) ' +
        'Chrome/140.0.0.0 Safari/537.36'
    });

    const page = await context.newPage();

    console.log('Yahoo!オークションを開きます');

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

    await page.waitForTimeout(2000);

    console.log(
      '現在URL:',
      page.url()
    );

    console.log(
      'ページタイトル:',
      await page.title()
    );


    // ==========================================
    // 商品カード単位で取得
    // ==========================================

    const items = await page.evaluate(
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

        for (const card of cards) {

          const auctionAnchors =
            Array.from(
              card.querySelectorAll(
                'a[href*="/jp/auction/"]'
              )
            );

          if (
            auctionAnchors.length === 0
          ) {
            continue;
          }


          // --------------------------------------
          // 商品URL / ID
          // --------------------------------------

          let href = '';

          for (
            const a of auctionAnchors
          ) {

            const candidate =
              a.href || '';

            if (
              /\/jp\/auction\/[A-Za-z0-9_-]+/
                .test(candidate)
            ) {

              href = candidate;
              break;

            }

          }

          if (!href) {
            continue;
          }

          const idMatch =
            href.match(
              /\/jp\/auction\/([A-Za-z0-9_-]+)/
            );

          if (!idMatch) {
            continue;
          }

          const itemId =
            idMatch[1];

          if (
            seen.has(itemId)
          ) {
            continue;
          }


          // --------------------------------------
          // タイトル
          // 同じカード内のauctionリンクから
          // 最も商品名らしい文字列を採用
          // --------------------------------------

          const titleCandidates =
            auctionAnchors
              .map(
                a => {

                  return clean(
                    a.getAttribute('title') ||
                    a.getAttribute('aria-label') ||
                    a.innerText ||
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


          // --------------------------------------
          // タイトルリンクで取れない場合
          // img altを補助的に使用
          // --------------------------------------

          if (!title) {

            const image =
              card.querySelector(
                'img[alt]'
              );

            if (image) {

              title =
                clean(
                  image.getAttribute('alt')
                );

            }

          }


          // --------------------------------------
          // 現在価格
          // カード内だけを見る
          // --------------------------------------

          const cardText =
            clean(
              card.innerText
            );

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
                  .replace(
                    /,/g,
                    ''
                  )
              );

          }


          // --------------------------------------
          // 異常値を除外
          // --------------------------------------

          if (!title) {
            continue;
          }

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

          if (
            price > 29000
          ) {
            continue;
          }


          seen.add(
            itemId
          );

          results.push({
            itemId,
            url: href,
            title,
            price
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


    // ==========================================
    // 安全チェック
    // ==========================================

    const suspicious =
      items.filter(
        item => {

          return (
            !item.title ||
            item.title.length > 250 ||
            !item.price ||
            item.price > 29000
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

    if (
      suspicious.length > 0
    ) {

      throw new Error(
        '不自然な商品データが含まれています'
      );

    }


    console.log(
      '=============================='
    );

    console.log(
      '✅ Yahoo parser安全テスト成功'
    );

    console.log(
      '※ Apps Scriptへの送信はまだしていません'
    );

  } finally {

    await browser.close();

  }

}


main().catch(
  error => {

    console.error(
      'YAHOO PARSER ERROR'
    );

    console.error(
      error
    );

    process.exit(1);

  }
);
