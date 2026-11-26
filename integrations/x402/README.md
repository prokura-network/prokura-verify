# x402: a mandate in front of a 402 payment

x402 is a payment challenge on an HTTP request. Prokura adds the business mandate the gate checks before that challenge is paid. [`guard/`](guard/) is a small TypeScript package, `@prokura/x402-guard`, that does this for the x402 client: every 402 challenge is mapped to a Prokura intent and checked before your wallet signs anything.

There are two ways to use it.

## A. Your wallet pays, Prokura decides first

```ts
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { connectProkura, createProkuraGuard } from "@prokura/x402-guard";

const guard = createProkuraGuard({ mcp: await connectProkura(), purpose: "api_usage" });
const client = guard.protect(new x402Client().register("eip155:8453", new ExactEvmScheme(signer)));
const fetchPaid = guard.wrapFetch(wrapFetchWithPayment(fetch, client));
const res = await fetchPaid("https://data.agents.prokura.network/v1/agents/data/forecast"); // throws unless Prokura says allow
console.log(guard.receiptOf(res)?.evidenceId);                  // the signed Nachweis record
```

`guard.protect()` registers an `onBeforePaymentCreation` hook on the x402 client. It runs after x402 picked a payment requirement and before the wallet creates the payload. The hook calls `prokura_check` and:

| Gate says | What happens | What you get |
|---|---|---|
| `allow` | x402 pays as usual | the response; `guard.receiptOf(res)` has decision, reasons and `evidenceId` |
| `step_up` | no payment | `ProkuraStepUpError` with `evidenceId`, and `approvalUrl` when the server sends one |
| `deny` | no payment | `ProkuraDeniedError` with `code` (first reason), `reasons` and `evidenceId` |
| session has no mandate | no payment, gate not called | `ProkuraGrantError` with `code` (`grant_required`, `grant_pending`, ...) and `grantUrl` |
| challenge cannot be expressed | no payment, gate not called | `ProkuraMappingError` (sub-cent price, unknown asset, IP or `localhost` host) |

x402 wraps errors thrown in its hooks in a plain `Error`; `guard.wrapFetch()` rethrows the typed error instead. The hook alone also blocks the payment, with the reason in the message. If you do not use `@x402/fetch`, call `guard.check(paymentRequired, requirement)` yourself; it returns the allow receipt or throws as above (`guard.decide()` returns the receipt without throwing).

### Intent mapping

| Intent field | Value |
|---|---|
| `amount` | the requirement's `amount` (v2) or `maxAmountRequired` (v1), from atomic units to two decimals; sub-cent prices are refused, not rounded |
| `currency` | from the asset: USDC on Base, Base Sepolia, Ethereum, Ethereum Sepolia, Polygon and Solana; add others with `assets` |
| `payee` | `{"type": "domain", "value": <host of the resource>}`, or a parent domain you give as `payeeDomain` |
| `purpose` | `purpose`, default `api_usage` |
| `rail` | `x402` |
| `reference.resource` | the resource URL (v2 `resource.url`, v1 `resource`, else the request URL) |
| `reference.description`, `reference.item`, `agent_name`, `mandateId` | from the challenge and your options, when present |

The wallet address in `payTo` is not part of the mandate; the payee is the domain that serves the resource.

## B. Let Prokura pay

`prokura_pay` takes `x402Url`. Our server fetches the resource, reads the 402 challenge (scheme `exact`, USDC), builds the same intent, decides, and executes only an `allow`, server-side; the paid response is returned in the tool result. Your agent holds no wallet.

```ts
import { connectProkura, prokuraPay } from "@prokura/x402-guard";

const r = await prokuraPay("https://data.agents.prokura.network/v1/agents/data/forecast", { mcp: await connectProkura(), onStepUp: "return" });
if (r.approvalUrl) console.log("approve:", r.approvalUrl);        // step_up: a human approves within 15 minutes
else console.log(r.execution?.response?.body, r.receipt.evidenceId);
```

`deny` throws `ProkuraDeniedError`. If you also pass `amount`, it must equal the challenge's price. This mode is the one that returns an approval link on `step_up`.

## The mandate

The mandate needs `x402` in its `rails`, the resource's domain in its `payees`, the purpose in its `purposes`, and USDC limits in `currencyLimits` (a EUR mandate without them judges USDC amounts at a fixed demo rate).

The public demo grant on `prokura.network/mcp` now also allows the x402 rail, with a tight scope:

- purpose `api_usage`
- payees: the demo seller agents (`data.`, `scraper.` and `compute.agents.prokura.network`), plus the demo stores
- USDC caps of its own: 0.50 on its own, 1.00 with approval, 2.00 per day

A check for `https://data.agents.prokura.network/…` at 0.05 USDC therefore returns `allow` once that grant is in place. A resource on any other host is still denied with `PAYEE_NOT_ALLOWED`.

### A fresh grant

One MCP session holds one demo grant, and a grant keeps the terms it was issued with. After the demo scope gained x402, an already-approved session still has the old Mollie-only mandate, so a check is denied with `RAIL_NOT_ALLOWED`. Open a **new** session (`connectProkura()`), call `prokura_request_mandate` again, and approve the new link (one tap, or a passkey). Then keep that connection: a new session needs a new grant. The example does this for you when you run it with `--wait`.

## Run it

```sh
cd integrations/x402/guard
npm ci
npm test                         # unit tests: mocked Prokura MCP, mocked 402 server, the real @x402/fetch client
npm run example -- --offline     # everything mocked, ends in a paid response
npm run example -- --wait        # live prokura.network/mcp: prints a grant link, waits for a fresh approval, then checks
```

The example's wallet is a stand-in that signs nothing; in an agent you register a real scheme such as `ExactEvmScheme` from `@x402/evm`. Set `PROKURA_MCP_URL` or pass `connectProkura({ url })` to use another endpoint.

## Limits

- `prokura_check` returns no approval link on `step_up`; the error carries the `evidenceId`. Use mode B when a human should approve from a link.
- One MCP session holds one demo grant. Keep the connection for the agent's lifetime; a new session needs a new grant.
- Prices must be whole cents. A 0.001 USDC call cannot be expressed as a Prokura intent and is refused.
- Hosts must be domain names. `localhost` and IP addresses are refused, as Prokura payees are domains.
- `guard.wrapFetch()` uses `AsyncLocalStorage`, so it needs Node.js 20 or later (no browsers yet).
- Tested against `@x402/fetch` and `@x402/core` 2.32.0 with v2 (header) and v1 (body) challenges. The package is not published to npm yet; use it from this folder.
