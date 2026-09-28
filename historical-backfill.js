const MARKET_INGEST = {



  SPREADSHEET_ID:



    '1ESxTivWg9JsLCOy4LQrmdk3o2YIGIfqpW0K6djWDDKc',







  SHEET_NAME:



    '市場監視台帳',







  CONFIG_SHEET_NAME:



    '市場監視設定',







  MARKET_COMPS_SHEET_NAME:



    '相場比較データ',







  MASTER_SHEET_NAME:



    '商品マスター',









  HISTORICAL_SHEET_NAME:



    '利益商品探索AI',
  MARKET_COMPS_COLUMN_COUNT:



    43,







  SECRET_PROP:



    'MARKET_INGEST_SECRET'



};











// ============================================================



// 初回のみ



//



// ※ 既にSecretはGitHubと接続済み。



// ※ 今回は絶対に実行しない。



// ============================================================







function setupMarketIngestSecret() {







  const secret =



    Utilities.getUuid().replace(/-/g, '') +



    Utilities.getUuid().replace(/-/g, '');







  PropertiesService



    .getScriptProperties()



    .setProperty(



      MARKET_INGEST.SECRET_PROP,



      secret



    );







  console.log(



    'MARKET_INGEST_SECRET=' + secret



  );



}











// ============================================================



// GitHub → market-ingest



//



// 3つの用途を同じmarket-ingestハンドラで処理



//



// ① action = getConfig



//    市場監視設定のON条件を取得



//



// ② action = upsertMarketComps



//    Yahoo / Mercari 等の類似成約データを



//    「相場比較データ」へ安全にupsert



//



// ③ actionなし



//    従来どおり市場監視台帳へ商品をupsert



// ============================================================







