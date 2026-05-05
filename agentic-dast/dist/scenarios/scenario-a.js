"use strict";
/**
 * scenarios/scenario-a.ts
 * ---------------------------------------------------------------
 * CENÁRIO A — Baseline: OWASP ZAP com spider tradicional.
 *
 * Fluxo:
 *   1. Inicia o ZAP spider na URL raiz do Juice Shop
 *   2. Aguarda o spider varrer todos os links encontrados
 *   3. Inicia scan ativo (envia payloads de ataque automaticamente)
 *   4. Aguarda conclusão do scan ativo
 *   5. Coleta todos os alertas gerados
 *   6. Salva relatório JSON em /reports
 *
 * Este cenário representa o uso convencional do ZAP sem qualquer
 * guia semântico ou automação de browser. Serve como baseline
 * inferior para comparação com os Cenários B e C.
 *
 * Limitação conhecida: o ZAP spider não consegue navegar SPAs
 * Angular porque o conteúdo é gerado por JavaScript — ele verá
 * apenas o index.html estático e poucos links externos.
 * ---------------------------------------------------------------
 */
Object.defineProperty(exports, "__esModule", { value: true });
const ZapClient_1 = require("../auditor/ZapClient");
const config_1 = require("../config");
const report_1 = require("./report");
async function main() {
    console.log('╔══════════════════════════════════════════╗');
    console.log('║    CENÁRIO A — ZAP SPIDER TRADICIONAL    ║');
    console.log('╚══════════════════════════════════════════╝\n');
    const startTime = Date.now();
    const zapClient = new ZapClient_1.ZapClient();
    const targetUrl = config_1.config.targetUrl;
    // ── Etapa 1: Spider ──────────────────────────────────────
    console.log('[ ETAPA 1 ] Spider tradicional...\n');
    const spiderId = await zapClient.startSpider(targetUrl);
    if (spiderId) {
        await zapClient.waitForSpiderCompletion(spiderId, 300_000);
    }
    else {
        console.warn('[Cenário A] Spider não iniciou. Prosseguindo sem ele.');
    }
    // ── Etapa 2: Scan Ativo ──────────────────────────────────
    console.log('\n[ ETAPA 2 ] Scan ativo...\n');
    const scanId = await zapClient.startActiveScan(targetUrl);
    if (scanId) {
        await zapClient.waitForScanCompletion(scanId, 600_000);
    }
    else {
        console.warn('[Cenário A] Scan ativo não iniciou. Coletando apenas alertas passivos.');
    }
    // ── Etapa 3: Coleta de Alertas ───────────────────────────
    console.log('\n[ ETAPA 3 ] Coletando alertas do ZAP...\n');
    const findings = await zapClient.getPassiveAlerts(targetUrl);
    // ── Etapa 4: Relatório ───────────────────────────────────
    const report = {
        scenario: 'A',
        description: 'ZAP spider tradicional + scan ativo (sem navegação humana)',
        generatedAt: new Date().toISOString(),
        durationMs: Date.now() - startTime,
        targetUrl,
        findingsCount: findings.length,
        findings,
    };
    (0, report_1.printScenarioSummary)(report);
    const filepath = (0, report_1.saveScenarioReport)(report);
    console.log(`Relatório salvo em: ${filepath}\n`);
}
main().catch((err) => {
    console.error('[ERRO FATAL]', err);
    process.exit(1);
});
//# sourceMappingURL=scenario-a.js.map