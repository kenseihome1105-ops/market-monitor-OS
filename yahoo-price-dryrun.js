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

  // body全文は使わない。
  // 現在価格専用のPriceWrapperだけを見る。
  const result = await page.evaluate(() => {

    const wrappers =
      Array.from(
        document.querySelectorAll(
          'div[class*="PriceWrapper"]'
        )
      );

    for (const wrapper of wrappers) {

      const text =
        String(wrapper.innerText || '')
          .replace(/\s+/g, ' ')
          .trim();

      // 「現在 20,000 円」のような価格欄だけ許可
      const match =
        text.match(
          /^現在\s*([\d,]+)\s*円/
        );

      if (!match) {
        continue;
      }

      const price =
        Number(
          match[1].replace(/,/g, '')
        );

      if (
        Number.isFinite(price) &&
        price > 0
      ) {

        return {
          price,
          sourceText: text
        };

      }

    }

    return null;

  });


  return result;

}


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
          waitUntil: 'domcontentloaded',
          timeout: 60000
        }
      );


      await page.waitForTimeout(
        1200
      );


      const result =
        await extractCurrentPrice(
          page
        );


      if (!result) {

        console.log(
          '❌ 現在価格を取得できません'
        );

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
        '取得元:',
        result.sourceText
      );


      // オークション価格は原則上昇。
      // 台帳価格より下がる値は誤取得として扱う。
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
      '✅ 全件価格監査OK'
    );

    console.log(
      '※ Apps Script送信なし / LINE送信なし'
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
