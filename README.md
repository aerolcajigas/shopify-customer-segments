# Shopify Customer Segments

Tags every Shopify customer with one RFM-style segment, `seg:vip`, `seg:loyal`, `seg:active`, `seg:new`,
`seg:one_time`, `seg:at_risk` or `seg:lapsed`, and keeps the tags current. Because they are plain Shopify customer
tags, every tool connected to the store can use them: Shopify customer segments and discounts, email and SMS apps,
helpdesks, ads audiences.

| Segment | Rule (defaults, all configurable) |
|---|---|
| `lapsed` | No order for more than 180 days |
| `at_risk` | 2+ orders, quiet for 90-180 days (includes VIPs going quiet) |
| `vip` | Spent 1,000+ or 8+ orders, and ordered in the last 90 days |
| `loyal` | 3+ orders, ordered in the last 90 days |
| `new` | First order in the last 30 days |
| `one_time` | One order, 30-180 days ago |
| `active` | Everyone else who ordered recently |

```
every 15 min -> next page of customers (cursor kept between runs, restarts after the last page)
             -> segment each one
             -> add / remove only the seg:* tags that changed, 25 customers per GraphQL request
```

## Design

- **Only touches its own tags.** Anything without the `seg:` prefix (wholesale, newsletter, manual tags) is left alone.
- **Writes only what changed**, batched: one GraphQL request updates up to 25 customers using aliased
  `tagsAdd` / `tagsRemove` mutations, which keeps it well inside Shopify's rate limits.
- **Rolling cursor.** Each run handles the next page; a store with 10,000 customers is fully refreshed every ~25 hours
  at the defaults (page size 100, every 15 minutes).
- **Safe cursor.** It only moves after the tag updates succeed. Any `userErrors` stop the run and that page is redone.
- Logic lives in `src/core.js`, pasted into the Code nodes by `build.mjs`; the tests run the same code.

## Set up

1. **n8n credential:** Shopify Access Token (custom app with `read_customers`, `write_customers`, `read_orders`).
2. `cp config.example.json config.json`: shop, thresholds, schedule, credential id.
3. `npm run build`, then import `workflows/customer-segments.json` or `npm run deploy`. Activate it.

```
npm test   # builds the workflow, then 8 tests: segment rules, tag diffs, batching, cursor safety, Code nodes with mocked n8n
```

Tested with sample payloads and n8n's workflow validator, not against a live store. Built with n8n and the Shopify
Admin GraphQL API.