function marketIngestDoPostOS_(e) {







  let lock = null;



  let lockAcquired = false;







  try {







    // ========================================================



    // POST body



    // ========================================================







    const body =



      JSON.parse(



        (



          e &&



          e.postData &&



          e.postData.contents



        )



          ? e.postData.contents



          : '{}'



      );











    // ========================================================



    // Secret認証



    //



    // 既存Secretをそのまま使用



    // ========================================================







    const expectedSecret =



      PropertiesService



        .getScriptProperties()



        .getProperty(



          MARKET_INGEST.SECRET_PROP



        );







    if (



      !expectedSecret ||



      body.secret !== expectedSecret



    ) {







      return jsonResponse_({



        ok: false,



        error: 'unauthorized'



      });



    }











    // ========================================================



    // Spreadsheet



    // ========================================================







    const ss =



      SpreadsheetApp.openById(



        MARKET_INGEST.SPREADSHEET_ID



      );











    // ========================================================



    // ① 監視設定取得



    //



    // GitHubから:



    //



    // {



    //   secret: "...",



    //   action: "getConfig",



    //   market: "ヤフオク"



    // }



    //



    // market省略なら



    // Mercari + YahooすべてのON条件を返す



    // ========================================================







    const action =



      String(



        body.action || ''



      ).trim();







    if (



      action === 'getConfig'



    ) {







      const marketFilter =



        String(



          body.market || ''



        ).trim();







      if (



        marketFilter



        &&



        marketFilter !== 'メルカリ'



        &&



        marketFilter !== 'ヤフオク'



      ) {







        return jsonResponse_({



          ok: false,



          error:



            'invalid market filter'



        });



      }







      const configs =



        getEnabledMarketConfigs_(



          ss,



          marketFilter



        );







      return jsonResponse_({



        ok: true,







        action:



          'getConfig',







        marketFilter:



          marketFilter || 'ALL',







        count:



          configs.length,







        configs



      });



    }











    // ========================================================



    // ①-B 利益商品探索AI Historical Backfill 対象取得



    // 商品マスター + 利益商品探索AIから、



    // 過去市場データ未取得の商品を優先度順に返す。



    // 読み取り専用なのでScript Lock対象外。



    // ========================================================



    if (



      action === 'getHistoricalBackfillTargets'



    ) {



      return jsonResponse_(



        getHistoricalBackfillTargets_(



          ss,



          body



        )



      );



    }







    // ========================================================



    // 書き込み系だけScript Lockを取得



    //



    // getConfig は読み取り専用なので、



    // Mercari / Yahoo / Market Comps が重なっても



    // busyで弾かれないようロック対象外にする。



    // ========================================================



    lock =



      LockService.getScriptLock();







    if (



      !lock.tryLock(5000)



    ) {







      return jsonResponse_({



        ok: false,



        error: 'busy'



      });



    }







    lockAcquired = true;







    // ========================================================



    // ①-C Historical Backfill 結果保存



    // 利益商品探索AI Y:AH に、



    // Yahoo終了180日間の過去実売サマリーを保存する。



    // ========================================================



    if (



      action === 'upsertHistoricalBackfill'



    ) {



      return upsertHistoricalBackfill_(



        ss,



        body



      );



    }







    // ========================================================



    // ② 相場比較データ upsert



    //



    // GitHubから:



    //



    // {



    //   secret: "...",



    //   action: "upsertMarketComps",



    //   target: { ... },



    //   comparisons: [ ... ]



    // }



    //



    // 既存の市場監視台帳には触らない。



    // ========================================================







    if (



      action === 'upsertMarketComps'



    ) {







      return upsertMarketComps_(



        ss,



        body



      );



    }











    // ========================================================



    // ③ 以下は従来の市場監視台帳upsert



    //



    // 既存仕様を維持



    // ========================================================







    const market =



      String(



        body.market || ''



      ).trim();







    const conditionId =



      String(



        body.conditionId || ''



      ).trim();







    const items =



      Array.isArray(body.items)



        ? body.items



        : [];







    if (



      market !== 'メルカリ'



      &&



      market !== 'ヤフオク'



    ) {







      return jsonResponse_({



        ok: false,



        error: 'invalid market'



      });



    }







    if (!conditionId) {







      return jsonResponse_({



        ok: false,



        error: 'conditionId required'



      });



    }











    const sheet =



      ss.getSheetByName(



        MARKET_INGEST.SHEET_NAME



      );







    if (!sheet) {







      throw new Error(



        '市場監視台帳が見つかりません'



      );



    }











    const lastRow =



      sheet.getLastRow();







    const existingRows =



      lastRow >= 2







        ? sheet



            .getRange(



              2,



              1,



              lastRow - 1,



              21



            )



            .getValues()







        : [];











    // ========================================================



    // Market Comps 既取得対象キーMap



    //



    // 目的:



    // ・新規時に相場取得できなかった商品でも、



    //   後からDB商品IDが入った場合に再度Market Comps対象へ戻す



    // ・同じ対象で相場比較データが既に存在する場合は再取得しない



    //



    // 相場比較データ B列 = 対象キー



    // ========================================================







    const marketCompTargetKeyMap =



      {};







    const marketCompSheet =



      ss.getSheetByName(



        MARKET_INGEST.MARKET_COMPS_SHEET_NAME



      );







    if (



      marketCompSheet &&



      marketCompSheet.getLastRow() >= 2



    ) {







      marketCompSheet



        .getRange(



          2,



          2,



          marketCompSheet.getLastRow() - 1,



          1



        )



        .getValues()



        .forEach(



          row => {







            const targetKey =



              String(



                row[0] || ''



              ).trim();







            if (targetKey) {



              marketCompTargetKeyMap[



                targetKey



              ] =



                true;



            }



          }



        );



    }











    // ========================================================



    // 商品マスター metadata Map



    //



    // Market Comps はDB同定後だけ実行する。



    // GitHubへDB商品ID・ブランド・カテゴリ・商品・検索語等を返す。



    // ========================================================







    const masterMetaMap =



      {};







    const masterSheet =



      ss.getSheetByName(



        MARKET_INGEST.MASTER_SHEET_NAME



      );







    if (!masterSheet) {



      throw new Error(



        '商品マスターが見つかりません'



      );



    }







    if (



      masterSheet.getLastRow() >= 2



    ) {







      masterSheet



        .getRange(



          2,



          1,



          masterSheet.getLastRow() - 1,



          32



        )



        .getValues()



        .forEach(



          row => {







            const dbItemId =



              String(



                row[0] || ''



              ).trim();







            const enabled =



              String(



                row[1] || ''



              )



                .trim()



                .toUpperCase();







            if (



              !dbItemId ||



              enabled !== 'ON'



            ) {



              return;



            }







            masterMetaMap[



              dbItemId



            ] = {







              dbItemId,







              category:



                String(



                  row[3] || ''



                ).trim(),







              brand:



                String(



                  row[4] || ''



                ).trim(),







              product:



                String(



                  row[5] || ''



                ).trim(),







              model:



                String(



                  row[6] || ''



                ).trim(),







              searchKeyword:



                String(



                  row[26] || ''



                ).trim(),







              subCategory:



                String(



                  row[30] || ''



                ).trim(),







              lineModel:



                String(



                  row[31] || ''



                ).trim()



            };



          }



        );



    }











    // ========================================================



    // 既存商品Map



    //



    // 市場 + 出品ID



    // ========================================================







    const rowMap =



      {};







    existingRows.forEach(



      (row, index) => {







        const rowMarket =



          String(



            row[0] || ''



          ).trim();







        const itemId =



          String(



            row[2] || ''



          ).trim();







        if (



          rowMarket &&



          itemId



        ) {







          rowMap[



            rowMarket +



            '::' +



            itemId



          ] =



            index + 2;



        }



      }



    );











    let inserted =



      0;







    const insertedItems =



      [];







    /**



     * insertedItems は後方互換のため名称を維持。



     *



     * 実際には「DB同定済みの Market Comps取得対象」だけ返す。



     *



     * 条件:



     * ・DB商品ID確定済み



     * ・商品マスターmetadata取得済み



     * ・相場比較データ0件



     *



     * 新規直後のDB未同定商品は流さない。



     * V4等でDB同定後、次回監視で自動バックフィルする。



     */



    const marketCompQueued =



      {};







    let updated =



      0;







    const now =



      new Date();











    // ========================================================



    // 商品upsert



    // ========================================================







    items.forEach(



      item => {







        const itemId =



          String(



            item.itemId || ''



          ).trim();







        const url =



          String(



            item.url || ''



          ).trim();







        const title =



          String(



            item.title || ''



          ).trim();







        const price =



          Number(



            item.price || 0



          );







        const remainingTime =



          String(



            item.remainingTime || ''



          ).trim();







        const endTime =



          item.endTime



            ? new Date(



                item.endTime



              )



            : '';







        if (



          !itemId ||



          !url ||



          !title ||



          !price



        ) {







          return;



        }











        const key =



          market +



          '::' +



          itemId;







        const existingRow =



          rowMap[key];











        // ====================================================



        // 既存商品



        // ====================================================







        if (



          existingRow



        ) {







          const initialPrice =



            sheet



              .getRange(



                existingRow,



                6



              )



              .getValue();







          const initialFound =



            sheet



              .getRange(



                existingRow,



                8



              )



              .getValue();











          // ==================================================



          // D〜J



          //



          // D URL



          // E 商品名



          // F 初回価格



          // G 現在価格



          // H 初回発見



          // I 最終確認



          // J 発見元



          // ==================================================







          sheet



            .getRange(



              existingRow,



              4,



              1,



              7



            )



            .setValues([



              [



                url,



                title,



                initialPrice,



                price,



                initialFound,



                now,



                '市場走査'



              ]



            ]);











          // ==================================================



          // T 終了日時



          // ==================================================







          if (



            endTime &&



            endTime instanceof Date &&



            !isNaN(



              endTime.getTime()



            )



          ) {







            sheet



              .getRange(



                existingRow,



                20



              )



              .setValue(



                endTime



              );



          }











          // ==================================================



          // U 残り時間



          // ==================================================







          sheet



            .getRange(



              existingRow,



              21



            )



            .setValue(



              remainingTime



            );







          updated++;











          // ==================================================



          // 既存商品 Market Comps 自動バックフィル



          //



          // 条件:



          // ・K列 DB商品IDあり



          // ・相場比較データに対象キーがまだ0件



          //



          // これにより、



          // 「新規発見時はDB未同定だったが、



          //   後から商品マスター追加でDB同定された商品」



          // を自動でMarket Comps取得へ戻せる。



          // ==================================================







          const existingDbItemId =



            String(



              sheet



                .getRange(



                  existingRow,



                  11



                )



                .getValue() || ''



            ).trim();











          const masterMeta =



            existingDbItemId



              ? masterMetaMap[



                  existingDbItemId



                ] || null



              : null;











          if (



            existingDbItemId



            &&



            masterMeta



            &&



            !marketCompTargetKeyMap[



              key



            ]



            &&



            !marketCompQueued[



              key



            ]



          ) {







            insertedItems.push({







              targetKey:



                key,







              market,







              conditionId,







              itemId,







              url,







              title,







              currentPrice:



                price,







              dbItemId:



                masterMeta.dbItemId,







              brand:



                masterMeta.brand,







              category:



                masterMeta.category,







              product:



                masterMeta.product,







              model:



                masterMeta.model,







              searchKeyword:



                masterMeta.searchKeyword,







              subCategory:



                masterMeta.subCategory,







              lineModel:



                masterMeta.lineModel,







              backfill:



                true,







              reason:



                'existing-db-no-comps'







            });











            marketCompQueued[



              key



            ] =



              true;



          }











        // ====================================================



        // 新規商品



        // ====================================================







        } else {







          sheet.appendRow([







            market,             // A 市場



            conditionId,        // B 条件ID



            itemId,             // C 出品ID



            url,                // D 商品URL



            title,              // E 商品名



            price,              // F 初回価格



            price,              // G 現在価格



            now,                // H 初回発見



            now,                // I 最終確認



            '市場走査',         // J 発見元



            '',                 // K DB商品ID



            '',                 // L 自動判定



            '',                 // M 保守判定



            '',                 // N LINE通知



            '',                 // O 最終判定価格



            '',                 // P 最終判定日時



            '',                 // Q 仕入方式



            '',                 // R 1スタ適性



            '',                 // S 1スタ安全仕入上限



            endTime || '',      // T 終了日時



            remainingTime       // U 残り時間







          ]);







          rowMap[key] =



            sheet.getLastRow();







          // 新規直後はK列(DB商品ID)が未確定。



          // 誤カテゴリ相場を取らないためMarket Compsには流さない。



          // DB同定後、次回監視で上のバックフィル対象になる。







          inserted++;



        }



      }



    );











    // ========================================================

    // 市場監視台帳 全体から Market Comps バックフィル

    //

    // 既存のバックフィルは「今回の検索結果に再登場した商品」だけが

    // 対象だったため、検索トップNから落ちた商品は

    // DB商品ID確定後も相場比較0件のまま残ることがあった。

    //

    // ここでは今回の検索結果とは無関係に、

    // 市場監視台帳の既存行を新しい順に確認し、

    //

    // ・今回のmarketと同じ市場

    // ・発見元 = 市場走査

    // ・DB商品IDあり

    // ・商品マスターmetadataあり

    // ・相場比較データ0件

    //

    // を Market Comps対象へ戻す。

    //

    // 1リクエスト最大5件。

    // 既存の相場取得済み商品は再取得しない。

    // ========================================================



    const GLOBAL_MARKET_COMP_BACKFILL_MAX =

      5;



    let globalBackfillAdded =

      0;



    for (

      let i = existingRows.length - 1;

      i >= 0;

      i--

    ) {



      if (

        globalBackfillAdded >=

        GLOBAL_MARKET_COMP_BACKFILL_MAX

      ) {

        break;

      }



      const row =

        existingRows[i];



      const rowMarket =

        String(

          row[0] || ''

        ).trim();



      const rowConditionId =

        String(

          row[1] || ''

        ).trim();



      const rowItemId =

        String(

          row[2] || ''

        ).trim();



      const rowUrl =

        String(

          row[3] || ''

        ).trim();



      const rowTitle =

        String(

          row[4] || ''

        ).trim();



      const rowCurrentPrice =

        Number(

          row[6] || 0

        );



      const rowSource =

        String(

          row[9] || ''

        ).trim();



      const rowDbItemId =

        String(

          row[10] || ''

        ).trim();



      if (

        rowMarket !== market ||

        rowSource !== '市場走査' ||

        !rowConditionId ||

        !rowItemId ||

        !rowUrl ||

        !rowTitle ||

        !rowCurrentPrice ||

        !rowDbItemId

      ) {

        continue;

      }



      const key =

        rowMarket +

        '::' +

        rowItemId;



      if (

        marketCompTargetKeyMap[

          key

        ] ||

        marketCompQueued[

          key

        ]

      ) {

        continue;

      }



      const masterMeta =

        masterMetaMap[

          rowDbItemId

        ] || null;



      if (!masterMeta) {

        continue;

      }



      insertedItems.push({



        targetKey:

          key,



        market:

          rowMarket,



        conditionId:

          rowConditionId,



        itemId:

          rowItemId,



        url:

          rowUrl,



        title:

          rowTitle,



        currentPrice:

          rowCurrentPrice,



        dbItemId:

          masterMeta.dbItemId,



        brand:

          masterMeta.brand,



        category:

          masterMeta.category,



        product:

          masterMeta.product,



        model:

          masterMeta.model,



        searchKeyword:

          masterMeta.searchKeyword,



        subCategory:

          masterMeta.subCategory,



        lineModel:

          masterMeta.lineModel,



        backfill:

          true,



        reason:

          'existing-db-no-comps'



      });



      marketCompQueued[

        key

      ] =

        true;



      globalBackfillAdded++;



    }



    if (

      globalBackfillAdded > 0

    ) {



      console.log(

        'Global Market Comps backfill queued: ' +

        globalBackfillAdded

      );



    }





    // ========================================================



    // 現在追跡中のYahoo商品一覧



    //



    // 検索結果から消えた後も



    // GitHubが商品詳細ページを追跡できるよう返す



    // ========================================================







    const trackedYahoo =



      getTrackedYahooItems_(



        sheet



      );











    // ========================================================



    // 従来レスポンス



    // ========================================================







    return jsonResponse_({







      ok: true,







      market,







      conditionId,







      received:



        items.length,







      inserted,







      insertedItems,







      marketCompTargetCount:



        insertedItems.length,







      updated,







      trackedYahoo







    });







  } catch (error) {







    return jsonResponse_({







      ok: false,







      error:



        error &&



        error.message



          ? error.message



          : String(error)







    });







  } finally {







    if (



      lockAcquired &&



      lock



    ) {







      lock.releaseLock();



    }



  }



}











