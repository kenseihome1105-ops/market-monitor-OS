const { chromium } = require('playwright');

const MARKET_INGEST_URL = process.env.MARKET_INGEST_URL;
const MARKET_INGEST_SECRET = process.env.MARKET_INGEST_SECRET;

const MARKET = 'ヤフオク';

const MAX_SEARCH_ITEMS = 10;
const MAX_TRACKED_ITEMS = 30;


// ============================================================
// Yahoo Market Comps 接続設定
//
// market-ingest が返す insertedItems
// (= DB同定済み + 相場比較データ0件) を
// Yahoo終了180日相場へ接続する。
// ============================================================

const MARKET_COMPS_SOURCE_VERSION =
  'yahoo-comps-v3-dbmeta';

const MARKET_COMPS_MAX_ITEMS =
  marketCompsPositiveInt_(
    process.env.COMP_MAX_ITEMS,
    30
  );

const MARKET_COMPS_TIMEOUT_MS =
  marketCompsPositiveInt_(
    process.env.COMP_TIMEOUT_MS,
    60000
  );

const MARKET_COMPS_FALLBACK_CATEGORY_ID =
  String(
    process.env.COMP_CATEGORY_ID ||
    '0'
  ).trim() || '0';

const INGEST_URL =
  MARKET_INGEST_URL;

const INGEST_SECRET =
  MARKET_INGEST_SECRET;

const APPS_SCRIPT_MAX_ATTEMPTS = 5;

const APPS_SCRIPT_RETRY_DELAYS_MS = [
  0,
  2500,
  6000,
  12000,
  20000
];

function sleep_(milliseconds) {
  return sleep(milliseconds);
}

function isRetryableAppsScriptStatus_(status) {
  return [
    404,
    408,
    425,
    429,
    500,
    502,
    503,
    504
  ].includes(Number(status));
}

function looksLikeAppsScriptHtml_(text, contentType) {
  const normalizedContentType =
    String(contentType || '').toLowerCase();

  const normalizedText =
    String(text || '').trim();

  return (
    normalizedContentType.includes('text/html') ||
    /^<!doctype\s+html/i.test(normalizedText) ||
    /^<html/i.test(normalizedText)
  );
}

async function postAppsScriptJson(payload, label) {
  let lastError = null;

  for (
    let attempt = 1;
    attempt <= APPS_SCRIPT_MAX_ATTEMPTS;
    attempt++
  ) {
    const delayMs =
      Number(
        APPS_SCRIPT_RETRY_DELAYS_MS[attempt - 1] ||
        0
      );

    if (delayMs > 0) {
      console.warn(
        `[${label}] retry wait:`,
        delayMs,
        'ms'
      );

      await sleep_(delayMs);
    }

    console.log(
      `[${label}] Attempt:`,
      `${attempt}/${APPS_SCRIPT_MAX_ATTEMPTS}`
    );

    let response;

    try {
      response = await fetch(
        INGEST_URL,
        {
          method: 'POST',
          redirect: 'follow',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload)
        }
      );
    } catch (error) {
      lastError = new Error(
        `${label}通信失敗: ${
          error && error.message
            ? error.message
            : String(error)
        }`
      );

      if (attempt < APPS_SCRIPT_MAX_ATTEMPTS) {
        continue;
      }

      throw lastError;
    }

    const text = await response.text();
    const contentType =
      response.headers.get('content-type') || '';

    if (!response.ok) {
      lastError = new Error(
        `${label} HTTP失敗: ${response.status}`
      );

      if (
        isRetryableAppsScriptStatus_(response.status) &&
        attempt < APPS_SCRIPT_MAX_ATTEMPTS
      ) {
        continue;
      }

      throw lastError;
    }

    let result;

    try {
      result = JSON.parse(text);
    } catch (error) {
      lastError = new Error(
        `${label}応答がJSONではありません`
      );

      const retryableBody =
        looksLikeAppsScriptHtml_(text, contentType) ||
        !String(contentType || '')
          .toLowerCase()
          .includes('json');

      if (
        retryableBody &&
        attempt < APPS_SCRIPT_MAX_ATTEMPTS
      ) {
        continue;
      }

      throw lastError;
    }

    if (result.ok !== true) {
      throw new Error(
        `${label}側エラー: ${JSON.stringify(result)}`
      );
    }

    return result;
  }

  throw (
    lastError ||
    new Error(`${label} Apps Script通信に失敗しました`)
  );
}


// ============================================================
// 共通
// ============================================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


// ============================================================
// Apps Script送信
// ============================================================

