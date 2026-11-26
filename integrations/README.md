# Integration sketches

> **These are sketches.** They show where a Prokura check fits in each stack. They have not been run against those SDKs, the APIs they rely on may not exist yet, and none of them is an official integration by the projects named. Status labels for each rail come from [prokura.network/works-with](https://prokura.network/works-with).

| Folder | Stack | Where Prokura sits | works-with status |
|---|---|---|---|
| `agentkit/` | coinbase/agentkit x402 action provider | the proposed `beforePayment` hook ([agentkit#1576](https://github.com/coinbase/agentkit/issues/1576)) asks `prokura_check` before a payment is signed | x402: test |
| `ap2/` | Google Agent Payments Protocol (AP2) | a pre-execution check on a payment mandate, plus the Nachweis as dispute evidence | AP2: test |
| `x402/` | x402 clients | `onBeforePaymentCreation` hook, or let Prokura pay through `prokura_pay` with `x402Url` | x402: test |

All three call the same tool over MCP. `prokura-check.ts` is the shared helper.

## Payee mapping (open question in all three)

Prokura payees are either `{"type":"iban"}` or `{"type":"domain"}` (see the `prokura_check` input schema). x402 and on-chain rails pay an **address** (`payTo`). The sketches use the resource URL's host as a `domain` payee. Whether Prokura plans an address payee type is for Prokura to answer; the site doesn't say.
