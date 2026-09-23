const { chromium } = require('playwright');

/**
 * ============================================================
 * Yahoo 落札済み類似商品取得 Dry Run
 *
 * 目的:
 * Yahooオークション「終了180日間」の落札相場から
 * 類似商品の基礎データを取得する。
 *
 * このファイルは Dry Run 専用。
 *
 * 絶対にしないこと:
 * ・Google Sheetsへの書き込み
 * ・market-ingestへのPOST
 * ・既存監視条件の変更
 * ・既存Yahoo parserの変更
 * ・LINE通知
 * ・Secretの利用
 *
 * 後工程:
 * Dry Run成功
 * ↓
 * 相場比較データ形式へ正規化
 * ↓
 * 類似度計算
 * ↓
 * 売価予測
 * ============================================================
 */


/* ============================================================
 * Dry Run設定
 *
 * GitHub Actionsから環境変数で変更可能。
 *
 * 初回テスト:
 * GUCCI スーツ
 * メンズスーツ category 23176
 * 最大30件
 * ============================================================
 */

const CONFIG = {
  query:
    String(
      process.env.COMP_QUERY ||
      'GUCCI スーツ'
    ).trim(),

  categoryId:
    String(
      process.env.COMP_CATEGORY_ID ||
      '23176'
    ).trim(),

  maxItems:
    positiveInt_(
      process.env.COMP_MAX_ITEMS,
      30
    ),

  timeoutMs:
    positiveInt_(
      process.env.COMP_TIMEOUT_MS,
      60000
    )
};


/* ============================================================
 * Main
 * ============================================================
 */

async function main() {
  console.log(
    '========================================'
  );

  console.log(
    'Yahoo Market Comps DRY RUN'
  );

  console.log(
    '========================================'
  );

  console.log(
    '検索語:',
    CONFIG.query
  );

  console.log(
    'カテゴリID:',
    CONFIG.categoryId
  );

  console.log(
    '取得上限:',
    CONFIG.maxItems
  );


  const searchUrl =
    buildYahooClosedSearchUrl_(
      CONFIG.query,
      CONFIG.categoryId
    );


  console.log(
    '検索URL:',
    searchUrl
  );


  const browser =
    await chromium.launch({
      headless: true
    });


  try {
    const context =
      await browser.newContext({
        locale: 'ja-JP',
        timezoneId: 'Asia/Tokyo',
        viewport: {
          width: 1440,
          height: 1200
        },
        extraHTTPHeaders: {
          'Accept-Language':
            'ja-JP,ja;q=0.9,en;q=0.8'
        }
      });


    const page =
      await context.newPage();


    console.log(
      'Yahoo落札相場ページを取得中...'
    );


    const response =
      await page.goto(
        searchUrl,
        {
          waitUntil:
            'domcontentloaded',

          timeout:
            CONFIG.timeoutMs
        }
      );


    if (!response) {
      throw new Error(
        'YahooからHTTPレスポンスを取得できませんでした'
      );
    }


    console.log(
      'HTTP Status:',
      response.status()
    );


    if (
      response.status() < 200 ||
      response.status() >= 400
    ) {
      throw new Error(
        `Yahoo HTTP Error: ${response.status()}`
      );
    }


    await page.waitForSelector(
      'body',
      {
        timeout:
          CONFIG.timeoutMs
      }
    );


    // 動的表示待ち
    await page.waitForTimeout(
      2500
    );


    const pageText =
      normalizeSpace_(
        await page
          .locator('body')
          .innerText()
      );


    /**
     * 開催中ページなどを誤って読まないための安全確認
     */
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
      await extractYahooSummary_(
        page
      );


    console.log(
      '----------------------------------------'
    );

    console.log(
      'Yahooページ集計'
    );

    console.log(
      JSON.stringify(
        summary,
        null,
        2
      )
    );


    const rawItems =
      await extractYahooClosedItems_(
        page,
        CONFIG.maxItems
      );


    if (
      rawItems.length === 0
    ) {
      throw new Error(
        '落札済み商品の取得件数が0件でした。DOM変更の可能性があるため安全停止します。'
      );
    }


    const normalized =
      normalizeYahooClosedItems_(
        rawItems,
        CONFIG
      );


    console.log(
      '----------------------------------------'
    );

    console.log(
      '取得件数:',
      normalized.length
    );


    console.log(
      '----------------------------------------'
    );

    normalized.forEach(
      (
        item,
        index
      ) => {

        console.log(
          `[${index + 1}/${normalized.length}]`
        );

        console.log(
          JSON.stringify(
            item,
            null,
            2
          )
        );

      }
    );


    console.log(
      '========================================'
    );

    console.log(
      '✅ Yahoo Market Comps DRY RUN SUCCESS'
    );

    console.log(
      '検索:',
      CONFIG.query
    );

    console.log(
      '取得:',
      normalized.length,
      '件'
    );

    console.log(
      'Sheets書込: 0件'
    );

    console.log(
      '既存Yahoo監視変更: なし'
    );

    console.log(
      '========================================'
    );


  } finally {
    await browser.close();
  }
}


/* ============================================================
 * Yahoo終了済み検索URL
 *
 * キーワード
 * +
 * カテゴリーID
 *
 * n=50 は検索ページ表示件数。
 * 実際の取得は maxItems でさらに制限する。
 * ============================================================
 */

function buildYahooClosedSearchUrl_(
  query,
  categoryId
) {
  if (!query) {
    throw new Error(
      '検索語が空です'
    );
  }


  if (!categoryId) {
    throw new Error(
      'categoryIdが空です'
    );
  }


  const encodedQuery =
    encodeURIComponent(
      query
    );


  return (
    'https://auctions.yahoo.co.jp/' +
    'closedsearch/closedsearch/' +
    encodedQuery +
    '/' +
    encodeURIComponent(
      categoryId
    ) +
    '?n=50'
  );
}


