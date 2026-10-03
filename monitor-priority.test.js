'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { selectMercariHeadGap_, selectConditionShard_, prioritizeYahooTargets_, runYahooDiscoveryCondition_ } = require('./monitor-priority');
const { enforceMercariActiveSearchUrl_, buildYahooScanUrl_, runConditionsIndependently_ } = require('./market-scan-cursor');
const { processDeadlineBatch_ } = require('./yahoo-deadline-worker');
const ids = (prefix, n) => Array.from({ length: n }, (_, i) => prefix + (i + 1));

test('Mercari forces active, newest-first sourcing; Yahoo forces ending-soon', () => {
  const m = new URL(enforceMercariActiveSearchUrl_('https://jp.mercari.com/search?keyword=coat&status=sold_out&sort=price&order=asc'));
  assert.equal(m.searchParams.get('status'), 'on_sale');
  assert.equal(m.searchParams.get('sort'), 'created_time');
  assert.equal(m.searchParams.get('order'), 'desc');
  const y = new URL(buildYahooScanUrl_('https://auctions.yahoo.co.jp/search/search?p=suit&s1=price&o1=d', 11));
  assert.equal(y.searchParams.get('s1'), 'end');
  assert.equal(y.searchParams.get('o1'), 'a');
  assert.equal(y.searchParams.get('b'), '11');
});

test('Mercari catches all 35 arrivals in ten-item gap batches', () => {
  const old = ids('old-', 25), fresh = ids('new-', 35);
  let state = selectMercariHeadGap_(old).state;
  const seen = new Set();
  for (let i = 0; i < 4; i++) {
    const r = selectMercariHeadGap_([...fresh, ...old], state);
    [...r.headIds, ...r.gapIds].forEach(id => seen.add(id));
    assert.ok(r.gapIds.length <= 10);
    state = r.state;
  }
  fresh.forEach(id => assert.ok(seen.has(id), id));
  assert.equal(state.afterId, '');
});

test('arrivals during unfinished catch-up stay behind the next durable checkpoint', () => {
  const old = ids('old-', 25), first = ids('first-', 35), second = ids('second-', 22);
  let state = selectMercariHeadGap_(old).state;
  const seen = new Set();
  const firstTick = selectMercariHeadGap_([...first, ...old], state);
  [...firstTick.headIds, ...firstTick.gapIds].forEach(id => seen.add(id));
  state = firstTick.state;
  for (let i = 0; i < 8; i++) {
    const r = selectMercariHeadGap_([...second, ...first, ...old], state);
    [...r.headIds, ...r.gapIds].forEach(id => seen.add(id));
    state = r.state;
  }
  [...first, ...second].forEach(id => assert.ok(seen.has(id), id));
});

test('missing boundary continues until proven feed bottom; empty results do not clear state', () => {
  const r = selectMercariHeadGap_(ids('new-', 30), { baselineIds: ['removed'], snapshotIds: [], afterId: '', offset: 0 });
  assert.equal(r.state.snapshotIds.length, 10);
  assert.ok(r.state.afterId);
  const completed = selectMercariHeadGap_(ids('new-', 30), r.state, true);
  assert.equal(completed.state.snapshotIds.length, 0);
  assert.throws(() => selectMercariHeadGap_([], r.state), /preserve saved state/);
});

test('condition sharding covers each condition once and appending configs does not move existing shards', () => {
  const configs = ids('C-', 112).map(conditionId => ({ conditionId }));
  const parts = [0,1,2,3].map(i => selectConditionShard_(configs, { MONITOR_SHARD_COUNT: '4', MONITOR_SHARD_INDEX: String(i) }));
  assert.equal(new Set(parts.flat().map(c => c.conditionId)).size, 112);
  assert.equal(parts.flat().length, 112);
  for (let i = 0; i < 4; i++) {
    const after = selectConditionShard_([...configs, { conditionId: 'added' }], { MONITOR_SHARD_COUNT: '4', MONITOR_SHARD_INDEX: String(i) });
    assert.deepEqual(after.filter(c => c.conditionId !== 'added'), parts[i]);
  }
});

test('oldest-attempt condition runs first without changing its saved cursor', () => {
  const configs = [{ conditionId:'a', lastScannedAt:10, scanOffset:40 }, { conditionId:'b', lastScannedAt:0, scanOffset:20 }];
  const selected = selectConditionShard_(configs);
  assert.equal(selected[0].conditionId, 'b');
  assert.equal(selected[0].scanOffset, 20);
});

