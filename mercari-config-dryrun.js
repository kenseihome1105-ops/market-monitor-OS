const MARKET_INGEST_URL =
  process.env.MARKET_INGEST_URL;

const MARKET_INGEST_SECRET =
  process.env.MARKET_INGEST_SECRET;


async function main() {

  if (!MARKET_INGEST_URL) {
    throw new Error(
      'MARKET_INGEST_URL がありません'
    );
  }

  if (!MARKET_INGEST_SECRET) {
    throw new Error(
      'MARKET_INGEST_SECRET がありません'
    );
  }


  console.log(
    '=============================='
  );

  console.log(
    'Mercari 市場監視設定 Dry Run'
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
              'メルカリ'
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
      'RAW RESPONSE:',
      text
    );

    throw new Error(
      'JSON応答ではありません'
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
      JSON.stringify(result)
    );

  }


  console.log(
    '取得件数:',
    result.count
  );


  console.log(
    '市場フィルタ:',
    result.marketFilter
  );


  const configs =
    Array.isArray(
      result.configs
    )
      ? result.configs
      : [];


  configs.forEach(
    (config, index) => {

      console.log(
        '------------------------------'
      );

      console.log(
        `[${index + 1}/${configs.length}]`
      );

      console.log(
        '条件ID:',
        config.conditionId
      );

      console.log(
        '市場:',
        config.market
      );

      console.log(
        '条件名:',
        config.searchName
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
  );


  if (
    configs.length !== 2
  ) {

    throw new Error(
      '現在のMercari ON条件は2件想定ですが、' +
      configs.length +
      '件返りました'
    );

  }


  const configMap =
    new Map(
      configs.map(
        config => [
          config.conditionId,
          config
        ]
      )
    );


  const m01 =
    configMap.get(
      'M-01'
    );


  const m02 =
    configMap.get(
      'M-02'
    );


  if (!m01) {

    throw new Error(
      'M-01が取得できていません'
    );

  }


  if (!m02) {

    throw new Error(
      'M-02が取得できていません'
    );

  }


  const expectedConfigs = [
    {
      conditionId:
        'M-01',

      searchName:
        'GUCCI スーツ'
    },

    {
      conditionId:
        'M-02',

      searchName:
        'PRADA スーツ'
    }
  ];


  for (
    const expected
    of expectedConfigs
  ) {

    const config =
      configMap.get(
        expected.conditionId
      );


    if (
      config.market !== 'メルカリ'
    ) {

      throw new Error(
        expected.conditionId +
        'の市場がメルカリではありません'
      );

    }


    if (
      config.searchName !==
      expected.searchName
    ) {

      throw new Error(
        expected.conditionId +
        'の条件名が想定と違います: ' +
        config.searchName
      );

    }


    if (
      !config.searchUrl
    ) {

      throw new Error(
        expected.conditionId +
        'の検索URLが空です'
      );

    }

  }


  console.log(
    '=============================='
  );

  console.log(
    '✅ Mercari 市場監視設定 Dry Run SUCCESS'
  );

  console.log(
    '✅ M-01 / M-02 の2条件取得確認'
  );

  console.log(
    '※ 台帳更新なし'
  );

  console.log(
    '※ LINE送信なし'
  );

}


main()
  .catch(
    error => {

      console.error(
        'MERCARI CONFIG DRY RUN ERROR'
      );

      console.error(
        error
      );

      process.exit(1);

    }
  );
