# Google AP2: Prokura next to AP2 mandates

AP2 carries an agent's payment intent between the agent and a merchant. Prokura adds the signed mandate that says which agent may spend for whom, and the evidence of every decision made under it. Our intents record the protocol they arrived on, and `ap2` is one of the values (format §2.1).

It fits in two places. The code is pseudo-code, because AP2's object model is still changing.

1. **Before execution.** Whoever executes an AP2 payment (the agent's payment step or a credentials provider) asks `prokura_check` with the amount, payee, purpose and rail from the payment mandate. Only `allow` proceeds. `step_up` waits for the human's passkey approval. `deny` stops with reason codes.

   ```text
   on payment_mandate(pm):
       d = prokura_check(amount=pm.total, currency=pm.currency,
                         payee={type:"domain", value=merchant_domain(pm)},
                         purpose=purpose_code(pm), rail=rail_of(pm))
       if d.decision != "allow": refuse(d.reasons)
       execute(pm); attach(pm, nachweis_id=d.evidenceId)
   ```

2. **After a dispute.** AP2 issues ask for revocation semantics ([#386](https://github.com/google-agentic-commerce/AP2/issues/386)) and a self-contained evidence format for disputes ([#338](https://github.com/google-agentic-commerce/AP2/issues/338)). A Nachweis export holds the credential, the decision, the reasons and the hash chain, and anyone can verify it offline with [`verifier/`](../../verifier). Revocation is a bit in the credential's status list, and the gate answers `MANDATE_REVOKED` from the moment it is set.

Mapping AP2 mandate fields to our purpose codes and payees is design work we want to agree with AP2 implementers.
