# x402: a mandate in front of a 402 payment

x402 is a payment challenge on an HTTP request. Prokura adds the business mandate the gate checks before that challenge is paid. There are two ways to use it.

## A. Let Prokura pay

`prokura_pay` takes `x402Url`. Our server fetches the resource, reads the 402 challenge (scheme `exact`, USDC), and builds the intent from it:

| Intent field | Value |
|---|---|
| `amount` | the challenge's `maxAmountRequired`, converted from USDC's 6 decimals to two (sub-cent prices are refused) |
| `currency` | `USDC` |
| `payee` | `{"type": "domain", "value": <host of x402Url>}` |
| `purpose` | the `purpose` you pass, default `api_usage` |
| `rail` | `x402` |
| `reference.resource` | `x402Url` |

The gate decides as for any payment. Only an `allow` is executed, server-side, and the paid response is returned in the tool result. If you also pass `amount`, it must equal the challenge's price.

```json
{ "name": "prokura_pay", "arguments": { "x402Url": "https://api.example.com/paid/resource", "purpose": "api_usage" } }
```

The mandate needs `x402` in its `rails`, the resource's domain in its `payees`, the purpose in its `purposes`, and USDC limits in `currencyLimits` (a EUR mandate without them judges USDC amounts at a fixed demo rate). The public demo grant covers the `mollie` rail only, so x402 needs a mandate of your own.

## B. Check, then let your own client pay

The x402 TypeScript client has `onBeforePaymentCreation` (`on_before_payment_creation` in Python). Ask `prokura_check` there and abort on anything but `allow`. In this pattern your wallet signs and pays; we record the decision but do not execute the payment. We have not run this snippet against the x402 SDK; check the field names of the version you use.

```ts
import { prokuraCheck } from "../prokura-check";

x402Client.onBeforePaymentCreation(async ({ paymentRequired, selectedRequirements }) => {
  const d = await prokuraCheck(mcp, {
    amount: toDecimal(selectedRequirements.maxAmountRequired, 6), // atomic units -> "0.01"
    currency: "USDC",
    payee: { type: "domain", value: new URL(paymentRequired.resource).hostname },
    purpose: "api_usage",
    rail: "x402",
    reference: { resource: paymentRequired.resource },
  });
  if ("error" in d || d.decision !== "allow") return { abort: true, reason: "error" in d ? d.error : d.reasons.join(",") };
});
```

`toDecimal` must return exactly two fraction digits and reject sub-cent prices, as the server does.
