# coinbase/agentkit: Prokura as a `beforePayment` hook

[agentkit#1576](https://github.com/coinbase/agentkit/issues/1576) proposes an optional `beforePayment` field on `x402ActionProvider`, and [agentkit#1577](https://github.com/coinbase/agentkit/pull/1577) implements it: the hook is registered on the x402 client's `onBeforePaymentCreation`, so a check can approve or block each payment before it is signed. The issue lists spend policy, a second approval above an amount, and an audit log of every decision. Those are our `allow`, `step_up` and Nachweis.

**Status:** the field is not in an agentkit release yet. The code below targets the API in #1577, and we have not compiled it against agentkit.

```ts
import { x402ActionProvider } from "@coinbase/agentkit";        // beforePayment: agentkit#1577
import { prokuraCheck } from "../prokura-check";

const provider = x402ActionProvider({
  maxPaymentUsdc: 1,
  beforePayment: async ({ paymentRequired, selectedRequirements }) => {
    const result = await prokuraCheck(mcp, {
      amount: toDecimal(selectedRequirements.maxAmountRequired, 6),     // USDC atomic units -> "0.01"
      currency: "USDC",
      payee: { type: "domain", value: new URL(paymentRequired.resource).hostname },
      purpose: "api_usage",
      rail: "x402",
      reference: { resource: paymentRequired.resource },
      agent_name: "my-agentkit-agent",
    });
    if ("error" in result) return { abort: true, reason: `prokura: ${result.error}` };   // no mandate, no payment
    if (result.decision === "deny") return { abort: true, reason: result.reasons.join(",") };
    if (result.decision === "step_up") return { abort: true, reason: "FOUR_EYES_REQUIRED: waiting for a human" };
    // allow: fall through, the x402 client signs and pays
  },
});
```

The payee is the resource's domain, not the `payTo` address ([integrations](../README.md#payees-for-x402-and-on-chain-rails)). The x402 field names (`maxAmountRequired`, `resource`) differ between x402 versions, so check the version you build against. `toDecimal` must return exactly two fraction digits and reject sub-cent prices, as our server does.