// ============================================================



// 市場監視設定



//



// A 条件ID



// B 市場



// C 検索条件名



// D 検索URL



// E 監視頻度(分)



// F ON/OFF



// G 最終監視日時



// H 備考



// I 取得件数



// J 最終エラー



//



// ONの行だけGitHubへ返す



// ============================================================







function getEnabledMarketConfigs_(



  ss,



  marketFilter



) {







  const sheet =



    ss.getSheetByName(



      MARKET_INGEST.CONFIG_SHEET_NAME



    );







  if (!sheet) {







    throw new Error(



      '市場監視設定が見つかりません'



    );



  }







  const lastRow =



    sheet.getLastRow();







  if (



    lastRow < 2



  ) {







    return [];



  }







  const rows =



    sheet



      .getRange(



        2,



        1,



        lastRow - 1,



        10



      )



      .getValues();







  const results =



    [];







  rows.forEach(



    row => {







      const conditionId =



        String(



          row[0] || ''



        ).trim();







      const market =



        String(



          row[1] || ''



        ).trim();







      const searchName =



        String(



          row[2] || ''



        ).trim();







      const searchUrl =



        String(



          row[3] || ''



        ).trim();







      const intervalMinutes =



        Number(



          row[4] || 0



        );







      const enabled =



        String(



          row[5] || ''



        )



          .trim()



          .toUpperCase();











      // ======================================================



      // ON以外は返さない



      // ======================================================







      if (



        enabled !== 'ON'



      ) {







        return;



      }











      // ======================================================



      // 有効な市場だけ



      // ======================================================







      if (



        market !== 'メルカリ'



        &&



        market !== 'ヤフオク'



      ) {







        return;



      }











      // ======================================================



      // 市場フィルタ



      // ======================================================







      if (



        marketFilter &&



        market !== marketFilter



      ) {







        return;



      }











      // ======================================================



      // 必須値



      // ======================================================







      if (



        !conditionId ||



        !searchUrl



      ) {







        return;



      }







      results.push({







        conditionId,







        market,







        searchName,







        searchUrl,







        intervalMinutes:



          intervalMinutes > 0



            ? intervalMinutes



            : 5







      });



    }



  );







  return results;



}