/* ============================================================
 * Yahooページ上部の
 * 最安 / 平均 / 最高 / 件数
 *
 * 取得失敗しても商品parser自体は止めない。
 * ============================================================
 */

async function extractYahooSummary_(
  page
) {
  const body =
    await page
      .locator('body')
      .innerText();


  const text =
    String(
      body || ''
    );


  return {
    minPrice:
      firstYenAfter_(
        text,
        '最安'
      ),

    averagePrice:
      firstYenAfter_(
        text,
        '平均'
      ),

    maxPrice:
      firstYenAfter_(
        text,
        '最高'
      ),

    resultCount:
      extractResultCount_(
        text
      )
  };
}


/* ============================================================
 * Yahoo落札済み商品抽出
 *
 * 特定CSS classへ強く依存しない。
 *
 * Yahoo商品URL
 * /jp/auction/
 *
 * を起点にし、
 * 親要素を上へ探索して
 *
 * ・落札
 * ・終了
 *
 * の両方が含まれる最小ブロックを商品カードとみなす。
 *
 * DOM変更時に誤価格を拾うより
 * 0件で安全停止する思想。
 * ============================================================
 */

async function extractYahooClosedItems_(
  page,
  limit
) {
  const items =
    await page.evaluate(
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
          } catch (e) {
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

            if (!node) {
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
                    href &&
                    href.split('#')[0] ===
                    itemHref.split('#')[0]
                  );
                }
              )
              .map(
                link =>
                  clean(
                    link.innerText ||
                    link.getAttribute(
                      'aria-label'
                    ) ||
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
          const anchor of anchors
        ) {
          if (
            results.length >= limit
          ) {
            break;
          }


          const href =
            absoluteUrl(
              anchor.getAttribute(
                'href'
              )
            );


          if (!href) {
            continue;
          }


          const match =
            href.match(
              /\/jp\/auction\/([^/?#]+)/
            );


          if (!match) {
            continue;
          }


          const itemId =
            match[1];


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


          if (!card) {
            continue;
          }


          const text =
            clean(
              card.innerText
            );


          /**
           * 必ず落札価格と終了表記があること。
           */
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


          if (!title) {
            continue;
          }


          const stateCandidates = [
            '未使用',
            '未使用に近い',
            '目立った傷や汚れなし',
            'やや傷や汚れあり',
            '傷や汚れあり',
            '全体的に状態が悪い'
          ];


          let condition =
            '';


          for (
            const state of
            stateCandidates
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
              /(?:^|\n)\s*(\d+)\s*(?:\n|$)/
            );


          seen.add(
            itemId
          );


          results.push({
            itemId:
              itemId,

            url:
              href.split(
                '#'
              )[0],

            title:
              title,

            soldPriceText:
              priceMatch[1],

            endDateLabel:
              endMatch[1],

            endTimeLabel:
              endMatch[2],

            condition:
              condition,

            bidCount:
              bidMatch
                ? Number(
                    bidMatch[1]
                  )
                : null,

            rawText:
              text
          });
        }


        return results;

      },
      {
        limit:
          limit
      }
    );


  return items;
}


/* ============================================================
 * 共通形式へ最低限正規化
 *
 * Phase 1 Dry Runでは
 * 類似度や高値要素判定はまだ行わない。
 * ============================================================
 */

function normalizeYahooClosedItems_(
  rawItems,
  config
) {
  return rawItems.map(
    item => {

      const soldPrice =
        parseYenNumber_(
          item.soldPriceText
        );


      const endedAt =
        parseYahooEndDate_(
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

        endedAt:
          endedAt,

        endLabel:
          `${item.endDateLabel} ${item.endTimeLabel}`,

        condition:
          item.condition ||
          '未取得',

        bidCount:
          item.bidCount,

        source:
          'Yahoo closedsearch',

        query:
          config.query,

        categoryId:
          config.categoryId
      };
    }
  );
}


/* ============================================================
 * Yahoo終了日時
 *
 * closedsearchは
 * 9/24 22:10終了
 *
 * のように年を省略して表示する。
 *
 * 終了180日以内なので、
 * 現在年で未来になりすぎる場合のみ前年へ戻す。
 *
 * DateはISO UTCで返す。
 * ============================================================
 */

function parseYahooEndDate_(
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


  /**
   * JST上の現在年を取得
   */
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


  /**
   * 終了済みなのに
   * 現在より大幅に未来なら前年。
   *
   * 24時間程度のズレでは年を戻さない。
   */
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


/* ============================================================
 * 集計値 helper
 * ============================================================
 */

function firstYenAfter_(
  text,
  label
) {
  const escaped =
    escapeRegExp_(
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
    ? parseYenNumber_(
        match[1]
      )
    : null;
}


function extractResultCount_(
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


/* ============================================================
 * 共通 helper
 * ============================================================
 */

function parseYenNumber_(
  value
) {
  const text =
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
      );


  const number =
    Number(
      text
    );


  return Number.isFinite(
    number
  )
    ? number
    : null;
}


function normalizeSpace_(
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


function positiveInt_(
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


function escapeRegExp_(
  value
) {
  return String(
    value || ''
  ).replace(
    /[.*+?^${}()|[\]\\]/g,
    '\\$&'
  );
}


/* ============================================================
 * 実行
 * ============================================================
 */

main()
  .catch(
    error => {

      console.error(
        '========================================'
      );

      console.error(
        '❌ Yahoo Market Comps DRY RUN FAILED'
      );

      console.error(
        error &&
        error.stack
          ? error.stack
          : error
      );

      console.error(
        '========================================'
      );


      process.exitCode = 1;
    }
  );
