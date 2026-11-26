# coinbase/agentkit: Prokura as a `beforePayment` hook (SKETCH)

[agentkit#1576](https://github.com/coinbase/agentkit/issues/1576) (open) proposes an optional `beforePayment` field on `x402ActionProvider`, passed through to the x402 client's `onBeforePaymentCreation`. The issue lists spend policy, a second approval above an amount, and logging every decision for audit. Those map to Prokura's `allow` / `step_up` / Nachweis.

**Status:** that config field isn't in agentkit yet. The issue author says they will open the PR, so the useful contribution is a test or an example on that PR, not a competing PR. The code below targets the API **as proposed in the issue** and has not been compiled against agentkit.

```ts
import { x402ActionProvider } from "@coinbase/agentkit";        // field below is proposed in #1576
import { prokuraCheck } from "../prokura-check";

const provider = x402ActionProvider({
  maxPaymentUsdc: 1,
  beforePayment: async ({ paymentRequired, selectedRequirements }) => {
    const result = await prokuraCheck(mcp, {
      amount: toDecimal(selectedRequirements.maxAmountRequired, 6),     // USDC atomic units -> "0.01"
      currency: "USDC",
      payee: { type: "domain", value: new URL(paymentRequired.resource).hostname }, // see payee mapping note
      purpose: "api_call",
      rail: "x402",
      reference: { resource: paymentRequired.resource },
      agent_name: "my-agentkit-agent",
    });
    if ("error" in result) return { abort: true, reason: `prokura: ${result.error}` };   // no mandate = no payment
    if (result.decision === "deny") return { abort: true, reason: result.reasons.join(",") };
    if (result.decision === "step_up") return { abort: true, reason: "FOUR_EYES_REQUIRED: waiting for a human" };
    // allow: fall through, the x402 client signs and pays
  },
});
```

The x402 field names (`maxAmountRequired`, `resource`) differ between x402 versions, so check the version you build against. `toDecimal` is left to you; it must produce exactly two decimals for the `prokura_check` schema (`^\d+\.\d{2}$`). Sub-cent x402 prices therefore need rounding up or a different unit. That's another open question for Prokura.
