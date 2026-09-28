// ============================================================
// 利益商品探索AI Historical Backfill
//
// 商品マスター / 利益商品探索AI
//   ↓
// market-ingest: getHistoricalBackfillTargets
//   ↓
// Mercari「売り切れ × 新着順」 + Yahooオークション「終了180日間 × 落札済み」
//   ↓
// 過去実売分布 + Historical Market Score
//   ↓
// market-ingest: upsertHistoricalBackfill
//   ↓
// 利益商品探索AI Y:AH
//
// このファイルは「売れた側（相場・需要）」を埋める。
// 現行出品の仕入れ側（Mercari / Yahoo）は別工程で同じDB商品へ結合する。
// ============================================================

const INGEST_URL = process.env.MARKET_INGEST_URL;
const INGEST_SECRET = process.env.MARKET_INGEST_SECRET;

const BATCH_LIMIT = positiveInt_(
  process.env.HISTORICAL_BATCH_LIMIT,
  5,
  1,
  10
);

const MAX_SOLD_ITEMS = positiveInt_(
  process.env.HISTORICAL_MAX_SOLD_ITEMS,
  50,
  1,
  50
);

const MAX_MERCARI_SOLD_ITEMS = positiveInt_(
  process.env.HISTORICAL_MAX_MERCARI_SOLD_ITEMS,
  50,
  1,
  50
);

const PAGE_TIMEOUT_MS = positiveInt_(
  process.env.HISTORICAL_PAGE_TIMEOUT_MS,
  60000,
  10000,
  120000
);

const BETWEEN_TARGETS_MS = positiveInt_(
  process.env.HISTORICAL_BETWEEN_TARGETS_MS,
  1500,
  0,
  10000
);

const FORCE =
  String(process.env.HISTORICAL_FORCE || '')
    .trim()
    .toLowerCase() === 'true';

const TARGET_DB_ITEM_ID = String(
  process.env.HISTORICAL_TARGET_DB_ITEM_ID || ''
).trim();

const DRY_RUN =
  String(process.env.HISTORICAL_DRY_RUN || '')
    .trim()
    .toLowerCase() === 'true';

const AUTO_CONTINUE =
  String(process.env.HISTORICAL_AUTO_CONTINUE || '')
    .trim()
    .toLowerCase() === 'true';

const APPS_SCRIPT_MAX_ATTEMPTS = 5;
const APPS_SCRIPT_RETRY_DELAYS_MS = [
  0,
  2500,
  6000,
  12000,
  20000
];

// ============================================================
// 共通
// ============================================================

function sleep_(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function positiveInt_(value, fallback, min, max) {
  const n = Number(value);

  if (!Number.isInteger(n)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, n));
}

function clamp_(value, min = 0, max = 1) {
  const n = Number(value);

  if (!Number.isFinite(n)) {
    return min;
  }

  return Math.max(min, Math.min(max, n));
}

function yen_(value) {
  const n = Number(value || 0);

  return Number.isFinite(n)
    ? `¥${Math.round(n).toLocaleString('ja-JP')}`
    : '¥0';
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
  const type = String(contentType || '').toLowerCase();
  const body = String(text || '').trim();

  return (
    type.includes('text/html') ||
    /^<!doctype\s+html/i.test(body) ||
    /^<html/i.test(body)
  );
}

async function postAppsScriptJson_(payload, label) {
  let lastError = null;

  for (
    let attempt = 1;
    attempt <= APPS_SCRIPT_MAX_ATTEMPTS;
    attempt++
  ) {
    const delayMs = Number(
      APPS_SCRIPT_RETRY_DELAYS_MS[attempt - 1] || 0
    );

    if (delayMs > 0) {
      console.warn(`[${label}] retry wait: ${delayMs}ms`);
      await sleep_(delayMs);
    }

    console.log(`[${label}] Attempt: ${attempt}/${APPS_SCRIPT_MAX_ATTEMPTS}`);

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
    const contentType = response.headers.get('content-type') || '';

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
        !String(contentType).toLowerCase().includes('json');

      if (
        retryableBody &&
        attempt < APPS_SCRIPT_MAX_ATTEMPTS
      ) {
        continue;
      }

      console.log(`[${label}] Response head:`, text.slice(0, 1000));
      throw lastError;
    }

    if (result.ok !== true) {
      const errorText = JSON.stringify(result);
      lastError = new Error(`${label}側エラー: ${errorText}`);

      // market-ingest の write lock 競合は一時エラーとして再試行する。
      if (
        result.error === 'busy' &&
        attempt < APPS_SCRIPT_MAX_ATTEMPTS
      ) {
        continue;
      }

      throw lastError;
    }

    return result;
  }

  throw (
    lastError ||
    new Error(`${label} Apps Script通信に失敗しました`)
  );
}

// ============================================================
// market-ingest
// ============================================================

async function getTargets_() {
  return postAppsScriptJson_(
    {
      secret: INGEST_SECRET,
      action: 'getHistoricalBackfillTargets',
      limit: BATCH_LIMIT,
      force: FORCE,
      dbItemId: TARGET_DB_ITEM_ID
    },
    'Historical targets'
  );
}

function selectHistoricalTargets_(targets, requestedDbItemId) {
  const available = Array.isArray(targets) ? targets : [];
  const requestedId = String(requestedDbItemId || '').trim();

  if (!requestedId) {
    return available;
  }

  return available.filter(target =>
    String(target && target.dbItemId || '').trim() === requestedId
  );
}

function shouldContinueHistoricalBackfill_(options = {}) {
  const targetCount = Math.max(0, Number(options.targetCount) || 0);
  const remaining = Math.max(0, Number(options.remaining) || 0);
  const success = Math.max(0, Number(options.success) || 0);
  const failed = Math.max(0, Number(options.failed) || 0);

  return (
    options.autoContinue === true &&
    options.force !== true &&
    !String(options.requestedDbItemId || '').trim() &&
    targetCount > 0 &&
    success === targetCount &&
    failed === 0 &&
    remaining > targetCount
  );
}

function writeGitHubOutput_(name, value) {
  const outputPath = String(process.env.GITHUB_OUTPUT || '').trim();

  if (!outputPath) {
    return;
  }

  require('node:fs').appendFileSync(
    outputPath,
    `${name}=${String(value)}\n`,
    'utf8'
  );
}

