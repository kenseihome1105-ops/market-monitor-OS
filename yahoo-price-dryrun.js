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


async function extractMainPrice(page) {

  return await page.evaluate(() => {

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


    // ========================================================
    // ① 商品タイトル
    // ========================================================

    const h1 =
      Array.from(
        document.querySelectorAll('h1')
      )
        .find(el =>
          clean(el.innerText)
        );


    if (!h1) {

      return {
        ok: false,
        reason: 'H1_NOT_FOUND'
      };

    }


    // ========================================================
    // ② 本体アクションボタン
    //
    // このボタンより後ろにある価格は絶対に使わない
    // ========================================================

    const actionCandidates =
      Array.from(
        document.querySelectorAll(
          'button, a'
        )
      )
        .filter(el => {

          if (!isAfter(el, h1)) {
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
            text.startsWith('入札する') ||
            text.startsWith('今すぐ落札')
          );

        });


    const actionButton =
      actionCandidates[0] || null;


    // ========================================================
    // ③ おすすめ欄開始位置
    //
    // アクションボタンが取れない場合の安全弁
    // ========================================================

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

          if (!isAfter(el, h1)) {
            return false;
          }


          const text =
            clean(
              el.innerText
            );


          return recommendationWords.some(
            word =>
              text.includes(word)
          );

        })[0] || null;


    // ========================================================
    // ④ 本体範囲
    //
    // h1の後ろ
    // かつ
    // 本体アクションボタンより前
    //
    // ボタンがなければおすすめ欄より前
    // ========================================================

    const boundary =
      actionButton ||
      recommendationHeading ||
      null;


    const allElements =
      Array.from(
        document.querySelectorAll(
          'body *'
        )
      );


    const candidates =
      [];


    for (
      let index = 0;
      index < allElements.length;
      index++
    ) {

      const el =
        allElements[index];


      if (
        el === h1 ||
        !isAfter(el, h1)
      ) {

        continue;

      }


      if (
        boundary &&
        !isBefore(el, boundary)
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


      // ======================================================
      // Yahoo本体価格として許可するラベル
      //
      // 現在 = オークション現在価格
      // 価格 = 通常オークション価格表示
      // 即決 = 固定/即決価格
      // ======================================================

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
        !Number.isFinite(price) ||
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


    // ========================================================
    // ⑤ 候補なし
    // ========================================================

    if (
      candidates.length === 0
    ) {

      return {

        ok: false,

        reason:
          'MAIN_PRICE_NOT_FOUND',

        debug: {

          pageTitle:
            document.title,

          currentUrl:
            location.href,

          h1:
            clean(
              h1.innerText
            ),

          actionButton:
            actionButton
              ? clean(
                  actionButton.innerText
                )
              : '',

          recommendationHeading:
            recommendationHeading
              ? clean(
                  recommendationHeading.innerText
                )
              : '',

          bodyPreview:
            clean(
              document.body.innerText
            ).slice(
              0,
              1000
            )

        }

      };

    }


    // ========================================================
    // ⑥ 重複排除
    //
    // span / div / 親要素などで
    // 同じ価格が複数回取れることがある
    // ========================================================

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


    // ========================================================
    // ⑦ 優先順位
    //
    // 現在価格があれば最優先
    // ↓
    // 通常の「価格」
    // ↓
    // 即決のみの商品は即決価格
    // ========================================================

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


    return {

      ok: true,

      price:
        selected.price,

      label:
        selected.label,

      sourceText:
        selected.sourceText,

      method:
        'H1_TO_MAIN_ACTION',

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

      candidates:
        uniqueCandidates.map(
          candidate => ({
            label:
              candidate.label,

            price:
              candidate.price,

            sourceText:
              candidate.sourceText
          })
        )

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
        await extractMainPrice(
          page
        );


      if (
        !result ||
        !result.ok
      ) {

        console.log(
          '❌ 本体価格を取得できません'
        );


        console.log(
          'DEBUG:',
          JSON.stringify(
            result,
            null,
            2
          )
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
        '価格ラベル:',
        result.label
      );


      console.log(
        '取得方式:',
        result.method
      );


      console.log(
        '取得元:',
        result.sourceText
      );


      console.log(
        '商品タイトル:',
        result.title
      );


      console.log(
        '本体ボタン:',
        result.actionButton
      );


      console.log(
        '価格候補:',
        result.candidates
      );


      // ======================================================
      // 現在価格/通常オークション価格は
      // 原則として既知価格より下がらない
      //
      // 「即決」は出品者が価格変更できるため
      // 下落をエラー扱いしない
      // ======================================================

      if (
        result.label !== '即決' &&
        result.price <
        item.knownPrice
      ) {

        console.log(
          '❌ 異常: オークション価格が台帳価格より低い'
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
