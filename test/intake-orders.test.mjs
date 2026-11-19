import test from 'node:test';
import assert from 'node:assert/strict';
import { validateEvents } from '../src/engine/validate.mjs';
import { mapAndDerive } from '../src/intake/pipeline.mjs';
import { normalizeIntakeConfig } from '../src/intake/tables.mjs';

// Orders, decision time, outcome time, and results from raw tables (intake-derive-0.1.0,
// ADR-017). All data is SYNTHETIC: a made-up contract exchange with fills, orders, a cash
// ledger, and markets.

const SALT = 'test-salt-not-a-secret-0003';
const csv = (lines) => lines.join('\n');

const FILLS = csv([
  'fill,acct,at,kind,order,mkt,side,px,qty,won,settles',
  // Order O-1: three fills of one buy, a win.
  'F-1,A-1,2026-05-01T10:00:00Z,FILL,O-1,M-1,buy,0.40,10,true,',
  'F-2,A-1,2026-05-01T10:00:00Z,FILL,O-1,M-1,buy,0.40,5,true,',
  'F-3,A-1,2026-05-01T10:00:02Z,FILL,O-1,M-1,buy,0.46,5,true,',
  // No order ID: two fills merged by account, market, side, and time.
  'F-4,A-1,2026-05-01T10:10:00Z,FILL,,M-2,sell,0.70,4,false,2026-05-01T10:30:00Z',
  'F-5,A-1,2026-05-01T10:10:00Z,FILL,,M-2,sell,0.70,6,false,2026-05-01T10:30:00Z',
  // A buy later closed by a sell on the same market (no other outcome time).
  'F-6,A-1,2026-05-01T11:00:00Z,FILL,O-6,M-9,buy,0.50,8,false,',
  'F-7,A-1,2026-05-01T11:20:00Z,FILL,O-7,M-9,sell,0.55,8,false,',
  // Unresolved contract: no result, so no outcome time.
  'F-8,A-2,2026-05-01T12:00:00Z,FILL,O-8,M-3,buy,0.20,10,,',
  // A market close time before the fill is skipped; the next method has nothing, so assumed.
  'F-9,A-2,2026-05-01T12:30:00Z,FILL,O-9,M-4,sell,0.30,10,true,'
]);
const ORDERS = csv(['order,created', 'O-1,2026-05-01T09:58:00Z', 'O-6,2026-05-01T10:59:30Z', 'O-9,2026-05-01T12:31:00Z']);
const LEDGER = csv([
  'entry,acct,at,kind,order,amount',
  'L-1,A-1,2026-05-01T09:00:00Z,DEPOSIT,,100',
  'L-2,A-1,2026-05-01T13:00:00Z,SETTLE,O-1,20',
  'L-3,A-2,2026-05-01T14:00:00Z,SETTLE,O-1,99',
  'L-4,A-1,2026-05-01T15:00:00Z,SETTLE,O-1,0'
]);
const MARKETS = csv(['market,closes', 'M-1,2026-05-02T00:00:00Z', 'M-2,2026-05-03T00:00:00Z', 'M-3,2026-05-04T00:00:00Z', 'M-4,2026-05-01T12:00:00Z']);

const CONTRACT = { price: 'px', quantity: 'qty', side: 'side' };

function config({ settledAt, withMarkets = true, withLedger = true, withOrders = true } = {}) {
  const tables = {
    fills: {
      trader: { column: 'acct' },
      eventId: { column: 'fill' },
      timestamp: { column: 'at', timezone: 'UTC' },
      eventType: { column: 'kind', values: { FILL: 'trade' } },
      fields: { side: { column: 'side' }, price: { column: 'px' }, quantity: { column: 'qty' }, market_id: { column: 'mkt' } },
      attributes: {
        order: { column: 'order', kind: 'key' },
        mkt: { column: 'mkt', kind: 'key' },
        side: { column: 'side', kind: 'key' },
        px: { column: 'px', kind: 'number' },
        qty: { column: 'qty', kind: 'number' },
        won: { column: 'won', kind: 'boolean' },
        settles: { column: 'settles', kind: 'timestamp' }
      },
      dropExactDuplicates: false
    }
  };
  const joins = {};
  if (withOrders) {
    tables.orders = { role: 'lookup', key: 'order', timezone: 'UTC', attributes: { order: { column: 'order', kind: 'key' }, created: { column: 'created', kind: 'timestamp' } } };
    joins.order = { from: 'fills.order', to: 'orders.order' };
  }
  if (withLedger) {
    tables.ledger = {
      trader: { column: 'acct' },
      eventId: { column: 'entry' },
      timestamp: { column: 'at', timezone: 'UTC' },
      eventType: { column: 'kind', values: { DEPOSIT: 'deposit' }, ignore: ['SETTLE'] },
      fields: { deposit_amount: { column: 'amount', units: 'dollars' } },
      attributes: { order: { column: 'order', kind: 'key' }, kind: { column: 'kind', kind: 'key', caseSensitive: false } }
    };
    joins.settlement = { from: 'fills.order', to: 'ledger.order' };
  }
  if (withMarkets) {
    tables.markets = { role: 'lookup', key: 'mkt', timezone: 'UTC', attributes: { mkt: { column: 'market', kind: 'key' }, closes: { column: 'closes', kind: 'timestamp' } } };
    joins.market = { from: 'fills.mkt', to: 'markets.mkt' };
  }
  const settled = settledAt ?? [
    ...(withLedger ? [{ method: 'ledger-settlement', join: 'settlement', kind: 'kind', kinds: ['settle'] }] : []),
    { method: 'trade-settlement-column', attribute: 'settles' },
    ...(withMarkets ? [{ method: 'market-settlement', join: 'market', attribute: 'closes' }] : []),
    { method: 'closing-trade', market: 'mkt', side: 'side', quantity: 'qty' }
  ];
  return {
    name: 'unit-orders',
    label: 'SYNTHETIC',
    venueId: 'unit-exchange',
    tables,
    joins,
    derive: {
      orders: [{ method: 'order-id', key: 'order' }, { method: 'account-market-side-time', market: 'mkt', side: 'side' }],
      stake_amount: [{ method: 'contract-resolution', ...CONTRACT }],
      realized_result: [{ method: 'contract-resolution', ...CONTRACT, won: 'won' }],
      placed_at: withOrders ? [{ method: 'order-created', join: 'order', joinAttribute: 'created' }] : [],
      settled_at: settled
    }
  };
}

