const { chromium } = require('playwright');

const TEST_ITEMS = [
  {
    itemId: 'k1244904454',
    url: 'https://auctions.yahoo.co.jp/jp/auction/k1244904454',
    knownPrice: 1
  },
  {
    itemId: 'x1244718691',
    url: 'https://auctions.yahoo.co.jp/jp/auction/x1244718691',
    knownPrice: 23400
  },
  {
    itemId: 'x1244429742',
    url: 'https://auctions.yahoo.co.jp/jp/auction/x1244429742',
    knownPrice: 20460
  },
  {
    itemId: 'x1244396444',
    url: 'https://auctions.yahoo.co.jp/jp/auction/x1244396444',
    knownPrice: 16500
  },
  {
    itemId: 'x1243815028',
    url: 'https://auctions.yahoo.co.jp/jp/auction/x1243815028',
    knownPrice: 16511
  },
  {
    itemId: 'k1241018175',
    url: 'https://auctions.yahoo.co.jp/jp/auction/k1241018175',
    knownPrice: 22000
  },
  {
    itemId: 'm1240546223',
    url: 'https://auctions.yahoo.co.jp/jp/auction/m1240546223',
    knownPrice: 16800
  },
  {
    itemId: 'w1240086732',
    url: 'https://auctions.yahoo.co.jp/jp/auction/w1240086732',
    knownPrice: 19800
  },
  {
    itemId: 'h1233715186',
    url: 'https://auctions.yahoo.co.jp/jp/auction/h1233715186',
    knownPrice: 20000
  },
  {
    itemId: 'g1231237974',
    url: 'https://auctions.yahoo.co.jp/jp/auction/g1231237974',
    knownPrice: 19800
  }
];


async function extractCurrentPrice(page) {

  return await page.evaluate(() => {

    function clean(text) {
      return String(text || '')
        .replace(/\s+/g, ' ')
        .trim();
    }


    // ========================================================
    // メイン商品専用の価格コンテナだけを見る
    // おすすめ商品カードはここを持たない
    // ========================================================

    const containers =
      Array.from(
        document.querySelectorAll(
          'div[class*="ProductDetail__PriceInfo--container"]'
        )
      );


    for (
      const container
      of containers
    ) {

      const currentLabel =
        container.querySelector(
          'span[class*="Price__PriceText--current"]'
        );


      const amountElement =
        container.querySelector(
          'span[class*="Price__PriceText--amount"]'
        );


      const currencyElement =
        container.querySelector(
          'span[class*="Price__PriceText--currency"]'
        );


      if (
        !currentLabel ||
        !amountElement ||
        !currencyElement
      ) {

        continue;

      }


      const label =
        clean(
          currentLabel.innerText
        );


      const amountText =
        clean(
          amountElement.innerText
        );


      const currency =
        clean(
          currencyElement.innerText
        );


      if (
        label !== '現在'
      ) {

        continue;

      }


      if (
        currency !== '円'
      ) {

        continue;

      }


      if (
        !/^[\d,]+$/
          .test(
            amountText
          )
      ) {

        continue;

      }


      const price =
        Number(
          amountText
            .replace(/,/g, '')
        );


      if (
        !Number.isFinite(price) ||
        price <= 0
      ) {

        continue;

      }


      return {

        ok: true,

        price,

        sourceText:
          clean(
            container.innerText
          ),

        method:
          'MAIN_PRODUCT_PRICE_CONTAINER'

      };

    }


    // ========================================================
    // メイン価格欄が取れなかった場合は
    // 絶対に他の価格へフォールバックしない
    // ========================================================

    return {

      ok: false,

      price: 0,

      sourceText: '',

      method: '',

      debug: {

        priceContainerCount:
          containers.length,

        bidButtonCount:
          document.querySelectorAll(
            'button[class*="ProductDetail__Action--bid"]'
          ).length

      }

    };

  });

}


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


    const page =
      await context.newPage();


    let failed =
      0;


    for (
      let i = 0;
      i < TEST_ITEMS.length;
      i++
    ) {

      const item =
        TEST_ITEMS[i];


      console.log(
        '=============================='
      );

      console.log(
        `[${i + 1}/${TEST_ITEMS.length}]`,
        item.itemId
      );


      await page.goto(
        item.url,
        {
          waitUntil:
            'domcontentloaded',

          timeout:
            60000
        }
      );


      await page.waitForTimeout(
        2000
      );


      const result =
        await extractCurrentPrice(
          page
        );


      if (
        !result ||
        !result.ok
      ) {

        console.log(
          '❌ 現在価格を取得できません'
        );


        if (
          result &&
          result.debug
        ) {

          console.log(
            'DEBUG:',
            result.debug
          );

        }


        failed++;

        continue;

      }


      console.log(
        '台帳価格:',
        item.knownPrice
      );

      console.log(
        '詳細価格:',
        result.price
      );

      console.log(
        '取得方式:',
        result.method
      );

      console.log(
        '取得元:',
        result.sourceText
      );


      // ======================================================
      // Yahooオークション価格は通常下がらない
      // 台帳価格未満なら誤取得として拒否
      // ======================================================

      if (
        result.price <
        item.knownPrice
      ) {

        console.log(
          '❌ 異常: 詳細価格が台帳価格より低い'
        );

        failed++;

        continue;

      }


      console.log(
        '✅ OK'
      );

    }


    console.log(
      '=============================='
    );


    if (
      failed > 0
    ) {

      throw new Error(
        `価格監査NG: ${failed}件`
      );

    }


    console.log(
      '✅ 全10件価格監査OK'
    );

    console.log(
      '※ Apps Script送信なし'
    );

    console.log(
      '※ LINE送信なし'
    );


  } finally {

    await browser.close();

  }

}


main()
  .catch(
    error => {

      console.error(
        'DRY RUN ERROR'
      );

      console.error(
        error
      );

      process.exit(1);

    }
  );
