const { chromium } = require('playwright');


// ============================================================
// 初期テスト設定
//
// まずは M-01 / GUCCI スーツだけ。
// さらに最初は10件だけ送る。
// 正常動作確認後に件数を増やす。
// ============================================================

const CONDITION = {

  market:
    'メルカリ',

  conditionId:
    'M-01',

  searchUrl:
    'https://jp.mercari.com/search?category_id=35&keyword=%E3%82%B0%E3%83%83%E3%83%81+%E3%82%B9%E3%83%BC%E3%83%84&order=desc&price_max=29000&sort=created_time&status=on_sale',

  maxItems:
    10

};


// ============================================================
// 必須Secret
// ============================================================

const INGEST_URL =
  process.env.MARKET_INGEST_URL;

const INGEST_SECRET =
  process.env.MARKET_INGEST_SECRET;


if (
  !INGEST_URL ||
  !INGEST_SECRET
) {

  throw new Error(
    'GitHub Secrets が設定されていません'
  );

}


// ============================================================
// Mercari URL → 商品ID
// ============================================================

function parseMercariUrl(href) {

  try {

    const url =
      new URL(
        href,
        'https://jp.mercari.com'
      );


    // 通常商品
    const normal =
      url.pathname.match(
        /^\/item\/(m\d+)/i
      );


    if (normal) {

      return {

        itemId:
          normal[1],

        url:
          `https://jp.mercari.com/item/${normal[1]}`

      };

    }


    // Mercari Shops
    const shop =
      url.pathname.match(
        /^\/shops\/product\/([A-Za-z0-9_-]+)/i
      );


    if (shop) {

      return {

        itemId:
          `shops:${shop[1]}`,

        url:
          `https://jp.mercari.com/shops/product/${shop[1]}`

      };

    }


    return null;


  } catch (error) {

    return null;

  }

}


// ============================================================
// 地域確認などが出た場合だけ押す
// ============================================================

async function dismissRegionGate(page) {

  const patterns = [

    /日本の商品を見る/i,
    /日本で続行/i,
    /日本で見る/i,
    /^続ける$/i,
    /^Continue$/i

  ];


  for (
    const pattern
    of patterns
  ) {

    try {

      const button =
        page
          .getByRole(
            'button',
            {
              name:
                pattern
            }
          )
          .first();


      if (
        await button.isVisible({
          timeout: 700
        })
      ) {

        await button.click();

        await page.waitForTimeout(
          1500
        );

        console.log(
          '地域確認を処理しました'
        );

        return;

      }

    } catch (error) {

      // ボタンがなければ無視

    }

  }

}


// ============================================================
// 商品が読み込まれるまで軽くスクロール
// ============================================================

async function loadListings(page) {

  for (
    let i = 0;
    i < 6;
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
      700
    );

  }


  await page.evaluate(
    () => {

      window.scrollTo(
        0,
        0
      );

    }
  );

}


// ============================================================
// Mercari商品抽出
// ============================================================

