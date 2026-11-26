import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { canonicalize, recordHash, verifyNachweis, verifyRoot, merkleLeaf, merkleNode } from "../src/index.js";

const fx = (f: string) => JSON.parse(readFileSync(new URL(`../../../fixtures/${f}`, import.meta.url), "utf8"));
// Prokura's evidence server key, as published in the signed daily roots (GET https://api.prokura.network/v1/roots/{date}).
const SERVER = "did:key:z6MksY9Gi8N1cbigCxWyR53eLdiTUUTaxq2A1c6mZe5Lea4L";
const REAL = ["nachweis-demo-allow.json", "nachweis-demo-step-up.json", "nachweis-demo-deny.json"];

for (const f of REAL) {
  test(`real demo Nachweis verifies: ${f}`, () => {
    const r = verifyNachweis(fx(f), { serverKey: SERVER });
    assert.equal(r.ok, true, JSON.stringify(r, null, 2));
    assert.equal(r.exportProof, "OK");
    for (const rec of r.records) {
      assert.equal(rec.hash, "OK");
      assert.equal(rec.signature, "OK");
      assert.match(String(rec.mandateLink), /^OK/);
    }
  });
}

test("signed daily root verifies with the pinned key", () => {
  assert.equal(verifyRoot(fx("root-2026-11-25.json"), { serverKey: SERVER }).ok, true);
});

test("tampered amount breaks the hash", () => {
  const d = fx("nachweis-demo-allow.json");
  d.records[1].amount = "1200.00";
  const r = verifyNachweis(d, { serverKey: SERVER });
  assert.equal(r.ok, false);
  assert.equal(r.records[1].hash, "FAIL");
});

test("tampered decision breaks the hash", () => {
  const d = fx("nachweis-demo-deny.json");
  d.records[6].decision = "allow";
  d.records[6].reasons = ["OK"];
  assert.equal(verifyNachweis(d, { serverKey: SERVER }).records[6].hash, "FAIL");
});

test("re-hashed but unsigned record fails the signature", () => {
  const d = fx("nachweis-demo-allow.json");
  d.records[1].amount = "99.00";
  d.records[1].hash = recordHash(d.records[1]);
  const r = verifyNachweis(d, { serverKey: SERVER });
  assert.equal(r.records[1].hash, "OK");
  assert.equal(r.records[1].signature, "FAIL");
  assert.equal(r.ok, false);
});

test("removed record breaks the chain", () => {
  const d = fx("nachweis-demo-allow.json");
  d.records.splice(2, 1);
  const r = verifyNachweis(d, { serverKey: SERVER });
  assert.equal(r.records[2].link, "FAIL");
  assert.equal(r.ok, false);
});

test("wrong pinned key fails signatures", () => {
  const r = verifyNachweis(fx("nachweis-demo-allow.json"), { serverKey: fx("synthetic-chain.json").server });
  assert.equal(r.ok, false);
  assert.equal(r.records[0].signature, "FAIL");
});

test("tampered export body fails the export proof", () => {
  const d = fx("nachweis-demo-allow.json");
  d.subject = "01M8C9B9F958TJ6SCM74T1FGED";
  assert.equal(verifyNachweis(d, { serverKey: SERVER }).exportProof, "FAIL");
});

test("tampered root fails", () => {
  const d = fx("root-2026-11-25.json");
  d.treeSize = 1;
  assert.equal(verifyRoot(d, { serverKey: SERVER }).ok, false);
});

test("synthetic chain (v1 + v2 from genesis) verifies", () => {
  const d = fx("synthetic-chain.json");
  const r = verifyNachweis(d, { serverKey: d.server });
  assert.equal(r.ok, true, JSON.stringify(r, null, 2));
  assert.equal(r.records[0].link, "OK (genesis)");
  assert.equal(r.records[1].mandateLink, "OK (genesis)");
});

test("RFC 8785 vectors", () => {
  for (const v of fx("jcs-vectors.json")) assert.equal(canonicalize(v.input), v.canonical);
});

test("Merkle prefixes", () => {
  const a = merkleLeaf(Buffer.from("a"));
  assert.equal(a.length, 32);
  assert.notDeepEqual(merkleNode(a, a), merkleLeaf(Buffer.concat([a, a])));
});
