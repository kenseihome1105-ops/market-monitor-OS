const test = require('node:test');
const assert = require('node:assert/strict');

const {
  scoreHistoricalTitleMatch_,
  selectHistoricalTargets_,
  shouldContinueHistoricalBackfill_
} = require('./historical-backfill');

const balmainRareLeather = {
  brand: 'BALMAIN',
  category: 'メンズ',
  product: 'レザージャケット',
  lineModel: '希少革',
  keywordAliases: 'ホース/ディア/バッファロー',
  highValue: '希少革'
};

const burberryLondonSuit = {
  brand: 'BURBERRY',
  category: 'メンズ',
  product: 'スーツ',
  lineModel: 'BURBERRY LONDON'
};

test('BALMAINの一般的な革ジャケットは希少革商品として採用しない', () => {
  const result = scoreHistoricalTitleMatch_(
    balmainRareLeather,
    'BALMAIN バルマン メンズ レザージャケット 羊革'
  );

  assert.equal(result.accepted, false);
  assert.ok(result.reasons.some(reason => reason.includes('高値要素:希少革の素材')));
});

test('BALMAINのホースハイド、ディアスキン、バッファロー革は採用できる', () => {
  for (const title of [
    'BALMAIN バルマン メンズ ホースハイド レザージャケット',
    'BALMAIN メンズ ディアスキン レザージャケット',
    'BALMAIN バッファロー革 メンズ レザージャケット'
  ]) {
    assert.equal(scoreHistoricalTitleMatch_(balmainRareLeather, title).accepted, true, title);
  }
});

test('羊毛皮の高値要素はムートン表記と照合し、通常の羊革ジャケットは除外する', () => {
  const target = {
    brand: 'BALMAIN',
    category: 'メンズ アウター',
    product: 'ジャケット',
    highValue: '羊毛皮・冬物'
  };

  const moutonTitle = scoreHistoricalTitleMatch_(
    target,
    'BALMAIN バルマン メンズ ダブルムートンジャケット'
  );
  const genericLeatherTitle = scoreHistoricalTitleMatch_(
    target,
    'BALMAIN バルマン メンズ 羊革 レザージャケット'
  );

  assert.equal(moutonTitle.accepted, true, JSON.stringify(moutonTitle));
  assert.equal(genericLeatherTitle.accepted, false);
  assert.ok(genericLeatherTitle.reasons.some(reason => reason.includes('高値要素:羊毛皮')));
});

test('ムートン特徴が一致しても、ジャケット/コート対象では手袋を除外する', () => {
  const target = {
    brand: 'BALMAIN',
    category: 'その他アウター',
    product: 'ムートンジャケット/コート',
    lineModel: 'ムートン',
    highValue: '羊毛皮・冬物'
  };

  const gloveTitle = '美品 BALMAIN バルマン ニット×ムートン コンビ ロンググローブ 手袋 レディース';
  const jacketTitle = '超美品 バルマン BALMAIN ラムレザー ムートンコート';
  const glove = scoreHistoricalTitleMatch_(target, gloveTitle);
  const jacket = scoreHistoricalTitleMatch_(target, jacketTitle);

  assert.equal(glove.accepted, false, JSON.stringify(glove));
  assert.ok(glove.reasons.includes('商品種別不一致:アウター'));
  assert.equal(jacket.accepted, true, JSON.stringify(jacket));
});

test('Burberry London指定では通常のBurberryスーツを除外する', () => {
  const genericTitle = scoreHistoricalTitleMatch_(
    burberryLondonSuit,
    'BURBERRY バーバリー メンズ シングルスーツ'
  );
  const romanTitle = scoreHistoricalTitleMatch_(
    burberryLondonSuit,
    'BURBERRY LONDON メンズ スーツ'
  );
  const japaneseTitle = scoreHistoricalTitleMatch_(
    burberryLondonSuit,
    'バーバリー ロンドン メンズ スーツ'
  );

  assert.equal(genericTitle.accepted, false);
  assert.ok(genericTitle.reasons.some(reason => reason.includes('ライン/モデル:ロンドン')));
  assert.equal(romanTitle.accepted, true);
  assert.equal(japaneseTitle.accepted, true);
});

test('男女の明示的なカテゴリ不一致は除外する', () => {
  const result = scoreHistoricalTitleMatch_(
    burberryLondonSuit,
    'BURBERRY LONDON レディース スーツ'
  );

  assert.equal(result.accepted, false);
  assert.ok(result.reasons.includes('性別カテゴリ不一致'));
});

