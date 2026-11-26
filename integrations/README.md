# Integrations

Where a Prokura check sits in three agent-payment stacks. All three ask the same MCP tool, `prokura_check`, before money moves; [`prokura-check.ts`](prokura-check.ts) is the shared helper.

| Folder | Stack | Where Prokura sits | Status |
|---|---|---|---|
| [`x402/`](x402/README.md) | x402 clients | check in the client's `onBeforePaymentCreation` hook, or let us pay with `prokura_pay` and `x402Url` | `prokura_pay` with `x402Url` is part of our MCP server; the hook example is a pattern we have not run against the x402 SDK |
| [`agentkit/`](agentkit/README.md) | coinbase/agentkit x402 action provider | the proposed `beforePayment` hook ([agentkit#1576](https://github.com/coinbase/agentkit/issues/1576)) asks `prokura_check` before a payment is signed | targets the API proposed upstream; not yet in an agentkit release |
| [`ap2/`](ap2/README.md) | Google Agent Payments Protocol (AP2) | a check before an AP2 payment executes, and the Nachweis as dispute evidence | pseudo-code; AP2's object model is still changing |

None of these is an integration endorsed by the projects named.

## Payees for x402 and on-chain rails

Our payees are `{"type": "iban"}` or `{"type": "domain"}` ([format §2.3](../docs/nachweis-format.md#23-payee)). For x402, the payee is the **domain of the paid resource**: a mandate allows `{"type": "domain", "value": "api.example.com"}`, the intent carries that domain as payee and the resource URL in `reference.resource`, and we pay only when the resource's host is that domain or a subdomain of it. The wallet address in the challenge's `payTo` is not part of the mandate in v1.

## Amounts

Amounts are decimal strings with exactly two fraction digits (`"0.01"`). An x402 price is converted from the asset's atomic units (6 decimals for USDC); a price with sub-cent precision is refused rather than rounded.