// ============================================================



// Yahoo追跡対象取得



// ============================================================







function getTrackedYahooItems_(



  sheet



) {







  const lastRow =



    sheet.getLastRow();







  if (



    lastRow < 2



  ) {







    return [];



  }







  const rows =



    sheet



      .getRange(



        2,



        1,



        lastRow - 1,



        21



      )



      .getValues();







  const results =



    [];







  rows.forEach(



    row => {







      const market =



        String(



          row[0] || ''



        ).trim();







      const conditionId =



        String(



          row[1] || ''



        ).trim();







      const itemId =



        String(



          row[2] || ''



        ).trim();







      const url =



        String(



          row[3] || ''



        ).trim();







      const title =



        String(



          row[4] || ''



        ).trim();







      const currentPrice =



        Number(



          row[6] || 0



        );







      const procurementType =



        String(



          row[16] || ''



        ).trim();







      if (



        market !== 'ヤフオク'



      ) {







        return;



      }







      if (



        !itemId ||



        !url



      ) {







        return;



      }







      results.push({







        conditionId,







        itemId,







        url,







        title,







        currentPrice,







        procurementType







      });



    }



  );







  return results;



}











// ============================================================



// 相場比較データ upsert



//



// 1行 = 1対象商品 × 1比較商品



//



// 重複キー:



// 対象キー + 比較市場 + 比較出品ID



//



// 既存行更新時は A:W と AO:AQ のみ更新。



// X:AN の相場エンジン計算列は保持する。



// ============================================================







