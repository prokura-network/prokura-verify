# Nachweis verifiers

Two independent implementations of the same rules (see [`../docs/nachweis-format.md`](../docs/nachweis-format.md)). Both pass the same fixtures.

| | Install | Run | Test |
|---|---|---|---|
| Python 3.9+ | `cd python && pip install -e .` | `prokura-verify FILE [--server-key did:key:…] [--json]` | `pip install -e '.[test]' && pytest` |
| TypeScript, Node 20+ | `cd typescript && npm install` | `npm run verify -- FILE [--server-key …] [--json]` | `npm test` |

`FILE` is a Nachweis export (`"format": "nachweis/v1"`) or a signed daily root (`"format": "merkle-root/v1"`). Exit codes: `0` verified, `1` not verified, `2` usage or read error.

As a library:

```python
from prokura_verify import verify_nachweis
report = verify_nachweis(doc, server_key="did:key:z6Mk…")   # report["ok"], report["records"]
```

```ts
import { verifyNachweis } from "@prokura/verify";
const report = verifyNachweis(doc, { serverKey: "did:key:z6Mk…" });
```
