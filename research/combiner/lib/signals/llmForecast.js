/**
 * Reads llm-forecast's existing log directly — this NEVER triggers a new
 * Claude API call. The combiner is meant to be free to run as often as
 * you like; silently spending money because someone ran a report would
 * be a bad surprise. If there's no fresh logged prediction, this signal
 * is just unavailable until you next run predict.js/predict-batch.js.
 */
import { readAll } from "../../../llm-forecast/lib/logStore.js";

export function getLlmForecastSignal(symbol) {
  const entries = readAll();
  const now = Date.now();

  const active = entries
    .filter((e) => e.symbol === symbol && e.targetAt > now)
    .sort((a, b) => b.createdAt - a.createdAt)[0];

  // Accuracy across ALL symbols (a per-symbol sample would be too small to mean anything for a long time) — used only for weighting, never as the prediction itself.
  const resolved = entries.filter((e) => e.resolved && e.actual && e.actual.correct !== null);
  const accuracy = resolved.length ? resolved.filter((e) => e.actual.correct).length / resolved.length : null;
  const resolvedCount = resolved.length;

  if (!active) {
    return { name: "llm-forecast", available: false, error: "no current unexpired prediction logged for this symbol — run predict.js/predict-batch.js first", accuracy, resolvedCount };
  }
  if (active.prediction.direction === "flat") {
    return { name: "llm-forecast", available: false, error: "latest logged prediction was 'flat' (abstained)", accuracy, resolvedCount };
  }

  return {
    name: "llm-forecast",
    available: true,
    direction: active.prediction.direction,
    conviction: active.prediction.confidence,
    detail: active.prediction.rationale,
    accuracy,
    resolvedCount,
    predictionAgeMs: now - active.createdAt,
  };
}