function upsertMarketComps_(



  ss,



  body



) {







  const sheet =



    ss.getSheetByName(



      MARKET_INGEST.MARKET_COMPS_SHEET_NAME



    );







  if (!sheet) {







    throw new Error(



      '相場比較データが見つかりません'



    );



  }







  validateMarketCompsHeaders_(



    sheet



  );











  const target =



    body &&



    body.target &&



    typeof body.target === 'object'



      ? body.target



      : {};







  const comparisons =



    Array.isArray(



      body.comparisons



    )



      ? body.comparisons



      : [];











  const targetKey =



    String(



      target.targetKey ||



      target.key ||



      ''



    ).trim();







  const targetMarket =



    String(



      target.market ||



      ''



    ).trim();







  const targetConditionId =



    String(



      target.conditionId ||



      ''



    ).trim();







  const targetItemId =



    String(



      target.itemId ||



      ''



    ).trim();







  const targetUrl =



    String(



      target.url ||



      ''



    ).trim();







  const targetTitle =



    String(



      target.title ||



      ''



    ).trim();







  const targetDbItemId =



    String(



      target.dbItemId ||



      ''



    ).trim();







  const targetBrand =



    String(



      target.brand ||



      ''



    ).trim();







  const targetCategory =



    String(



      target.category ||



      ''



    ).trim();







  const targetCurrentPrice =



    positiveNumberOrZero_(



      target.currentPrice



    );











  if (!targetKey) {







    return jsonResponse_({







      ok: false,







      action:



        'upsertMarketComps',







      error:



        'target.targetKey required'







    });



  }











  if (



    targetMarket !== 'メルカリ'



    &&



    targetMarket !== 'ヤフオク'



  ) {







    return jsonResponse_({







      ok: false,







      action:



        'upsertMarketComps',







      error:



        'invalid target.market'







    });



  }











  if (



    !targetItemId ||



    !targetUrl ||



    !targetTitle ||



    !targetCurrentPrice



  ) {







    return jsonResponse_({







      ok: false,







      action:



        'upsertMarketComps',







      error:



        'target itemId/url/title/currentPrice required'







    });



  }











  if (



    comparisons.length === 0



  ) {







    return jsonResponse_({







      ok: true,







      action:



        'upsertMarketComps',







      targetKey,







      received: 0,







      inserted: 0,







      updated: 0,







      skipped: 0







    });



  }











  const lastRow =



    sheet.getLastRow();







  const existingRows =



    lastRow >= 2







      ? sheet



          .getRange(



            2,



            1,



            lastRow - 1,



            MARKET_INGEST.MARKET_COMPS_COLUMN_COUNT



          )



          .getValues()







      : [];











  const rowMap =



    {};







  existingRows.forEach(



    (row, index) => {







      const existingTargetKey =



        String(



          row[1] || ''



        ).trim();







      const comparisonMarket =



        String(



          row[11] || ''



        ).trim();







      const comparisonItemId =



        String(



          row[13] || ''



        ).trim();







      if (



        existingTargetKey &&



        comparisonMarket &&



        comparisonItemId



      ) {







        rowMap[



          marketCompKey_(



            existingTargetKey,



            comparisonMarket,



            comparisonItemId



          )



        ] =



          index + 2;



      }



    }



  );











  const now =



    new Date();







  let inserted =



    0;







  let updated =



    0;







  let skipped =



    0;











  comparisons.forEach(



    comparison => {







      const comparisonMarket =



        String(



          comparison.comparisonMarket ||



          comparison.market ||



          ''



        ).trim();







      const comparisonType =



        String(



          comparison.comparisonType ||



          comparison.type ||



          ''



        ).trim();







      const comparisonItemId =



        String(



          comparison.comparisonItemId ||



          comparison.itemId ||



          ''



        ).trim();







      const comparisonUrl =



        String(



          comparison.comparisonUrl ||



          comparison.url ||



          ''



        ).trim();







      const comparisonTitle =



        String(



          comparison.comparisonTitle ||



          comparison.title ||



          ''



        ).trim();







      const comparisonPrice =



        positiveNumberOrZero_(



          comparison.comparisonPrice !== undefined



            ? comparison.comparisonPrice



            : comparison.price



        );







      const shipping =



        nullableNonNegativeNumber_(



          comparison.shipping



        );







      const comparisonTotal =



        positiveNumberOrZero_(



          comparison.comparisonTotal



        )



        ||



        (



          comparisonPrice +



          (



            shipping === null



              ? 0



              : shipping



          )



        );







      const currency =



        String(



          comparison.currency ||



          'JPY'



        )



          .trim()



          .toUpperCase();







      const jpyTotal =



        positiveNumberOrZero_(



          comparison.jpyTotal



        )



        ||



        (



          currency === 'JPY'



            ? comparisonTotal



            : 0



        );







      const endedAt =



        validDateOrBlank_(



          comparison.endedAt



        );







      const condition =



        String(



          comparison.condition ||



          ''



        ).trim();







      const source =



        String(



          comparison.source ||



          body.source ||



          ''



        ).trim();







      const version =



        String(



          comparison.version ||



          body.version ||



          body.sourceVersion ||



          ''



        ).trim();







      const query =



        String(



          comparison.query ||



          body.query ||



          ''



        ).trim();







      const sourceCategoryId =



        String(



          comparison.categoryId ||



          body.categoryId ||



          ''



        ).trim();











      if (



        (



          comparisonMarket !== 'メルカリ'



          &&



          comparisonMarket !== 'ヤフオク'



          &&



          comparisonMarket !== 'eBay'



        )



        ||



        !comparisonItemId



        ||



        !comparisonUrl



        ||



        !comparisonTitle



        ||



        !comparisonPrice



      ) {







        skipped++;







        return;



      }











      const row = [







        now,                    // A 取得日時







        targetKey,              // B 対象キー







        targetMarket,           // C 対象市場







        targetConditionId,      // D 対象条件ID







        targetItemId,           // E 対象出品ID







        targetUrl,              // F 対象URL







        targetTitle,            // G 対象商品名







        targetDbItemId,         // H 対象DB商品ID







        targetBrand,            // I 対象ブランド







        targetCategory,         // J 対象カテゴリー







        targetCurrentPrice,     // K 対象現在価格







        comparisonMarket,       // L 比較市場







        comparisonType,         // M 比較種別







        comparisonItemId,       // N 比較出品ID







        comparisonUrl,          // O 比較URL







        comparisonTitle,        // P 比較商品名







        comparisonPrice,        // Q 比較価格







        shipping === null



          ? ''



          : shipping,           // R 比較送料







        comparisonTotal,        // S 比較総額







        currency,               // T 通貨







        jpyTotal || '',         // U 円換算総額







        endedAt,                // V 成約/終了日時







        condition,              // W 比較状態







        '',                     // X ブランド一致







        '',                     // Y カテゴリー一致







        '',                     // Z モデル/ライン一致







        '',                     // AA サイズ一致







        '',                     // AB 素材一致







        '',                     // AC 色一致







        '',                     // AD 高値要素







        '',                     // AE 高値要素一致







        '',                     // AF 類似度







        '',                     // AG 経過日数







        '',                     // AH 時間重み







        '',                     // AI 状態補正率







        '',                     // AJ 高値要素補正率







        '',                     // AK 除外







        '',                     // AL 除外理由







        '',                     // AM 最終重み







        '',                     // AN 補正後価格







        source,                 // AO データ元







        version,                // AP 取得バージョン







        buildMarketCompNote_(



          query,



          sourceCategoryId



        )                       // AQ 備考







      ];











      const key =



        marketCompKey_(



          targetKey,



          comparisonMarket,



          comparisonItemId



        );











      const existingRow =



        rowMap[key];











      if (existingRow) {







        // A:W



        sheet



          .getRange(



            existingRow,



            1,



            1,



            23



          )



          .setValues([



            row.slice(



              0,



              23



            )



          ]);











        // AO:AQ



        sheet



          .getRange(



            existingRow,



            41,



            1,



            3



          )



          .setValues([



            row.slice(



              40,



              43



            )



          ]);











        updated++;







      } else {







        sheet.appendRow(



          row



        );







        rowMap[key] =



          sheet.getLastRow();







        inserted++;



      }



    }



  );











  return jsonResponse_({







    ok: true,







    action:



      'upsertMarketComps',







    targetKey,







    received:



      comparisons.length,







    inserted,







    updated,







    skipped







  });



}











