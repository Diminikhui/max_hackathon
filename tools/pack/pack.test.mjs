import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadActiveRulepacks } from "../../packages/rules/loader/rulepack-loader.mjs";
import { run } from "./pack.mjs";

const repositoryRoot = join(import.meta.dirname, "../..");
const examplePath = join(repositoryRoot, "contracts/rulepack/pack/examples/model-cafe.json");

const fixture = async () => JSON.parse(await readFile(examplePath, "utf8"));
const output = () => {
  const stdout = [];
  const stderr = [];
  return {
    stdout,
    stderr,
    io: { stdout: { write: (value) => stdout.push(value) }, stderr: { write: (value) => stderr.push(value) } },
  };
};

test("pack add устанавливает пакет, повтор идентичен и загрузчик обнаруживает его", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pack-add-"));
  const source = join(directory, "direction-or-region.json");
  const registry = join(directory, "registry");
  await writeFile(source, JSON.stringify(await fixture()), "utf8");
  try {
    assert.equal(await run(["add", source, "--registry", registry], output().io), 0);
    const second = output();
    assert.equal(await run(["add", source, "--registry", registry], second.io), 0);
    assert.match(second.stdout.join(""), /уже установлен/);
    assert.deepEqual(
      (await loadActiveRulepacks(registry)).map((pack) => pack.packId),
      ["a-fed"],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("невалидный пакет отклоняется атомарно с понятной ошибкой", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pack-invalid-"));
  const source = join(directory, "invalid.json");
  const registry = join(directory, "registry");
  const pack = await fixture();
  delete pack.title;
  await writeFile(source, JSON.stringify(pack), "utf8");
  const result = output();
  try {
    assert.equal(await run(["add", source, "--registry", registry], result.io), 1);
    assert.match(result.stderr.join(""), /невалиден/);
    await assert.rejects(readFile(join(registry, "manifest.json")), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("конфликт содержимого версии и откат версии отклоняются", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pack-version-"));
  const registry = join(directory, "registry");
  const source = join(directory, "pack.json");
  const pack = await fixture();
  try {
    await writeFile(source, JSON.stringify(pack), "utf8");
    assert.equal(await run(["add", source, "--registry", registry], output().io), 0);

    pack.title = "Другое содержимое той же версии";
    await writeFile(source, JSON.stringify(pack), "utf8");
    const conflict = output();
    assert.equal(await run(["add", source, "--registry", registry], conflict.io), 1);
    assert.match(conflict.stderr.join(""), /уже установлен с другим содержимым/);

    pack.packVersion = 2;
    for (const requirement of pack.requirements) requirement.packVersion = 2;
    await writeFile(source, JSON.stringify(pack), "utf8");
    assert.equal(await run(["add", source, "--registry", registry], output().io), 0);

    pack.packVersion = 1;
    for (const requirement of pack.requirements) requirement.packVersion = 1;
    await writeFile(source, JSON.stringify(pack), "utf8");
    const rollback = output();
    assert.equal(await run(["add", source, "--registry", registry], rollback.io), 1);
    assert.match(rollback.stderr.join(""), /старее активной версии/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