test('Yahoo deadline priority has no first-30 cap, excludes ended auctions and rotates attempts', () => {
  const now = Date.now();
  const targets = ids('y-', 75).map((itemId, i) => ({ itemId, conditionId: 'Y', endTime: new Date(now + 50 * 60000).toISOString(), lastConfirmedAt: i }));
  const result = prioritizeYahooTargets_([...targets, { ...targets[0], itemId:'ended', endTime: new Date(now-1).toISOString() }], now);
  assert.equal(result.length, 75);
  assert.equal(result[0].itemId, 'y-1');
  const retried = prioritizeYahooTargets_(result.map((r,i) => ({ ...r, lastConfirmedAt: i < 10 ? now : r.lastConfirmedAt })), now);
  assert.equal(retried[0].itemId, 'y-11');
});

test('deadline notifications use only successfully refreshed and persisted item IDs', async () => {
  const targets = ['a','b','c'].map(itemId => ({ itemId, conditionId:'Y' }));
  const events = [];
  const result = await processDeadlineBatch_(targets, async item => item.itemId === 'b' ? null : ({ itemId:item.itemId, price:5000, endTime: new Date(Date.now() + 60000).toISOString() }),
    async items => { events.push(['ingest',items.map(i => i.itemId)]); return { ok:true }; },
    async itemIds => { events.push(['notify',itemIds]); return { notifications:{failed:0} }; });
  assert.deepEqual(events, [['ingest',['a','c']],['notify',['a','c']]]);
  assert.deepEqual(result.failedDetails, ['b']);
});

test('failed price persistence never calls LINE', async () => {
  let notified = false;
  await assert.rejects(processDeadlineBatch_([{itemId:'a',conditionId:'Y'}], async () => ({itemId:'a',endTime:new Date(Date.now()+60000).toISOString()}),
    async () => ({ok:false,error:'busy'}), async () => { notified = true; }), /no notification/);
  assert.equal(notified, false);
});

test('an unreadable or expired deadline is never notified as a fresh auction', async () => {
  const result = await processDeadlineBatch_([{itemId:'a',conditionId:'Y'}], async () => ({itemId:'a',price:1,endTime:''}),
    async () => { throw new Error('Must not ingest invalid detail'); }, async () => { throw new Error('Must not notify'); });
  assert.equal(result.updated, 0);
});

test('a global Yahoo outage defers later fast conditions without empty ingests or cursor/attempt writes', async () => {
  const configs=ids('Y-',80).map((conditionId,i)=>({conditionId,scanOffset:i*10+1,lastItemId:'anchor-'+i}));
  const saved=structuredClone(configs);
  let searches=0,ingests=0,attemptWrites=0,deferred=0,circuitOpen=false;
  const failures=await runConditionsIndependently_(configs,config=>runYahooDiscoveryCondition_(async()=>{
    searches++;
    if(searches<=3) {
      if(searches===3)circuitOpen=true;
      throw new Error('Yahoo search HTTP 500');
    }
    ingests++;
    config.scanOffset+=10;
    return {ok:true};
  },{fastMode:true,circuitOpen,acknowledge:async()=>{attemptWrites++;},onDeferred:()=>{deferred++;}}),()=>{});
  assert.equal(searches,3);assert.equal(ingests,0);assert.equal(attemptWrites,3);
  assert.equal(failures.length,3);assert.equal(deferred,77);
  assert.deepEqual(configs,saved);
});

test('deferred budgets preserve state; normal fast work acknowledges before scanning', async () => {
  const events=[];
  const options={fastMode:true,acknowledge:async()=>events.push('ack'),onDeferred:reason=>events.push(reason)};
  const deferred=await runYahooDiscoveryCondition_(async()=>events.push('scan'),{...options,budgetExpired:true});
  assert.equal(deferred.deferred,true);
  assert.deepEqual(events,['DISCOVERY_BUDGET_EXHAUSTED']);
  events.length=0;
  await runYahooDiscoveryCondition_(async()=>{events.push('scan');return {ok:true};},options);
  assert.deepEqual(events,['ack','scan']);
  events.length=0;
  await assert.rejects(runYahooDiscoveryCondition_(async()=>events.push('scan'),{...options,acknowledge:async()=>{throw new Error('busy');}}),/busy/);
  assert.deepEqual(events,[]);
});

test('legacy Yahoo mode retains inline tracking even when search circuit is open', async () => {
  let legacyCalls=0;
  const result=await runYahooDiscoveryCondition_(async()=>{legacyCalls++;return {ok:false,error:'search unavailable; legacy detail tracking ran'};},
    {fastMode:false,circuitOpen:true,budgetExpired:true,acknowledge:async()=>{throw new Error('legacy must not ack fast attempt');}});
  assert.equal(legacyCalls,1);assert.equal(result.ok,false);
});