// ============================================================



// 相場比較データ ヘッダー固定



//



// A:AQ = 43列



//



// 構造が違う場合は



// 誤書き込みを避けるため安全停止。



// ============================================================







function validateMarketCompsHeaders_(



  sheet



) {







  const expected = [







    '取得日時',







    '対象キー',







    '対象市場',







    '対象条件ID',







    '対象出品ID',







    '対象URL',







    '対象商品名',







    '対象DB商品ID',







    '対象ブランド',







    '対象カテゴリー',







    '対象現在価格',







    '比較市場',







    '比較種別',







    '比較出品ID',







    '比較URL',







    '比較商品名',







    '比較価格',







    '比較送料',







    '比較総額',







    '通貨',







    '円換算総額',







    '成約/終了日時',







    '比較状態',







    'ブランド一致',







    'カテゴリー一致',







    'モデル/ライン一致',







    'サイズ一致',







    '素材一致',







    '色一致',







    '高値要素',







    '高値要素一致',







    '類似度',







    '経過日数',







    '時間重み',







    '状態補正率',







    '高値要素補正率',







    '除外',







    '除外理由',







    '最終重み',







    '補正後価格',







    'データ元',







    '取得バージョン',







    '備考'







  ];











  if (



    expected.length !==



    MARKET_INGEST.MARKET_COMPS_COLUMN_COUNT



  ) {







    throw new Error(



      '相場比較データの内部列定義が不正です'



    );



  }











  if (



    sheet.getLastColumn() <



    MARKET_INGEST.MARKET_COMPS_COLUMN_COUNT



  ) {







    throw new Error(



      '相場比較データの列数が不足しています'



    );



  }











  const actual =



    sheet



      .getRange(



        1,



        1,



        1,



        MARKET_INGEST.MARKET_COMPS_COLUMN_COUNT



      )



      .getValues()[0]



      .map(



        value =>



          String(



            value || ''



          ).trim()



      );











  for (



    let i = 0;



    i < expected.length;



    i++



  ) {







    if (



      actual[i] !==



      expected[i]



    ) {







      throw new Error(



        '相場比較データの列構造が想定と違います。' +



        '安全のため停止しました。' +



        ' 列' +



        (i + 1) +



        ': 期待="' +



        expected[i] +



        '" / 実際="' +



        actual[i] +



        '"'



      );



    }



  }



}











// ============================================================



// 相場比較データ helper



// ============================================================







function marketCompKey_(



  targetKey,



  comparisonMarket,



  comparisonItemId



) {







  return [







    String(



      targetKey || ''



    ).trim(),







    String(



      comparisonMarket || ''



    ).trim(),







    String(



      comparisonItemId || ''



    ).trim()







  ].join(



    '::'



  );



}











function positiveNumberOrZero_(



  value



) {







  const number =



    Number(



      value



    );







  return (



    Number.isFinite(



      number



    )



    &&



    number > 0



  )



    ? number



    : 0;



}











function nullableNonNegativeNumber_(



  value



) {







  if (



    value === null ||



    value === undefined ||



    value === ''



  ) {







    return null;



  }







  const number =



    Number(



      value



    );







  return (



    Number.isFinite(



      number



    )



    &&



    number >= 0



  )



    ? number



    : null;



}











function validDateOrBlank_(



  value



) {







  if (!value) {







    return '';



  }







  const date =



    value instanceof Date







      ? value







      : new Date(



          value



        );







  return (



    date instanceof Date



    &&



    !isNaN(



      date.getTime()



    )



  )



    ? date



    : '';



}











function buildMarketCompNote_(



  query,



  categoryId



) {







  const parts =



    [];







  if (query) {







    parts.push(



      'query=' +



      query



    );



  }







  if (categoryId) {







    parts.push(



      'categoryId=' +



      categoryId



    );



  }







  return parts.join(



    ' / '



  );



}











// ============================================================



// JSON



// ============================================================







function jsonResponse_(obj) {







  return ContentService



    .createTextOutput(



      JSON.stringify(obj)



    )



    .setMimeType(



      ContentService.MimeType.JSON



    );



}


// ============================================================
// 利益商品探索AI Historical Backfill
//
// 仕入URL（Mercari / Yahoo現行出品）と
// 相場URL（Mercari売切 / Yahoo終了180日間）を同じDB商品へ紐づける。
// ============================================================

