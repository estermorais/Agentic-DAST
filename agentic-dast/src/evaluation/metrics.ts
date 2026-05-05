/**
 * evaluation/metrics.ts
 * ---------------------------------------------------------------
 * Calcula Precisão, Revocação e F1-Score a partir do resultado
 * da classificação (TP, FP, FN).
 *
 * Definições:
 *   • Precision = TP / (TP + FP)   — fração de findings reais entre os reportados
 *   • Recall    = TP / (TP + FN)   — fração de vulnerabilidades reais detectadas
 *   • F1        = 2·P·R / (P + R)  — média harmônica
 *
 * Convenção: 0 quando o denominador é 0 (em vez de NaN).
 * ---------------------------------------------------------------
 */

import { CanonicalCategory, CANONICAL_CATEGORIES } from './categories';
import { ClassificationResult, GroundTruthEntry } from './classify';

// ===========================================================
// Tipos
// ===========================================================

export interface Metrics {
  truePositives:  number;
  falsePositives: number;
  falseNegatives: number;
  precision:      number;
  recall:         number;
  f1:             number;
}

export interface CategoryMetrics {
  category: CanonicalCategory;
  metrics:  Metrics;
}

export interface ScenarioMetrics {
  overall:        Metrics;
  perCategory:    CategoryMetrics[];
}

// ===========================================================
// Cálculo
// ===========================================================

/** Calcula Precision, Recall, F1 a partir de TP/FP/FN brutos */
export function computeMetrics(tp: number, fp: number, fn: number): Metrics {
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall    = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1        = precision + recall === 0
    ? 0
    : (2 * precision * recall) / (precision + recall);

  return {
    truePositives:  tp,
    falsePositives: fp,
    falseNegatives: fn,
    precision:      round(precision),
    recall:         round(recall),
    f1:             round(f1),
  };
}

/**
 * Calcula métricas agregadas (overall) e por categoria.
 *
 * Per-categoria: filtra TPs e FNs pela categoria, e atribui FPs
 * ao bucket da categoria que o agente sugeriu (mesmo errada,
 * conta lá — penaliza a categoria onde o ruído foi gerado).
 */
export function computeScenarioMetrics(
  classification: ClassificationResult,
  groundTruth: GroundTruthEntry[],
): ScenarioMetrics {
  // ── Overall ───────────────────────────────────────────────
  const tpTotal = classification.truePositives.length;
  const fpTotal = classification.falsePositives.length;
  const fnTotal = classification.falseNegatives.length;
  const overall = computeMetrics(tpTotal, fpTotal, fnTotal);

  // ── Por categoria ─────────────────────────────────────────
  const perCategory: CategoryMetrics[] = CANONICAL_CATEGORIES.map((category) => {
    const tp = classification.truePositives.filter(
      (cf) => cf.inferredCategory === category,
    ).length;

    const fp = classification.falsePositives.filter(
      (cf) => cf.inferredCategory === category,
    ).length;

    const fn = classification.falseNegatives.filter(
      (gt) => gt.category === category,
    ).length;

    return {
      category,
      metrics: computeMetrics(tp, fp, fn),
    };
  });

  // Avoid unused import warning (groundTruth is part of the API for symmetry)
  void groundTruth;

  return { overall, perCategory };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
