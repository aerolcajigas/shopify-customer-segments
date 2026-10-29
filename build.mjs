// Generates workflows/customer-segments.json from src/core.js + config.json (or config.example.json).
//   node build.mjs [--deploy]   (--deploy needs env N8N_API_URL, N8N_API_KEY)
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { loadCore, makeBuilder, GQL_CHECK, deploy } from './lib/n8n.mjs';

const here = (p) => new URL(p, import.meta.url);
const cfg = JSON.parse(readFileSync(here(existsSync(here('config.json')) ? 'config.json' : 'config.example.json'), 'utf8'));
const { credentials: C, shop, apiVersion, everyMinutes, pageSize, ...logic } = cfg;
const b = makeBuilder({ core: loadCore(here('src/core.js')), config: logic });
const GQL = `https://${shop}/admin/api/${apiVersion}/graphql.json`;
const shopify = (name, jsonBody) => b.http(name, { credType: 'shopifyAccessTokenApi', cred: C.shopify, method: 'POST', url: GQL, jsonBody });

const CUSTOMERS_Q = `query($after: String, $n: Int!) { customers(first: $n, after: $after, query: "orders_count:>0", sortKey: ID) {
  pageInfo { hasNextPage endCursor } nodes { id displayName tags numberOfOrders amountSpent { amount currencyCode } lastOrder { createdAt } } } }`.replace(/\s+/g, ' ');

// Same pattern as a watermark: the cursor only moves after the tag updates succeed ("Plan Tags" saves it when there
// is nothing to update, "Save Cursor" after the updates). A failed update stops the run and the page is redone.
const wf = b.workflow('Shopify / Customer Segments', [
  b.schedule(`Every ${everyMinutes} Minutes`, { field: 'minutes', minutesInterval: everyMinutes }),
  b.code('Cursor', `
return [{ json: { after: $getWorkflowStaticData('global').cursor || null } }];`),
  shopify('Get Customers', `={{ JSON.stringify({ query: ${JSON.stringify(CUSTOMERS_Q)}, variables: { after: $json.after, n: ${pageSize} } }) }}`),
  b.code('Plan Tags', `${GQL_CHECK}
const page = gql($input.first()).customers;
const plan = planPage(page.nodes, new Date().toISOString(), CONFIG);
const cursor = nextCursor(page.pageInfo);
const docs = mutationBatches(plan.changes, CONFIG);
if (!docs.length) $getWorkflowStaticData('global').cursor = cursor;
return docs.map((d) => ({ json: { ...d, cursor, counts: plan.counts, changed: plan.changes.length } }));`),
  shopify('Update Tags', '={{ JSON.stringify({ query: $json.query }) }}'),
  b.code('Save Cursor', `
for (const r of $input.all()) checkMutation(r.json);
const first = $('Plan Tags').first().json;
$getWorkflowStaticData('global').cursor = first.cursor;
return [{ json: { changed: first.changed, counts: first.counts, nextCursor: first.cursor } }];`),
], 'Every run: next page of customers -> RFM segment -> "seg:*" tags added/removed only where they changed. Cycles through all customers.');

mkdirSync(here('workflows/'), { recursive: true });
writeFileSync(here('workflows/customer-segments.json'), JSON.stringify(wf, null, 2) + '\n');
console.log('wrote workflows/customer-segments.json');
if (process.argv.includes('--deploy')) await deploy([wf]);
