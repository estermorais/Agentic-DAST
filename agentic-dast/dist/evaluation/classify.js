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
        // Procura entradas GT compativeis (multi-match — um finding pode
        // revelar mais de uma vuln simultaneamente, especialmente quando
        // expoe endpoint que combina categorias, como GET /api/Users que
        // e tanto Broken Access Control quanto Sensitive Data Exposure).
        //
        // Regras de match:
        //   a) MESMA categoria canonica → sempre aceito
        //      OU CROSS-category se casou keyword muito especifica → aceito
        //   b) pelo menos uma keyword do GT no texto
        //   c) endpointHint: obrigatorio SE nenhuma das keywords for
        //      "especifica" (>= 12 chars).
        //
        // Threshold de 12 chars ('zero estrela', 'user enumeration',
        // 'listagem de usuarios') e restritivo o bastante para evitar
        // false positives de keywords curtas/ambiguas ('admin', 'ftp',
        // 'xss', 'jwt', 'sqli' etc.).
        //
        // Motivacao empirica:
        //   - GT-BLV-02 (Zero Stars): AbuseZeroStarReview detectava, mas
        //     evidence (JSON response) nao mencionava 'feedbacks' — hint
        //     rigido rejeitava.
        //   - GT-SDE-03 (Exposed User List): AbuseAdminRoute e varios
        //     findings ReAct expunham /api/Users com listagem completa,
        //     mas ficavam classificados como Broken Access Control, nao
        //     como Sensitive Data Exposure — categoria rigida rejeitava.
        const SPECIFIC_KEYWORD_MIN_LENGTH = 12;
        const candidates = groundTruth.filter((gt) => {
            if (matchedGtIds.has(gt.id))
                return false;
            const matchedKeywords = gt.detectionKeywords.filter((kw) => text.includes(normalize(kw)));
            if (matchedKeywords.length === 0)
                return false;
            const hasSpecificMatch = matchedKeywords.some((kw) => kw.length >= SPECIFIC_KEYWORD_MIN_LENGTH);
            // Regra de categoria: mesmo canonico OU cross-category se
            // keyword especifica bateu.
            if (gt.category !== inferredCategory && !hasSpecificMatch) {
                return false;
            }
            // Regra de hint: obrigatorio se nenhuma keyword especifica bateu.
            if (gt.endpointHint && !hasSpecificMatch && !text.includes(normalize(gt.endpointHint))) {
                return false;
            }
            return true;
        });
        if (candidates.length > 0) {
            for (const candidate of candidates) {
                matchedGtIds.add(candidate.id);
                truePositives.push({
                    finding,
                    inferredCategory,
                    matchedGtId: candidate.id,
                });
            }
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