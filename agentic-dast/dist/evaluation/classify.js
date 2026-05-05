"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.classify = classify;
const categories_1 = require("./categories");
// ===========================================================
// Função principal
// ===========================================================
function classify(findings, groundTruth) {
    const matchedGtIds = new Set();
    const truePositives = [];
    const falsePositives = [];
    for (const finding of findings) {
        const inferredCategory = (0, categories_1.inferCategory)(finding.category, finding.title);
        const text = `${finding.title} ${finding.description}`.toLowerCase();
        // Procura uma entrada GT compatível e ainda não casada
        const candidate = groundTruth.find((gt) => {
            if (matchedGtIds.has(gt.id))
                return false;
            if (gt.category !== inferredCategory)
                return false;
            return gt.detectionKeywords.some((kw) => text.includes(kw.toLowerCase()));
        });
        if (candidate) {
            matchedGtIds.add(candidate.id);
            truePositives.push({
                finding,
                inferredCategory,
                matchedGtId: candidate.id,
            });
        }
        else {
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
//# sourceMappingURL=classify.js.map