async function saveSummary_(target, summary) {
  if (DRY_RUN) {
    console.log(
      `[DRY RUN] 保存スキップ ${target.dbItemId}:`,
      JSON.stringify(summary)
    );
    return { ok: true, dryRun: true };
  }

  return postAppsScriptJson_(
    {
      secret: INGEST_SECRET,
      action: 'upsertHistoricalBackfill',
      dbItemId: target.dbItemId,
      summary
    },
    `Historical save ${target.dbItemId}`
  );
}

// ============================================================
// Mercari売り切れ検索
// ============================================================

function normalizeMercariSoldUrl_(rawUrl) {
  let url;

  try {
    url = new URL(String(rawUrl || '').trim());
  } catch (error) {
    throw new Error('相場URL_Mercari売切 が不正です');
  }

  if (
    url.origin !== 'https://jp.mercari.com' ||
    url.pathname !== '/search'
  ) {
    throw new Error('相場URL_Mercari売切 はMercari検索URLではありません');
  }

  // 4市場版 Apps Script のURLに加え、実行時にも売り切れ・新着順を固定する。
  url.searchParams.set('status', 'sold_out');
  url.searchParams.set('sort', 'created_time');
  url.searchParams.set('order', 'desc');

  return url.toString();
}

function parseMercariItemUrl_(href) {
  try {
    const url = new URL(href, 'https://jp.mercari.com');
    const normal = url.pathname.match(/^\/item\/(m\d+)/i);

    if (normal) {
      return {
        itemId: normal[1],
        url: `https://jp.mercari.com/item/${normal[1]}`
      };
    }

    const shop = url.pathname.match(/^\/shops\/product\/([A-Za-z0-9_-]+)/i);

    if (shop) {
      return {
        itemId: `shops:${shop[1]}`,
        url: `https://jp.mercari.com/shops/product/${shop[1]}`
      };
    }

    return null;
  } catch (error) {
    return null;
  }
}

async function dismissMercariRegionGate_(page) {
  const patterns = [
    /日本の商品を見る/i,
    /日本で続行/i,
    /日本で見る/i,
    /^続ける$/i,
    /^Continue$/i
  ];

  for (const pattern of patterns) {
    try {
      const button = page.getByRole('button', { name: pattern }).first();

      if (await button.isVisible({ timeout: 700 })) {
        await button.click();
        await page.waitForTimeout(1500);
        console.log('Mercari地域確認を処理しました');
        return;
      }
    } catch (error) {
      // 地域確認が表示されない場合はそのまま続ける。
    }
  }
}

async function loadMercariListings_(page) {
  for (let i = 0; i < 6; i++) {
    await page.evaluate(() => {
      window.scrollBy(0, window.innerHeight * 1.5);
    });
    await page.waitForTimeout(700);
  }

  await page.evaluate(() => {
    window.scrollTo(0, 0);
  });
}