async function sendToAppsScript(items, conditionId) {

  if (!MARKET_INGEST_URL) {
    throw new Error('MARKET_INGEST_URL が設定されていません');
  }

  if (!MARKET_INGEST_SECRET) {
    throw new Error('MARKET_INGEST_SECRET が設定されていません');
  }


  const payload = {
    secret: MARKET_INGEST_SECRET,
    market: MARKET,
    conditionId,
    items
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


  const text = await response.text();

  let result;


  try {

    result = JSON.parse(text);

  } catch (error) {

    console.log(
      'Apps Script Response:',
      text
    );

    throw new Error(
      'Apps Script応答がJSONではありません'
    );

  }


  if (!response.ok) {
    throw new Error(
      'Apps Script HTTP失敗: ' +
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
// 市場監視設定取得
//
// market-ingest の getConfig を使用し、
// 「市場監視設定」で ON のYahoo条件だけ取得する。
//
// 検索URL / 条件IDはコードへ固定しない。
// ============================================================

async function getYahooConfigs() {

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


  console.log(
    '=============================='
  );

  console.log(
    '市場監視設定を取得'
  );


  const response =
    await fetch(
      MARKET_INGEST_URL,
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
              MARKET_INGEST_SECRET,

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
        '⚠️ Yahoo以外の設定をスキップ:',
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
    'Yahoo ON条件:',
    validConfigs.length,
    '件'
  );


  return validConfigs;

}


// ============================================================
// Yahoo Market Comps
//
// market-comps-yahoo-dryrun.js で確認済みの
// 「Yahoo終了180日間」取得方式を monitor.js に統合。
//
// 重要:
// ・DB同定済みのMarket Comps対象(insertedItems)だけを対象にする
// ・既存Yahoo監視の成否は相場取得失敗で壊さない
// ・市場監視台帳へ直接書かない
// ・相場比較データへの書込は market-ingest 経由のみ
// ============================================================


function marketCompsPositiveInt_(
  value,
  fallback
) {


  const number =
    Number(
      value
    );




  if (
    !Number.isInteger(
      number
    )
    ||
    number <= 0
  ) {


    return fallback;


  }




  return number;


}




function normalizeMarketCompsSpace_(
  value
) {


  return String(
    value || ''
  )
    .replace(
      /\u00a0/g,
      ' '
    )
    .replace(
      /\s+/g,
      ' '
    )
    .trim();


}




function parseMarketCompsYen_(
  value
) {


  const number =
    Number(
      String(
        value == null
          ? ''
          : value
      )
        .replace(
          /,/g,
          ''
        )
        .replace(
          /[¥￥円\s]/g,
          ''
        )
    );




  return Number.isFinite(
    number
  )
    ? number
    : null;


}




function escapeMarketCompsRegExp_(
  value
) {


  return String(
    value || ''
  ).replace(
    /[.*+?^${}()|[\]\\]/g,
    '\\$&'
  );


}




function firstMarketCompsYenAfter_(
  text,
  label
) {


  const escaped =
    escapeMarketCompsRegExp_(
      label
    );




  const match =
    String(
      text || ''
    ).match(
      new RegExp(
        escaped +
        '\\s*([\\d,]+)\\s*円'
      )
    );




  return match
    ? parseMarketCompsYen_(
        match[1]
      )
    : null;


}




function extractMarketCompsResultCount_(
  text
) {


  const matches =
    [
      ...String(
        text || ''
      ).matchAll(
        /([\d,]+)\s*件/g
      )
    ];




  if (
    !matches.length
  ) {


    return null;


  }




  const numbers =
    matches
      .map(
        match =>
          Number(
            String(
              match[1]
            ).replace(
              /,/g,
              ''
            )
          )
      )
      .filter(
        Number.isFinite
      );




  return numbers.length
    ? Math.max(
        ...numbers
      )
    : null;


}




function buildYahooClosedSearchUrl_(
  query,
  categoryId
) {


  if (
    !query
  ) {


    throw new Error(
      'Yahoo Market Comps: 検索語が空です'
    );


  }




  if (
    !categoryId
  ) {


    throw new Error(
      'Yahoo Market Comps: categoryIdが空です'
    );


  }




  return (
    'https://auctions.yahoo.co.jp/' +
    'closedsearch/closedsearch/' +
    encodeURIComponent(
      query
    ) +
    '/' +
    encodeURIComponent(
      categoryId
    ) +
    '?n=50'
  );


}




async function extractYahooMarketCompsSummary_(
  page
) {


  const body =
    await page
      .locator(
        'body'
      )
      .innerText();




  const text =
    String(
      body || ''
    );




  return {


    minPrice:
      firstMarketCompsYenAfter_(
        text,
        '最安'
      ),


    averagePrice:
      firstMarketCompsYenAfter_(
        text,
        '平均'
      ),


    maxPrice:
      firstMarketCompsYenAfter_(
        text,
        '最高'
      ),


    resultCount:
      extractMarketCompsResultCount_(
        text
      )


  };


}




async function extractYahooClosedItems_(
  page,
  limit
) {


  return await page.evaluate(
    ({ limit }) => {


      function clean(
        value
      ) {


        return String(
          value || ''
        )
          .replace(
            /\u00a0/g,
            ' '
          )
          .replace(
            /[ \t]+/g,
            ' '
          )
          .replace(
            /\n{3,}/g,
            '\n\n'
          )
          .trim();


      }




      function absoluteUrl(
        href
      ) {


        try {


          return new URL(
            href,
            location.href
          ).href;


        } catch (error) {


          return '';


        }


      }




      function findCard(
        anchor
      ) {


        let node =
          anchor;




        for (
          let depth = 0;
          depth < 10;
          depth++
        ) {


          node =
            node.parentElement;




          if (
            !node
          ) {


            break;


          }




          const text =
            clean(
              node.innerText
            );




          if (
            text.includes(
              '落札'
            )
            &&
            text.includes(
              '終了'
            )
            &&
            text.length <= 5000
          ) {


            return node;


          }


        }




        return null;


      }




      function bestTitle(
        card,
        itemHref
      ) {


        const links =
          Array.from(
            card.querySelectorAll(
              'a'
            )
          );




        const candidates =
          links
            .filter(
              link => {


                const href =
                  absoluteUrl(
                    link.getAttribute(
                      'href'
                    )
                  );




                return (
                  href
                  &&
                  href.split('#')[0] ===
                  itemHref.split('#')[0]
                );


              }
            )
            .map(
              link =>
                clean(
                  link.innerText
                  ||
                  link.getAttribute(
                    'aria-label'
                  )
                  ||
                  link.getAttribute(
                    'title'
                  )
                )
            )
            .filter(
              text =>
                text &&
                text.length >= 4
            )
            .sort(
              (
                a,
                b
              ) =>
                b.length -
                a.length
            );




        if (
          candidates.length
        ) {


          return candidates[0];


        }




        const heading =
          card.querySelector(
            'h1,h2,h3,h4'
          );




        return heading
          ? clean(
              heading.innerText
            )
          : '';


      }




      const anchors =
        Array.from(
          document.querySelectorAll(
            'a[href*="/jp/auction/"]'
          )
        );




      const seen =
        new Set();




      const results =
        [];




      for (
        const anchor
        of anchors
      ) {


        if (
          results.length >=
          limit
        ) {


          break;


        }




        const href =
          absoluteUrl(
            anchor.getAttribute(
              'href'
            )
          );




        if (
          !href
        ) {


          continue;


        }




        const idMatch =
          href.match(
            /\/jp\/auction\/([^/?#]+)/
          );




        if (
          !idMatch
        ) {


          continue;


        }




        const itemId =
          idMatch[1];




        if (
          seen.has(
            itemId
          )
        ) {


          continue;


        }




        const card =
          findCard(
            anchor
          );




        if (
          !card
        ) {


          continue;


        }




        const text =
          clean(
            card.innerText
          );




        const priceMatch =
          text.match(
            /落札\s*([\d,]+)\s*円/
          );




        const endMatch =
          text.match(
            /(\d{1,2}\/\d{1,2})\s+(\d{1,2}:\d{2})\s*終了/
          );




        if (
          !priceMatch ||
          !endMatch
        ) {


          continue;


        }




        const title =
          bestTitle(
            card,
            href
          );




        if (
          !title
        ) {


          continue;


        }




        const stateCandidates = [


          '新品、未使用',


          '未使用に近い',


          '目立った傷や汚れなし',


          'やや傷や汚れあり',


          '傷や汚れあり',


          '全体的に状態が悪い',


          '未使用'


        ];




        let condition =
          '';




        for (
          const state
          of stateCandidates
        ) {


          if (
            text.includes(
              state
            )
          ) {


            condition =
              state;




            break;


          }


        }




        const bidMatch =
          text.match(
            /(?:入札|入札件数)\s*[:：]?\s*(\d+)/
          );




        seen.add(
          itemId
        );




        results.push({


          itemId,


          url:
            href.split('#')[0],


          title,


          soldPriceText:
            priceMatch[1],


          endDateLabel:
            endMatch[1],


          endTimeLabel:
            endMatch[2],


          condition,


          bidCount:
            bidMatch
              ? Number(
                  bidMatch[1]
                )
              : null


        });


      }




      return results;


    },


    {
      limit
    }
  );


}




function parseYahooMarketCompsEndDate_(
  md,
  hm
) {


  const mdMatch =
    String(
      md || ''
    ).match(
      /^(\d{1,2})\/(\d{1,2})$/
    );




  const hmMatch =
    String(
      hm || ''
    ).match(
      /^(\d{1,2}):(\d{2})$/
    );




  if (
    !mdMatch ||
    !hmMatch
  ) {


    return null;


  }




  const month =
    Number(
      mdMatch[1]
    );




  const day =
    Number(
      mdMatch[2]
    );




  const hour =
    Number(
      hmMatch[1]
    );




  const minute =
    Number(
      hmMatch[2]
    );




  const now =
    new Date();




  const currentYear =
    Number(
      new Intl.DateTimeFormat(
        'en-US',
        {
          timeZone:
            'Asia/Tokyo',


          year:
            'numeric'
        }
      ).format(
        now
      )
    );




  let year =
    currentYear;




  let timestamp =
    Date.UTC(
      year,
      month - 1,
      day,
      hour - 9,
      minute,
      0
    );




  if (
    timestamp >
    now.getTime() +
    24 * 60 * 60 * 1000
  ) {


    year -= 1;




    timestamp =
      Date.UTC(
        year,
        month - 1,
        day,
        hour - 9,
        minute,
        0
      );


  }




  const date =
    new Date(
      timestamp
    );




  if (
    isNaN(
      date.getTime()
    )
  ) {


    return null;


  }




  return date.toISOString();


}




function normalizeYahooClosedItems_(
  rawItems,
  query,
  categoryId
) {


  return rawItems
    .map(
      item => {


        const soldPrice =
          parseMarketCompsYen_(
            item.soldPriceText
          );




        const endedAt =
          parseYahooMarketCompsEndDate_(
            item.endDateLabel,
            item.endTimeLabel
          );




        return {


          comparisonMarket:
            'ヤフオク',


          comparisonType:
            '成約',


          comparisonItemId:
            item.itemId,


          comparisonUrl:
            item.url,


          comparisonTitle:
            item.title,


          comparisonPrice:
            soldPrice,


          shipping:
            null,


          comparisonTotal:
            soldPrice,


          currency:
            'JPY',


          jpyTotal:
            soldPrice,


          endedAt,


          condition:
            item.condition ||
            '未取得',


          bidCount:
            item.bidCount,


          source:
            'Yahoo closedsearch',


          version:
            MARKET_COMPS_SOURCE_VERSION,


          query,


          categoryId


        };


      }
    )
    .filter(
      item =>
        item.comparisonItemId
        &&
        item.comparisonUrl
        &&
        item.comparisonTitle
        &&
        item.comparisonPrice
    );


}




function buildMarketCompsTarget_(
  insertedItem,
  config
) {


  const itemId =
    String(
      insertedItem &&
      insertedItem.itemId ||
      ''
    ).trim();




  const market =
    String(
      insertedItem &&
      insertedItem.market ||
      MARKET
    ).trim();




  const targetKey =
    String(
      insertedItem &&
      insertedItem.targetKey ||
      ''
    ).trim()
    ||
    [
      market,
      itemId
    ].join(
      '::'
    );




  return {


    targetKey,


    market,


    conditionId:
      String(
        insertedItem &&
        insertedItem.conditionId ||
        config.conditionId ||
        ''
      ).trim(),


    itemId,


    url:
      String(
        insertedItem &&
        insertedItem.url ||
        ''
      ).trim(),


    title:
      String(
        insertedItem &&
        insertedItem.title ||
        ''
      ).trim(),


    dbItemId:
      String(
        insertedItem &&
        insertedItem.dbItemId ||
        ''
      ).trim(),


    brand:
      String(
        insertedItem &&
        insertedItem.brand ||
        ''
      ).trim(),


    category:
      String(
        insertedItem &&
        insertedItem.category ||
        ''
      ).trim(),


    product:
      String(
        insertedItem &&
        insertedItem.product ||
        ''
      ).trim(),


    model:
      String(
        insertedItem &&
        insertedItem.model ||
        ''
      ).trim(),


    searchKeyword:
      String(
        insertedItem &&
        insertedItem.searchKeyword ||
        ''
      ).trim(),


    subCategory:
      String(
        insertedItem &&
        insertedItem.subCategory ||
        ''
      ).trim(),


    lineModel:
      String(
        insertedItem &&
        insertedItem.lineModel ||
        ''
      ).trim(),


    currentPrice:
      Number(
        insertedItem &&
        insertedItem.currentPrice ||
        insertedItem &&
        insertedItem.price ||
        0
      )


  };


}




function compactMarketCompsQueryText_(
  value
) {


  return String(
    value || ''
  )
    .replace(
      /のサムネイル$/i,
      ''
    )
    .replace(
      /[\/／|｜]+/g,
      ' '
    )
    .replace(
      /\s+/g,
      ' '
    )
    .trim();


}




function buildMarketCompsQuery_(
  insertedItem,
  config
) {


  // 商品マスター AA列「検索キーワード」を最優先。
  // config.searchName は監視条件名なので相場検索には使わない。


  const fromMaster =
    compactMarketCompsQueryText_(
      insertedItem &&
      insertedItem.searchKeyword ||
      ''
    );


  if (
    fromMaster
  ) {


    return fromMaster;
  }




  const brand =
    compactMarketCompsQueryText_(
      insertedItem &&
      insertedItem.brand ||
      ''
    );


  const product =
    compactMarketCompsQueryText_(
      insertedItem &&
      insertedItem.product ||
      ''
    );


  const subCategory =
    compactMarketCompsQueryText_(
      insertedItem &&
      insertedItem.subCategory ||
      ''
    );




  const parts =
    [];


  if (brand) {
    parts.push(
      brand
    );
  }


  if (product) {


    parts.push(
      product
    );


  } else if (
    subCategory
  ) {


    parts.push(
      subCategory
    );
  }




  const fromDbMeta =
    compactMarketCompsQueryText_(
      parts.join(
        ' '
      )
    );


  if (
    fromDbMeta
  ) {


    return fromDbMeta;
  }




  return compactMarketCompsQueryText_(
    insertedItem &&
    insertedItem.title ||
    ''
  );


}




function buildMarketCompsCategoryId_(
  insertedItem
) {


  const category =
    compactMarketCompsQueryText_(
      insertedItem &&
      insertedItem.category ||
      ''
    )
      .normalize(
        'NFKC'
      )
      .toUpperCase();


  const product =
    compactMarketCompsQueryText_(
      insertedItem &&
      insertedItem.product ||
      ''
    )
      .normalize(
        'NFKC'
      )
      .toUpperCase();


  const subCategory =
    compactMarketCompsQueryText_(
      insertedItem &&
      insertedItem.subCategory ||
      ''
    )
      .normalize(
        'NFKC'
      )
      .toUpperCase();




  const allText =
    [
      category,
      product,
      subCategory
    ].join(
      ' '
    );




  if (
    /レディース|WOMEN|WOMAN|LADIES/.test(
      allText
    )
  ) {


    return '0';
  }




  if (
    /スラックス/.test(
      product + ' ' + subCategory
    )
  ) {


    return '2084007077';
  }




  if (
    /メンズスーツ/.test(
      category
    )
    ||
    (
      !/レディース/.test(
        category
      )
      &&
      /(?:スーツ|SUIT)/.test(
        product + ' ' + subCategory
      )
    )
  ) {


    return '2084007041';
  }




  if (
    /(?:チェスターコート|ステンカラーコート|トレンチコート|ダッフルコート|ノーカラーコート)/.test(
      product
    )
  ) {


    return '2084007042';
  }




  if (
    /(?:テーラードジャケット|レザージャケット|スウィングトップ|スカジャン|スタジャン|ボンバージャケット|ダウンジャケット)/.test(
      product
    )
  ) {


    return '23196';
  }




  if (
    /(?:ニット|セーター)/.test(
      product
    )
    &&
    !/カーディガン/.test(
      product
    )
  ) {


    return '2084005282';
  }




  return (
    MARKET_COMPS_FALLBACK_CATEGORY_ID ||
    '0'
  );


}




async function runYahooMarketCompsForTarget_(
  page,
  insertedItem,
  config
) {


  const target =
    buildMarketCompsTarget_(
      insertedItem,
      config
    );




  const query =
    buildMarketCompsQuery_(
      insertedItem,
      config
    );




  const categoryId =
    buildMarketCompsCategoryId_(
      insertedItem
    );




  if (
    !target.itemId ||
    !target.url ||
    !target.title ||
    !target.currentPrice ||
    !target.dbItemId
  ) {


    throw new Error(
      'Yahoo Market Comps: DB同定済み対象の必須情報が不足しています: ' +
      JSON.stringify(
        target
      )
    );


  }




  if (
    !query
  ) {


    throw new Error(
      'Yahoo Market Comps: 検索語を生成できませんでした'
    );


  }




  const searchUrl =
    buildYahooClosedSearchUrl_(
      query,
      categoryId
    );




  console.log(
    '========================================'
  );




  console.log(
    'Yahoo Market Comps START'
  );




  console.log(
    '対象キー:',
    target.targetKey
  );




  console.log(
    '対象商品:',
    target.title
  );




  console.log(
    'DB商品ID:',
    target.dbItemId
  );




  console.log(
    'DBブランド:',
    target.brand
  );




  console.log(
    'DBカテゴリ:',
    target.category
  );




  console.log(
    'DB商品:',
    target.product
  );




  console.log(
    '検索語:',
    query
  );




  console.log(
    'YahooカテゴリID:',
    categoryId
  );




  console.log(
    '検索URL:',
    searchUrl
  );




  const response =
    await page.goto(
      searchUrl,
      {


        waitUntil:
          'domcontentloaded',


        timeout:
          MARKET_COMPS_TIMEOUT_MS


      }
    );




  if (
    !response
  ) {


    throw new Error(
      'Yahoo Market Comps: HTTPレスポンスを取得できませんでした'
    );


  }




  console.log(
    'Yahoo Market Comps HTTP:',
    response.status()
  );




  if (
    response.status() < 200 ||
    response.status() >= 400
  ) {


    throw new Error(
      `Yahoo Market Comps HTTP Error: ${response.status()}`
    );


  }




  await page.waitForSelector(
    'body',
    {
      timeout:
        MARKET_COMPS_TIMEOUT_MS
    }
  );




  await page.waitForTimeout(
    2500
  );




  const pageText =
    normalizeMarketCompsSpace_(
      await page
        .locator(
          'body'
        )
        .innerText()
    );




  if (
    !pageText.includes(
      '落札'
    )
    ||
    (
      !pageText.includes(
        '終了180日間'
      )
      &&
      !pageText.includes(
        '180日間の落札相場'
      )
    )
  ) {


    throw new Error(
      'Yahoo落札相場ページとして確認できませんでした。安全停止します。'
    );


  }




  const summary =
    await extractYahooMarketCompsSummary_(
      page
    );




  console.log(
    'Yahooページ集計:',
    JSON.stringify(
      summary
    )
  );




  const rawItems =
    await extractYahooClosedItems_(
      page,
      MARKET_COMPS_MAX_ITEMS
    );




  if (
    rawItems.length === 0
  ) {


    throw new Error(
      '落札済み商品の取得件数が0件でした。DOM変更の可能性があるため安全停止します。'
    );


  }




  const comparisons =
    normalizeYahooClosedItems_(
      rawItems,
      query,
      categoryId
    );




  if (
    comparisons.length === 0
  ) {


    throw new Error(
      '正規化後の比較商品が0件です。安全停止します。'
    );


  }




  console.log(
    'Yahoo比較商品:',
    comparisons.length,
    '件'
  );




  const ingestResult =
    await postAppsScriptJson(
      {


        secret:
          INGEST_SECRET,


        action:
          'upsertMarketComps',


        source:
          'Yahoo closedsearch',


        sourceVersion:
          MARKET_COMPS_SOURCE_VERSION,


        query,


        categoryId,


        target,


        comparisons


      },


      `MarketComps ${target.itemId}`
    );




  if (
    ingestResult.action !==
    'upsertMarketComps'
  ) {


    throw new Error(
      'market-ingest response action が不正です'
    );


  }




  console.log(
    '✅ Yahoo Market Comps SUCCESS',
    target.itemId,
    'received=',
    ingestResult.received,
    'inserted=',
    ingestResult.inserted,
    'updated=',
    ingestResult.updated,
    'skipped=',
    ingestResult.skipped
  );




  return ingestResult;


}




async function runYahooMarketCompsForInsertedItems_(
  page,
  insertedItems,
  config
) {


  if (
    !Array.isArray(
      insertedItems
    )
    ||
    insertedItems.length === 0
  ) {


    console.log(
      'Yahoo Market Comps: 新規0件のためスキップ'
    );




    return {
      attempted: 0,
      succeeded: 0,
      failed: 0
    };


  }




  console.log(
    '========================================'
  );




  console.log(
    'Yahoo Market Comps対象:',
    insertedItems.length,
    '件'
  );




  let succeeded =
    0;




  let failed =
    0;




  for (
    let i = 0;
    i < insertedItems.length;
    i++
  ) {


    const insertedItem =
      insertedItems[i];




    try {


      console.log(
        `[Market Comps ${i + 1}/${insertedItems.length}]`,
        insertedItem &&
        insertedItem.itemId
          ? insertedItem.itemId
          : 'UNKNOWN'
      );




      await runYahooMarketCompsForTarget_(
        page,
        insertedItem,
        config
      );




      succeeded++;


    } catch (error) {


      failed++;




      console.error(
        '⚠️ Yahoo Market Comps失敗:',
        insertedItem &&
        insertedItem.itemId
          ? insertedItem.itemId
          : 'UNKNOWN'
      );




      console.error(
        error &&
        error.stack
          ? error.stack
          : error
      );




      // 既存Mercari監視を壊さないため、
      // 比較取得失敗はこの商品だけで止める。
      // 次の商品・次条件のYahoo監視は継続する。


    }


  }




  console.log(
    'Yahoo Market Comps結果:',
    'attempted=',
    insertedItems.length,
    'succeeded=',
    succeeded,
    'failed=',
    failed
  );




  return {
    attempted:
      insertedItems.length,
    succeeded,
    failed
  };


}




// ============================================================


// ============================================================
// Yahoo検索結果
//
// 役割:
// 新しい出品を発見する。
//
// Yahoo検索側が一時的に取得不能でも
// 既存商品の詳細追跡は止めない。
// ============================================================

async function scanYahooSearch(
  page,
  config
) {

  const conditionId =
    config.conditionId;

  const searchName =
    config.searchName || '';

  const searchUrl =
    config.searchUrl;


  console.log(
    '=============================='
  );

  console.log(
    '条件:',
    conditionId,
    searchName
  );

  console.log(
    '① Yahoo新着検索'
  );


  let cardFound = false;


  for (
    let attempt = 1;
    attempt <= 3;
    attempt++
  ) {

    try {

      console.log(
        `検索試行 ${attempt}/3`
      );


      if (attempt === 1) {

        await page.goto(
          searchUrl,
          {
            waitUntil: 'domcontentloaded',
            timeout: 60000
          }
        );

      } else {

        await page.reload({
          waitUntil: 'domcontentloaded',
          timeout: 60000
        });

      }


      await page.waitForTimeout(
        3000
      );


      const count =
        await page.locator(
          'li.Product'
        ).count();


      console.log(
        '商品カード数:',
        count
      );


      if (count > 0) {

        cardFound = true;

        break;

      }


    } catch (error) {

      console.log(
        '検索試行失敗:',
        error.message
      );

    }


    await sleep(
      3000
    );

  }


  if (!cardFound) {

    console.log(
      '⚠️ Yahoo新着検索は今回取得できませんでした'
    );

    console.log(
      '⚠️ 既存商品の価格追跡は継続します'
    );

    return [];

  }


  const items =
    await page.evaluate(
      (MAX_SEARCH_ITEMS) => {

        function cleanText(text) {

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

          // ====================================================
          // URL / 商品ID
          // ====================================================

          const auctionAnchors =
            Array.from(
              card.querySelectorAll(
                'a[href*="/jp/auction/"]'
              )
            );


          let href = '';
          let itemId = '';


          for (const anchor of auctionAnchors) {

            const candidate =
              anchor.href || '';


            const match =
              candidate.match(
                /\/jp\/auction\/([A-Za-z0-9_-]+)/
              );


            if (match) {

              href = candidate;
              itemId = match[1];

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


          // ====================================================
          // タイトル
          // ====================================================

          const titleCandidates =
            auctionAnchors

              .map(anchor => {

                return cleanText(

                  anchor.getAttribute(
                    'title'
                  )

                  ||

                  anchor.getAttribute(
                    'aria-label'
                  )

                  ||

                  anchor.innerText

                  ||

                  ''

                );

              })

              .filter(text => {

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

              })

              .sort(
                (a, b) =>
                  b.length - a.length
              );


          let title =
            titleCandidates[0] || '';


          if (!title) {

            const image =
              card.querySelector(
                'img[alt]'
              );


            if (image) {

              title =
                cleanText(
                  image.getAttribute(
                    'alt'
                  )
                );

            }

          }


          const cardText =
            cleanText(
              card.innerText
            );


          // ====================================================
          // 検索結果価格
          // ====================================================

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
                  .replace(/,/g, '')
              );

          }


          // ====================================================
          // 残り時間
          // ====================================================

          let remainingTime = '';


          const remainingElement =
            card.querySelector(
              '.Product__timeRemaining, [class*="timeRemaining"]'
            );


          if (remainingElement) {

            remainingTime =
              cleanText(

                remainingElement.innerText

                ||

                remainingElement.textContent

                ||

                ''

              );

          }


          if (!remainingTime) {

            const timeInfo =
              card.querySelector(
                '.Product__timeInfo, [class*="timeInfo"]'
              );


            const timeInfoText =
              cleanText(

                timeInfo
                  ? (
                      timeInfo.innerText
                      ||
                      timeInfo.textContent
                      ||
                      ''
                    )
                  : ''

              );


            const timeMatch =
              timeInfoText.match(
                /(\d+\s*(?:日|時間|分))/
              );


            if (timeMatch) {

              remainingTime =
                cleanText(
                  timeMatch[1]
                );

            }

          }


          if (!remainingTime) {

            const fallback =
              cardText.match(
                /(?:^|\s)(\d+\s*(?:日|時間|分))(?:\s|$)/
              );


            if (fallback) {

              remainingTime =
                cleanText(
                  fallback[1]
                );

            }

          }


          // ====================================================
          // 安全監査
          // ====================================================

          if (!title) {
            continue;
          }


          if (title.length > 250) {
            continue;
          }


          if (
            !price ||
            price <= 0 ||
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


          seen.add(itemId);


          results.push({

            itemId,

            url:
              href,

            title,

            price,

            remainingTime

          });


          if (
            results.length >=
            MAX_SEARCH_ITEMS
          ) {
            break;
          }

        }


        return results;

      },

      MAX_SEARCH_ITEMS
    );


  console.log(
    '新着取得:',
    items.length,
    '件'
  );


  items.forEach(
    (item, index) => {

      console.log(
        `${index + 1}.`,
        item.itemId,
        '¥' + item.price,
        item.remainingTime || ''
      );

    }
  );


  return items;

}


// ============================================================
// Yahoo詳細ページ
//
// 10/10 Dry Runを通過した方式。
//
// h1の商品タイトルから
// 本体の「入札する / 今すぐ落札」までだけを見る。
//
// おすすめ商品エリアの価格は読まない。
// ============================================================

async function scanTrackedYahooItem(
  page,
  trackedItem
) {

  try {

    await page.goto(
      trackedItem.url,
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


    const detail =
      await page.evaluate(
        () => {

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


          const bodyText =
            clean(
              document.body.innerText
            );


          // ==================================================
          // 終了済み判定
          // ==================================================

          const ended =
            /このオークションは終了しています|オークションは終了しました/
              .test(
                bodyText
              );


          if (ended) {

            return {
              ended: true
            };

          }


          // ==================================================
          // 商品タイトル
          // ==================================================

          const h1 =
            Array.from(
              document.querySelectorAll(
                'h1'
              )
            )
              .find(el =>
                clean(el.innerText)
              );


          if (!h1) {

            return {
              ended: false,
              ok: false,
              reason: 'H1_NOT_FOUND'
            };

          }


          // ==================================================
          // 本体アクションボタン
          // ==================================================

          const actionCandidates =
            Array.from(
              document.querySelectorAll(
                'button, a'
              )
            )
              .filter(el => {

                if (
                  !isAfter(
                    el,
                    h1
                  )
                ) {
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
                  text.startsWith(
                    '入札する'
                  ) ||
                  text.startsWith(
                    '今すぐ落札'
                  )
                );

              });


          const actionButton =
            actionCandidates[0]
            ||
            null;


          // ==================================================
          // おすすめ欄の開始位置
          // ==================================================

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

                if (
                  !isAfter(
                    el,
                    h1
                  )
                ) {
                  return false;
                }


                const text =
                  clean(
                    el.innerText
                  );


                return recommendationWords.some(
                  word =>
                    text.includes(
                      word
                    )
                );

              })[0]
            ||
            null;


          const boundary =
            actionButton
            ||
            recommendationHeading
            ||
            null;


          // ==================================================
          // 本体価格候補
          // ==================================================

          const allElements =
            Array.from(
              document.querySelectorAll(
                'body *'
              )
            );


          const candidates = [];


          for (
            let index = 0;
            index < allElements.length;
            index++
          ) {

            const el =
              allElements[index];


            if (
              el === h1 ||
              !isAfter(
                el,
                h1
              )
            ) {
              continue;
            }


            if (
              boundary &&
              !isBefore(
                el,
                boundary
              )
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
              !Number.isFinite(
                price
              ) ||
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


          if (
            candidates.length === 0
          ) {

            return {

              ended: false,

              ok: false,

              reason:
                'MAIN_PRICE_NOT_FOUND',

              title:
                clean(
                  h1.innerText
                ),

              actionButton:
                actionButton
                  ? clean(
                      actionButton.innerText
                    )
                  : ''

            };

          }


          // ==================================================
          // 重複排除
          // ==================================================

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


          // ==================================================
          // 価格優先順位
          //
          // 現在 → 価格 → 即決
          // ==================================================

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


          // ==================================================
          // 残り時間
          // ==================================================

          let remainingTime = '';


          const remainingMatch =
            bodyText.match(
              /残り時間\s*(\d+)\s*(日|時間|分)/
            );


          if (remainingMatch) {

            remainingTime =
              remainingMatch[1] +
              remainingMatch[2];

          }


          // ==================================================
          // 終了予定時刻
          //
          // 半角()・全角（）の両方に対応。
          // 例:
          // 9月24日 (木) 22時10分 終了予定
          // 9月24日（木）22時10分 終了予定
          // ==================================================

          let endParts = null;


          const endMatch =
            bodyText.match(
              /(\d{1,2})月(\d{1,2})日(?:\s*[（(][^）)]*[）)])?\s*(\d{1,2})時\s*(\d{1,2})分\s*終了予定/
            );


          if (endMatch) {

            endParts = {

              month:
                Number(
                  endMatch[1]
                ),

              day:
                Number(
                  endMatch[2]
                ),

              hour:
                Number(
                  endMatch[3]
                ),

              minute:
                Number(
                  endMatch[4]
                )

            };

          }


          return {

            ended: false,

            ok: true,

            price:
              selected.price,

            priceLabel:
              selected.label,

            sourceText:
              selected.sourceText,

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

            remainingTime,

            endParts

          };

        }
      );


    // ========================================================
    // 終了済み
    // ========================================================

    if (
      detail &&
      detail.ended
    ) {

      console.log(
        '終了済み:',
        trackedItem.itemId
      );

      return null;

    }


    // ========================================================
    // 本体価格を安全に取得できなかった場合
    //
    // 台帳にも送らない
    // LINEにも進ませない
    // ========================================================

    if (
      !detail ||
      !detail.ok ||
      !detail.price ||
      detail.price <= 0
    ) {

      console.log(
        '⚠️ 本体価格取得失敗:',
        trackedItem.itemId,
        detail
          ? detail.reason
          : 'UNKNOWN'
      );


      return null;

    }


    const previousPrice =
      Number(
        trackedItem.currentPrice
        ||
        0
      );


    // ========================================================
    // 安全弁
    //
    // 「現在」「価格」のオークション価格は
    // 原則として下がらない。
    //
    // 以前の価格より低い値が取れた場合は
    // おすすめ商品などの誤取得とみなし更新しない。
    //
    // 「即決」は出品者の価格変更があり得るため除外。
    // ========================================================

    if (
      detail.priceLabel !== '即決' &&
      previousPrice > 0 &&
      detail.price < previousPrice
    ) {

      console.log(
        '🛑 異常価格を拒否:',
        trackedItem.itemId,
        previousPrice,
        '→',
        detail.price,
        'ラベル:',
        detail.priceLabel
      );


      return null;

    }


    // ========================================================
    // 終了日時
    //
    // Yahooは日本時間。
    // Node側のタイムゾーンに依存させず +09:00 を明示。
    // ========================================================

    let endTime = '';


    if (
      detail.endParts
    ) {

      const nowJstYear =
        Number(
          new Intl.DateTimeFormat(
            'en',
            {
              timeZone:
                'Asia/Tokyo',

              year:
                'numeric'
            }
          ).format(
            new Date()
          )
        );


      let year =
        nowJstYear;


      const pad =
        n =>
          String(n)
            .padStart(
              2,
              '0'
            );


      let iso =
        `${year}-` +
        `${pad(detail.endParts.month)}-` +
        `${pad(detail.endParts.day)}T` +
        `${pad(detail.endParts.hour)}:` +
        `${pad(detail.endParts.minute)}:00+09:00`;


      let candidate =
        new Date(
          iso
        );


      const now =
        new Date();


      // 年末→年始をまたぐ出品への安全対応
      if (
        candidate.getTime() <
        now.getTime() -
        1000 * 60 * 60 * 24 * 180
      ) {

        year++;


        iso =
          `${year}-` +
          `${pad(detail.endParts.month)}-` +
          `${pad(detail.endParts.day)}T` +
          `${pad(detail.endParts.hour)}:` +
          `${pad(detail.endParts.minute)}:00+09:00`;

      }


      endTime = iso;

    }


    console.log(
      '詳細取得:',
      trackedItem.itemId,
      '¥' + detail.price,
      'ラベル:',
      detail.priceLabel,
      '残り:',
      detail.remainingTime || '不明',
      '終了:',
      endTime || '未取得'
    );


    return {

      itemId:
        trackedItem.itemId,

      url:
        trackedItem.url,

      title:
        trackedItem.title,

      price:
        detail.price,

      remainingTime:
        detail.remainingTime,

      endTime

    };


  } catch (error) {

    console.log(
      '詳細追跡失敗:',
      trackedItem.itemId,
      error.message
    );


    return null;

  }

}


// ============================================================
// 既存Yahoo商品の価格追跡
// ============================================================

async function trackExistingYahooItems(
  context,
  trackedYahoo
) {

  console.log(
    '=============================='
  );

  console.log(
    '② Yahoo既存商品の価格追跡'
  );


  const targets =
    Array.isArray(
      trackedYahoo
    )
      ? trackedYahoo.slice(
          0,
          MAX_TRACKED_ITEMS
        )
      : [];


  console.log(
    '追跡対象:',
    targets.length,
    '件'
  );


  if (
    targets.length === 0
  ) {
    return;
  }


  const updateGroups = {};


  const page =
    await context.newPage();


  for (
    let i = 0;
    i < targets.length;
    i++
  ) {

    const trackedItem =
      targets[i];


    console.log(
      `[${i + 1}/${targets.length}]`,
      trackedItem.itemId
    );


    const update =
      await scanTrackedYahooItem(
        page,
        trackedItem
      );


    if (!update) {
      continue;
    }


    console.log(
      '価格:',
      trackedItem.currentPrice,
      '→',
      update.price,
      '/ 残り:',
      update.remainingTime || '不明'
    );


    const conditionId =
      trackedItem.conditionId;


    if (!conditionId) {

      console.log(
        '⚠️ conditionIdなしの追跡商品をスキップ:',
        trackedItem.itemId
      );

      continue;

    }


    if (
      !updateGroups[
        conditionId
      ]
    ) {

      updateGroups[
        conditionId
      ] = [];

    }


    updateGroups[
      conditionId
    ].push(
      update
    );


    await sleep(
      500
    );

  }


  await page.close();


  for (
    const [
      conditionId,
      items
    ]
    of Object.entries(
      updateGroups
    )
  ) {

    if (
      items.length === 0
    ) {
      continue;
    }


    const result =
      await sendToAppsScript(
        items,
        conditionId
      );


    console.log(
      '追跡更新:',
      conditionId,
      '件数:',
      items.length,
      'updated:',
      result.updated
    );

  }

}


// ============================================================
// メイン
// ============================================================

async function main() {

  // ========================================================
  // 市場監視設定からYahooのON条件を取得
  // ========================================================

  const configs =
    await getYahooConfigs();


  if (
    configs.length === 0
  ) {

    console.log(
      '=============================='
    );

    console.log(
      'YahooのON監視条件が0件のため終了します'
    );

    return;

  }


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


    const searchPage =
      await context.newPage();


    // ========================================================
    // ① ON条件を順番に新着検索
    //
    // 各条件ごとにmarket-ingestへ接続し、
    // 新着0件でもtrackedYahooを取得する。
    // ========================================================

    const trackedYahooMap =
      new Map();


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


      const searchItems =
        await scanYahooSearch(
          searchPage,
          config
        );


      // ======================================================
      // market-ingestへ接続
      // ======================================================

      console.log(
        '=============================='
      );

      console.log(
        '市場監視台帳へ接続:',
        config.conditionId
      );


      const ingestResult =
        await sendToAppsScript(
          searchItems,
          config.conditionId
        );


      console.log(
        '新着受信:',
        ingestResult.received,
        '新規:',
        ingestResult.inserted,
        '更新:',
        ingestResult.updated
      );


      // ======================================================
      // DB同定済み + 相場比較データ0件 を Market Compsへ
      //
      // market-ingest側では後方互換のため
      // フィールド名 insertedItems を維持している。
      // 新規だけでなく existing-db-no-comps も含む。
      // ======================================================

      const marketCompTargets =
        Array.isArray(
          ingestResult.insertedItems
        )
          ? ingestResult.insertedItems
          : [];

      console.log(
        'Market Comps対象:',
        marketCompTargets.length,
        '件'
      );

      await runYahooMarketCompsForInsertedItems_(
        searchPage,
        marketCompTargets,
        config
      );


      const trackedYahoo =
        Array.isArray(
          ingestResult.trackedYahoo
        )
          ? ingestResult.trackedYahoo
          : [];


      // trackedYahoo側にconditionIdが無い場合でも、
      // 今回問い合わせた条件IDを安全なフォールバックとして付与する。
      for (
        let j = 0;
        j < trackedYahoo.length;
        j++
      ) {

        const trackedItem =
          trackedYahoo[j];


        if (!trackedItem) {
          continue;
        }


        const normalizedConditionId =
          trackedItem.conditionId
          ||
          config.conditionId;


        const normalizedItem = {
          ...trackedItem,
          conditionId:
            normalizedConditionId
        };


        const itemKey =
          normalizedItem.itemId
          ||
          normalizedItem.url;


        if (!itemKey) {

          console.log(
            '⚠️ itemId / URLなしの追跡商品をスキップ:',
            normalizedConditionId
          );

          continue;

        }


        const key =
          `${normalizedConditionId}::${itemKey}`;


        trackedYahooMap.set(
          key,
          normalizedItem
        );

      }


      await sleep(
        500
      );

    }


    await searchPage.close();


    // ========================================================
    // ② 既存商品の詳細価格追跡
    //
    // 複数条件から返ったtrackedYahooを重複排除したうえで、
    // 既存の安全な詳細価格取得ロジックへ渡す。
    // ========================================================

    const trackedYahoo =
      Array.from(
        trackedYahooMap.values()
      );


    console.log(
      '=============================='
    );

    console.log(
      '統合追跡対象:',
      trackedYahoo.length,
      '件'
    );


    await trackExistingYahooItems(
      context,
      trackedYahoo
    );


    console.log(
      '=============================='
    );


    console.log(
      '✅ Yahoo Config Discovery + Safe Price Tracking SUCCESS'
    );


  } finally {

    await browser.close();

  }

}


// ============================================================
// 実行
// ============================================================

main()
  .catch(
    error => {

      console.error(
        'YAHOO MONITOR ERROR'
      );


      console.error(
        error
      );


      process.exit(
        1
      );

    }
  );