function input(cfg) {
  const tables = { fills: { text: FILLS, fileName: 'fills.csv' } };
  if (cfg.tables.orders) tables.orders = { text: ORDERS, fileName: 'orders.csv' };
  if (cfg.tables.ledger) tables.ledger = { text: LEDGER, fileName: 'ledger.csv' };
  if (cfg.tables.markets) tables.markets = { text: MARKETS, fileName: 'markets.csv' };
  return { tables };
}

function run(cfg) {
  return mapAndDerive(input(cfg), { config: cfg, salt: SALT, label: 'SYNTHETIC' });
}

function tradesOf(events) {
  return events.filter((event) => event.type === 'trade');
}

test('fills that share an order ID merge into one order; the fallback merges same account, market, side, and time', () => {
  const { events, report } = run(config());
  const trades = tradesOf(events);
  assert.equal(trades.length, 6, '9 fill rows become 6 orders');
  const [o1, o4] = trades;
  assert.equal(o1.stake_amount, 0.4 * 10 + 0.4 * 5 + 0.46 * 5, 'stakes sum (amount at risk of a buy: price x quantity)');
  assert.equal(o1.realized_result, Math.round((20 - (0.4 * 10 + 0.4 * 5 + 0.46 * 5)) * 1e8) / 1e8, 'results sum (a winning buy pays quantity minus cost)');
  assert.equal(o1.quantity, 20);
  assert.equal(o1.price, Math.round(((0.4 * 15 + 0.46 * 5) / 20) * 1e8) / 1e8, 'price is quantity-weighted');
  assert.equal(o1.occurred_at, '2026-05-01T10:00:00.000Z', 'the order starts at its first fill');
  assert.equal(o4.stake_amount, Math.round(((1 - 0.7) * 10) * 1e8) / 1e8, 'a sell risks (1 - price) x quantity');
  assert.equal(o4.realized_result, Math.round(0.7 * 10 * 1e8) / 1e8, 'a sell of a losing contract keeps the price');
  assert.deepEqual(report.derive.orders, {
    rowsIn: 10,
    eventsOut: 7,
    ordersMerged: { 'derived:order-id-0.1': 1, 'derived:account-market-side-time-0.1': 1 },
    rowsMergedAway: { 'derived:order-id-0.1': 2, 'derived:account-market-side-time-0.1': 1 }
  });
  assert.ok(validateEvents(events).valid);
});

test('placed_at comes from the orders table joined by order ID; otherwise the execution time is assumed', () => {
  const { events, report } = run(config());
  const trades = tradesOf(events);
  assert.equal(trades[0].placed_at, '2026-05-01T09:58:00.000Z');
  assert.equal(trades[0].provenance.placed_at, 'derived:order-created-0.1');
  assert.equal(trades[2].placed_at, '2026-05-01T10:59:30.000Z');
  assert.equal(trades[1].placed_at, undefined);
  assert.equal(trades[1].provenance.placed_at, 'assumed');
  assert.equal(trades[5].provenance.placed_at, 'assumed', 'an order created after its fill is skipped');
  assert.equal(report.derive.notes.placed_at['derived:order-created-0.1: after the execution time, skipped'], 1);
  const none = run(config({ withOrders: false }));
  assert.ok(tradesOf(none.events).every((trade) => trade.provenance.placed_at === 'assumed' && trade.placed_at === undefined));
});

