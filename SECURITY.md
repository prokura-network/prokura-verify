# Security

## Reporting a vulnerability

Email **hello@prokura.network** with "security" in the subject. Please don't open a public issue for a vulnerability. Prokura's security page is [prokura.network/security](https://prokura.network/security).

That covers this repository (examples, verifiers) and the Prokura service at prokura.network. Please include:

- what you found and where (file, endpoint, tool name),
- steps or a proof of concept,
- the impact as you see it.

## Scope notes

- The public demo at `https://prokura.network/mcp` uses fake money, a fake store and Mollie test mode. Getting a payment past the gate in the demo counts as a finding; the Arena on the homepage invites exactly that.
- The verifiers in `verifier/` check integrity and signatures offline. A Nachweis that verifies while the hash, chain or signature rules in `docs/nachweis-format.md` say it shouldn't is a security bug. Please report it.
- Never send real payment credentials, IBANs of real people, or personal data in a report or an issue.