function getHistoricalBackfillTargets_(ss, body) {
  const exploreSheet = ss.getSheetByName(MARKET_INGEST.HISTORICAL_SHEET_NAME);
  const masterSheet = ss.getSheetByName(MARKET_INGEST.MASTER_SHEET_NAME);

  if (!exploreSheet) {
    return { ok: false, action: 'getHistoricalBackfillTargets', error: '利益商品探索AIが見つかりません' };
  }

  if (!masterSheet) {
    return { ok: false, action: 'getHistoricalBackfillTargets', error: '商品マスターが見つかりません' };
  }

  const headerRow = 5;
  const exploreLastRow = exploreSheet.getLastRow();

  if (exploreLastRow <= headerRow) {
    return { ok: true, action: 'getHistoricalBackfillTargets', count: 0, remaining: 0, targets: [] };
  }

  const exploreColumnCount = Math.max(exploreSheet.getLastColumn(), 34);
  const exploreHeaders = exploreSheet
    .getRange(headerRow, 1, 1, exploreColumnCount)
    .getValues()[0]
    .map(value => String(value || '').trim());

  const requiredExploreHeaders = [
    'DB商品ID', '優先度', 'ブランド', 'カテゴリ', '商品',
    'Exploration Priority', '仕入URL_Mercari', '仕入URL_Yahoo',
    '相場URL_Yahoo180', '相場URL_Mercari売切', '過去市場状態'
  ];

  const missingExploreHeaders = requiredExploreHeaders.filter(name => exploreHeaders.indexOf(name) < 0);

  if (missingExploreHeaders.length > 0) {
    return {
      ok: false,
      action: 'getHistoricalBackfillTargets',
      error: '利益商品探索AIヘッダー不足: ' + missingExploreHeaders.join(', ')
    };
  }

  const eIndex = {};
  exploreHeaders.forEach((name, index) => {
    if (name) eIndex[name] = index;
  });

  const exploreRows = exploreSheet
    .getRange(headerRow + 1, 1, exploreLastRow - headerRow, exploreColumnCount)
    .getValues();

  const masterValues = masterSheet
    .getRange(1, 1, masterSheet.getLastRow(), masterSheet.getLastColumn())
    .getValues();

  const masterHeaders = masterValues[0].map(value => String(value || '').trim());
  const mIndex = {};
  masterHeaders.forEach((name, index) => {
    if (name) mIndex[name] = index;
  });

  const getOptionalMasterText = (row, header) => {
    const column = mIndex[header];
    return column === undefined
      ? ''
      : String(row[column] || '').replace(/\s+/g, ' ').trim();
  };

  const requiredMasterHeaders = ['商品ID', '検索キーワード', '通常仕入上限', '採用想定売価'];
  const missingMasterHeaders = requiredMasterHeaders.filter(name => mIndex[name] === undefined);

  if (missingMasterHeaders.length > 0) {
    return {
      ok: false,
      action: 'getHistoricalBackfillTargets',
      error: '商品マスターヘッダー不足: ' + missingMasterHeaders.join(', ')
    };
  }

  const masterMap = {};
  masterValues.slice(1).forEach(row => {
    const dbItemId = String(row[mIndex['商品ID']] || '').trim();
    if (!dbItemId) return;

    masterMap[dbItemId] = {
      searchKeyword: String(row[mIndex['検索キーワード']] || '').replace(/\s+/g, ' ').trim(),
      normalBuyLimit: positiveNumberOrZero_(row[mIndex['通常仕入上限']]),
      adoptedSalePrice: positiveNumberOrZero_(row[mIndex['採用想定売価']]),
      brand: getOptionalMasterText(row, 'ブランド/メーカー'),
      productName: getOptionalMasterText(row, '商品名'),
      subCategory: getOptionalMasterText(row, '商品サブカテゴリ'),
      lineModel: getOptionalMasterText(row, 'ライン/モデル'),
      keywordAliases: getOptionalMasterText(row, 'キーワード/別名'),
      highValue: getOptionalMasterText(row, '高値要素')
    };
  });

  const force = !!(body && body.force === true);
  const requestedLimit = Number(body && body.limit || 3);
  const limit = Math.max(1, Math.min(Number.isFinite(requestedLimit) ? Math.floor(requestedLimit) : 3, 10));

  const candidates = [];

  exploreRows.forEach((row, index) => {
    const dbItemId = String(row[eIndex['DB商品ID']] || '').trim();
    if (!dbItemId) return;

    const historicalState = String(row[eIndex['過去市場状態']] || '').trim();

    if (!force && (historicalState === '取得済' || historicalState === '0件')) {
      return;
    }

    const master = masterMap[dbItemId] || {};
    const brand = String(row[eIndex['ブランド']] || '').trim();
    const category = String(row[eIndex['カテゴリ']] || '').trim();
    const product = String(row[eIndex['商品']] || '').trim();
    const searchKeyword = String(master.searchKeyword || [brand, product].filter(Boolean).join(' '))
      .replace(/\s+/g, ' ')
      .trim();
    const normalBuyLimit = positiveNumberOrZero_(master.normalBuyLimit);

    const mercariBuyUrl = String(
      row[eIndex['仕入URL_Mercari']] || buildHistoricalMercariBuyUrl_(searchKeyword, normalBuyLimit)
    ).trim();

    const yahooBuyUrl = String(
      row[eIndex['仕入URL_Yahoo']] || buildHistoricalYahooBuyUrl_(searchKeyword, normalBuyLimit)
    ).trim();

    const yahooHistoricalUrl = String(
      row[eIndex['相場URL_Yahoo180']] || buildHistoricalYahooClosedUrl_(searchKeyword)
    ).trim();

    const mercariHistoricalUrl = String(
      row[eIndex['相場URL_Mercari売切']] || buildHistoricalMercariSoldUrl_(searchKeyword)
    ).trim();

    candidates.push({
      rowNumber: headerRow + 1 + index,
      dbItemId,
      priority: String(row[eIndex['優先度']] || '').trim(),
      brand,
      category,
      product,
      masterBrand: master.brand || '',
      masterProductName: master.productName || '',
      masterSubCategory: master.subCategory || '',
      lineModel: master.lineModel || '',
      keywordAliases: master.keywordAliases || '',
      highValue: master.highValue || '',
      searchKeyword,
      normalBuyLimit,
      adoptedSalePrice: positiveNumberOrZero_(master.adoptedSalePrice),
      explorationPriority: Number(row[eIndex['Exploration Priority']] || 0),
      mercariBuyUrl,
      yahooBuyUrl,
      mercariHistoricalUrl,
      yahooHistoricalUrl,
      historicalState
    });
  });

  candidates.sort((a, b) => {
    const diff = Number(b.explorationPriority || 0) - Number(a.explorationPriority || 0);
    if (diff !== 0) return diff;
    return String(a.dbItemId).localeCompare(String(b.dbItemId), 'ja');
  });

  return {
    ok: true,
    action: 'getHistoricalBackfillTargets',
    count: Math.min(candidates.length, limit),
    remaining: candidates.length,
    targets: candidates.slice(0, limit)
  };
}


