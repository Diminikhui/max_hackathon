// Явная живая проверка K-19b. Запускается вручную только с реальным ключом в окружении;
// отправляет модельный документ и не печатает ключ, токен, промпт или ответ модели.
import { classifyDocument } from "../core/index.js";
import { REGULATORY_IMPACT_PROFILE } from "../prompts/index.js";
import { gigachatProviderFromEnv } from "./provider.js";

const result = await classifyDocument(
  {
    id: "k19b-model-smoke",
    title: "Модельный проект требований для проверки интеграции",
    text: "Модельные данные: для предприятий общественного питания вводится требование с 1 марта 2027 года.",
    sourceUrl: "https://example.invalid/k19b-model-smoke",
    isModel: true,
  },
  gigachatProviderFromEnv(),
  REGULATORY_IMPACT_PROFILE,
);

if (result.usedFallback || result.provider !== "gigachat") {
  throw new Error("GigaChat smoke не прошёл: классификатор использовал template fallback");
}

console.log("GigaChat smoke OK: structured response прошёл локальную JSON Schema");
