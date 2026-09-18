"use strict";
/**
 * production-mode/SurfacePrioritizer.ts
 * ---------------------------------------------------------------
 * Prioriza a superfície de ataque de um AppMap por RISCO antes de
 * entregá-la ao ReActAgent.
 *
 * PROBLEMA QUE RESOLVE. O resumo enviado ao LLM em
 * `buildInitialUserMessage` lista apenas os primeiros N endpoints
 * (slice), na ordem em que foram DESCOBERTOS pela Percepção. No
 * Juice Shop isso é irrelevante (dezenas de endpoints, todos vistos).
 * Numa aplicação real (CRM/ERP/SaaS) a Percepção descobre centenas
 * de endpoints; cortar os primeiros N por ordem de descoberta faz o
 * agente NUNCA ver a maior parte da superfície — e o corte é
 * arbitrário, não por relevância de segurança.
 *
 * O QUE FAZ. Reordena `apiEndpoints` por um score de risco
 * heurístico (maior = testar primeiro), de forma que, quando o
 * resumo for truncado, os endpoints que sobrevivem ao corte sejam os
 * de MAIOR probabilidade de conter vulnerabilidade. Não descarta
 * nada: a lista completa continua no AppMap; apenas a ORDEM muda.
 * Ruído estático (bundles .js, imagens, fontes) é empurrado para o
 * fim.
 *
 * ISOLAMENTO DO TCC. Este módulo pertence ao caminho de produção e
 * NÃO é chamado pelo entrypoint oficial (`src/index.ts`). A rodada
 * n=30 do Juice Shop continua recebendo o AppMap na ordem original.
 *
 * A heurística de rota sensível reaproveita os mesmos padrões do
 * RiskClassifier (fonte única), garantindo que "endpoint que o
 * classificador trata como HIGH/CRITICAL" e "endpoint que a
 * priorização sobe" não divirjam ao longo do tempo.
 * ---------------------------------------------------------------
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.scoreEndpoint = scoreEndpoint;
exports.rankEndpoints = rankEndpoints;
exports.prioritizeAppMap = prioritizeAppMap;
const RiskClassifier_1 = require("./RiskClassifier");
/** Métodos que escrevem estado — maior superfície de ataque. */
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const MUTATING_METHODS = new Set(['PUT', 'PATCH', 'DELETE']);
/**
 * Nomes de parâmetro (query ou path) que sugerem SSRF — o agente
 * deve priorizar quem tem controle de destino de requisição.
 */
const SSRF_PARAM_PATTERNS = /[?&/](url|uri|callback|redirect|redirect_uri|webhook|endpoint|domain|host|target|src|href|feed|proxy|fetch|image_url|imageurl)\b/i;
/** Extensões de recurso estático — ruído para pentest de API. */
const STATIC_ASSET_PATTERN = /\.(js|mjs|css|map|png|jpe?g|gif|svg|ico|webp|woff2?|ttf|eot|mp4|webm|pdf)(\?|$)/i;
/** Segmento de path com id numérico (candidato IDOR clássico). */
const NUMERIC_ID_PATTERN = /\/\d+(\/|$|\?)/;
/** Segmento de path com UUID (IDOR sobre identificador não-sequencial). */
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
/** Documentação de API exposta — mapa completo da superfície. */
const API_DOC_PATTERN = /\/(swagger|openapi|api-docs|graphql|graphiql|redoc|altair|actuator|_debug|rails\/info)\b/i;
/** Versão de API antiga/beta — costuma ter menos proteção. */
const OLD_API_VERSION_PATTERN = /\/(api\/)?(v0|v1|beta|internal|legacy|old)\b/i;
/**
 * Pontua um único endpoint. Score maior = testar antes. A escala é
 * relativa (só a ordem importa), não um valor absoluto calibrado.
 */
function scoreEndpoint(ep) {
    const url = ep.url ?? '';
    const method = (ep.method ?? 'GET').toUpperCase();
    const reasons = [];
    let score = 0;
    // Ruído estático desce para o fim, independentemente do resto.
    if (STATIC_ASSET_PATTERN.test(url)) {
        return { endpoint: ep, score: -100, reasons: ['recurso estático'] };
    }
    if (WRITE_METHODS.has(method)) {
        score += 3;
        reasons.push('método de escrita');
    }
    if (MUTATING_METHODS.has(method)) {
        score += 2;
        reasons.push('PUT/PATCH/DELETE (mutação direta)');
    }
    // Endpoint que não exige auth é candidato primário a exposição /
    // broken access control.
    if (ep.authRequired === false) {
        score += 3;
        reasons.push('authRequired=false (exposição)');
    }
    if (NUMERIC_ID_PATTERN.test(url)) {
        score += 3;
        reasons.push('id numérico na URL (IDOR)');
    }
    else if (UUID_PATTERN.test(url)) {
        score += 1;
        reasons.push('UUID na URL (IDOR não-sequencial)');
    }
    if (SSRF_PARAM_PATTERNS.test(url)) {
        score += 3;
        reasons.push('parâmetro de destino (SSRF)');
    }
    if (RiskClassifier_1.CRITICAL_PATH_PATTERNS.some((re) => re.test(url))) {
        score += 3;
        reasons.push('rota sensível CRITICAL (billing/webhook/export/…)');
    }
    else if (RiskClassifier_1.HIGH_PATH_PATTERNS.some((re) => re.test(url))) {
        score += 2;
        reasons.push('rota sensível HIGH (admin/user/config/…)');
    }
    if (API_DOC_PATTERN.test(url)) {
        score += 2;
        reasons.push('documentação/painel de API exposto');
    }
    if (OLD_API_VERSION_PATTERN.test(url)) {
        score += 1;
        reasons.push('versão de API antiga/interna');
    }
    // 500 revela superfície de erro (stack trace, SQL, path).
    if (ep.responseStatus === 500) {
        score += 1;
        reasons.push('respondeu 500 (info disclosure)');
    }
    if (reasons.length === 0) {
        reasons.push('sem sinal de risco específico');
    }
    return { endpoint: ep, score, reasons };
}
/**
 * Ordena os endpoints por score (desc), preservando a ordem original
 * como critério de desempate (ordenação estável). Retorna também os
 * scores, caso o chamador queira logar/inspecionar.
 */
function rankEndpoints(endpoints) {
    return endpoints
        .map((ep, index) => ({ ...scoreEndpoint(ep), index }))
        .sort((a, b) => (b.score - a.score) || (a.index - b.index))
        .map(({ endpoint, score, reasons }) => ({ endpoint, score, reasons }));
}
/**
 * Retorna uma CÓPIA rasa do AppMap com `apiEndpoints` reordenado por
 * risco. O AppMap original não é mutado; nenhum endpoint é removido.
 */
function prioritizeAppMap(appMap) {
    const ranked = rankEndpoints(appMap.apiEndpoints);
    return {
        ...appMap,
        apiEndpoints: ranked.map((r) => r.endpoint),
    };
}
//# sourceMappingURL=SurfacePrioritizer.js.map