test('settled_at: ledger posting, then the trade column, then the market, then the closing trade, else assumed', () => {
  const { events, report } = run(config());
  const [o1, o4, o6, o7, o8, o9] = tradesOf(events);
  assert.equal(o1.settled_at, '2026-05-01T15:00:00.000Z', 'the latest settlement posting of the same trader only');
  assert.equal(o1.provenance.settled_at, 'derived:ledger-settlement-0.1');
  assert.equal(o4.settled_at, '2026-05-01T10:30:00.000Z');
  assert.equal(o4.provenance.settled_at, 'derived:trade-settlement-column-0.1');
  assert.equal(o6.settled_at, '2026-05-01T11:20:00.000Z', 'closed by the opposite trade');
  assert.equal(o6.provenance.settled_at, 'derived:closing-trade-0.1');
  assert.equal(o7.provenance.settled_at, 'assumed', 'the closing trade itself has no later trade to close it');
  assert.equal(o8.realized_result, null, 'unresolved: unavailable, never 0');
  assert.equal(o8.settled_at, undefined);
  assert.equal(o8.provenance.settled_at, undefined);
  assert.equal(o9.provenance.settled_at, 'assumed');
  assert.equal(report.derive.notes.settled_at['derived:market-settlement-0.1: before the trade, skipped'], 1);
  assert.deepEqual(report.derive.byField.settled_at, {
    'derived:ledger-settlement-0.1': 1,
    'derived:trade-settlement-column-0.1': 1,
    'derived:closing-trade-0.1': 1,
    assumed: 2,
    unavailable: 1
  });
  assert.deepEqual(report.derive.joins.settlement, { looked: 7, found: 3 }, 'joins are counted per fill row with a key, never shown');
  assert.ok(validateEvents(events).valid);
});

test('market tables stay optional: with only the fills table the core path works', () => {
  const minimal = config({ withMarkets: false, withLedger: false, withOrders: false });
  const { events, report } = run(minimal);
  assert.equal(tradesOf(events).length, 6);
  assert.equal(report.derive.byField.settled_at['derived:market-settlement-0.1'], undefined);
  assert.ok(validateEvents(events).valid);
});

test('settled_at methods must follow the order of preference', () => {
  const swapped = config({ settledAt: [
    { method: 'market-settlement', join: 'market', attribute: 'closes' },
    { method: 'trade-settlement-column', attribute: 'settles' }
  ] });
  assert.throws(() => normalizeIntakeConfig(swapped), /order of preference: ledger-settlement, trade-settlement-column, market-settlement, closing-trade/);
  const wrongTarget = config({ settledAt: [{ method: 'ledger-settlement', join: 'market' }] });
  assert.throws(() => normalizeIntakeConfig(wrongTarget), /ledger table with role "events"/);
});

test('a merged order with an unresolved part has no result, and the merge is deterministic', () => {
  const partial = FILLS.replace('F-2,A-1,2026-05-01T10:00:00Z,FILL,O-1,M-1,buy,0.40,5,true,', 'F-2,A-1,2026-05-01T10:00:00Z,FILL,O-1,M-1,buy,0.40,5,,');
  const cfg = config();
  const first = mapAndDerive({ tables: { ...input(cfg).tables, fills: { text: partial, fileName: 'fills.csv' } } }, { config: cfg, salt: SALT, label: 'SYNTHETIC' });
  const [o1] = tradesOf(first.events);
  assert.equal(o1.realized_result, null);
  assert.equal(o1.provenance.realized_result, undefined);
  assert.equal(first.report.derive.notes.orders['merged order with a part whose result is unavailable: result unavailable'], 1);
  const again = mapAndDerive({ tables: { ...input(cfg).tables, fills: { text: partial, fileName: 'fills.csv' } } }, { config: cfg, salt: SALT, label: 'SYNTHETIC' });
  assert.deepEqual(first.events, again.events);
});

test('contract resolution: a buy and a sell of the same contract net to zero exposure, results never invented', () => {
  const lines = csv([
    'fill,acct,at,kind,order,mkt,side,px,qty,won,settles',
    'F-1,A-1,2026-05-01T10:00:00Z,FILL,O-1,M-1,buy,0.25,4,false,',
    'F-2,A-1,2026-05-01T10:01:00Z,FILL,O-2,M-1,sell,0.25,4,false,',
    'F-3,A-1,2026-05-01T10:02:00Z,FILL,O-3,M-1,hold,0.25,4,false,',
    'F-4,A-1,2026-05-01T10:03:00Z,FILL,O-4,M-1,buy,1.5,4,true,'
  ]);
  const cfg = config({ withMarkets: false, withLedger: false, withOrders: false, settledAt: [] });
  const { events } = mapAndDerive({ tables: { fills: { text: lines, fileName: 'f.csv' } } }, { config: cfg, salt: SALT, label: 'SYNTHETIC' });
  const trades = tradesOf(events);
  assert.deepEqual(trades.map((trade) => trade.stake_amount), [1, 3, null, null]);
  assert.deepEqual(trades.map((trade) => trade.realized_result), [-1, 1, null, null], 'an unknown side or a price outside [0, 1] is unavailable');
});
