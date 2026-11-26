/**
 * Offline verifier for Prokura Nachweis (evidence) files and signed daily roots.
 *
 *   SPEC     = stated in https://prokura.network/llms.txt ("Verify a Nachweis")
 *   OBSERVED = not written in llms.txt; matches the verifier on the
 *              prokura.network homepage and real demo files, but may change.
 *
 * See docs/nachweis-format.md for every rule and its source.
 */
import { createHash, createPublicKey, verify as edVerify } from "node:crypto";
import canonicalizeLib from "canonicalize";

// canonicalize ships CJS + ESM typings that differ between versions; normalise.
const jcs = canonicalizeLib as unknown as (v: unknown) => string | undefined;

export const GENESIS = "0".repeat(64);

/** OBSERVED: the "remaining stored fields" (llms.txt does not enumerate them). */
export const RECORD_FIELDS = [
  "id", "kind", "refId", "mandateId", "agentId", "principalId", "intentHash",
  "stepUp", "gateState", "rail", "railStatus", "amount", "currency", "payee",
] as const;

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type NachweisRecord = { [k: string]: Json | undefined };

export function canonicalize(value: unknown): string {
  const s = jcs(value);
  if (s === undefined) throw new Error("value cannot be canonicalized");
  return s;
}

const sha256Hex = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

/** SPEC: SHA-256 over RFC 8785 [prevHash, intent, decision, reasons, railRef, createdAt, rest]. */
export function recordHash(r: NachweisRecord): string {
  const rest: Record<string, unknown> = {};
  for (const k of RECORD_FIELDS) rest[k] = r[k]; // undefined keys are dropped by JCS, like the site
  if (r.v === 2) {
    rest.v = 2;
    rest.mandateSeq = r.mandateSeq ?? null;
    rest.mandatePrevHash = r.mandatePrevHash ?? null;
    rest.agentName = r.agentName ?? null;
  }
  return sha256Hex(canonicalize([r.prevHash, r.intent, r.decision, r.reasons, r.railRef, r.createdAt, rest]));
}

/** OBSERVED: "sha256:" + hex SHA-256 of the canonical intent (signature included). */
export const intentHash = (intent: unknown) => "sha256:" + sha256Hex(canonicalize(intent));

/** SPEC: Merkle leaf = SHA-256(0x00 || leaf). Which bytes form a leaf is not specified. */
export const merkleLeaf = (leaf: Uint8Array) => createHash("sha256").update(Buffer.from([0])).update(leaf).digest();
/** SPEC: Merkle node = SHA-256(0x01 || left || right). */
export const merkleNode = (l: Uint8Array, r: Uint8Array) =>
  createHash("sha256").update(Buffer.from([1])).update(l).update(r).digest();

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58decode(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error("invalid base58 character");
    n = n * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
  let zeros = 0;
  while (s[zeros] === "1") zeros++;
  return Uint8Array.from([...new Array(zeros).fill(0), ...bytes]);
}

/** did:key:z6Mk... -> 32-byte Ed25519 public key (multicodec 0xed01). */
export function didKeyToEd25519(did: string): Uint8Array {
  const m = /^did:key:z([1-9A-HJ-NP-Za-km-z]+)(?:#.*)?$/.exec(did);
  if (!m) throw new Error("not a base58btc did:key");
  const raw = b58decode(m[1]);
  if (raw.length !== 34 || raw[0] !== 0xed || raw[1] !== 0x01) throw new Error("not an Ed25519 did:key");
  return raw.slice(2);
}

function ed25519Ok(pub: Uint8Array, sigB64url: unknown, msg: Uint8Array): boolean {
  if (typeof sigB64url !== "string" || !sigB64url) return false;
  try {
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(pub).toString("base64url") }, format: "jwk" });
    return edVerify(null, msg, key, Buffer.from(sigB64url.trim(), "base64url"));
  } catch {
    return false;
  }
}

function resolveKey(docKey: unknown, pinned: string | undefined, warnings: string[]): Uint8Array | null {
  if (pinned) {
    if (typeof docKey === "string" && docKey.split("#")[0] !== pinned.split("#")[0])
      warnings.push(`file names server ${docKey}, but the pinned key is ${pinned}; using the pinned key`);
    return didKeyToEd25519(pinned);
  }
  if (typeof docKey === "string") {
    warnings.push(
      "server key taken from the file itself (self-asserted). Pin it with --server-key, e.g. the 'server' value of a signed daily root from GET https://api.prokura.network/v1/roots/{date}",
    );
    return didKeyToEd25519(docKey);
  }
  return null;
}

export interface RecordResult { id: unknown; kind: unknown; decision: unknown; [check: string]: unknown }
export interface Report { ok: boolean; records: RecordResult[]; exportProof?: string; warnings: string[] }

