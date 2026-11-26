# MCP tool annotations

Every tool on `https://prokura.network/mcp` carries a `title` and an MCP `annotations` object (spec 2025-06-18), so clients can tell a dry run from a payment before they call anything. The same values as a plain map: [`tool-annotations.json`](tool-annotations.json).

| Tool | title | readOnly | destructive | idempotent | openWorld | Why |
|---|---|---|---|---|---|---|
| `prokura_request_mandate` | Request a demo mandate | false | false | false | false | Opens a pending grant on our side and returns its URL and QR code. Nothing is paid or overwritten. Each call can open a new grant (at most 5 per client address per hour), so a repeat is not a no-op. It talks only to our own approval service. |
| `prokura_check` | Check a payment | **true** | – | – | false | Asks the gate; nothing is paid and no budget is spent. |
| `prokura_pay` | Pay | false | **true** | false | **true** | Executes a payment when the gate allows it. Money that moved cannot be pulled back by another call, and a repeat is a second payment with a fresh nonce (only `DUPLICATE_INVOICE` stops a repeat, and only when an invoice is given). It reaches outside systems: the payment rail and, with `x402Url`, any HTTP 402 URL. |
| `prokura_evidence` | Get evidence | true | – | – | false | Reads stored records. |
| `prokura_mandate` | Get mandate | true | – | – | false | Reads a redacted summary of the mandate. |
| `store_catalog` | Fake store catalog | true | – | – | false | The demo store's static catalog. |
| `store_quote` | Fake store quote | true | – | – | false | A price calculation; a quote is not a decision. |

Under the MCP spec, `destructiveHint` and `idempotentHint` only mean something when `readOnlyHint` is false, so the read-only tools leave them out. `annotations.title` repeats the top-level `title` for clients that read only the annotations.

**Why `prokura_check` is read-only.** A check writes its own signed `kind: "check"` record into the evidence chain. That record is an audit trail of the question, not a change the caller asked for: no money moves, no budget is used and the nonce stays unused. Marking the tool read-only lets clients run a dry-run check without a confirmation prompt.

**Arguments of `prokura_pay`.** Give either `x402Url` (amount, payee and rail come from the HTTP 402 challenge), or `amount` + `payee` + `purpose`. The server enforces this when it validates the call. The published input schema stays a plain object with no top-level `oneOf`, because Anthropic's and OpenAI's tool APIs reject tool schemas with `oneOf`, `anyOf` or `allOf` at the top level.