test('ラインに指定された2B・ロング・ダブルをそれぞれ必須にする', () => {
  const twoButtonTarget = {
    brand: 'BURBERRY',
    category: 'メンズ',
    product: 'スーツ',
    lineModel: 'BURBERRY LONDON 2B'
  };
  const longDoubleTarget = {
    brand: 'HERMES',
    category: 'メンズ',
    product: 'チェスターコート',
    lineModel: 'チェスター ロング ダブル'
  };

  assert.equal(
    scoreHistoricalTitleMatch_(twoButtonTarget, 'BURBERRY LONDON メンズ 2ボタン スーツ').accepted,
    true
  );
  assert.equal(
    scoreHistoricalTitleMatch_(twoButtonTarget, 'BURBERRY LONDON メンズ シングルスーツ').accepted,
    false
  );
  assert.equal(
    scoreHistoricalTitleMatch_(longDoubleTarget, 'HERMES メンズ ロング ダブル チェスターコート').accepted,
    true
  );
  assert.equal(
    scoreHistoricalTitleMatch_(longDoubleTarget, 'HERMES メンズ ロング シングル チェスターコート').accepted,
    false
  );
});

test('高値要素のスラッシュは候補のいずれかに一致すればよい', () => {
  const target = {
    brand: 'Tom Ford',
    category: 'メンズスーツ',
    product: 'ビジネススーツ',
    lineModel: 'ブランド生地',
    highValue: 'DORMEUIL / Loro Piana / Zegna 生地'
  };
  const zegnaTitle = 'TOM FORD トムフォード メンズ Ermenegildo Zegna ゼニア生地 ウール100% ビジネススーツ';
  const noFabricBrandTitle = 'TOM FORD トムフォード メンズ ウール100% ビジネススーツ';

  assert.equal(scoreHistoricalTitleMatch_(target, zegnaTitle).accepted, true, JSON.stringify(scoreHistoricalTitleMatch_(target, zegnaTitle)));
  assert.equal(scoreHistoricalTitleMatch_(target, noFabricBrandTitle).accepted, false);
});

test('高値要素は中黒区切りをすべて満たし、素材のスラッシュ候補はどちらかでよい', () => {
  const target = {
    brand: 'Loro Piana',
    category: 'コート',
    product: 'チェスターコート',
    lineModel: 'ロング ダブル',
    highValue: 'ロング・ダブル・ウール/カシミヤ'
  };
  const cashmereTitle = 'ロロピアーナ メンズ ロング ダブル カシミヤ100% チェスターコート';
  const woolTitle = 'ロロピアーナ メンズ ロング ダブル ウール100% チェスターコート';
  const missingDoubleTitle = 'ロロピアーナ メンズ ロング シングル カシミヤ100% チェスターコート';
  const missingMaterialTitle = 'ロロピアーナ メンズ ロング ダブル チェスターコート';

  assert.equal(scoreHistoricalTitleMatch_(target, cashmereTitle).accepted, true, JSON.stringify(scoreHistoricalTitleMatch_(target, cashmereTitle)));
  assert.equal(scoreHistoricalTitleMatch_(target, woolTitle).accepted, true, JSON.stringify(scoreHistoricalTitleMatch_(target, woolTitle)));
  assert.equal(scoreHistoricalTitleMatch_(target, missingDoubleTitle).accepted, false);
  assert.equal(scoreHistoricalTitleMatch_(target, missingMaterialTitle).accepted, false);
});

test('日本語ブランド名だけで出品された候補も照合する', () => {
  const loroTarget = {
    brand: 'Loro Piana',
    category: 'コート',
    product: 'チェスターコート',
    lineModel: 'ロング ダブル',
    highValue: 'ロング・ダブル・ウール/カシミヤ'
  };
  const brunelloTarget = {
    brand: 'Brunello Cucinelli',
    category: 'コート',
    product: 'チェスターコート',
    lineModel: 'ロング ダブル',
    highValue: 'ロング・ダブル・ウール/カシミヤ'
  };

  assert.equal(
    scoreHistoricalTitleMatch_(loroTarget, 'ロロピアーナ カシミヤ100% ダブルブレスト ロングコート 黒 44').accepted,
    true
  );
  assert.equal(
    scoreHistoricalTitleMatch_(brunelloTarget, 'ブルネロクチネリ カシミヤ100% チェスターコート ロング ダブル 紺 52').accepted,
    true
  );
});

