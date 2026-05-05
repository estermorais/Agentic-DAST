"use strict";
/**
 * index.ts
 * ---------------------------------------------------------------
 * Ponto de entrada do framework Agentic DAST.
 *
 * Orquestra os módulos em sequência:
 *   1. Percepção  — DOMExtractor constrói o AppMap
 *   2. Execução   — ActionDispatcher inicializa o Actor
 *   3. Cognição   — ReActAgent executa o loop ReAct (LLM autônomo)
 *   3b. Abuso     — Abuse Cases predefinidos complementam a cobertura
 *   3c. Auditoria — ZapClient coleta alertas do scan passivo
 *   4. Relatório  — findings consolidados exibidos e salvos em JSON
 * ---------------------------------------------------------------
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const DOMExtractor_1 = require("./perception/DOMExtractor");
const ActionDispatcher_1 = require("./executor/ActionDispatcher");
const ReActAgent_1 = require("./cognitive/ReActAgent");
const runner_1 = require("./executor/tasks/runner");
const ZapClient_1 = require("./auditor/ZapClient");
const config_1 = require("./config");
async function main() {
    console.log('╔══════════════════════════════════════════╗');
    console.log('║          AGENTIC DAST — INICIANDO        ║');
    console.log('╚══════════════════════════════════════════╝\n');
    const extractor = new DOMExtractor_1.DOMExtractor();
    const zapClient = new ZapClient_1.ZapClient();
    let dispatcher = null;
    try {
        // ── Fase 1: Percepção ──────────────────────────────────
        console.log('[ FASE 1 ] Percepção — construindo AppMap...\n');
        await extractor.launch();
        const appMap = await extractor.extract();
        await extractor.close();
        console.log('\n[ AppMap resumido ]');
        console.log(`  Rotas encontradas : ${appMap.routes.length}`);
        console.log(`  Endpoints de API  : ${appMap.apiEndpoints.length}`);
        console.log(`  Formulários       : ${appMap.metadata.totalForms}`);
        console.log(`  JWT coletado      : ${appMap.auth.jwt ? 'sim' : 'não'}\n`);
        // ── Fase 2: Inicialização do Executor ──────────────────
        console.log('[ FASE 2 ] Executor — iniciando Actor...\n');
        dispatcher = await ActionDispatcher_1.ActionDispatcher.create();
        // ── Fase 3: Cognição (loop ReAct) ──────────────────────
        console.log('[ FASE 3 ] Cognição — executando loop ReAct...\n');
        const agent = new ReActAgent_1.ReActAgent(dispatcher);
        const result = await agent.run(appMap);
        // ── Fase 3b: Abuse Cases predefinidos ──────────────────
        console.log('[ FASE 3b ] Abuse Cases — testes estruturados...');
        const abuseFingdings = appMap.auth.jwt
            ? await (0, runner_1.runAbuseCases)(appMap.auth.jwt, config_1.config.targetUrl)
            : [];
        // ── Fase 3c: Alertas ZAP (scan passivo) ────────────────
        console.log('[ FASE 3c ] Auditoria — coletando alertas ZAP...\n');
        const zapFindings = await zapClient.getPassiveAlerts(config_1.config.targetUrl);
        // ── Fase 4: Relatório consolidado ──────────────────────
        const allFindings = deduplicateFindings([
            ...result.findings,
            ...abuseFingdings,
            ...zapFindings,
        ]);
        console.log('\n[ FASE 4 ] Relatório final\n');
        printReport(result, abuseFingdings, zapFindings, allFindings);
        saveReport(result, abuseFingdings, zapFindings, allFindings);
    }
    catch (err) {
        console.error('\n[ERRO FATAL]', err.message);
        console.error(err.stack);
        process.exit(1);
    }
    finally {
        await dispatcher?.teardown();
    }
}
// ===========================================================
// Deduplicação
// ===========================================================
/**
 * Remove Findings duplicados com base no título (normalizado).
 * Útil quando o agente ReAct e um Abuse Case detectam a mesma vuln.
 */
function deduplicateFindings(findings) {
    const seen = new Set();
    return findings.filter((f) => {
        const key = f.title.toLowerCase().trim();
        if (seen.has(key))
            return false;
        seen.add(key);
        return true;
    });
}
// ===========================================================
// Relatório
// ===========================================================
function printReport(agentResult, abuseFindings, zapFindings, allFindings) {
    const divider = '─'.repeat(60);
    console.log(divider);
    console.log('RESUMO DA SESSÃO');
    console.log(divider);
    console.log(`Iterações ReAct      : ${agentResult.totalIterations}`);
    console.log(`Encerramento limpo   : ${agentResult.finishedCleanly ? 'sim' : 'não (limite atingido)'}`);
    console.log(`Sumário do agente    : ${agentResult.summary}`);
    console.log(divider);
    console.log(`Findings (ReAct)     : ${agentResult.findings.length}`);
    console.log(`Findings (AbuseCases): ${abuseFindings.length}`);
    console.log(`Findings (ZAP)       : ${zapFindings.length}`);
    console.log(`Total (deduplicado)  : ${allFindings.length}`);
    console.log(divider);
    if (allFindings.length === 0) {
        console.log('\nNenhuma vulnerabilidade encontrada.');
    }
    else {
        console.log(`\n${allFindings.length} vulnerabilidade(s) encontrada(s):\n`);
        allFindings.forEach((f, i) => {
            console.log(`  ${i + 1}. [${f.severity}] ${f.title}`);
            console.log(`     Categoria  : ${f.category}`);
            console.log(`     Descrição  : ${f.description.substring(0, 120)}...`);
            console.log(`     Evidência  : ${f.evidence.substring(0, 100)}`);
            console.log();
        });
    }
    console.log(divider);
}
function saveReport(agentResult, abuseFindings, zapFindings, allFindings) {
    const reportsDir = path.join(__dirname, '..', 'reports');
    if (!fs.existsSync(reportsDir)) {
        fs.mkdirSync(reportsDir, { recursive: true });
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = path.join(reportsDir, `report-${timestamp}.json`);
    const report = {
        generatedAt: new Date().toISOString(),
        summary: agentResult.summary,
        finishedCleanly: agentResult.finishedCleanly,
        totalIterations: agentResult.totalIterations,
        findingsSummary: {
            reactAgent: agentResult.findings.length,
            abuseCases: abuseFindings.length,
            zapPassive: zapFindings.length,
            total: allFindings.length,
        },
        findings: allFindings,
        steps: agentResult.steps.map((s) => ({
            iteration: s.iteration,
            thought: s.thought,
            action: s.action,
            observation: s.observation.substring(0, 500),
            timestamp: s.timestamp,
        })),
    };
    fs.writeFileSync(filename, JSON.stringify(report, null, 2), 'utf-8');
    console.log(`\nRelatório salvo em: ${filename}`);
}
// ===========================================================
// Entrada
// ===========================================================
main().catch((err) => {
    console.error('[ERRO NÃO TRATADO]', err);
    process.exit(1);
});
//# sourceMappingURL=index.js.map