async function extractMercariItems(
  page
) {

  const raw =
    await page.evaluate(
      () => {

        const yenRegex =
          /[¥￥]\s*([\d,]+)/;


        const anchors =
          Array.from(
            document.querySelectorAll(
              'a[href*="/item/m"], a[href*="/shops/product/"]'
            )
          );


        const results =
          [];


        for (
          const anchor
          of anchors
        ) {

          const href =
            anchor.href ||
            anchor.getAttribute(
              'href'
            ) ||
            '';


          if (!href) {

            continue;

          }


          // ----------------------------------------------
          // 商品カード全体っぽい親要素を探す
          // ----------------------------------------------

          let node =
            anchor;


          let cardText =
            '';


          for (
            let depth = 0;
            depth < 7 &&
            node;
            depth++
          ) {

            const text =
              String(
                node.innerText || ''
              )
                .replace(
                  /\s+/g,
                  ' '
                )
                .trim();


            if (
              yenRegex.test(
                text
              )
              &&
              text.length < 1000
            ) {

              cardText =
                text;

              break;

            }


            node =
              node.parentElement;

          }


          const priceMatch =
            cardText.match(
              yenRegex
            );


          if (!priceMatch) {

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


          if (!price) {

            continue;

          }


          // ----------------------------------------------
          // タイトル取得
          // ----------------------------------------------

          let title =
            String(
              anchor.getAttribute(
                'aria-label'
              ) ||
              ''
            )
              .trim();


          if (!title) {

            const image =
              anchor.querySelector(
                'img'
              );


            if (image) {

              title =
                String(
                  image.getAttribute(
                    'alt'
                  ) ||
                  ''
                )
                  .trim();

            }

          }


          if (!title) {

            title =
              String(
                anchor.innerText ||
                ''
              )
                .replace(
                  /[¥￥]\s*[\d,]+/g,
                  ' '
                )
                .replace(
                  /\s+/g,
                  ' '
                )
                .trim();

          }


          if (
            !title &&
            cardText
          ) {

            title =
              cardText
                .replace(
                  /[¥￥]\s*[\d,]+/g,
                  ' '
                )
                .replace(
                  /\s+/g,
                  ' '
                )
                .trim();

          }


          if (!title) {

            continue;

          }


          results.push({

            href,
            title,
            price

          });

        }


        return results;

      }
    );


  // ========================================================
  // 同じ商品URLがDOM内に複数あっても1件にする
  // ========================================================

  const map =
    new Map();


  for (
    const row
    of raw
  ) {

    const parsed =
      parseMercariUrl(
        row.href
      );


    if (!parsed) {

      continue;

    }


    const existing =
      map.get(
        parsed.itemId
      );


    if (!existing) {

      map.set(
        parsed.itemId,
        {

          itemId:
            parsed.itemId,

          url:
            parsed.url,

          title:
            row.title,

          price:
            row.price

        }
      );


    } else {

      // タイトルが複数候補ある場合は長い方を採用

      if (
        row.title.length >
        existing.title.length
      ) {

        existing.title =
          row.title;

      }


      if (
        row.price
      ) {

        existing.price =
          row.price;

      }

    }

  }


  return Array
    .from(
      map.values()
    )
    .slice(
      0,
      CONDITION.maxItems
    );

}


// ============================================================
// Apps Scriptへ送信
// ============================================================

async function sendToAppsScript(
  items
) {

  const payload = {

    secret:
      INGEST_SECRET,

    market:
      CONDITION.market,

    conditionId:
      CONDITION.conditionId,

    items:
      items

  };


  const response =
    await fetch(
      INGEST_URL,
      {

        method:
          'POST',

        redirect:
          'follow',

        headers: {

          'Content-Type':
            'application/json'

        },

        body:
          JSON.stringify(
            payload
          )

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


  if (
    !response.ok
  ) {

    throw new Error(
      'Apps Script送信失敗'
    );

  }


  try {

    const result =
      JSON.parse(
        text
      );


    if (
      result.ok !== true
    ) {

      throw new Error(
        'Apps Script側エラー: ' +
        text
      );

    }


    return result;


  } catch (error) {

    throw new Error(
      'Apps Script応答解析失敗: ' +
      text
    );

  }

}


// ============================================================
// メイン
// ============================================================

async function main() {

  console.log(
    '=============================='
  );

  console.log(
    'Market Monitor OS START'
  );

  console.log(
    '市場:',
    CONDITION.market
  );

  console.log(
    '条件:',
    CONDITION.conditionId
  );

  console.log(
    '=============================='
  );


  const browser =
    await chromium.launch(
      {

        headless:
          true,

        args: [

          '--no-sandbox',

          '--disable-dev-shm-usage'

        ]

      }
    );


  const context =
    await browser.newContext(
      {

        locale:
          'ja-JP',

        timezoneId:
          'Asia/Tokyo',

        viewport: {

          width:
            1440,

          height:
            1200

        },

        userAgent:
          'Mozilla/5.0 (X11; Linux x86_64) ' +
          'AppleWebKit/537.36 (KHTML, like Gecko) ' +
          'Chrome/140.0.0.0 Safari/537.36'

      }
    );


  const page =
    await context.newPage();


  try {

    console.log(
      'Mercari検索ページを開きます'
    );


    await page.goto(
      CONDITION.searchUrl,
      {

        waitUntil:
          'domcontentloaded',

        timeout:
          60000

      }
    );


    await dismissRegionGate(
      page
    );


    await page.waitForTimeout(
      2500
    );


    await loadListings(
      page
    );


    const items =
      await extractMercariItems(
        page
      );


    console.log(
      '取得商品数:',
      items.length
    );


    for (
      const item
      of items
    ) {

      console.log(
        item.itemId,
        item.price,
        item.title
      );

    }


    if (
      items.length === 0
    ) {

      throw new Error(
        '商品を1件も取得できませんでした'
      );

    }


    const result =
      await sendToAppsScript(
        items
      );


    console.log(
      '=============================='
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
      'Market Monitor OS SUCCESS'
    );

    console.log(
      '=============================='
    );


  } finally {

    await page.close();

    await context.close();

    await browser.close();

  }

}


main()
  .catch(
    error => {

      console.error(
        'MONITOR ERROR'
      );

      console.error(
        error
      );


      process.exit(
        1
      );

    }
  );