const isFail = (v: unknown) => typeof v === "string" && v.startsWith("FAIL");

export function verifyNachweis(input: unknown, opts: { serverKey?: string } = {}): Report {
  const warnings: string[] = [];
  const doc = (Array.isArray(input) ? {} : (input ?? {})) as Record<string, any>;
  const records = (Array.isArray(input) ? input : doc.records) as NachweisRecord[] | undefined;
  if (!Array.isArray(records) || records.length === 0) throw new Error("no records found");
  if (doc.format !== undefined && doc.format !== "nachweis/v1") warnings.push(`unknown format ${JSON.stringify(doc.format)}`);

  const pub = resolveKey(doc.server, opts.serverKey, warnings);
  if (!pub) warnings.push("no server key: record signatures not checked");
  const subjectId: string | undefined = doc.credential?.credentialSubject?.id;

  const results: RecordResult[] = [];
  let failures = 0;
  let prev: string | undefined;
  const lastByMandate = new Map<unknown, NachweisRecord>();

  records.forEach((r, i) => {
    const res: RecordResult = { id: r.id, kind: r.kind, decision: r.decision };
    try { res.hash = recordHash(r) === r.hash ? "OK" : "FAIL"; } catch (e) { res.hash = `FAIL (${(e as Error).message})`; }

    if (i === 0) res.link = r.prevHash === GENESIS ? "OK (genesis)" : "EXTERNAL (chain starts before this file)";
    else res.link = r.prevHash === prev ? "OK" : "FAIL";
    prev = r.hash as string;

    if (r.v === 2) {
      const last = lastByMandate.get(r.mandateId);
      if (last) {
        res.mandateLink = r.mandatePrevHash === last.hash && r.mandateSeq === ((last.mandateSeq as number) ?? 0) + 1 ? "OK" : "FAIL";
      } else if (r.mandateSeq === 1) {
        res.mandateLink = r.mandatePrevHash === GENESIS ? "OK (genesis)" : "FAIL";
      } else {
        res.mandateLink = "EXTERNAL (earlier records of this mandate are not in this file)";
      }
      lastByMandate.set(r.mandateId, r);
    }

    if (pub) {
      const h = typeof r.hash === "string" && /^[0-9a-f]{64}$/.test(r.hash) ? Buffer.from(r.hash, "hex") : null;
      res.signature = h && ed25519Ok(pub, r.signature, h) ? "OK" : "FAIL";
    }

    const intent = r.intent as Record<string, any> | undefined;
    if (intent && typeof intent === "object" && "intentHash" in r) res.intentHash = intentHash(intent) === r.intentHash ? "OK" : "FAIL";
    if (intent && typeof intent === "object" && intent.agentSignature && intent.agentId) {
      const { agentSignature, ...unsigned } = intent;
      try {
        res.agentSignature = ed25519Ok(didKeyToEd25519(intent.agentId), agentSignature, Buffer.from(canonicalize(unsigned))) ? "OK" : "FAIL";
      } catch {
        res.agentSignature = "UNSUPPORTED (agentId is not an Ed25519 did:key)";
      }
      if (subjectId) res.agentIsCredentialSubject = intent.agentId === subjectId ? "OK" : "FAIL";
    }

    if (Object.entries(res).some(([k, v]) => !["id", "kind", "decision"].includes(k) && isFail(v))) failures++;
    results.push(res);
  });

  const report: Report = { ok: false, records: results, warnings };
  if (doc.proof && typeof doc.proof === "object" && pub) {
    const { proof, ...body } = doc;
    const ok = ed25519Ok(pub, proof.signature, Buffer.from(canonicalize(body)));
    if (proof.verificationMethod && typeof doc.server === "string" && proof.verificationMethod.split("#")[0] !== doc.server.split("#")[0])
      warnings.push("proof.verificationMethod differs from server");
    report.exportProof = ok ? "OK" : "FAIL";
    if (!ok) failures++;
  }
  report.ok = failures === 0;
  return report;
}

/** OBSERVED: daily root signature = Ed25519 over canonical JSON of the root without "signature". */
export function verifyRoot(doc: Record<string, any>, opts: { serverKey?: string } = {}) {
  const warnings: string[] = [];
  const pub = resolveKey(doc.server, opts.serverKey, warnings);
  if (!pub) throw new Error("no server key");
  const { signature, ...body } = doc;
  const ok = ed25519Ok(pub, signature, Buffer.from(canonicalize(body)));
  return { date: doc.date, root: doc.root, treeSize: doc.treeSize, signature: ok ? "OK" : "FAIL", warnings, ok };
}
