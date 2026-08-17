"use strict";
/**
 * production-mode/production-runner.ts
 * ---------------------------------------------------------------
 * Entrypoint alternativo do Agentic DAST para uso em ambientes de
 * producao autorizados. NAO substitui o entrypoint oficial (src/
 * index.ts) usado na rodada n=30 do TCC 2 — apenas o envolve com
 * uma camada de guardas que pede confirmacao humana antes de acoes
 * destrutivas ou sensiveis.
 *
 * Configuracao via variaveis de ambiente:
 *   READ_ONLY=true|false       Bloqueia qualquer POST/PUT/PATCH/DELETE
 *                              sem sequer perguntar. Default: false.
 *   INTERACTIVE=true|false     Pede confirmacao humana em MEDIUM,
 *                              HIGH e CRITICAL. Default: true.
 *   AUDIT_LOG=path/prod.csv    Grava CSV com cada acao executada,
 *                              pulada, bloqueada. Default: vazio.
 *   RATE_LIMIT_MS=1000         Delay entre make_requests. Default: 500.
 *   CIRCUIT_BREAKER=5          Encerra apos N findings HIGH/CRITICAL.
 *                              Default: 0 (desativado).
 *
 * Uso recomendado (primeira rodada em producao):
 *   READ_ONLY=true INTERACTIVE=true AUDIT_LOG=./logs/prod-audit.csv \
 *     npm run start:production
 *
 * Uso subsequente (apos validar rodada read-only):
 *   INTERACTIVE=true AUDIT_LOG=./logs/prod-audit.csv \
 *     npm run start:production
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
const DOMExtractor_1 = require("../perception/DOMExtractor");
const ActionDispatcher_1 = require("../executor/ActionDispatcher");
const ReActAgent_1 = require("../cognitive/ReActAgent");
const runner_1 = require("../executor/tasks/runner");
const ZapClient_1 = require("../auditor/ZapClient");
const config_1 = require("../config");
const SafeDispatcher_1 = require("./SafeDispatcher");
function parseEnvBool(name, defaultValue) {
    const v = process.env[name];
    if (v === undefined)
        return defaultValue;
    return v.toLowerCase() === 'true' || v === '1';
}
function parseEnvNumber(name, defaultValue) {
    const v = process.env[name];
    if (v === undefined)
        return defaultValue;
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : defaultValue;
}
async function main() {
    const readOnly = parseEnvBool('READ_ONLY', false);
    const interactive = parseEnvBool('INTERACTIVE', true);
    const auditLog = process.env.AUDIT_LOG ?? '';
    const rateLimitMs = parseEnvNumber('RATE_LIMIT_MS', 500);
    const circuitBreak = parseEnvNumber('CIRCUIT_BREAKER', 0);
    console.log('╔══════════════════════════════════════════════════╗');
    console.log('║   AGENTIC DAST — MODO PRODUÇÃO (com aprovação)   ║');
    console.log('╚══════════════════════════════════════════════════╝\n');
    console.log('[Config]');
    console.log(`  READ_ONLY        : ${readOnly}`);
    console.log(`  INTERACTIVE      : ${interactive}`);
    console.log(`  AUDIT_LOG        : ${auditLog || '(desativado)'}`);
    console.log(`  RATE_LIMIT_MS    : ${rateLimitMs}`);
    console.log(`  CIRCUIT_BREAKER  : ${circuitBreak || '(desativado)'}`);
    console.log(`  Alvo (targetUrl) : ${config_1.config.targetUrl}\n`);
    if (!readOnly && !interactive) {
        console.warn('[AVISO] READ_ONLY=false e INTERACTIVE=false — nenhuma proteção ativa. ' +
            'Isso equivale ao modo oficial. Continue apenas se for intencional.\n');
    }
    const extractor = new DOMExtractor_1.DOMExtractor();
    const zapClient = new ZapClient_1.ZapClient();
    let dispatcher = null;
    let safeDispatcher = null;
    try {
        // Fase 1: Percepção
        console.log('[ FASE 1 ] Percepção — construindo AppMap...\n');
        await extractor.launch();
        const appMap = await extractor.extract();
        await extractor.close();
        console.log('\n[ AppMap resumido ]');
        console.log(`  Rotas encontradas : ${appMap.routes.length}`);
        console.log(`  Endpoints de API  : ${appMap.apiEndpoints.length}`);
        console.log(`  Formulários       : ${appMap.metadata.totalForms}`);
        console.log(`  JWT coletado      : ${appMap.auth.jwt ? 'sim' : 'não'}\n`);
        // Fase 2: Inicialização com envelope SafeDispatcher
        console.log('[ FASE 2 ] Executor — iniciando Actor com camada de guardas...\n');
        dispatcher = await ActionDispatcher_1.ActionDispatcher.create();
        safeDispatcher = new SafeDispatcher_1.SafeDispatcher(dispatcher, {
            readOnly,
            interactive,
            auditLogPath: auditLog,
            rateLimitMs,
            circuitBreakerFindings: circuitBreak,
        });
        // Fase 3: Loop ReAct usando o dispatcher envolvido.
        // Cast para ActionDispatcher via unknown: o ReActAgent so usa
        // dispatch() e getFindings(), ambos presentes no SafeDispatcher.
        console.log('[ FASE 3 ] Cognição — executando loop ReAct...\n');
        const agent = new ReActAgent_1.ReActAgent(safeDispatcher);
        const result = await agent.run(appMap);
        // Fase 3b: Abuse Cases (rodam via HttpClient direto, NAO passam pelo
        // SafeDispatcher). Em modo produção autorizado, o operador humano deve
        // desativar essa fase se quiser controle absoluto sobre cada request.
        let abuseFindings = [];
        if (process.env.SKIP_ABUSE_CASES !== 'true') {
            console.log('[ FASE 3b ] Abuse Cases — testes estruturados...');
            console.log('[ FASE 3b ] AVISO: rodam via HttpClient direto, sem passar pela camada de guardas. ' +
                'Para desativar, use SKIP_ABUSE_CASES=true.');
            abuseFindings = await (0, runner_1.runAbuseCases)(appMap.auth.jwt ?? '', config_1.config.targetUrl);
        }
        else {
            console.log('[ FASE 3b ] Pulado (SKIP_ABUSE_CASES=true).');
        }
        // Fase 3c: Auditoria ZAP (passiva, sem risco adicional)
        console.log('[ FASE 3c ] Auditoria — coletando alertas ZAP...\n');
        const zapFindings = await zapClient.getPassiveAlerts(config_1.config.browserBaseUrl);
        // Fase 4: Relatório
        const allFindings = deduplicateFindings([
            ...result.findings,
            ...abuseFindings,
            ...zapFindings,
        ]);
        console.log('\n[ FASE 4 ] Relatório final\n');
        printReport(result, abuseFindings, zapFindings, allFindings);
        saveReport(result, abuseFindings, zapFindings, allFindings);
    }
    catch (err) {
        console.error('\n[ERRO FATAL]', err.message);
        console.error(err.stack);
        process.exit(1);
    }
    finally {
        await safeDispatcher?.teardown();
    }
}
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
function printReport(agentResult, abuseFindings, zapFindings, allFindings) {
    const divider = '─'.repeat(60);
    console.log(divider);
    console.log('RESUMO DA SESSÃO (MODO PRODUÇÃO)');
    console.log(divider);
    console.log(`Iterações ReAct      : ${agentResult.totalIterations}`);
    console.log(`Encerramento limpo   : ${agentResult.finishedCleanly ? 'sim' : 'não'}`);
    console.log(`Findings (ReAct)     : ${agentResult.findings.length}`);
    console.log(`Findings (AbuseCases): ${abuseFindings.length}`);
    console.log(`Findings (ZAP)       : ${zapFindings.length}`);
    console.log(`Total (deduplicado)  : ${allFindings.length}`);
    console.log(divider);
    if (allFindings.length === 0) {
        console.log('\nNenhuma vulnerabilidade encontrada.');
        return;
    }
    console.log(`\n${allFindings.length} vulnerabilidade(s) encontrada(s):\n`);
    allFindings.forEach((f, i) => {
        console.log(`  ${i + 1}. [${f.severity}] ${f.title}`);
        console.log(`     Categoria  : ${f.category}`);
        console.log(`     Descrição  : ${f.description.substring(0, 120)}...`);
        console.log();
    });
}
function saveReport(agentResult, abuseFindings, zapFindings, allFindings) {
    const reportsDir = path.join(__dirname, '..', '..', 'reports');
    if (!fs.existsSync(reportsDir)) {
        fs.mkdirSync(reportsDir, { recursive: true });
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = path.join(reportsDir, `report-production-${timestamp}.json`);
    const report = {
        mode: 'production',
        generatedAt: new Date().toISOString(),
        summary: agentResult.summary,
        finishedCleanly: agentResult.finishedCleanly,
        totalIterations: agentResult.totalIterations,
        config: {
            readOnly: parseEnvBool('READ_ONLY', false),
            interactive: parseEnvBool('INTERACTIVE', true),
            rateLimitMs: parseEnvNumber('RATE_LIMIT_MS', 500),
        },
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
main().catch((err) => {
    console.error('[ERRO NÃO TRATADO]', err);
    process.exit(1);
});
//# sourceMappingURL=production-runner.js.map