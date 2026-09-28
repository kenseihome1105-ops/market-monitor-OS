const test = require('node:test');
const assert = require('node:assert/strict');

const {
  scoreHistoricalTitleMatch_,
  selectHistoricalTargets_
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
  assert.ok(genericLeatherTitle.reasons.some(reason => reason.includes('高値要素:羊毛皮・冬物')));
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
