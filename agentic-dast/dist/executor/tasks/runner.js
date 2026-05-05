"use strict";
/**
 * executor/tasks/runner.ts
 * ---------------------------------------------------------------
 * Orquestrador dos Abuse Cases predefinidos.
 *
 * Os Abuse Cases são testes estruturados que complementam o loop
 * ReAct. Enquanto o ReAct descobre vulnerabilidades autonomamente
 * com raciocínio livre, os Abuse Cases garantem cobertura mínima
 * dos challenges documentados do Juice Shop em múltiplas categorias.
 *
 * Categorias cobertas:
 *   - Lógica de Negócio (BLV)
 *   - Broken Access Control (IDOR, rotas admin)
 *   - XSS Armazenado
 *   - JWT Attacks
 *   - Sensitive Data Exposure
 *   - SQL Injection
 *
 * Fluxo:
 *   1. Recebe o JWT coletado na fase de Percepção
 *   2. Executa cada task de forma sequencial (para não sobrecarregar)
 *   3. Filtra e retorna apenas os Findings confirmados (não-null)
 * ---------------------------------------------------------------
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.runAbuseCases = runAbuseCases;
const AbuseNegativeQuantity_1 = require("./AbuseNegativeQuantity");
const AbuseZeroStarReview_1 = require("./AbuseZeroStarReview");
const AbuseIDOR_1 = require("./AbuseIDOR");
const AbuseAdminRoute_1 = require("./AbuseAdminRoute");
const AbuseXSS_1 = require("./AbuseXSS");
const AbuseJWT_1 = require("./AbuseJWT");
const AbuseSensitiveDataExposure_1 = require("./AbuseSensitiveDataExposure");
const AbuseSQLInjection_1 = require("./AbuseSQLInjection");
const ABUSE_TASKS = [
    // ── Lógica de Negócio ──────────────────────────────────────
    { name: 'AbuseNegativeQuantity', category: 'Business Logic', fn: AbuseNegativeQuantity_1.abuseNegativeQuantity },
    { name: 'AbuseZeroStarReview', category: 'Business Logic', fn: AbuseZeroStarReview_1.abuseZeroStarReview },
    // ── Broken Access Control ──────────────────────────────────
    { name: 'AbuseIDOR', category: 'Broken Access Control', fn: AbuseIDOR_1.abuseIDOR },
    { name: 'AbuseAdminRoute', category: 'Broken Access Control', fn: AbuseAdminRoute_1.abuseAdminRoute },
    // ── XSS ───────────────────────────────────────────────────
    { name: 'AbuseXSS', category: 'XSS', fn: AbuseXSS_1.abuseXSS },
    // ── JWT Attacks ───────────────────────────────────────────
    { name: 'AbuseJWT', category: 'JWT', fn: AbuseJWT_1.abuseJWT },
    // ── Sensitive Data Exposure ───────────────────────────────
    { name: 'AbuseSensitiveDataExposure', category: 'Sensitive Data', fn: AbuseSensitiveDataExposure_1.abuseSensitiveDataExposure },
    // ── Injection ─────────────────────────────────────────────
    { name: 'AbuseSQLInjection', category: 'Injection', fn: AbuseSQLInjection_1.abuseSQLInjection },
];
/**
 * Executa todos os Abuse Cases e retorna os Findings encontrados.
 *
 * @param jwt      Token JWT do usuário de teste (customer)
 * @param baseUrl  URL base do alvo (ex: http://localhost:3000)
 */
async function runAbuseCases(jwt, baseUrl) {
    console.log(`\n[ ABUSE CASES ] Executando ${ABUSE_TASKS.length} testes predefinidos...\n`);
    // Agrupa por categoria para exibição organizada
    const categories = [...new Set(ABUSE_TASKS.map((t) => t.category))];
    const findings = [];
    for (const category of categories) {
        const tasksInCategory = ABUSE_TASKS.filter((t) => t.category === category);
        console.log(`  ── ${category} (${tasksInCategory.length} teste(s)) ──`);
        for (const task of tasksInCategory) {
            process.stdout.write(`     → ${task.name}... `);
            try {
                const finding = await task.fn(jwt, baseUrl);
                if (finding) {
                    console.log(`VULNERÁVEL [${finding.severity}]`);
                    findings.push(finding);
                }
                else {
                    console.log('seguro');
                }
            }
            catch (err) {
                console.log(`ERRO: ${err.message}`);
            }
        }
        console.log('');
    }
    console.log(`[ ABUSE CASES ] Concluído: ${findings.length} vulnerabilidade(s) encontrada(s) ` +
        `em ${ABUSE_TASKS.length} testes.\n`);
    return findings;
}
//# sourceMappingURL=runner.js.map