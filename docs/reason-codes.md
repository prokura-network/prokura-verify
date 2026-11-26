# Reason codes

Every decision of the Prokura gate comes with reason codes from one closed list. The list is part of the Nachweis format: a record with a code outside it does not validate, and we add codes only through a change to this specification.

The gate runs every check below in a fixed order, appends the code of each check that fails (each code at most once), and then decides:

- nothing failed → `allow`, reasons `["OK"]`
- the only failing code is `FOUR_EYES_REQUIRED` → `step_up`: a human approves (or rejects) with a passkey
- any other code → `deny`

There is no model in this path. The gate is a pure function of the credential, the intent and the recorded gate state (`gateState`), so a decision can be re-run from its Nachweis.

| Code | When |
|---|---|
| `OK` | Every check passed. The decision is `allow`. |
| `SIGNATURE_INVALID` | The agent's signature on the intent does not verify, the intent's `createdAt` is more than five minutes from the gate's clock, the agent already used the nonce in a payment (a check does not use up its nonce), or the credential's proof or issuer key did not verify. |
| `AGENT_MISMATCH` | The intent's agent is not the credential subject, or the intent names a different mandate. |
| `MANDATE_NOT_YET_VALID` | The gate's clock is before the credential's `validFrom`. |
| `MANDATE_EXPIRED` | The gate's clock is at or after the credential's `validUntil`. |
| `MANDATE_REVOKED` | The credential's revocation bit is set in its status list. |
| `RAIL_NOT_ALLOWED` | The intent's rail is not in the mandate's `rails`. |
| `PURPOSE_NOT_ALLOWED` | The intent's purpose is not in the mandate's `purposes`. |
| `PAYEE_NOT_ALLOWED` | No mandate payee matches: an IBAN must be the same IBAN; a domain must be an allowed domain or a subdomain of one. |
| `MCC_NOT_ALLOWED` | The intent carries an MCC, the mandate lists MCCs, and this one is not among them. |
| `PO_MISSING` | The mandate requires a purchase order reference and the intent has none. |
| `INVOICE_HASH_MISSING` | The mandate requires an invoice hash and the intent has none. |
| `DUPLICATE_INVOICE` | The same principal already has an allowed payment (or an approved step-up) with this invoice hash. |
| `CAP_PER_TX_EXCEEDED` | The amount is above the mandate's `capPerTx` for that currency. |
| `CAP_PERIOD_EXCEEDED` | The spend in the current period plus this amount is above `capPeriod`. |
| `FOUR_EYES_REQUIRED` | The amount is above `fourEyesAbove` and no passkey approval has been verified for this intent. The only code that leads to `step_up`. A rejected step-up is recorded as `deny` with this code. |
| `VOP_MISMATCH` | Reserved for verification of payee (the payee's name does not match the account). The current gate has no verification-of-payee input and never emits it. |

## Decision rule in code

```ts
function decide(reasons: string[]): "allow" | "step_up" | "deny" {
  const failing = reasons.filter((r) => r !== "OK");
  if (failing.length === 0) return "allow";
  if (failing.every((r) => r === "FOUR_EYES_REQUIRED")) return "step_up";
  return "deny";
}
```

The gate returns the decision itself. This function is useful for checking that the decision in a Nachweis matches its reasons.