async function extractMercariSoldItems_(page, limit) {
  const raw = await page.evaluate(() => {
    const yenRegex = /[¥￥]\s*([\d,]+)/;
    const anchors = Array.from(
      document.querySelectorAll(
        'a[href*="/item/m"], a[href*="/shops/product/"]'
      )
    );
    const results = [];

    for (const anchor of anchors) {
      const href = anchor.href || anchor.getAttribute('href') || '';

      if (!href) {
        continue;
      }

      let node = anchor;
      let cardText = '';

      for (let depth = 0; depth < 7 && node; depth++) {
        const text = String(node.innerText || '')
          .replace(/\s+/g, ' ')
          .trim();

        if (yenRegex.test(text) && text.length < 1000) {
          cardText = text;
          break;
        }

        node = node.parentElement;
      }

      const priceMatch = cardText.match(yenRegex);

      if (!priceMatch) {
        continue;
      }

      const price = Number(priceMatch[1].replace(/,/g, ''));

      if (!price) {
        continue;
      }

      let title = String(anchor.getAttribute('aria-label') || '').trim();

      if (!title) {
        const image = anchor.querySelector('img');
        title = image ? String(image.getAttribute('alt') || '').trim() : '';
      }

      if (!title) {
        title = String(anchor.innerText || '')
          .replace(/[¥￥]\s*[\d,]+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
      }

      if (!title && cardText) {
        title = cardText
          .replace(/[¥￥]\s*[\d,]+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
      }

      if (!title) {
        continue;
      }

      results.push({ href, title, price });
    }

    return results;
  });

  const map = new Map();

  for (const row of raw) {
    const parsed = parseMercariItemUrl_(row.href);

    if (!parsed) {
      continue;
    }

    const existing = map.get(parsed.itemId);

    if (!existing) {
      map.set(parsed.itemId, {
        itemId: parsed.itemId,
        url: parsed.url,
        title: row.title,
        price: row.price
      });
      continue;
    }

    if (row.title.length > existing.title.length) {
      existing.title = row.title;
    }

    if (row.price) {
      existing.price = row.price;
    }
  }

  return Array.from(map.values()).slice(0, limit);
}

// ============================================================
// DB商品との類似度
// ============================================================

function normalizeMatchText_(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase('ja-JP')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

function matchTerms_(value) {
  const text = String(value || '').normalize('NFKC').toLocaleLowerCase('ja-JP');
  const terms = text.match(/[a-z0-9]+|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u30fc]+/gu) || [];

  return Array.from(new Set(
    terms
      .map(term => normalizeMatchText_(term))
      .filter(term => term.length >= 2)
  ));
}

function matchGroup_(title, value) {
  const terms = matchTerms_(value);

  if (!terms.length) {
    return { terms: [], matched: false, ratio: 0 };
  }

  const titleText = normalizeMatchText_(title);
  let hitWeight = 0;
  let matchedTerms = 0;

  for (const term of terms) {
    if (titleText.includes(term)) {
      hitWeight += 1;
      matchedTerms++;
      continue;
    }

    // Japanese product labels often contain a more specific phrase than the
    // listing title. Allow one shared 3-character phrase at half weight;
    // brand matching remains exact.
    if (/[^\u0000-\u007f]/.test(term) && term.length >= 5) {
      const grams = [];

      for (let i = 0; i <= term.length - 3; i++) {
        grams.push(term.slice(i, i + 3));
      }

      if (grams.some(gram => titleText.includes(gram))) {
        hitWeight += 0.5;
        matchedTerms++;
      }
    }
  }

  return {
    terms,
    matched: matchedTerms > 0,
    ratio: hitWeight / terms.length
  };
}

function splitMatchAlternatives_(value) {
  return String(value || '')
    .normalize('NFKC')
    .split(/[\/|,、;；，]+/)
    .map(part => part.trim())
    .filter(Boolean);
}

function uniqueMatchPhrases_(values) {
  const seen = new Set();
  const result = [];

  for (const value of values) {
    const phrase = String(value || '').trim();
    const normalized = normalizeMatchText_(phrase);

    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    result.push(phrase);
  }

  return result;
}

function brandMatchPhrases_(value) {
  const phrases = splitMatchAlternatives_(value);
  const normalized = normalizeMatchText_(phrases.join(' '));
  const equivalences = [
    { keys: ['burberry', 'バーバリー'], values: ['BURBERRY', 'バーバリー'] },
    { keys: ['balmain', 'バルマン'], values: ['BALMAIN', 'バルマン'] },
    { keys: ['hermes', 'エルメス'], values: ['HERMES', 'エルメス'] },
    { keys: ['tomford', 'トムフォード'], values: ['TOM FORD', 'トムフォード', 'トム・フォード'] },
    { keys: ['loropiana', 'ロロピアーナ'], values: ['Loro Piana', 'ロロピアーナ'] },
    { keys: ['brunellocucinelli', 'ブルネロクチネリ'], values: ['Brunello Cucinelli', 'ブルネロクチネリ'] }
  ];

  for (const entry of equivalences) {
    if (entry.keys.some(key => normalized.includes(normalizeMatchText_(key)))) {
      phrases.push(...entry.values);
    }
  }

  return uniqueMatchPhrases_(phrases);
}

function strictPhrasePresent_(title, phrase) {
  const normalizedPhrase = normalizeMatchText_(phrase);

  if (!normalizedPhrase) {
    return false;
  }

  const rawTitle = String(title || '')
    .normalize('NFKC')
    .toLocaleLowerCase('ja-JP');

  // Avoid accepting English feature words inside unrelated longer words.
  if (/^[a-z0-9]+$/i.test(String(phrase || '').trim())) {
    const phraseParts = String(phrase || '')
      .normalize('NFKC')
      .toLocaleLowerCase('ja-JP')
      .match(/[a-z0-9]+/g) || [];
    const escaped = phraseParts
      .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('[\\s_%-]*');
    return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`, 'i').test(rawTitle);
  }

  return normalizeMatchText_(title).includes(normalizedPhrase);
}

function expandKnownFeaturePhrases_(value) {
  const original = splitMatchAlternatives_(value);
  const normalized = normalizeMatchText_(original.join(' '));
  const phrases = [...original];

  if (/(horse|horsehide|ホース|馬革)/.test(normalized)) {
    phrases.push('馬革', 'ホース', 'ホースハイド', 'horsehide', 'horse leather');
  }
  if (/(deer|deerskin|ディア|鹿革)/.test(normalized)) {
    phrases.push('鹿革', 'ディア', 'ディアスキン', 'deerskin', 'deer leather');
  }
  if (/(buffalo|バッファロー|水牛)/.test(normalized)) {
    phrases.push('水牛革', 'バッファロー', 'buffalo', 'buffalo leather');
  }
  if (/(cashmere|カシミヤ|カシミア)/.test(normalized)) {
    if (/100/.test(normalized)) {
      phrases.push(
        'カシミヤ100%', 'カシミア100%', 'cashmere100%',
        'cashmere 100%', '100% cashmere'
      );
    } else {
      phrases.push('カシミヤ', 'カシミア', 'cashmere');
    }
  }
  if (/(wool|ウール|羊毛)/.test(normalized)) {
    if (/100/.test(normalized)) {
      phrases.push(
        'ウール100%', '羊毛100%', '毛100%',
        'wool100%', 'wool 100%', '100% wool'
      );
    } else {
      phrases.push('ウール', '羊毛', 'wool');
    }
  }
  if (/(濃色|darkcolor|darkshade)/.test(normalized)) {
    phrases.push(
      '黒', 'ブラック', 'black',
      'ネイビー', '濃紺', 'navy',
      '濃灰', 'チャコール', 'チャコールグレー',
      'ダークグレー', 'dark gray', 'dark grey',
      'ダークネイビー', 'dark navy',
      'ダークブラウン', 'dark brown'
    );
  }
  if (/(ベスト付3点|ベスト付き3点|スリーピース|3ピース|threepiece|3piece)/.test(normalized)) {
    phrases.push(
      '3ピース', 'スリーピース',
      'three piece', 'three-piece', 'threepiece',
      '3 piece', '3-piece', '3piece'
    );
  }
  if (/(dormeuil|ドーメル)/.test(normalized)) {
    phrases.push('DORMEUIL', 'ドーメル');
  }
  if (/(loropiana|ロロピアーナ)/.test(normalized)) {
    phrases.push('Loro Piana', 'ロロピアーナ');
  }
  if (/(zegna|ゼニア)/.test(normalized)) {
    phrases.push('Zegna', 'Ermenegildo Zegna', 'ゼニア');
  }
  if (/(mouton|ムートン|sheepskin|shearling|シープスキン)/.test(normalized)) {
    phrases.push('ムートン', 'mouton', 'シープスキン', 'sheepskin', 'shearling');
  }
  if (/(羊毛皮|羊毛付き)/.test(normalized)) {
    phrases.push(
      '羊毛皮', '羊毛付き',
      'ムートン', 'mouton',
      'シープスキン', 'sheepskin', 'shearling'
    );
  }
  if (/(london|ロンドン)/.test(normalized)) {
    phrases.push('LONDON', 'ロンドン');
  }
  if (/(chester|チェスター)/.test(normalized)) {
    phrases.push('chester', 'chesterfield', 'チェスター');
  }

  return uniqueMatchPhrases_(phrases);
}

const MODEL_CUES_ = [
  {
    id: 'ライン/モデル:ロンドン',
    pattern: /london|ロンドン/,
    remove: ['london', 'ロンドン'],
    alternatives: ['LONDON', 'ロンドン']
  },
  {
    id: 'ライン/モデル:2ボタン',
    pattern: /2b|2釦|2ボタン|2つボタン|twobutton/,
    remove: ['2b', '2釦', '2ボタン', '2つボタン', 'twobutton'],
    alternatives: ['2B', '2釦', '2ボタン', '2つボタン', '二つボタン', 'two button']
  },
  {
    id: 'ライン/モデル:ロング',
    pattern: /ロング|long/,
    remove: ['ロング', 'long'],
    alternatives: ['ロング', 'long', '丈長']
  },
  {
    id: 'ライン/モデル:ダブル',
    pattern: /ダブル|double/,
    remove: ['ダブル', 'double'],
    alternatives: ['ダブル', 'double', 'doublebreasted']
  },
  {
    id: 'ライン/モデル:3ピース',
    pattern: /3ピース|スリーピース|threepiece|3piece/,
    remove: ['3ピース', 'スリーピース', 'threepiece', '3piece'],
    alternatives: [
      '3ピース', 'スリーピース',
      'three piece', 'three-piece', 'threepiece',
      '3 piece', '3-piece', '3piece'
    ]
  },
  {
    id: 'ライン/モデル:ブランド生地',
    pattern: /ブランド生地/,
    remove: ['ブランド生地'],
    alternatives: []
  },
  {
    id: 'ライン/モデル:ムートン',
    pattern: /ムートン|mouton|sheepskin|shearling/,
    remove: ['ムートン', 'mouton', 'sheepskin', 'shearling'],
    alternatives: ['ムートン', 'mouton', 'シープスキン', 'sheepskin', 'shearling']
  }
];

function splitHighValueRequirements_(value) {
  return String(value || '')
    .normalize('NFKC')
    .split(/[・･]+/)
    .map(part => part.trim())
    .filter(Boolean);
}

function detectGender_(value) {
  const text = String(value || '').normalize('NFKC').toLocaleLowerCase('ja-JP');

  if (/(レディース|婦人|女性|\b(women|woman|ladies|female)\b)/i.test(text)) {
    return 'women';
  }
  if (/(メンズ|紳士|男性|\b(men|mens|male)\b)/i.test(text)) {
    return 'men';
  }

  return '';
}

function hasOuterwearCue_(value) {
  const text = normalizeMatchText_(value);
  return /ジャケット|コート|ブルゾン|ライダース|ジャンパー|アウター|フライト|パーカー|jacket|coat|blouson|riders|outerwear|parka|anorak|bomber|b3/.test(text);
}

function hasNonOuterwearCue_(value) {
  const text = normalizeMatchText_(value);
  return /手袋|グローブ|ミトン|靴下|ソックス|マフラー|ストール|スカーフ|帽子|ハット|キャップ|バッグ|かばん|財布|シューズ|ブーツ|スニーカー|glove|mitten|sock|scarf|muffler|stole|hat|cap|bag|wallet|shoe|boot/.test(text);
}

function isOuterwearTarget_(target) {
  const descriptor = [target.product, target.masterProductName, target.category, target.masterSubCategory]
    .filter(Boolean)
    .join(' ');
  return hasOuterwearCue_(descriptor);
}

function addRequiredFeature_(groups, name, alternatives) {
  const phrases = uniqueMatchPhrases_(alternatives);

  if (!phrases.length) {
    return;
  }

  const signature = phrases
    .map(normalizeMatchText_)
    .sort()
    .join('|');

  if (groups.some(group => group.signature === signature)) {
    return;
  }

  groups.push({ name, alternatives: phrases, signature });
}

function buildRequiredIdentityFeatures_(target) {
  const groups = [];
  const modelText = String(target.lineModel || '').trim();
  const highValueText = String(target.highValue || '').trim();
  const featureDescription = normalizeMatchText_(`${modelText} ${highValueText}`);
  const rareLeather = /(希少革|希少素材|レアレザー|rareleather)/.test(featureDescription);

  if (rareLeather) {
    const aliasPhrases = splitMatchAlternatives_(target.keywordAliases || target.aliases)
      .flatMap(expandKnownFeaturePhrases_)
      .filter(phrase => /(horse|ホース|馬革|deer|ディア|鹿革|buffalo|バッファロー|水牛)/.test(normalizeMatchText_(phrase)));
    const rareLeatherPhrases = aliasPhrases.length
      ? aliasPhrases
      : [
          '馬革', 'ホース', 'ホースハイド', 'horsehide',
          '鹿革', 'ディア', 'ディアスキン', 'deerskin',
          '水牛革', 'バッファロー', 'buffalo'
        ];

    addRequiredFeature_(groups, '高値要素:希少革の素材', rareLeatherPhrases);
  }

  for (const cue of MODEL_CUES_) {
    if (cue.pattern.test(featureDescription)) {
      addRequiredFeature_(groups, cue.id, cue.alternatives);
    }
  }

  const genericHighValue = /^(高値|希少|希少革|希少素材|レア|レアレザー|限定|人気|定番|プレミア|冬物|秋冬|春夏|秋物|夏物)$/;
  if (highValueText && !rareLeather) {
    for (const value of splitHighValueRequirements_(highValueText)) {
      const normalized = normalizeMatchText_(value);

      if (!normalized || genericHighValue.test(normalized)) {
        continue;
      }

      const known = splitMatchAlternatives_(value)
        .flatMap(expandKnownFeaturePhrases_);
      addRequiredFeature_(groups, `高値要素:${value}`, known);
    }
  }

  if (modelText) {
    let residual = normalizeMatchText_(modelText);
    const identityPhrases = [
      ...brandMatchPhrases_([target.brand, target.masterBrand].filter(Boolean).join(' ')),
      target.product,
      target.masterProductName,
      target.category,
      target.masterSubCategory
    ].filter(Boolean);

    for (const phrase of identityPhrases) {
      const normalized = normalizeMatchText_(phrase);
      if (normalized.length >= 2) {
        residual = residual.split(normalized).join('');
      }
    }

    for (const cue of MODEL_CUES_) {
      for (const phrase of cue.remove) {
        residual = residual.split(normalizeMatchText_(phrase)).join('');
      }
    }

    residual = residual.replace(/希少革|希少素材|レアレザー|rareleather|ライン|モデル|line|model/g, '');

    for (const term of matchTerms_(residual)) {
      const normalized = normalizeMatchText_(term);
      if (normalized.length < 2 || genericHighValue.test(normalized)) {
        continue;
      }

      addRequiredFeature_(groups, `ライン/モデル:${term}`, expandKnownFeaturePhrases_(term));
    }
  }

  return groups.map(({ name, alternatives }) => ({ name, alternatives }));
}

function bestMatchGroup_(title, values) {
  const groups = values
    .filter(value => String(value || '').trim())
    .map(value => matchGroup_(title, value))
    .filter(group => group.terms.length)
    .sort((a, b) => b.ratio - a.ratio);

  return groups[0] || { terms: [], matched: false, ratio: 0 };
}

function scoreHistoricalTitleMatch_(target, title) {
  const brandValues = [target.brand, target.masterBrand]
    .filter(Boolean)
    .flatMap(brandMatchPhrases_);
  const brand = bestMatchGroup_(title, brandValues);
  const product = bestMatchGroup_(title, [target.product, target.masterProductName]);
  const category = bestMatchGroup_(title, [target.category, target.masterSubCategory]);
  const keyword = matchGroup_(title, target.searchKeyword);

  const hasBrand = brand.terms.length > 0;
  const hasProduct = product.terms.length > 0;
  const hasCategory = category.terms.length > 0;

  const groups = [];
  if (hasBrand) groups.push({ ratio: brand.ratio, weight: 0.45 });
  if (hasProduct) groups.push({ ratio: product.ratio, weight: 0.40 });
  if (hasCategory) groups.push({ ratio: category.ratio, weight: 0.15 });

  if (!groups.length && keyword.terms.length) {
    groups.push({ ratio: keyword.ratio, weight: 1 });
  }

  const totalWeight = groups.reduce((sum, group) => sum + group.weight, 0);
  const score = totalWeight
    ? groups.reduce((sum, group) => sum + group.ratio * group.weight, 0) / totalWeight
    : 0;

  const identityMatch = hasBrand
    ? brand.matched && (product.matched || category.matched)
    : hasProduct
      ? product.matched || category.matched
      : hasCategory
        ? category.matched
        : keyword.matched;

  const targetGender = detectGender_(`${target.category || ''} ${target.masterSubCategory || ''}`);
  const titleGender = detectGender_(title);
  const genderMismatch = Boolean(targetGender && titleGender && targetGender !== titleGender);
  const outerwearTypeMismatch = isOuterwearTarget_(target)
    && (!hasOuterwearCue_(title) || hasNonOuterwearCue_(title));
  const requiredFeatures = buildRequiredIdentityFeatures_(target);
  const missingFeatures = requiredFeatures.filter(feature =>
    !feature.alternatives.some(phrase => strictPhrasePresent_(title, phrase))
  );
  const reasons = [];

  if (!identityMatch) reasons.push('ブランド・商品・カテゴリ不一致');
  if (score < 0.55) reasons.push('一致スコア55未満');
  if (genderMismatch) reasons.push('性別カテゴリ不一致');
  if (outerwearTypeMismatch) reasons.push('商品種別不一致:アウター');
  for (const feature of missingFeatures) {
    reasons.push(`必須特徴不足:${feature.name}`);
  }

  return {
    accepted: reasons.length === 0,
    score: Math.round(score * 100),
    reasons,
    matchedFeatures: requiredFeatures
      .filter(feature => !missingFeatures.includes(feature))
      .map(feature => feature.name)
  };
}

function filterComparableItems_(target, items, marketLabel) {
  const accepted = [];
  let rejected = 0;
  const reasonCounts = {};
  const acceptedSamples = [];
  const rejectedSamples = [];

  for (const item of items) {
    const match = scoreHistoricalTitleMatch_(target, item.title);

    if (match.accepted) {
      accepted.push({ ...item, matchScore: match.score, matchFeatures: match.matchedFeatures });
      if (acceptedSamples.length < 3) {
        acceptedSamples.push({ title: item.title, score: match.score, features: match.matchedFeatures });
      }
    } else {
      rejected++;
      for (const reason of match.reasons) {
        reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
      }
      if (rejectedSamples.length < 3) {
        rejectedSamples.push({ title: item.title, score: match.score, reasons: match.reasons });
      }
    }
  }

  console.log(`${marketLabel}類似商品:`, accepted.length, '/', items.length);
  if (rejected) {
    console.log(`${marketLabel}類似度不足で除外:`, rejected);
  }
  console.log(`${marketLabel}採用例:`, JSON.stringify(acceptedSamples));
  console.log(`${marketLabel}除外理由:`, JSON.stringify(reasonCounts));
  if (rejectedSamples.length) {
    console.log(`${marketLabel}除外例:`, JSON.stringify(rejectedSamples));
  }

  return accepted;
}

// ============================================================
// Yahoo終了180日間 parser
// 既存 Market Comps の抽出ルールを基礎にしている。
// ============================================================

async function extractYahooClosedItems_(page, limit) {
  return page.evaluate(
    ({ limit }) => {
      function clean(value) {
        return String(value || '')
          .replace(/\u00a0/g, ' ')
          .replace(/[ \t]+/g, ' ')
          .replace(/\n{3,}/g, '\n\n')
          .trim();
      }

      function absoluteUrl(href) {
        try {
          return new URL(href, location.href).href;
        } catch (error) {
          return '';
        }
      }

      function findCard(anchor) {
        let node = anchor;

        for (let depth = 0; depth < 10; depth++) {
          node = node.parentElement;

          if (!node) {
            break;
          }

          const text = clean(node.innerText);

          if (
            text.includes('落札') &&
            text.includes('終了') &&
            text.length <= 5000
          ) {
            return node;
          }
        }

        return null;
      }

      function bestTitle(card, itemHref) {
        const links = Array.from(card.querySelectorAll('a'));

        const candidates = links
          .filter(link => {
            const href = absoluteUrl(link.getAttribute('href'));

            return (
              href &&
              href.split('#')[0] === itemHref.split('#')[0]
            );
          })
          .map(link =>
            clean(
              link.innerText ||
              link.getAttribute('aria-label') ||
              link.getAttribute('title')
            )
          )
          .filter(text => text && text.length >= 4)
          .sort((a, b) => b.length - a.length);

        if (candidates.length) {
          return candidates[0];
        }

        const heading = card.querySelector('h1,h2,h3,h4');
        return heading ? clean(heading.innerText) : '';
      }

      const anchors = Array.from(
        document.querySelectorAll('a[href*="/jp/auction/"]')
      );

      const seen = new Set();
      const results = [];

      for (const anchor of anchors) {
        if (results.length >= limit) {
          break;
        }

        const href = absoluteUrl(anchor.getAttribute('href'));

        if (!href) {
          continue;
        }

        const idMatch = href.match(/\/jp\/auction\/([^/?#]+)/);

        if (!idMatch) {
          continue;
        }

        const itemId = idMatch[1];

        if (seen.has(itemId)) {
          continue;
        }

        const card = findCard(anchor);

        if (!card) {
          continue;
        }

        const text = clean(card.innerText);
        const priceMatch = text.match(/落札\s*([\d,]+)\s*円/);
        const endMatch = text.match(
          /(\d{1,2}\/\d{1,2})\s+(\d{1,2}:\d{2})\s*終了/
        );

        if (!priceMatch || !endMatch) {
          continue;
        }

        const title = bestTitle(card, href);

        if (!title) {
          continue;
        }

        seen.add(itemId);

        results.push({
          itemId,
          url: href.split('#')[0],
          title,
          price: Number(String(priceMatch[1]).replace(/,/g, '')) || 0,
          endDateLabel: endMatch[1],
          endTimeLabel: endMatch[2]
        });
      }

      return results;
    },
    { limit }
  );
}

// ============================================================
// 集計 / Historical Market Score
// ============================================================

function quantile_(sortedValues, q) {
  if (!sortedValues.length) {
    return 0;
  }

  if (sortedValues.length === 1) {
    return sortedValues[0];
  }

  const position = (sortedValues.length - 1) * q;
  const base = Math.floor(position);
  const rest = position - base;
  const next = sortedValues[base + 1];

  if (next === undefined) {
    return sortedValues[base];
  }

  return (
    sortedValues[base] +
    rest * (next - sortedValues[base])
  );
}

function buildHistoricalScore_(target, stats) {
  const sampleCount = stats.sampleCount;
  const medianPrice = stats.medianPrice;
  const q25Price = stats.q25Price;
  const q75Price = stats.q75Price;
  const buyLimit = Number(target.normalBuyLimit || 0);
  const adoptedSale = Number(target.adoptedSalePrice || 0);

  if (
    sampleCount <= 0 ||
    medianPrice <= 0
  ) {
    return {
      score: 0,
      judgement: '過去実売0件・後回し'
    };
  }

  // ① 実売量 25点
  const volumeScore =
    clamp_(sampleCount / 20) * 25;

  // ② サンプル信頼度 10点
  const sampleScore =
    clamp_(sampleCount / 12) * 10;

  // ③ 中央売価 ÷ 通常仕入上限 25点
  // 通常仕入上限がDB側で利益条件を織り込んでいるため、
  // ここでは「過去市場が仕入上限より十分上にあるか」を見る。
  let medianSpreadScore = 0;

  if (buyLimit > 0) {
    const ratio = medianPrice / buyLimit;
    medianSpreadScore =
      clamp_((ratio - 1.0) / 1.5) * 25;
  }

  // ④ 25%値 ÷ 通常仕入上限 20点
  // 中央値だけでなく、弱めに売れたゾーンでも利益余地が残るか。
  let q25SpreadScore = 0;

  if (buyLimit > 0 && q25Price > 0) {
    const ratio = q25Price / buyLimit;
    q25SpreadScore =
      clamp_((ratio - 1.0) / 1.5) * 20;
  }

  // ⑤ 価格安定性 15点
  // IQRが中央値に対して小さいほど安定。
  const iqr = Math.max(0, q75Price - q25Price);
  const iqrRatio = medianPrice > 0
    ? iqr / medianPrice
    : 1;
  const stabilityScore =
    clamp_(1 - (iqrRatio / 1.0)) * 15;

  // ⑥ DB想定売価との整合 5点
  // 過去中央値がDB想定の50%以上なら満点へ近づける。
  let dbPlausibilityScore = 0;

  if (adoptedSale > 0) {
    const ratio = medianPrice / adoptedSale;
    dbPlausibilityScore =
      clamp_(ratio / 0.8) * 5;
  }

  const score = Math.round(
    volumeScore +
    sampleScore +
    medianSpreadScore +
    q25SpreadScore +
    stabilityScore +
    dbPlausibilityScore
  );

  let judgement;

  if (score >= 70 && sampleCount >= 5) {
    judgement = '過去市場強い・仕入側検証へ';
  } else if (score >= 50 && sampleCount >= 3) {
    judgement = '過去市場あり・要ライブ検証';
  } else {
    judgement = '過去市場弱い・優先度低';
  }

  return {
    score,
    judgement
  };
}

function summarizeHistorical_(target, items) {
  const prices = items
    .map(item => Number(item.price || 0))
    .filter(price => Number.isFinite(price) && price > 0)
    .sort((a, b) => a - b);

  if (!prices.length) {
    return {
      soldCount: 0,
      sampleCount: 0,
      minPrice: 0,
      q25Price: 0,
      medianPrice: 0,
      q75Price: 0,
      maxPrice: 0,
      historicalScore: 0,
      judgement: '過去実売0件・後回し',
      state: '0件'
    };
  }

  const stats = {
    sampleCount: prices.length,
    minPrice: prices[0],
    q25Price: Math.round(quantile_(prices, 0.25)),
    medianPrice: Math.round(quantile_(prices, 0.50)),
    q75Price: Math.round(quantile_(prices, 0.75)),
    maxPrice: prices[prices.length - 1]
  };

  const score = buildHistoricalScore_(target, stats);

  return {
    // 各市場で重複URLを除いた比較可能商品数の合計。
    soldCount: prices.length,
    sampleCount: prices.length,
    minPrice: stats.minPrice,
    q25Price: stats.q25Price,
    medianPrice: stats.medianPrice,
    q75Price: stats.q75Price,
    maxPrice: stats.maxPrice,
    historicalScore: score.score,
    judgement: score.judgement,
    state: '取得済'
  };
}

function summarizeMarket_(items) {
  const prices = items
    .map(item => Number(item.price || 0))
    .filter(price => Number.isFinite(price) && price > 0)
    .sort((a, b) => a - b);

  return {
    count: prices.length,
    medianPrice: prices.length
      ? Math.round(quantile_(prices, 0.5))
      : 0
  };
}

function classifyMarketSources_(mercari, yahoo) {
  if (mercari.count === 0 && yahoo.count === 0) {
    return 'データ不足';
  }

  if (mercari.count === 0 || yahoo.count === 0) {
    return '片市場のみ';
  }

  const gapRate = Math.abs(mercari.medianPrice - yahoo.medianPrice) /
    Math.max(mercari.medianPrice, yahoo.medianPrice);

  // 価格差35%以上は、商品混在・モデル差・状態差などを再確認する。
  if (gapRate >= 0.35) {
    return '市場差大';
  }

  const volumeRatio = Math.max(mercari.count, yahoo.count) /
    Math.min(mercari.count, yahoo.count);

  if (volumeRatio >= 1.5) {
    return mercari.count > yahoo.count ? 'Mercari優勢' : 'Yahoo優勢';
  }

  return '両市場一致';
}

function summarizeTwoMarkets_(target, mercariItems, yahooItems, marketStatus) {
  const mercari = summarizeMarket_(mercariItems);
  const yahoo = summarizeMarket_(yahooItems);
  const combined = summarizeHistorical_(target, [
    ...mercariItems,
    ...yahooItems
  ]);

  const hasBothMarketMedians =
    mercari.medianPrice > 0 && yahoo.medianPrice > 0;
  const marketMedianGapRate = hasBothMarketMedians
    ? Math.abs(mercari.medianPrice - yahoo.medianPrice) /
      Math.max(mercari.medianPrice, yahoo.medianPrice)
    // upsertHistoricalBackfill_ treats a JSON null as zero. "NaN" converts to
    // a non-finite number there, so the sheet leaves an unavailable gap blank.
    : 'NaN';

  const state = marketStatus.mercariSucceeded && marketStatus.yahooSucceeded
    ? (combined.sampleCount > 0 ? '取得済' : '0件')
    : '一部取得失敗';

  return {
    ...combined,
    soldCount: mercari.count + yahoo.count,
    sampleCount: mercari.count + yahoo.count,
    mercariSoldCount: mercari.count,
    mercariMedianPrice: mercari.medianPrice,
    yahooSoldCount: yahoo.count,
    yahooMedianPrice: yahoo.medianPrice,
    marketMedianGapRate,
    sourceJudgement: classifyMarketSources_(mercari, yahoo),
    state
  };
}

// ============================================================
// 1商品
// ============================================================

async function runTarget_(page, target) {
  if (!target.dbItemId) {
    throw new Error('DB商品IDがありません');
  }

  let mercariUrl = '';
  let mercariUrlError = '';
  const yahooUrl = String(target.yahooHistoricalUrl || '').trim();
  const marketErrors = [];

  try {
    mercariUrl = normalizeMercariSoldUrl_(target.mercariHistoricalUrl);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    mercariUrlError = message;
    console.error(`[${target.dbItemId}] Mercari売切 URL不正:`, message);
  }

  console.log('========================================');
  console.log('DB商品ID:', target.dbItemId);
  console.log('ブランド:', target.brand || '');
  console.log('カテゴリ:', target.category || '');
  console.log('商品:', target.product || '');
  console.log('Exploration Priority:', target.explorationPriority || 0);
  console.log('検索語:', target.searchKeyword || '');
  console.log('仕入URL Mercari:', target.mercariBuyUrl || '');
  console.log('仕入URL Yahoo:', target.yahooBuyUrl || '');
  console.log('相場URL Mercari売切:', mercariUrl);
  console.log('相場URL Yahoo180:', yahooUrl);

  const mercariItems = [];
  const yahooItems = [];
  const marketStatus = {
    mercariSucceeded: false,
    yahooSucceeded: false
  };

  try {
    if (!mercariUrl) {
      throw new Error(mercariUrlError || '相場URL_Mercari売切 がありません');
    }

    const response = await page.goto(
      mercariUrl,
      {
        waitUntil: 'domcontentloaded',
        timeout: PAGE_TIMEOUT_MS
      }
    );

    if (!response) {
      throw new Error('Mercari HTTPレスポンスなし');
    }

    const status = response.status();
    console.log('Mercari HTTP:', status);

    if (status < 200 || status >= 400) {
      throw new Error(`Mercari HTTP ${status}`);
    }

    await dismissMercariRegionGate_(page);
    await page.waitForSelector('body', { timeout: PAGE_TIMEOUT_MS });
    await page.waitForTimeout(2200);
    await loadMercariListings_(page);

    const rawItems = await extractMercariSoldItems_(
      page,
      MAX_MERCARI_SOLD_ITEMS
    );
    const comparable = filterComparableItems_(target, rawItems, 'Mercari売切');
    mercariItems.push(...comparable);
    marketStatus.mercariSucceeded = true;
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    marketErrors.push(`Mercari売切: ${message}`);
    console.error(`[${target.dbItemId}] Mercari売切取得失敗:`, message);
  }

  try {
    if (!yahooUrl) {
      throw new Error('相場URL_Yahoo180 がありません');
    }

    const response = await page.goto(
      yahooUrl,
      {
        waitUntil: 'domcontentloaded',
        timeout: PAGE_TIMEOUT_MS
      }
    );

    if (!response) {
      throw new Error('Yahoo HTTPレスポンスなし');
    }

    const status = response.status();
    console.log('Yahoo HTTP:', status);

    if (status < 200 || status >= 400) {
      throw new Error(`Yahoo HTTP ${status}`);
    }

    await page.waitForSelector('body', { timeout: PAGE_TIMEOUT_MS });
    await page.waitForTimeout(2200);

    const bodyText = String(
      await page.locator('body').innerText()
    ).replace(/\u00a0/g, ' ');

    const looksLikeClosedSearch =
      bodyText.includes('終了180日間') ||
      bodyText.includes('180日間の落札相場') ||
      bodyText.includes('落札相場');

    if (!looksLikeClosedSearch) {
      throw new Error('Yahoo落札相場ページとして確認できません');
    }

    const rawItems = await extractYahooClosedItems_(
      page,
      MAX_SOLD_ITEMS
    );
    const comparable = filterComparableItems_(target, rawItems, 'Yahoo落札');
    yahooItems.push(...comparable);
    marketStatus.yahooSucceeded = true;
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    marketErrors.push(`Yahoo落札: ${message}`);
    console.error(`[${target.dbItemId}] Yahoo落札取得失敗:`, message);
  }

  if (!marketStatus.mercariSucceeded && !marketStatus.yahooSucceeded) {
    throw new Error(
      `${target.dbItemId}: Mercari・Yahoo両市場の取得に失敗しました。${marketErrors.join(' / ')}`
    );
  }

  const summary = summarizeTwoMarkets_(
    target,
    mercariItems,
    yahooItems,
    marketStatus
  );

  console.log('実売サンプル:', summary.sampleCount);
  console.log('Mercari売切件数 / 中央値:', summary.mercariSoldCount, yen_(summary.mercariMedianPrice));
  console.log('Yahoo落札件数 / 中央値:', summary.yahooSoldCount, yen_(summary.yahooMedianPrice));
  console.log(
    '市場間中央値差率:',
    typeof summary.marketMedianGapRate === 'number'
      ? `${(summary.marketMedianGapRate * 100).toFixed(1)}%`
      : '—'
  );
  console.log('相場ソース判定:', summary.sourceJudgement);
  console.log('25%値:', yen_(summary.q25Price));
  console.log('中央値:', yen_(summary.medianPrice));
  console.log('75%値:', yen_(summary.q75Price));
  console.log('Historical Score:', summary.historicalScore);
  console.log('Historical判定:', summary.judgement);
  console.log('Historical状態:', summary.state);

  await saveSummary_(target, summary);

  if (marketErrors.length) {
    throw new Error(
      `${target.dbItemId}: 一部市場は失敗しましたが、取得できた市場のデータは保存済みです。${marketErrors.join(' / ')}`
    );
  }

  return summary;
}

// ============================================================
// main
// ============================================================

async function main() {
  if (!INGEST_URL || !INGEST_SECRET) {
    throw new Error('GitHub Secrets が設定されていません');
  }

  const { chromium } = require('playwright');

  console.log('========================================');
  console.log('Historical Backfill START');
  console.log('Batch limit:', BATCH_LIMIT);
  console.log('Max Mercari sold items:', MAX_MERCARI_SOLD_ITEMS);
  console.log('Max sold items:', MAX_SOLD_ITEMS);
  console.log('Force:', FORCE);
  console.log('指定DB商品ID:', TARGET_DB_ITEM_ID || '(なし)');
  console.log('Dry run:', DRY_RUN);
  console.log('Auto continue:', AUTO_CONTINUE);
  console.log('========================================');

  if (TARGET_DB_ITEM_ID && !FORCE) {
    throw new Error(
      'DB商品IDを指定して再処理する場合は、workflow_dispatch の force を true にしてください'
    );
  }

  const targetResult = await getTargets_();
  const returnedTargets = Array.isArray(targetResult.targets)
    ? targetResult.targets
    : [];
  const targets = selectHistoricalTargets_(
    returnedTargets,
    TARGET_DB_ITEM_ID
  );

  console.log('今回対象:', targets.length);
  console.log('未処理候補:', targetResult.remaining || 0);

  if (TARGET_DB_ITEM_ID && targets.length !== 1) {
    const returnedIds = returnedTargets
      .map(target => String(target && target.dbItemId || '').trim())
      .filter(Boolean);
    throw new Error(
      `指定ID ${TARGET_DB_ITEM_ID} をApps Scriptから1件取得できませんでした。` +
      `返却ID: ${returnedIds.join(', ') || '(なし)'}. ` +
      'Apps Script側にも dbItemId 絞り込みを反映して再デプロイしてください。対象外の商品は処理していません。'
    );
  }

  if (!targets.length) {
    console.log('Historical Backfill: 対象なし');
    writeGitHubOutput_('has_more', 'false');
    return;
  }

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage'
    ]
  });

  const context = await browser.newContext({
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/140.0.0.0 Safari/537.36',
    viewport: {
      width: 1440,
      height: 1200
    }
  });

  const page = await context.newPage();

  let success = 0;
  let failed = 0;
  const errors = [];

  try {
    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];

      try {
        await runTarget_(page, target);
        success++;
      } catch (error) {
        failed++;
        const message =
          error && error.message
            ? error.message
            : String(error);

        errors.push({
          dbItemId: target.dbItemId,
          error: message
        });

        console.error(
          `[${target.dbItemId}] Historical Backfill ERROR:`,
          message
        );
      }

      if (
        i < targets.length - 1 &&
        BETWEEN_TARGETS_MS > 0
      ) {
        await sleep_(BETWEEN_TARGETS_MS);
      }
    }
  } finally {
    await browser.close();
  }

  console.log('========================================');
  console.log('Historical Backfill END');
  console.log('成功:', success);
  console.log('失敗:', failed);

  if (errors.length) {
    console.log('失敗一覧:', JSON.stringify(errors, null, 2));
  }

  const hasMore = shouldContinueHistoricalBackfill_({
    autoContinue: AUTO_CONTINUE,
    force: FORCE,
    requestedDbItemId: TARGET_DB_ITEM_ID,
    remaining: Number(targetResult.remaining || 0),
    targetCount: targets.length,
    success,
    failed
  });

  writeGitHubOutput_('has_more', hasMore ? 'true' : 'false');
  console.log('自動継続:', hasMore ? '次バッチあり' : '停止');

  console.log('========================================');

  // 一部失敗でも成功分は保存済み。
  // 全件失敗した時だけWorkflowを赤にする。
  if (success === 0 && failed > 0) {
    throw new Error('Historical Backfill が全件失敗しました');
  }
}

module.exports = {
  buildRequiredIdentityFeatures_,
  filterComparableItems_,
  scoreHistoricalTitleMatch_,
  selectHistoricalTargets_,
  shouldContinueHistoricalBackfill_
};

if (require.main === module) {
  main().catch(error => {
    console.error(error);
    process.exit(1);
  });
}
