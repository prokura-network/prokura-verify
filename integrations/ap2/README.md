# Google AP2: Prokura next to AP2 mandates (SKETCH)

Prokura's own framing ([works-with](https://prokura.network/works-with)): *"AP2 carries an agent payment intent between an agent and a merchant. Prokura adds the signed mandate that says which agent may spend for whom."* Status on the site: **test**.

Two places it fits, written as pseudo-code because AP2's object model is still moving:

1. **Before execution.** Whoever executes an AP2 payment (the agent's payment step or a credentials provider) asks `prokura_check` with the amount, payee, purpose and rail from the payment mandate. Only `allow` proceeds. `step_up` waits for the human's passkey approval. `deny` stops with reason codes.

   ```text
   on payment_mandate(pm):
       d = prokura_check(amount=pm.total, currency=pm.currency,
                         payee={type:"domain", value=merchant_domain(pm)},
                         purpose=purpose_code(pm), rail="ap2")
       if d.decision != "allow": refuse(d.reasons)
       execute(pm); attach(pm, nachweis_id=d.evidenceId)
   ```

2. **After a dispute.** AP2 issues ask for revocation semantics ([#386](https://github.com/google-agentic-commerce/AP2/issues/386)) and a self-contained evidence format for disputes ([#338](https://github.com/google-agentic-commerce/AP2/issues/338)). A Nachweis export holds the credential, the decision, the reasons and the hash chain, and verifies offline with `verifier/`. It is one concrete answer to point at in those threads, together with a working example, not a sales comment.

Not shown: mapping AP2 mandate fields to Prokura's `purpose` codes and payees. That mapping is the real design work and should be agreed with AP2 implementers.
