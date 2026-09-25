// Модельные данные: самоподписанный тестовый УЦ генерируется на лету, это не сертификат НУЦ.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createMaxClient, loadPinnedCa, MaxApiError, normalizeFingerprint } from "./max-client.mjs";

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

// Модельный УЦ и выпущенный им сертификат localhost для HTTPS-сервера, имитирующего MAX.
function makeServerCert() {
  const { crt: caCrt } = makeCa();
  const caKey = join(dir, "model-ca.key");
  const key = join(dir, "server.key");
  const csr = join(dir, "server.csr");
  const crt = join(dir, "server.crt");
  const ext = join(dir, "server.ext");
  writeFileSync(ext, "subjectAltName=DNS:localhost,IP:127.0.0.1\n");
  const newKey = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", key];
  execFileSync("openssl", ["req", ...newKey, "-out", csr, "-subj", "/CN=localhost"]);
  const sign = ["-CA", caCrt, "-CAkey", caKey, "-CAcreateserial", "-days", "1", "-extfile", ext];
  execFileSync("openssl", ["x509", "-req", "-in", csr, ...sign, "-out", crt]);
  return { caPem: readFileSync(caCrt, "utf8"), key: readFileSync(key), cert: readFileSync(crt) };
}

async function withServer(handler, run) {
  const { caPem, key, cert } = makeServerCert();
  const server = createServer({ key, cert }, handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `https://127.0.0.1:${server.address().port}`;
  try {
    await run({ baseUrl, caPem });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

test("запрос проходит с проверкой сертификата, токен уходит только в заголовке", async () => {
  let seen;
  await withServer(
    (req, res) => {
      seen = { url: req.url, auth: req.headers.authorization };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ user_id: 1, username: "t214_hakaton_max_bot", is_bot: true }));
    },
    async ({ baseUrl, caPem }) => {
      const client = createMaxClient({ token: "model-token", baseUrl, caPem });
      try {
        assert.equal((await client.getMe()).username, "t214_hakaton_max_bot");
      } finally {
        client.close();
      }
    },
  );
  assert.deepEqual(seen, { url: "/me", auth: "model-token" });
});

test("чужой УЦ не принимается: проверка TLS не отключена", async () => {
  const { crt } = makeCa();
  const otherCa = readFileSync(crt, "utf8");
  await withServer(
    (_req, res) => res.end("{}"),
    async ({ baseUrl }) => {
      const client = createMaxClient({ token: "model-token", baseUrl, caPem: otherCa });
      try {
        await assert.rejects(client.getMe(), /certificate/i);
      } finally {
        client.close();
      }
    },
  );
});

test("ошибка API возвращается как MaxApiError, оборванный ответ не зависает", async () => {
  await withServer(
    (req, res) => {
      if (req.url === "/me") {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ code: "verify.token" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": "100" });
      res.write('{"updates":[');
      setTimeout(() => res.destroy(), 20);
    },
    async ({ baseUrl, caPem }) => {
      const client = createMaxClient({ token: "model-token", baseUrl, caPem, timeoutMs: 2000 });
      try {
        await assert.rejects(client.getMe(), (error) => error instanceof MaxApiError && error.status === 401);
        await assert.rejects(client.getUpdates({ timeout: 1 }), /оборван|aborted|socket hang up|ECONNRESET/i);
      } finally {
        client.close();
      }
    },
  );
});