test('スリーピース表記を3ピースと同じモデルとして照合し、高値3条件を維持する', () => {
  const target = {
    brand: 'Tom Ford',
    category: 'メンズスーツ',
    product: '3ピーススーツ',
    lineModel: 'スリーピース',
    highValue: 'ベスト付3点・濃色・ウール100%'
  };
  const validTitle = 'TOM FORD トムフォード メンズ 3ピーススーツ ベスト付き ウール100% ネイビー';
  const missingColorTitle = 'TOM FORD トムフォード メンズ スリーピーススーツ ベスト付き ウール100%';
  const missingWoolPercentageTitle = 'TOM FORD トムフォード メンズ three-piece suit vest dark navy wool blend';

  assert.equal(scoreHistoricalTitleMatch_(target, validTitle).accepted, true, JSON.stringify(scoreHistoricalTitleMatch_(target, validTitle)));
  assert.equal(scoreHistoricalTitleMatch_(target, missingColorTitle).accepted, false);
  assert.equal(scoreHistoricalTitleMatch_(target, missingWoolPercentageTitle).accepted, false);
});

test('カシミヤ100%指定では混紡表記だけの候補を採用しない', () => {
  const target = {
    brand: 'Tom Ford',
    category: 'ニット',
    product: 'セーター',
    highValue: 'カシミヤ100%'
  };

  assert.equal(
    scoreHistoricalTitleMatch_(target, 'TOM FORD カシミヤ100% セーター').accepted,
    true
  );
  assert.equal(
    scoreHistoricalTitleMatch_(target, 'TOM FORD 100% cashmere セーター').accepted,
    true
  );
  assert.equal(
    scoreHistoricalTitleMatch_(target, 'TOM FORD カシミヤ混 セーター').accepted,
    false
  );
});

test('必須モデル指定がない通常商品は従来どおり照合できる', () => {
  const result = scoreHistoricalTitleMatch_(
    { brand: 'HERMES', category: 'メンズ', product: 'コート' },
    'HERMES エルメス メンズ チェスターコート'
  );

  assert.equal(result.accepted, true);
});

test('指定DB商品IDがある場合は完全一致する対象だけを選ぶ', () => {
  const targets = [
    { dbItemId: '06OUTR-051', brand: 'Balmain' },
    { dbItemId: '06OUTR-052', brand: 'Balmain' }
  ];

  assert.deepEqual(
    selectHistoricalTargets_(targets, '06OUTR-051'),
    [{ dbItemId: '06OUTR-051', brand: 'Balmain' }]
  );
  assert.deepEqual(selectHistoricalTargets_(targets, ' missing '), []);
  assert.deepEqual(selectHistoricalTargets_(targets, ''), targets);
});

test('自動継続は全件成功し、未処理対象が残るときだけ有効になる', () => {
  assert.equal(shouldContinueHistoricalBackfill_({
    autoContinue: true,
    force: false,
    requestedDbItemId: '',
    remaining: 12,
    targetCount: 5,
    success: 5,
    failed: 0
  }), true);
});

test('対象が最後のバッチだけなら自動継続しない', () => {
  assert.equal(shouldContinueHistoricalBackfill_({
    autoContinue: true,
    remaining: 5,
    targetCount: 5,
    success: 5,
    failed: 0
  }), false);
});

test('対象なしなら自動継続しない', () => {
  assert.equal(shouldContinueHistoricalBackfill_({
    autoContinue: true,
    remaining: 0,
    targetCount: 0,
    success: 0,
    failed: 0
  }), false);
});

test('1件でも失敗したバッチは自動継続しない', () => {
  assert.equal(shouldContinueHistoricalBackfill_({
    autoContinue: true,
    remaining: 12,
    targetCount: 5,
    success: 4,
    failed: 1
  }), false);
});

test('force再処理は自動継続しない', () => {
  assert.equal(shouldContinueHistoricalBackfill_({
    autoContinue: true,
    force: true,
    remaining: 12,
    targetCount: 5,
    success: 5,
    failed: 0
  }), false);
});

test('商品IDを指定した単体再処理は自動継続しない', () => {
  assert.equal(shouldContinueHistoricalBackfill_({
    autoContinue: true,
    force: true,
    requestedDbItemId: '06OUTR-051',
    remaining: 12,
    targetCount: 1,
    success: 1,
    failed: 0
  }), false);
});

test('自動継続を明示的に無効にした場合は次バッチを起動しない', () => {
  assert.equal(shouldContinueHistoricalBackfill_({
    autoContinue: false,
    remaining: 12,
    targetCount: 5,
    success: 5,
    failed: 0
  }), false);
});
