import { test } from 'node:test';
import assert from 'node:assert/strict';
import { core, wf, node, run, checkWiring } from './harness.mjs';

const c = core();
const NOW = '2026-10-30T12:00:00Z';
const ago = (d) => new Date(Date.parse(NOW) - d * 86400000).toISOString();
const cust = (id, orders, spent, lastDaysAgo, tags = []) => ({
  id: `gid://shopify/Customer/${id}`, displayName: `C${id}`, tags, numberOfOrders: String(orders),
  amountSpent: { amount: String(spent), currencyCode: 'USD' }, lastOrder: lastDaysAgo == null ? null : { createdAt: ago(lastDaysAgo) },
});

test('segments', () => {
  const s = (cu) => c.segmentOf(cu, NOW);
  assert.equal(s(cust(1, 0, 0, null)), null);
  assert.equal(s(cust(2, 1, 40, 5)), 'new');
  assert.equal(s(cust(3, 1, 40, 45)), 'one_time');
  assert.equal(s(cust(4, 2, 90, 20)), 'active');
  assert.equal(s(cust(5, 4, 300, 20)), 'loyal');
  assert.equal(s(cust(6, 2, 1500, 10)), 'vip');
  assert.equal(s(cust(7, 9, 200, 10)), 'vip');
  assert.equal(s(cust(8, 9, 5000, 120)), 'at_risk', 'a VIP going quiet is at risk, not VIP');
  assert.equal(s(cust(9, 1, 40, 120)), 'one_time');
  assert.equal(s(cust(10, 6, 900, 400)), 'lapsed');
});

test('thresholds are configurable', () => {
  assert.equal(c.segmentOf(cust(1, 2, 300, 10), NOW, { vipSpend: 250 }), 'vip');
  assert.equal(c.segmentOf(cust(1, 2, 300, 50), NOW, { atRiskDays: 40 }), 'at_risk');
});

test('tag changes only touch our prefix', () => {
  assert.deepEqual(c.tagChanges(cust(1, 2, 0, 1, ['wholesale', 'seg:new']), 'active'), { add: ['seg:active'], remove: ['seg:new'] });
  assert.deepEqual(c.tagChanges(cust(1, 2, 0, 1, ['seg:active', 'newsletter']), 'active'), { add: [], remove: [] });
  assert.deepEqual(c.tagChanges(cust(1, 0, 0, null, ['seg:vip', 'seg:loyal']), null), { add: [], remove: ['seg:vip', 'seg:loyal'] });
});

test('planPage counts segments and lists only customers that change', () => {
  const p = c.planPage([cust(1, 1, 40, 5, ['seg:new']), cust(2, 4, 300, 20), cust(3, 0, 0, null)], NOW);
  assert.deepEqual(p.counts, { new: 1, loyal: 1, none: 1 });
  assert.equal(p.changes.length, 1);
  assert.deepEqual(p.changes[0], { id: 'gid://shopify/Customer/2', name: 'C2', segment: 'loyal', add: ['seg:loyal'], remove: [] });
});

test('mutations are batched with aliases and valid string literals', () => {
  const changes = Array.from({ length: 30 }, (_, i) => ({ id: `gid://shopify/Customer/${i}`, add: ['seg:vip'], remove: i % 2 ? ['seg:new'] : [] }));
  const docs = c.mutationBatches(changes);
  assert.equal(docs.length, 2);
  assert.equal(docs[0].customers, 25);
  assert.equal(docs[1].customers, 5);
  assert.match(docs[0].query, /^mutation \{ a0: tagsAdd\(id: "gid:\/\/shopify\/Customer\/0", tags: \["seg:vip"\]\) \{ userErrors \{ field message \} \} a1: /);
  assert.match(docs[0].query, /r1: tagsRemove\(id: "gid:\/\/shopify\/Customer\/1", tags: \["seg:new"\]\)/);
  assert.equal((docs[0].query.match(/\{/g) || []).length, (docs[0].query.match(/\}/g) || []).length);
  assert.deepEqual(c.mutationBatches([]), []);
});

test('checkMutation throws on GraphQL errors and userErrors', () => {
  assert.equal(c.checkMutation({ data: { a0: { userErrors: [] }, r0: { userErrors: [] } } }), 2);
  assert.throws(() => c.checkMutation({ data: { a0: { userErrors: [{ field: ['id'], message: 'Customer not found' }] } } }), /a0: Customer not found/);
  assert.throws(() => c.checkMutation({ errors: [{ message: 'Throttled' }] }), /Throttled/);
});

test('cursor rolls forward and restarts after the last page', () => {
  assert.equal(c.nextCursor({ hasNextPage: true, endCursor: 'abc' }), 'abc');
  assert.equal(c.nextCursor({ hasNextPage: false, endCursor: 'xyz' }), null);
});

test('workflow: wiring, cursor only moves after successful updates', () => {
  const w = wf('customer-segments');
  checkWiring(w);
  const staticData = { cursor: 'page1' };
  assert.deepEqual(run(node(w, 'Cursor'), [{}], { staticData }), [{ after: 'page1' }]);

  const res = { data: { customers: { pageInfo: { hasNextPage: true, endCursor: 'page2' }, nodes: [cust(1, 4, 300, 20), cust(2, 1, 10, 3, ['seg:new'])] } } };
  const docs = run(node(w, 'Plan Tags'), [res], { staticData });
  assert.equal(docs.length, 1);
  assert.equal(docs[0].changed, 1);
  assert.equal(staticData.cursor, 'page1', 'not moved before the update');
  assert.throws(() => run(node(w, 'Save Cursor'), [{ data: { a0: { userErrors: [{ message: 'nope' }] } } }], { nodes: { 'Plan Tags': docs }, staticData }), /nope/);
  assert.equal(staticData.cursor, 'page1');
  run(node(w, 'Save Cursor'), [{ data: { a0: { userErrors: [] } } }], { nodes: { 'Plan Tags': docs }, staticData });
  assert.equal(staticData.cursor, 'page2');

  const quiet = { cursor: 'page2' };
  const last = { data: { customers: { pageInfo: { hasNextPage: false, endCursor: 'end' }, nodes: [cust(3, 1, 10, 3, ['seg:new'])] } } };
  assert.deepEqual(run(node(w, 'Plan Tags'), [last], { staticData: quiet }), []);
  assert.equal(quiet.cursor, null, 'full pass done: start over');
});
