# MCP tool annotations for https://prokura.network/mcp

**Status (tools/list, 26 Nov 2026, protocol 2025-06-18):** all 7 tools have a top-level `title`, but **none has an `annotations` object**. Anthropic's connector directory requires `title` plus the applicable `readOnlyHint` / `destructiveHint` on every tool and flags tools that lack them. Glama's connector score also reads tool-definition quality.

Ready-to-paste files: `tool-annotations.snippet.ts` (TypeScript SDK) and `tool-annotations.json` (plain map).

| Tool | title | readOnly | destructive | idempotent | openWorld | Why |
|---|---|---|---|---|---|---|
| `prokura_request_mandate` | Request a demo mandate | false | false | false | false | Creates a pending grant (state on Prokura's side) and returns a URL and QR. Nothing is overwritten or paid. Each call creates a new grant (`"created": true`), limited to 5 per address per hour, so repeating it isn't a no-op. Talks only to Prokura's own approval service. |
| `prokura_check` | Check a payment | **true** | – | – | false | "Nothing is paid." No spend or budget change. See the note below. |
| `prokura_pay` | Pay | false | **true** | false | **true** | Executes a payment when the gate allows it. Money that has moved can't be pulled back by another call, and a repeat call is a second payment with a fresh nonce. Only `DUPLICATE_INVOICE` blocks a repeat, and only when an invoice is given. It reaches outside systems: the rail (Mollie) and, with `x402Url`, any HTTP 402 URL. |
| `prokura_evidence` | Get evidence | true | – | – | false | Reads stored records. |
| `prokura_mandate` | Get mandate | true | – | – | false | Reads a redacted summary. |
| `store_catalog` | Fake store catalog | true | – | – | false | Static demo catalog. |
| `store_quote` | Fake store quote | true | – | – | false | Pure price calculation. |

Per the MCP spec, `destructiveHint` and `idempotentHint` only matter when `readOnlyHint` is false, so they are left out of the read-only tools. `annotations.title` repeats the top-level `title` for clients that only read annotations.

**Note on `prokura_check`:** the real demo exports in `fixtures/` show that a check writes its own signed `kind: "check"` record into the evidence chain (an audit side effect, not a change the caller asked for). Decision: `readOnlyHint: true`, so clients can run a dry-run check without a confirmation prompt.

**Also worth fixing while you're in there:**
- `prokura_pay` has no `required` list in its input schema (`prokura_check` requires `amount, payee, purpose`), because `x402Url` can stand in for them. A `oneOf` (either `x402Url` or `amount+payee+purpose`) would make the contract explicit.
- `prokura_request_mandate` takes `additionalProperties: true` and ignores everything. `{"type":"object","properties":{}}` would say that more plainly. The description already says it ignores input.
