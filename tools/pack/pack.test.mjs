import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { addRulepack, loadActiveRulepacks } from "../../packages/rules/loader/rulepack-loader.mjs";
import { validateRulepack } from "../rulepack-validate/rulepack-validate.mjs";
import { run } from "./pack.mjs";

const repositoryRoot = join(import.meta.dirname, "../..");
const examplePath = join(repositoryRoot, "contracts/rulepack/pack/examples/model-cafe.json");
const execFileAsync = promisify(execFile);

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

test("pack add не следует по символической ссылке packId за пределы реестра", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pack-symlink-"));
  const registry = join(directory, "registry");
  const outside = join(directory, "outside");
  const source = join(directory, "pack.json");
  await mkdir(registry);
  await mkdir(outside);
  await symlink(outside, join(registry, "a-fed"));
  await writeFile(source, JSON.stringify(await fixture()), "utf8");
  const result = output();
  try {
    assert.equal(await run(["add", source, "--registry", registry], result.io), 1);
    assert.match(result.stderr.join(""), /символической ссылкой/);
    await assert.rejects(readFile(join(outside, "1.json")), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("параллельные процессы не теряют обновления manifest", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pack-concurrent-"));
  const registry = join(directory, "registry");
  const firstPath = join(directory, "first.json");
  const secondPath = join(directory, "second.json");
  const first = await fixture();
  const second = structuredClone(first);
  second.packId = "b-fed";
  second.title = "Второй модельный пакет";
  for (const requirement of second.requirements) requirement.packId = second.packId;
  await writeFile(firstPath, JSON.stringify(first), "utf8");
  await writeFile(secondPath, JSON.stringify(second), "utf8");
  try {
    await Promise.all(
      [firstPath, secondPath].map((source) =>
        execFileAsync(process.execPath, [join(import.meta.dirname, "pack.mjs"), "add", source, "--registry", registry]),
      ),
    );
    assert.deepEqual(
      (await loadActiveRulepacks(registry)).map((pack) => pack.packId),
      ["a-fed", "b-fed"],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("повтор восстанавливает manifest после сбоя между фиксацией пакета и manifest", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pack-recovery-"));
  const registry = join(directory, "registry");
  const pack = await fixture();
  try {
    await mkdir(join(registry, pack.packId), { recursive: true });
    await writeFile(join(registry, pack.packId, "1.json"), `${JSON.stringify(pack, null, 2)}\n`);
    await mkdir(join(registry, ".pack-add.lock"));
    await writeFile(join(registry, ".pack-add.lock", "owner"), "99999999\n");
    await assert.rejects(readFile(join(registry, "manifest.json")), { code: "ENOENT" });
    const recovered = await addRulepack({ pack, registryDirectory: registry, validate: validateRulepack });
    assert.equal(recovered.status, "recovered");
    assert.deepEqual(
      (await loadActiveRulepacks(registry)).map((item) => item.packId),
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
