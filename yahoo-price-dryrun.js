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


    const all =
      Array.from(
        document.querySelectorAll('body *')
      );


    // ========================================================
    // 第一候補
    // 「現在」とだけ書かれたラベルを探し、
    // その親要素を上にたどって価格ブロックを特定
    // ========================================================

    const currentLabels =
      all.filter(el => {
        return clean(el.innerText) === '現在';
      });


    const candidates =
      [];


    for (
      const label
      of currentLabels
    ) {

      let node =
        label.parentElement;


      for (
        let depth = 0;
        depth < 6 && node;
        depth++
      ) {

        const text =
          clean(
            node.innerText
          );


        const match =
          text.match(
            /^現在\s*([\d,]+)\s*円/
          );


        if (
          match
        ) {

          const price =
            Number(
              match[1]
                .replace(/,/g, '')
            );


          if (
            Number.isFinite(price) &&
            price > 0 &&
            text.length <= 150
          ) {

            candidates.push({
              price,
              sourceText: text,
              depth
            });

          }

        }


        node =
          node.parentElement;

      }

    }


    // 一番小さい価格ブロックを採用
    if (
      candidates.length > 0
    ) {

      candidates.sort(
        (a, b) => {

          if (
            a.sourceText.length !==
            b.sourceText.length
          ) {

            return (
              a.sourceText.length -
              b.sourceText.length
            );

          }


          return (
            a.depth -
            b.depth
          );

        }
      );


      return {
        ok: true,
        price: candidates[0].price,
        sourceText: candidates[0].sourceText,
        method: 'CURRENT_LABEL_PARENT'
      };

    }


    // ========================================================
    // 第二候補
    // 小さいDOM要素の中で
    // 「現在 20,000円」形式そのものを探す
    // ========================================================

    const directCandidates =
      [];


    for (
      const el
      of all
    ) {

      const text =
        clean(
          el.innerText
        );


      if (
        !text ||
        text.length > 120
      ) {

        continue;

      }


      const match =
        text.match(
          /^現在\s*([\d,]+)\s*円/
        );


      if (
        !match
      ) {

        continue;

      }


      const price =
        Number(
          match[1]
            .replace(/,/g, '')
        );


      if (
        !Number.isFinite(price) ||
        price <= 0
      ) {

        continue;

      }


      directCandidates.push({
        price,
        sourceText: text
      });

    }


    if (
      directCandidates.length > 0
    ) {

      directCandidates.sort(
        (a, b) =>
          a.sourceText.length -
          b.sourceText.length
      );


      return {
        ok: true,
        price: directCandidates[0].price,
        sourceText: directCandidates[0].sourceText,
        method: 'DIRECT_CURRENT_BLOCK'
      };

    }


    // ========================================================
    // 見つからなければデバッグ情報だけ返す
    // ========================================================

    const debugTexts =
      all
        .map(el =>
          clean(el.innerText)
        )
        .filter(text =>
          text &&
          text.includes('現在') &&
          text.length <= 200
        )
        .slice(0, 10);


    return {
      ok: false,
      price: 0,
      sourceText: '',
      method: '',
      debugTexts
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

        locale: 'ja-JP',

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
          result.debugTexts
        ) {

          console.log(
            'DEBUG:',
            result.debugTexts
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
      // Yahooオークション価格は通常下がらない。
      // 台帳価格未満なら誤取得として拒否。
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
