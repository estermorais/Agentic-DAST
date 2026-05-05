/**
 * evaluation/classify.ts
 * ---------------------------------------------------------------
 * Classifica os findings de um relatório de cenário em
 * Verdadeiros Positivos (TP), Falsos Positivos (FP) e Falsos
 * Negativos (FN), comparando com a matriz Ground Truth.
 *
 * Regra de matching:
 *   Um finding casa com uma entrada GT se:
 *     1. Sua categoria canônica == categoria da entrada GT
 *     2. Pelo menos uma palavra-chave do GT aparece no título
 *        ou descrição do finding (case-insensitive)
 *
 *   Cada entrada GT pode ser casada por no máximo um finding
 *   (greedy matching pela ordem dos findings no relatório).
 *
 *   Findings que não casam com nenhuma entrada GT → FP.
 *   Entradas GT que ninguém casou → FN.
 * ---------------------------------------------------------------
 */

import { Finding } from '../executor/ActionDispatcher';
import { CanonicalCategory, inferCategory } from './categories';

// ===========================================================
// Tipos
// ===========================================================

export interface GroundTruthEntry {
  id: string;
  category: CanonicalCategory;
  challengeName: string;
  description: string;
  endpoint: string;
  detectionKeywords: string[];
  expectedSeverity: string;
}

export interface ClassifiedFinding {
  finding:        Finding;
  inferredCategory: CanonicalCategory;
  matchedGtId:    string | null;   // null se for FP
}

export interface ClassificationResult {
  truePositives:    ClassifiedFinding[];   // findings que casaram com GT
  falsePositives:   ClassifiedFinding[];   // findings sem correspondência
  falseNegatives:   GroundTruthEntry[];    // entradas GT não detectadas
  matchedGtIds:     Set<string>;
}

// ===========================================================
// Função principal
// ===========================================================

export function classify(
  findings: Finding[],
  groundTruth: GroundTruthEntry[],
): ClassificationResult {
  const matchedGtIds = new Set<string>();
  const truePositives:  ClassifiedFinding[] = [];
  const falsePositives: ClassifiedFinding[] = [];

  for (const finding of findings) {
    const inferredCategory = inferCategory(finding.category, finding.title);
    const text = `${finding.title} ${finding.description}`.toLowerCase();

    // Procura uma entrada GT compatível e ainda não casada
    const candidate = groundTruth.find((gt) => {
      if (matchedGtIds.has(gt.id)) return false;
      if (gt.category !== inferredCategory) return false;
      return gt.detectionKeywords.some((kw) => text.includes(kw.toLowerCase()));
    });

    if (candidate) {
      matchedGtIds.add(candidate.id);
      truePositives.push({
        finding,
        inferredCategory,
        matchedGtId: candidate.id,
      });
    } else {
      falsePositives.push({
        finding,
        inferredCategory,
        matchedGtId: null,
      });
    }
  }

  // Falsos Negativos: entradas GT que nenhum finding cobriu
  const falseNegatives = groundTruth.filter((gt) => !matchedGtIds.has(gt.id));

  return { truePositives, falsePositives, falseNegatives, matchedGtIds };
}