function upsertHistoricalBackfill_(ss, body) {
  const sheet = ss.getSheetByName(MARKET_INGEST.HISTORICAL_SHEET_NAME);

  if (!sheet) {
    return jsonResponse_({ ok: false, action: 'upsertHistoricalBackfill', error: '利益商品探索AIが見つかりません' });
  }

  const dbItemId = String(body && body.dbItemId || '').trim();

  if (!dbItemId) {
    return jsonResponse_({ ok: false, action: 'upsertHistoricalBackfill', error: 'dbItemId required' });
  }

  const summary = body && body.summary && typeof body.summary === 'object' ? body.summary : {};
  const headerRow = 5;
  const lastRow = sheet.getLastRow();

  if (lastRow <= headerRow) {
    return jsonResponse_({ ok: false, action: 'upsertHistoricalBackfill', error: '利益商品探索AIにデータ行がありません' });
  }

  const ids = sheet.getRange(headerRow + 1, 1, lastRow - headerRow, 1).getValues();
  let targetRow = 0;

  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0] || '').trim() === dbItemId) {
      targetRow = headerRow + 1 + i;
      break;
    }
  }

  if (!targetRow) {
    return jsonResponse_({
      ok: false,
      action: 'upsertHistoricalBackfill',
      error: 'DB商品IDが利益商品探索AIにありません: ' + dbItemId
    });
  }

  const soldCount = Math.max(0, Math.floor(positiveNumberOrZero_(summary.soldCount)));
  const sampleCount = Math.max(0, Math.floor(positiveNumberOrZero_(summary.sampleCount)));
  const minPrice = positiveNumberOrZero_(summary.minPrice);
  const q25Price = positiveNumberOrZero_(summary.q25Price);
  const medianPrice = positiveNumberOrZero_(summary.medianPrice);
  const q75Price = positiveNumberOrZero_(summary.q75Price);
  const maxPrice = positiveNumberOrZero_(summary.maxPrice);
  const historicalScore = Math.max(0, Math.min(100, Number(summary.historicalScore || 0)));
  const state = String(summary.state || ((soldCount > 0 || sampleCount > 0) ? '取得済' : '0件')).trim();
  const judgement = String(summary.judgement || '').trim();
  const updatedAt = new Date();

  // ----------------------------------------------------------
  // 市場別Historicalデータ
  // AI:AN
  // AI Mercari売切件数
  // AJ Mercari売切中央値
  // AK Yahoo落札件数
  // AL Yahoo落札中央値
  // AM 市場間中央値差率
  // AN 相場ソース判定
  //
  // 旧historical-backfill.jsからの送信でも壊れないよう、
  // 未送信項目は空欄として保存する。
  // ----------------------------------------------------------
  const mercariSoldCount = Math.max(0, Math.floor(positiveNumberOrZero_(summary.mercariSoldCount)));
  const mercariMedianPrice = positiveNumberOrZero_(summary.mercariMedianPrice);
  const yahooSoldCount = Math.max(0, Math.floor(positiveNumberOrZero_(summary.yahooSoldCount)));
  const yahooMedianPrice = positiveNumberOrZero_(summary.yahooMedianPrice);
  const marketMedianGapRate = Number(summary.marketMedianGapRate);
  const sourceJudgement = String(summary.sourceJudgement || '').trim();

  // Y:AH = 統合Historical 10列
  sheet.getRange(targetRow, 25, 1, 10).setValues([[
    soldCount,
    minPrice || '',
    q25Price || '',
    medianPrice || '',
    q75Price || '',
    maxPrice || '',
    updatedAt,
    state,
    historicalScore,
    judgement
  ]]);

  // AI:AN = 市場別Historical 6列
  sheet.getRange(targetRow, 35, 1, 6).setValues([[
    mercariSoldCount || '',
    mercariMedianPrice || '',
    yahooSoldCount || '',
    yahooMedianPrice || '',
    Number.isFinite(marketMedianGapRate) ? marketMedianGapRate : '',
    sourceJudgement
  ]]);

  return jsonResponse_({
    ok: true,
    action: 'upsertHistoricalBackfill',
    dbItemId,
    rowNumber: targetRow,
    soldCount,
    sampleCount,
    historicalScore,
    judgement,
    state,
    mercariSoldCount,
    mercariMedianPrice,
    yahooSoldCount,
    yahooMedianPrice,
    marketMedianGapRate: Number.isFinite(marketMedianGapRate) ? marketMedianGapRate : null,
    sourceJudgement
  });
}


function buildHistoricalMercariBuyUrl_(query, maxPrice) {
  const keyword = encodeURIComponent(String(query || '').trim());
  if (!keyword) return '';

  return (
    'https://jp.mercari.com/search' +
    '?keyword=' + keyword +
    '&status=on_sale' +
    (positiveNumberOrZero_(maxPrice) > 0
      ? '&price_max=' + Math.floor(positiveNumberOrZero_(maxPrice))
      : '') +
    '&order=desc' +
    '&sort=created_time'
  );
}


function buildHistoricalYahooBuyUrl_(query, maxPrice) {
  const keyword = encodeURIComponent(String(query || '').trim()).replace(/%20/g, '+');
  if (!keyword) return '';

  return (
    'https://auctions.yahoo.co.jp/search/search' +
    '?p=' + keyword +
    '&va=' + keyword +
    (positiveNumberOrZero_(maxPrice) > 0
      ? '&aucmaxprice=' + Math.floor(positiveNumberOrZero_(maxPrice))
      : '') +
    '&is_postage_mode=1' +
    '&dest_pref_code=40' +
    '&b=1' +
    '&n=50' +
    '&s1=end' +
    '&o1=a'
  );
}


function buildHistoricalMercariSoldUrl_(query) {
  const keyword = encodeURIComponent(String(query || '').trim());
  if (!keyword) return '';

  return (
    'https://jp.mercari.com/search' +
    '?keyword=' + keyword +
    '&status=sold_out' +
    '&sort=created_time' +
    '&order=desc'
  );
}


function buildHistoricalYahooClosedUrl_(query) {
  const keyword = String(query || '').trim();
  if (!keyword) return '';

  return (
    'https://auctions.yahoo.co.jp/' +
    'closedsearch/closedsearch/' +
    encodeURIComponent(keyword) +
    '/0?n=50'
  );
}
