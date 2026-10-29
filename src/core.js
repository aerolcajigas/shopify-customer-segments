// RFM-style customer segments as Shopify customer tags ("seg:vip", "seg:at_risk", ...), so marketing tools, Shopify
// customer segments, discounts and support all see the same groups. Plain JS, no imports: build.mjs pastes it into the
// n8n Code nodes; tests run the same functions.

const DEFAULTS = {
  prefix: 'seg:',
  vipSpend: 1000,    // lifetime spend (shop currency) ...
  vipOrders: 8,      // ... or this many orders = VIP, while still active
  loyalOrders: 3,
  newDays: 30,       // first order this recent = new
  atRiskDays: 90,    // repeat customer quiet for longer than this = at risk
  lapsedDays: 180,   // no order for longer than this = lapsed
  batchSize: 25,     // customers per GraphQL mutation request
};
const cfgOf = (c) => ({ ...DEFAULTS, ...(c || {}) });
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const SEGMENTS = ['vip', 'loyal', 'active', 'new', 'one_time', 'at_risk', 'lapsed'];

// customer: GraphQL Customer node. Returns one segment name, or null for customers with no orders.
function segmentOf(customer, now, c) {
  const cfg = cfgOf(c);
  const orders = num(customer.numberOfOrders);
  const last = customer.lastOrder && customer.lastOrder.createdAt;
  if (!orders || !last) return null;
  const quiet = (new Date(now).getTime() - new Date(last).getTime()) / 86400000;
  const spent = num(customer.amountSpent && customer.amountSpent.amount);
  if (quiet > cfg.lapsedDays) return 'lapsed';
  if (quiet > cfg.atRiskDays) return orders >= 2 ? 'at_risk' : 'one_time';
  if (spent >= cfg.vipSpend || orders >= cfg.vipOrders) return 'vip';
  if (orders >= cfg.loyalOrders) return 'loyal';
  if (orders === 1) return quiet <= cfg.newDays ? 'new' : 'one_time';
  return 'active';
}

// Only touches tags with our prefix; every other tag on the customer is left alone.
function tagChanges(customer, segment, c) {
  const cfg = cfgOf(c);
  const ours = (customer.tags || []).filter((t) => t.startsWith(cfg.prefix));
  const want = segment ? [cfg.prefix + segment] : [];
  return { add: want.filter((t) => !ours.includes(t)), remove: ours.filter((t) => !want.includes(t)) };
}

// One page of customers -> the changes to make + per-segment counts.
function planPage(customers, now, c) {
  const cfg = cfgOf(c);
  const counts = {};
  const changes = [];
  for (const cu of customers || []) {
    const seg = segmentOf(cu, now, cfg);
    counts[seg || 'none'] = (counts[seg || 'none'] || 0) + 1;
    const ch = tagChanges(cu, seg, cfg);
    if (ch.add.length || ch.remove.length) changes.push({ id: cu.id, name: cu.displayName, segment: seg, ...ch });
  }
  return { changes, counts };
}

// Changes -> GraphQL mutation documents, batchSize customers each, using aliases (a0, r0, ...) so one request
// updates many customers. JSON.stringify produces valid GraphQL string literals for ids and tags.
function mutationBatches(changes, c) {
  const cfg = cfgOf(c);
  const docs = [];
  for (let i = 0; i < changes.length; i += cfg.batchSize) {
    const parts = [];
    changes.slice(i, i + cfg.batchSize).forEach((ch, j) => {
      const id = JSON.stringify(ch.id);
      if (ch.add.length) parts.push(`a${j}: tagsAdd(id: ${id}, tags: ${JSON.stringify(ch.add)}) { userErrors { field message } }`);
      if (ch.remove.length) parts.push(`r${j}: tagsRemove(id: ${id}, tags: ${JSON.stringify(ch.remove)}) { userErrors { field message } }`);
    });
    docs.push({ query: `mutation { ${parts.join(' ')} }`, customers: Math.min(cfg.batchSize, changes.length - i) });
  }
  return docs;
}

// Throws on GraphQL errors or any per-customer userErrors, so the cursor doesn't move past a failed page.
function checkMutation(res) {
  if (res.errors && res.errors.length) throw new Error('Shopify GraphQL: ' + res.errors.map((e) => e.message).join('; '));
  const bad = [];
  for (const [alias, r] of Object.entries(res.data || {})) for (const e of (r && r.userErrors) || []) bad.push(`${alias}: ${e.message}`);
  if (bad.length) throw new Error('Shopify tag update failed: ' + bad.join('; '));
  return Object.keys(res.data || {}).length;
}

// Rolling cursor: each run handles the next page; after the last page it starts over.
const nextCursor = (pageInfo) => (pageInfo && pageInfo.hasNextPage ? pageInfo.endCursor : null);

// @export
if (typeof module !== 'undefined') module.exports = { DEFAULTS, SEGMENTS, segmentOf, tagChanges, planPage, mutationBatches, checkMutation, nextCursor };
