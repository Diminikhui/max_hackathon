// K-31. Оценка качества пакетов правил против эталона K-06a и прогон статусов на модельных компаниях K-28.
// Запуск из корня репозитория после `pnpm build`:  node docs/quality/k31-evaluate.mjs
// YAML эталона читается системным `ruby` (есть в macOS и большинстве Linux): в репозитории нет YAML-парсера.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { assessRequirement } from "../../packages/rules/dist/index.js";

const read = (path) => JSON.parse(readFileSync(path, "utf8"));
const golden = JSON.parse(
  execFileSync(
    "ruby",
    [
      "-rdate",
      "-ryaml",
      "-rjson",
      "-e",
      "puts JSON.generate(YAML.load(File.read(ARGV[0])))",
      "data/rulepacks/_golden/a/checklist.yaml",
    ],
    {
      encoding: "utf8",
    },
  ),
);
// Направление A — федеральный пакет и региональное дополнение Татарстана (K-17d): эталон содержит оба.
const packAFed = read("data/rulepacks/a/foodservice-federal-v1.json");
const packA16 = read("data/rulepacks/a/tatarstan/foodservice-tatarstan-v1.json");
const packA = { requirements: [...packAFed.requirements, ...packA16.requirements] };
const packB = read("data/rulepacks/b/autoservice-federal-v1.json");
const companies = read("data/fixtures/k28-companies.json");

// 1. Содержательное сравнение пакета A с эталоном: все поля, кроме идентификаторов пакета.
const IGNORED = new Set(["packId", "packVersion"]);
const goldenById = new Map(golden.requirements.map((r) => [r.id, r]));
const packById = new Map(packA.requirements.map((r) => [r.id, r]));
const same = [];
const changed = [];
for (const [id, g] of goldenById) {
  const p = packById.get(id);
  if (!p) continue;
  const keys = [...new Set([...Object.keys(g), ...Object.keys(p)])].filter((k) => !IGNORED.has(k));
  const diff = keys.filter((k) => JSON.stringify(g[k]) !== JSON.stringify(p[k]));
  (diff.length ? changed : same).push(diff.length ? `${id}: ${diff.join(", ")}` : id);
}
const report = {
  golden: golden.requirements.length,
  packA: packA.requirements.length,
  packAByPack: { [packAFed.packId]: packAFed.requirements.length, [packA16.packId]: packA16.requirements.length },
  identical: same.length,
  changed,
  onlyGolden: [...goldenById.keys()].filter((id) => !packById.has(id)),
  onlyPack: [...packById.keys()].filter((id) => !goldenById.has(id)),
  coverage: {},
  statuses: {},
  violations: [],
};
for (const [name, reqs] of [
  ["A", packA.requirements],
  ["B", packB.requirements],
  ["golden", golden.requirements],
]) {
  report.coverage[name] = Object.groupBy(reqs, (r) => r.coverage);
  for (const k of Object.keys(report.coverage[name])) report.coverage[name][k] = report.coverage[name][k].length;
}

// 2. Статусы: каждая компания K-28 × пакеты A, B и эталон (как пакет). Фиксированная дата — воспроизводимость.
const evaluatedAt = "2026-09-27T00:00:00Z";
const okvedPrefix = (c) => c.facts.find((f) => f.key === "activity.okved_main")?.value ?? "";
for (const company of companies) {
  const row = {};
  for (const [name, reqs] of [
    ["A", packA.requirements],
    ["B", packB.requirements],
    ["golden", golden.requirements],
  ]) {
    const counts = {};
    for (const r of reqs) {
      const { status } = assessRequirement(r, company, { evaluatedAt });
      counts[status] = (counts[status] ?? 0) + 1;
      // Инварианты качества: чужое направление — только not_applies; своё — никогда not_applies у безусловных
      // записей; partial — не выше needs_review (не уверенное applies).
      const prefix = r.id.startsWith("b.") ? "45.2" : "56";
      const own = okvedPrefix(company).startsWith(prefix);
      if (!own && status !== "not_applies" && status !== "out_of_coverage") {
        report.violations.push(`${company.companyId} × ${r.id}: ${status} для чужого направления`);
      }
      if (own && r.coverage === "partial" && status === "applies") {
        report.violations.push(`${company.companyId} × ${r.id}: applies при coverage partial`);
      }
      if (own && r.condition?.type === "okved_prefix" && status === "not_applies") {
        report.violations.push(`${company.companyId} × ${r.id}: not_applies при совпадающем ОКВЭД`);
      }
    }
    row[name] = counts;
  }
  report.statuses[company.companyId] = row;
}
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.violations.length ? 1 : 0;
