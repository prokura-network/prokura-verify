# x402: two ways to put a mandate in front of a 402 payment (SKETCH)

Prokura's framing ([works-with](https://prokura.network/works-with)): *"x402 is a payment challenge on an HTTP request. Prokura adds the business mandate the gate checked before that challenge is paid."* Status on the site: **test**.

## A. Check, then let your own client pay

The x402 TypeScript client has `onBeforePaymentCreation` (`on_before_payment_creation` in Python), the hook that agentkit#1576 wants to expose. Ask `prokura_check` there and abort on anything but `allow`:

```ts
import { prokuraCheck } from "../prokura-check";

x402Client.onBeforePaymentCreation(async ({ paymentRequired, selectedRequirements }) => {
  const d = await prokuraCheck(mcp, {
    amount: toDecimal(selectedRequirements.maxAmountRequired, 6),
    currency: "USDC",
    payee: { type: "domain", value: new URL(paymentRequired.resource).hostname },
    purpose: "api_call",
    rail: "x402",
  });
  if ("error" in d || d.decision !== "allow") return { abort: true, reason: "error" in d ? d.error : d.reasons.join(",") };
});
```

In this pattern your wallet signs. Prokura records the decision, but it doesn't execute the payment.

## B. Let Prokura pay

`prokura_pay` takes `x402Url`: *"Pay for an HTTP 402 resource: amount, payee and rail are read from its challenge"*. Only an allow is executed, server-side, and the paid response is returned:

```json
{ "name": "prokura_pay", "arguments": { "x402Url": "https://api.example.com/paid/resource", "purpose": "api_call" } }
```

The public demo mandate covers EUR and the demo payees only, so pattern B needs a mandate whose scope includes the x402 rail and payee. Not tried against the demo.
