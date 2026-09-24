const { chromium } = require('playwright');


// ============================================================
// 基本設定
//
// 検索条件は「市場監視設定」から取得する。
// 1条件あたりの取得件数は、現在の小規模本番を維持して10件。
// ============================================================

const MARKET =
  'メルカリ';

const MAX_SEARCH_ITEMS =
  10;


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
// 市場監視設定取得
//
// market-ingest の getConfig を使用し、
// 「市場監視設定」で ON のMercari条件だけ取得する。
//
// 検索URL / 条件IDはコードへ固定しない。
// ============================================================

async function getMercariConfigs() {

  console.log(
    '=============================='
  );

  console.log(
    'Mercari 市場監視設定を取得'
  );


  const response =
    await fetch(
      INGEST_URL,
      {
        method:
          'POST',

        headers: {
          'Content-Type':
            'application/json'
        },

        body:
          JSON.stringify({
            secret:
              INGEST_SECRET,

            action:
              'getConfig',

            market:
              MARKET
          }),

        redirect:
          'follow'
      }
    );


  const text =
    await response.text();


  let result;


  try {

    result =
      JSON.parse(text);

  } catch (error) {

    console.log(
      'Apps Script Response:',
      text
    );

    throw new Error(
      'Config応答がJSONではありません'
    );

  }


  if (!response.ok) {

    throw new Error(
      'Config HTTP失敗: ' +
      response.status
    );

  }


  if (!result.ok) {

    throw new Error(
      'Config取得失敗: ' +
      text
    );

  }


  const configs =
    Array.isArray(
      result.configs
    )
      ? result.configs
      : [];


  const validConfigs = [];


  for (
    let i = 0;
    i < configs.length;
    i++
  ) {

    const config =
      configs[i];


    if (
      !config ||
      config.market !== MARKET
    ) {

      console.log(
        '⚠️ Mercari以外の設定をスキップ:',
        config && config.conditionId
          ? config.conditionId
          : 'UNKNOWN'
      );

      continue;

    }


    if (
      !config.conditionId ||
      !config.searchUrl
    ) {

      throw new Error(
        '市場監視設定が不正です: ' +
        JSON.stringify(config)
      );

    }


    validConfigs.push(
      config
    );


    console.log(
      '------------------------------'
    );

    console.log(
      `[${validConfigs.length}]`,
      config.conditionId,
      config.searchName || ''
    );

    console.log(
      '監視頻度:',
      config.intervalMinutes,
      '分'
    );

    console.log(
      '検索URL:',
      config.searchUrl
    );

  }


  console.log(
    'Mercari ON条件:',
    validConfigs.length,
    '件'
  );


  return validConfigs;

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
  page,
  maxItems
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
      maxItems
    );

}


// ============================================================
// Apps Scriptへ送信
// ============================================================

async function sendToAppsScript(
  items,
  conditionId
) {

  const payload = {

    secret:
      INGEST_SECRET,

    market:
      MARKET,

    conditionId:
      conditionId,

    items:
      items

  };


  const requestBody =
    JSON.stringify(
      payload
    );


  const requestHeaders = {

    'Content-Type':
      'application/json'

  };


  let currentUrl =
    INGEST_URL;


  let response =
    null;


  let text =
    '';


  let completed =
    false;


  for (
    let hop = 0;
    hop < 6;
    hop++
  ) {

    response =
      await fetch(
        currentUrl,
        {

          method:
            'POST',

          redirect:
            'manual',

          headers:
            requestHeaders,

          body:
            requestBody

        }
      );


    console.log(
      'Apps Script Initial HTTP:',
      response.status
    );


    if (
      response.status !== 301 &&
      response.status !== 302 &&
      response.status !== 303 &&
      response.status !== 307 &&
      response.status !== 308
    ) {

      text =
        await response.text();

      completed =
        true;

      break;

    }


    const location =
      response.headers.get(
        'location'
      );


    if (!location) {

      throw new Error(
        'Apps Scriptリダイレクト先URLがありません'
      );

    }


    const redirectUrl =
      new URL(
        location,
        currentUrl
      );


    console.log(
      'Apps Script Redirect:',
      response.status,
      redirectUrl.hostname
    );


    if (
      redirectUrl.hostname ===
      'script.googleusercontent.com'
    ) {

      response =
        await fetch(
          redirectUrl.toString(),
          {

            method:
              'GET',

            redirect:
              'follow'

          }
        );


      text =
        await response.text();


      completed =
        true;


      break;

    }


    if (
      redirectUrl.hostname !==
      'script.google.com'
    ) {

      throw new Error(
        '想定外のApps Scriptリダイレクト先: ' +
        redirectUrl.hostname
      );

    }


    currentUrl =
      redirectUrl.toString();

  }


  if (
    !completed ||
    !response
  ) {

    throw new Error(
      'Apps Scriptリダイレクト回数が上限を超えました'
    );

  }


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
      'Apps Script送信失敗: HTTP ' +
      response.status +
      ' / ' +
      text
    );

  }


  let result;


  try {

    result =
      JSON.parse(
        text
      );

  } catch (error) {

    throw new Error(
      'Apps Script応答解析失敗: ' +
      text
    );

  }


  if (
    result.ok !== true
  ) {

    throw new Error(
      'Apps Script側エラー: ' +
      text
    );

  }


  return result;

}


// ============================================================
// 1条件分のMercari検索
// ============================================================

async function scanMercariCondition(
  page,
  config
) {

  console.log(
    '=============================='
  );

  console.log(
    '条件:',
    config.conditionId,
    config.searchName || ''
  );

  console.log(
    'Mercari検索ページを開きます'
  );


  await page.goto(
    config.searchUrl,
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
      page,
      MAX_SEARCH_ITEMS
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
      config.conditionId +
      ' 商品を1件も取得できませんでした'
    );

  }


  const result =
    await sendToAppsScript(
      items,
      config.conditionId
    );


  console.log(
    '------------------------------'
  );

  console.log(
    '条件ID:',
    config.conditionId
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


  return result;

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
    MARKET
  );


  // ========================================================
  // 市場監視設定からMercariのON条件を取得
  // ========================================================

  const configs =
    await getMercariConfigs();


  if (
    configs.length === 0
  ) {

    console.log(
      '=============================='
    );

    console.log(
      'MercariのON監視条件が0件のため終了します'
    );

    return;

  }


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

    for (
      let i = 0;
      i < configs.length;
      i++
    ) {

      const config =
        configs[i];


      console.log(
        '=============================='
      );

      console.log(
        `[条件 ${i + 1}/${configs.length}]`,
        config.conditionId,
        config.searchName || ''
      );


      await scanMercariCondition(
        page,
        config
      );


      await page.waitForTimeout(
        500
      );

    }


    console.log(
      '=============================='
    );

    console.log(
      '✅ Mercari Config Discovery + Monitor SUCCESS'
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
