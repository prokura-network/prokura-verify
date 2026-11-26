#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { verifyAny } from "./index.js";

const USAGE = "usage: prokura-verify FILE [--server-key did:key:z6Mk...[,did:key:...]] [--record-hash HEX] [--json]";
const args = process.argv.slice(2);
const json = args.includes("--json");
const VALUED = ["--server-key", "--record-hash"];
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const keyArg = opt("--server-key");
// Several keys (the published key ring after a rotation) are comma-separated.
const serverKey = keyArg ? keyArg.split(",").map((k) => k.trim()).filter(Boolean) : undefined;
const recordHash = opt("--record-hash");
const file = args.find((a, i) => !a.startsWith("--") && !VALUED.includes(args[i - 1]));
if (!file) {
  console.error(USAGE);
  process.exit(2);
}

let report: any;
try {
  report = verifyAny(JSON.parse(readFileSync(file, "utf8")), { serverKey, recordHash });
} catch (e) {
  console.error(`error: ${(e as Error).message}`);
  process.exit(2);
}

if (json) console.log(JSON.stringify(report, null, 2));
else {
  for (const w of report.warnings ?? []) console.log(`warning: ${w}`);
  if (report.kind === "nachweis") {
    for (const r of report.records) {
      const checks = Object.entries(r).filter(([k]) => !["id", "kind", "decision"].includes(k)).map(([k, v]) => `${k}=${String(v).split(" ")[0]}`).join(" ");
      console.log(`${r.id}  ${String(r.kind).padEnd(9)} ${String(r.decision).padEnd(8)} ${checks}`);
    }
    if (report.serverKey) console.log(`server key: ${report.serverKey}`);
    if (report.serverKeys) console.log(`server keys: ${report.serverKeys}`);
    if (report.exportProof) console.log(`export proof: ${report.exportProof}`);
  } else if (report.kind === "proof") {
    console.log(`proof ${report.format} record=${report.recordId} leaf=${report.leafIndex}/${report.treeSize} signature=${report.signature} inclusion=${report.inclusion}${report.record ? ` record=${report.record}` : ""}`);
  } else console.log(`${report.format ?? "root"} ${report.id ?? report.date} treeSize=${report.treeSize} signature=${report.signature}`);
  console.log(report.ok ? "VERIFIED" : "NOT VERIFIED");
}
process.exit(report.ok ? 0 : 1);
