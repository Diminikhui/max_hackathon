#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { addRulepack } from "../../packages/rules/loader/rulepack-loader.mjs";
import { validateRulepack } from "../rulepack-validate/rulepack-validate.mjs";

const usage = "Использование: pack add <путь-к-пакету.json> [--registry <каталог>]\n";

const parseArgs = (args) => {
  if (args[0] !== "add" || !args[1]) return undefined;
  let registryDirectory = process.env.RULEPACK_DIRECTORY || "data/rulepacks/installed";
  for (let index = 2; index < args.length; index += 1) {
    if (args[index] !== "--registry" || !args[index + 1] || index + 2 !== args.length) return undefined;
    registryDirectory = args[index + 1];
    index += 1;
  }
  return { source: args[1], registryDirectory };
};

export const run = async (args, io = { stdout: process.stdout, stderr: process.stderr }) => {
  const options = parseArgs(args);
  if (!options) {
    io.stderr.write(usage);
    return 2;
  }

  const source = isAbsolute(options.source) ? options.source : resolve(process.cwd(), options.source);
  const registryDirectory = isAbsolute(options.registryDirectory)
    ? options.registryDirectory
    : resolve(process.cwd(), options.registryDirectory);
  try {
    const pack = JSON.parse(await readFile(source, "utf8"));
    const result = await addRulepack({ pack, registryDirectory, validate: validateRulepack });
    io.stdout.write(
      result.status === "already-installed"
        ? `Пакет ${result.packId} версии ${result.version} уже установлен.\n`
        : `Пакет ${result.packId} версии ${result.version} установлен: ${result.path}\n`,
    );
    return 0;
  } catch (error) {
    io.stderr.write(`${error.message}\n`);
    return 1;
  }
};

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await run(process.argv.slice(2));
