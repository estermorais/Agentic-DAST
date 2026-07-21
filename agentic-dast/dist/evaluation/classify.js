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
/**
 * Normaliza texto para matching diacritic-insensitive: 'administração'
 * casa com 'administracao'. Sem isso, findings escritos em portugues
 * com acentos falham em bater com keywords escritas sem acento no GT
 * (e vice-versa), o que gerou FNs falsos no AbuseAdminRoute.
 */
function normalize(s) {
    return s
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '');
}
// ===========================================================
// Função principal
// ===========================================================
function classify(findings, groundTruth) {
    const matchedGtIds = new Set();
    const truePositives = [];
    const falsePositives = [];
    const configurationalFindings = [];
    for (const finding of findings) {
        // 1. Segrega alertas de configuracao (headers, CORS, timestamps,
        //    versao de lib JS, etc.). Nao concorrem a TP/FP no calculo das
        //    metricas funcionais — sao reportados em bucket separado.
        if ((0, categories_1.isConfigurationalAlert)(finding)) {
            configurationalFindings.push(finding);
            continue;
        }
        const inferredCategory = (0, categories_1.inferCategory)(finding.category, finding.title);
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
            if (matchedGtIds.has(gt.id))
                return false;
            if (gt.category !== inferredCategory)
                return false;
            const kwMatch = gt.detectionKeywords.some((kw) => text.includes(normalize(kw)));
            if (!kwMatch)
                return false;
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
    return {
        truePositives,
        falsePositives,
        falseNegatives,
        matchedGtIds,
        configurationalFindings,
    };
}
//# sourceMappingURL=classify.js.map