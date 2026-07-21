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
import { CanonicalCategory, inferCategory, isConfigurationalAlert } from './categories';

/**
 * Normaliza texto para matching diacritic-insensitive: 'administração'
 * casa com 'administracao'. Sem isso, findings escritos em portugues
 * com acentos falham em bater com keywords escritas sem acento no GT
 * (e vice-versa), o que gerou FNs falsos no AbuseAdminRoute.
 */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

// ===========================================================
// Tipos
// ===========================================================

export interface GroundTruthEntry {
  id: string;
  category: CanonicalCategory;
  challengeName: string;
  description: string;
  endpoint: string;
  /** Substring que precisa aparecer no texto do finding (title|description|
   *  evidence) para o match ser aceito. Impede over-matching entre
   *  vulns da mesma categoria em endpoints diferentes. Opcional. */
  endpointHint?: string;
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
  /** Alertas informativos de configuracao (headers, CORS, timestamps, JS
   *  lib version, etc.) segregados antes da classificacao. Nao entram
   *  em TP/FP/FN — sao reportados a parte pelo evaluate.ts. */
  configurationalFindings: Finding[];
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
  const configurationalFindings: Finding[] = [];

  for (const finding of findings) {
    // 1. Segrega alertas de configuracao (headers, CORS, timestamps,
    //    versao de lib JS, etc.). Nao concorrem a TP/FP no calculo das
    //    metricas funcionais — sao reportados em bucket separado.
    if (isConfigurationalAlert(finding)) {
      configurationalFindings.push(finding);
      continue;
    }

    const inferredCategory = inferCategory(finding.category, finding.title);
    // Inclui evidence no texto de match: o LLM/AbuseCase frequentemente
    // coloca o endpoint (ex: 'POST /rest/user/login') so na evidence.
    // Normalizado diacritic-insensitive: 'administracao' == 'administração'.
    const text = normalize(`${finding.title} ${finding.description} ${finding.evidence ?? ''}`);

    // Procura uma entrada GT compativel e ainda nao casada.
    // Match precisa satisfazer:
    //   a) mesma categoria canonica
    //   b) pelo menos uma keyword do GT no texto
    //   c) se o GT tem endpointHint, ele tambem precisa aparecer no
    //      texto (evita over-matching entre vulns da mesma categoria
    //      em endpoints diferentes)
    const candidate = groundTruth.find((gt) => {
      if (matchedGtIds.has(gt.id)) return false;
      if (gt.category !== inferredCategory) return false;
      const kwMatch = gt.detectionKeywords.some((kw) => text.includes(normalize(kw)));
      if (!kwMatch) return false;
      if (gt.endpointHint && !text.includes(normalize(gt.endpointHint))) {
        return false;
      }
      return true;
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

  return {
    truePositives,
    falsePositives,
    falseNegatives,
    matchedGtIds,
    configurationalFindings,
  };
}
