"use strict";
/**
 * evaluation/categories.ts
 * ---------------------------------------------------------------
 * Mapeamento entre as várias formas de identificar uma categoria
 * de vulnerabilidade no projeto e as 6 categorias canônicas do
 * Ground Truth.
 *
 * Origens dos códigos brutos:
 *   • Abuse Cases       — códigos próprios (ex: BLV_NEGATIVE_QUANTITY)
 *   • Agente ReAct      — qualquer string definida pelo LLM
 *   • OWASP ZAP         — ZAP_PLUGIN_<id> (sem semântica direta)
 *
 * Para o ZAP, a categoria canônica é inferida a partir do título
 * do alerta (ex: "Cross Site Scripting" → XSS).
 * ---------------------------------------------------------------
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.CANONICAL_CATEGORIES = void 0;
exports.inferCategory = inferCategory;
exports.isConfigurationalAlert = isConfigurationalAlert;
/** Mapa direto de códigos conhecidos → categoria canônica */
const CODE_TO_CANONICAL = {
    // ── Abuse Cases ──────────────────────────────────────────────
    BLV_NEGATIVE_QUANTITY: 'BUSINESS_LOGIC',
    BLV_INPUT_VALIDATION_BYPASS: 'BUSINESS_LOGIC',
    BLV_BROKEN_ACCESS_CONTROL: 'BROKEN_ACCESS_CONTROL',
    BLV_IDOR_BASKET: 'BROKEN_ACCESS_CONTROL',
    XSS_STORED: 'XSS',
    JWT_SIGNATURE_BYPASS: 'JWT',
    SENSITIVE_DATA_EXPOSURE: 'SENSITIVE_DATA_EXPOSURE',
    SQLI_AUTH_BYPASS: 'SQL_INJECTION',
    // ── Variantes possíveis de strings que o LLM pode gerar ─────
    'BUSINESS_LOGIC': 'BUSINESS_LOGIC',
    'BROKEN_ACCESS_CONTROL': 'BROKEN_ACCESS_CONTROL',
    'XSS': 'XSS',
    'JWT': 'JWT',
    'SQL_INJECTION': 'SQL_INJECTION',
    'SQLI': 'SQL_INJECTION',
};
/**
 * Palavras-chave que, se presentes no título do finding,
 * indicam fortemente a categoria. Usadas como fallback quando
 * o código de categoria não é reconhecido (típico de findings
 * gerados pelo ZAP e pelo agente ReAct).
 */
const TITLE_KEYWORD_MAP = [
    { keywords: ['xss', 'cross site scripting', 'cross-site scripting'], category: 'XSS' },
    { keywords: ['sql injection', 'sqli', 'sql inject'], category: 'SQL_INJECTION' },
    { keywords: ['jwt', 'json web token', 'alg:none', 'alg none'], category: 'JWT' },
    { keywords: ['idor', 'broken access', 'horizontal privilege',
            'vertical privilege', 'forbidden', 'unauthorized access',
            'admin section', 'admin route', 'admin route access'], category: 'BROKEN_ACCESS_CONTROL' },
    { keywords: ['negative quantity', 'negative order', 'business logic',
            'logic flaw', 'zero star', 'zero stars',
            'rating validation', 'input validation bypass'], category: 'BUSINESS_LOGIC' },
    { keywords: ['ftp', 'backup', 'sensitive data', 'information disclosure',
            'exposed', 'directory listing', 'application-configuration',
            'package.json.bak', '/api/users'], category: 'SENSITIVE_DATA_EXPOSURE' },
];
/**
 * Determina a categoria canônica de um finding.
 *
 * Estratégia:
 *   1. Se o code está no mapa direto, usa-o.
 *   2. Senão, procura keywords no título.
 *   3. Senão, retorna 'OTHER'.
 */
function inferCategory(rawCategory, title) {
    // Tentativa 1: lookup direto
    const direct = CODE_TO_CANONICAL[rawCategory.toUpperCase()];
    if (direct)
        return direct;
    // Tentativa 2: keywords no título
    const lowerTitle = title.toLowerCase();
    for (const { keywords, category } of TITLE_KEYWORD_MAP) {
        if (keywords.some((k) => lowerTitle.includes(k))) {
            return category;
        }
    }
    return 'OTHER';
}
/** Lista das 6 categorias canônicas (sem 'OTHER') */
exports.CANONICAL_CATEGORIES = [
    'BUSINESS_LOGIC',
    'BROKEN_ACCESS_CONTROL',
    'XSS',
    'JWT',
    'SENSITIVE_DATA_EXPOSURE',
    'SQL_INJECTION',
];
// ================================================================
// Segregacao: alertas de CONFIGURACAO vs. findings FUNCIONAIS
// ================================================================
//
// O Ground Truth deste TCC cataloga apenas as 18 vulnerabilidades
// funcionais do OWASP Juice Shop (SQLi, XSS, IDOR, JWT, etc.). O
// scanner ZAP passivo agrega, em paralelo, muitos alertas de
// hardening/misconfig (headers de seguranca ausentes, CORS wildcard,
// timestamps expostos) que sao SINAIS uteis mas nao entradas do GT.
// Contabiliza-los como FP penaliza injustamente cenarios que ativam
// o ZAP passivo (B, C e ate D), inflando o denominador da Precisao
// e distorcendo o comparativo.
//
// A funcao abaixo identifica esses alertas para que evaluate.ts os
// separe em um bucket 'configurational' que entra no relatorio como
// contagem paralela, fora do calculo de TP/FP/FN.
//
// Regra: um finding e configurational se
//   - seu titulo comeca com '[ZAP] ' (marca da conversao ZapClient) E
//   - o plugin/tipo bate com uma das familias tipicamente
//     informativas listadas abaixo.
// Vulns funcionais que o proprio ZAP as vezes flagra (SQL Injection,
// XSS, Path Traversal via scan ativo) NAO caem aqui, e continuam
// concorrendo a TP no Ground Truth normalmente.
const CONFIGURATIONAL_ZAP_KEYWORDS = [
    // headers de seguranca ausentes
    'content security policy', 'csp header',
    'x-content-type-options', 'x-frame-options',
    'strict-transport-security', 'hsts',
    'anti-clickjacking', 'clickjacking',
    'cache-control', 'cache control',
    // CORS
    'cross-domain misconfiguration', 'cross domain misconfiguration',
    // fingerprinting/verbosidade
    'timestamp disclosure',
    'modern web application',
    'user agent fuzzer',
    'vulnerable js library',
    'private ip disclosure',
    'session id in url',
    'application error disclosure',
    'debug error messages',
    'authentication request identified',
    'session management response identified',
];
function isConfigurationalAlert(finding) {
    const t = finding.title.toLowerCase();
    const isZap = t.startsWith('[zap]')
        || (finding.category ?? '').toUpperCase().startsWith('ZAP_PLUGIN_');
    if (!isZap)
        return false;
    return CONFIGURATIONAL_ZAP_KEYWORDS.some((k) => t.includes(k));
}
//# sourceMappingURL=categories.js.map