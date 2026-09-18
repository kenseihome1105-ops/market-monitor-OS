const { chromium } = require('playwright');

const YAHOO_URL =
  'https://auctions.yahoo.co.jp/search/search?p=グッチ+スーツ&auccat=23176&va=グッチ+スーツ&aucmaxprice=29000&is_postage_mode=1&dest_pref_code=40&b=1&n=50&s1=new&o1=d';

(async () => {

  const browser = await chromium.launch({
    headless: true
  });

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

  await page.waitForTimeout(5000);

  console.log('現在URL:', page.url());
  console.log('ページタイトル:', await page.title());

  // 少しスクロールして遅延描画も拾う
  for (let i = 0; i < 5; i++) {

    await page.evaluate(() => {
      window.scrollBy(
        0,
        window.innerHeight * 1.5
      );
    });

    await page.waitForTimeout(1000);
  }

  const items = await page.evaluate(() => {

    const anchors =
      Array.from(
        document.querySelectorAll('a[href*="/jp/auction/"]')
      );

    const results = [];
    const seen = new Set();

    for (const a of anchors) {

      const href =
        a.href || '';

      const match =
        href.match(
          /\/jp\/auction\/([A-Za-z0-9_-]+)/
        );

      if (!match) continue;

      const itemId =
        match[1];

      if (seen.has(itemId)) continue;

      let node = a;

      let text =
        '';

      // 商品カードらしき親要素まで遡る
      for (
        let i = 0;
        i < 6 && node;
        i++
      ) {

        const candidate =
          (node.innerText || '')
            .replace(/\s+/g, ' ')
            .trim();

        if (
          candidate.length > text.length
        ) {
          text = candidate;
        }

        node =
          node.parentElement;
      }

      const priceMatch =
        text.match(
          /(?:¥|￥)\s*([\d,]+)/
        );

      const price =
        priceMatch
          ? Number(
              priceMatch[1]
                .replace(/,/g, '')
            )
          : 0;

      const title =
        (a.innerText || a.getAttribute('aria-label') || text)
          .replace(/\s+/g, ' ')
          .trim();

      seen.add(itemId);

      results.push({
        itemId,
        url: href,
        title,
        price,
        rawText: text.slice(0, 300)
      });

      if (
        results.length >= 10
      ) {
        break;
      }
    }

    return results;

  });

  console.log(
    '取得商品数:',
    items.length
  );

  items.forEach(
    (item, index) => {

      console.log(
        `--- ${index + 1} ---`
      );

      console.log(
        'ID:',
        item.itemId
      );

      console.log(
        '価格:',
        item.price
      );

      console.log(
        'タイトル:',
        item.title
      );

      console.log(
        'URL:',
        item.url
      );

      console.log(
        'RAW:',
        item.rawText
      );

    }
  );

  if (
    items.length > 0
  ) {

    console.log(
      '✅ Yahoo取得テスト成功'
    );

  } else {

    console.log(
      '❌ Yahoo商品を取得できませんでした'
    );

  }

  await browser.close();

})();
