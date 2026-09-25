// Модельные данные: самоподписанный тестовый УЦ генерируется на лету, это не сертификат НУЦ.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { loadPinnedCa, normalizeFingerprint } from "./max-client.mjs";

const dir = mkdtempSync(join(tmpdir(), "k05a-"));
after(() => rmSync(dir, { recursive: true, force: true }));

function makeCa() {
  const crt = join(dir, "model-ca.crt");
  execFileSync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:prime256v1",
    "-nodes",
    "-keyout",
    join(dir, "model-ca.key"),
    "-out",
    crt,
    "-days",
    "1",
    "-subj",
    "/CN=Model Test CA",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
  ]);
  const fp = execFileSync("openssl", ["x509", "-in", crt, "-noout", "-fingerprint", "-sha256"], { encoding: "utf8" });
  return { crt, fingerprint: fp.trim().split("=")[1] };
}

test("normalizeFingerprint приравнивает форматы", () => {
  assert.equal(normalizeFingerprint("aa:bb cc"), "AABBCC");
});

test("loadPinnedCa принимает сертификат с верным отпечатком в любом формате", () => {
  const { crt, fingerprint } = makeCa();
  assert.match(loadPinnedCa(crt, fingerprint), /BEGIN CERTIFICATE/);
  assert.match(loadPinnedCa(crt, fingerprint.replaceAll(":", "").toLowerCase()), /BEGIN CERTIFICATE/);
});

test("loadPinnedCa отвергает неверный или пустой отпечаток", () => {
  const { crt } = makeCa();
  assert.throws(() => loadPinnedCa(crt, "00".repeat(32)), /не совпадает/);
  assert.throws(() => loadPinnedCa(crt, ""), /MAX_CA_CERT_SHA256/);
  assert.throws(() => loadPinnedCa("", "00"), /MAX_CA_CERT_PATH/);
});
