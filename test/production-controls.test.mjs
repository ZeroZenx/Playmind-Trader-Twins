import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTokenizedCsv } from '../src/lib/ingestion-runner.mjs';

const header = 'event_id,trader_token,occurred_at,type,venue_id,stake_amount,realized_result,source_row_number';

test('production ingestion parser rejects PII and preserves duplicate diagnostics', () => {
  assert.throws(() => parseTokenizedCsv('event_id,email,occurred_at,type,venue_id,source_row_number\n1,a@example.com,2026-01-01T00:00:00Z,trade,v,1'), /Direct PII/);
  const parsed = parseTokenizedCsv(`${header}\n1,t1,2026-01-01T00:00:00Z,trade,v,10,-2,1\n1,t1,2026-01-01T01:00:00Z,trade,v,20,2,2`);
  assert.equal(parsed.events.length, 1);
  assert.equal(parsed.errors.length, 1);
  assert.match(parsed.errors[0].message, /Duplicate event_id/);
});

test('production ingestion parser accepts optional provenance and settlement timing', () => {
  const parsed = parseTokenizedCsv(`${header},placed_at,settled_at,provenance\n1,t1,2026-01-01T00:00:00Z,trade,v,10,-2,1,2026-01-01T00:00:00Z,2026-01-01T02:00:00Z,"{""source"":""venue""}"`);
  assert.equal(parsed.events[0].settled_at, '2026-01-01T02:00:00Z');
  assert.deepEqual(parsed.events[0].provenance, { source: 'venue' });
});
