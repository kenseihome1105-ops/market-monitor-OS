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


    function findPriceInside(root) {

      if (!root) {
        return null;
      }


      const elements =
        Array.from(
          root.querySelectorAll('*')
        );


      const labels =
        elements.filter(el => {
          return clean(el.innerText) === '現在';
        });


      const candidates =
        [];


      for (const label of labels) {

        let node =
          label.parentElement;


        for (
          let depth = 0;
          depth < 7 && node;
          depth++
        ) {

          if (
            !root.contains(node)
          ) {
            break;
          }


          const text =
            clean(
              node.innerText
            );


          const match =
            text.match(
              /^現在\s*([\d,]+)\s*円/
            );


          if (match) {

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

                sourceText:
                  text,

                textLength:
                  text.length,

                depth

              });

            }

          }


          node =
            node.parentElement;

        }

      }


      if (
        candidates.length === 0
      ) {

        return null;

      }


      candidates.sort(
        (a, b) => {

          if (
            a.textLength !==
            b.textLength
          ) {

            return (
              a.textLength -
              b.textLength
            );

          }


          return (
            a.depth -
            b.depth
          );

        }
      );


      return candidates[0];

    }


    // ========================================================
    // ① h1の商品タイトルから親を上へ辿る
    //
    // 「入札する」ボタンと「現在」が両方ある
    // 最小エリアを本体商品エリアとする
    // ========================================================

    const h1s =
      Array.from(
        document.querySelectorAll('h1')
      )
        .filter(el =>
          clean(el.innerText)
        );


    for (const h1 of h1s) {

      let root =
        h1;


      for (
        let depth = 0;
        depth < 12;
        depth++
      ) {

        root =
          root.parentElement;


        if (!root) {
          break;
        }


        const actionElements =
          Array.from(
            root.querySelectorAll(
              'button, a'
            )
          );


        const hasBidButton =
          actionElements.some(el => {

            const text =
              clean(
                el.innerText
              );


            return (
              text === '入札する' ||
              text.startsWith('入札')
            );

          });


        if (!hasBidButton) {
          continue;
        }


        const hasCurrentLabel =
          Array.from(
            root.querySelectorAll('*')
          )
            .some(el =>
              clean(el.innerText) ===
              '現在'
            );


        if (!hasCurrentLabel) {
          continue;
        }


        const result =
          findPriceInside(root);


        if (result) {

          return {

            ok: true,

            price:
              result.price,

            sourceText:
              result.sourceText,

            method:
              'H1_AND_BID_AREA',

            title:
              clean(
                h1.innerText
              )

          };

        }

      }

    }


    // ========================================================
    // ② h1側で見つからない場合
    //
    // 「入札する」ボタンから親を上へ辿り、
    // 現在価格を含む最小エリアだけを見る
    // ========================================================

    const bidButtons =
      Array.from(
        document.querySelectorAll(
          'button, a'
        )
      )
        .filter(el => {

          const text =
            clean(
              el.innerText
            );


          return (
            text === '入札する' ||
            text.startsWith('入札')
          );

        });


    for (const button of bidButtons) {

      let root =
        button;


      for (
        let depth = 0;
        depth < 10;
        depth++
      ) {

        root =
          root.parentElement;


        if (!root) {
          break;
        }


        const result =
          findPriceInside(root);


        if (result) {

          return {

            ok: true,

            price:
              result.price,

            sourceText:
              result.sourceText,

            method:
              'BID_BUTTON_AREA',

            title:
              ''

          };

        }

      }

    }


    // ========================================================
    // 取得失敗時の診断
    //
    // 価格としては絶対採用しない
    // ========================================================

    const exactCurrentCount =
      Array.from(
        document.querySelectorAll('*')
      )
        .filter(el =>
          clean(el.innerText) ===
          '現在'
        )
        .length;


    const h1Texts =
      h1s
        .map(el =>
          clean(el.innerText)
        )
        .slice(0, 5);


    const actionTexts =
      Array.from(
        document.querySelectorAll(
          'button, a'
        )
      )
        .map(el =>
          clean(el.innerText)
        )
        .filter(text =>
          text.includes('入札')
        )
        .slice(0, 10);


    return {

      ok: false,

      price: 0,

      sourceText: '',

      method: '',

      debug: {

        pageTitle:
          document.title,

        currentUrl:
          location.href,

        h1Texts,

        actionTexts,

        exactCurrentCount,

        bodyPreview:
          clean(
            document.body.innerText
          ).slice(
            0,
            500
          )

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
        2500
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
            JSON.stringify(
              result.debug,
              null,
              2
            )
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


      if (
        result.title
      ) {

        console.log(
          '商品タイトル:',
          result.title
        );

      }


      // ======================================================
      // オークションの現在価格が
      // 既知価格より下がる値は拒否
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
