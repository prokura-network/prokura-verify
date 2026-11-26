# Reason codes

Copied from [prokura.network/reason-codes](https://prokura.network/reason-codes) and [llms.txt](https://prokura.network/llms.txt). The site is the source of truth; if this file and the site disagree, the site wins.

The list is closed (it comes from the core schema). The gate appends **every** failing check, then decides:

- nothing failed → `allow`, reasons `["OK"]`
- the only reason is `FOUR_EYES_REQUIRED` → `step_up` (a human approves with a passkey)
- any other reason present → `deny`

There is no model in this path.

| Code | Meaning |
|---|---|
| `OK` | Every check passed. The decision is allow. |
| `MANDATE_EXPIRED` | The gate's clock is on or after the credential `validUntil`. |
| `MANDATE_REVOKED` | The credential's status-list revocation bit is set. |
| `MANDATE_NOT_YET_VALID` | The gate's clock is before the credential `validFrom`. |
| `AGENT_MISMATCH` | The intent's agent is not the credential subject, or the intent names a different mandate. |
| `SIGNATURE_INVALID` | The intent signature does not verify, `createdAt` is outside the five-minute window, the nonce was already used, or the credential proof did not verify. |
| `PAYEE_NOT_ALLOWED` | An IBAN must match exactly. A domain must be an allowed domain or a subdomain of one. |
| `RAIL_NOT_ALLOWED` | The intent's rail is not in the credential scope. |
| `PURPOSE_NOT_ALLOWED` | The intent's purpose is not in the credential scope. |
| `CAP_PER_TX_EXCEEDED` | The amount is above `capPerTx` for that currency. |
| `CAP_PERIOD_EXCEEDED` | Spend in the current period plus this amount is above `capPeriod`. |
| `FOUR_EYES_REQUIRED` | The amount is above `fourEyesAbove` and no passkey approval is attached. The only step-up reason. Any other reason forces deny. |
| `PO_MISSING` | The credential requires a purchase order and the intent has none. |
| `INVOICE_HASH_MISSING` | The credential requires an invoice hash and the intent has none. |
| `DUPLICATE_INVOICE` | That invoice hash was already seen for this mandate. |
| `VOP_MISMATCH` | Reserved in the closed list. The current gate has no verification-of-payee input and does not emit this code. |
| `MCC_NOT_ALLOWED` | The intent carries an MCC, the credential lists MCCs, and this code is not in the list. |

## Decision rule in code

```ts
function decide(reasons: string[]): "allow" | "step_up" | "deny" {
  const failing = reasons.filter((r) => r !== "OK");
  if (failing.length === 0) return "allow";
  if (failing.every((r) => r === "FOUR_EYES_REQUIRED")) return "step_up";
  return "deny";
}
```

You don't need to run this yourself; the gate returns the decision. It's handy for checking that a decision in a Nachweis matches its reasons.
