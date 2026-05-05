"use strict";
/**
 * scenarios/report.ts
 * ---------------------------------------------------------------
 * Formato de relatório compartilhado entre os três cenários do
 * experimento comparativo:
 *
 *   Cenário A — ZAP spider + scan ativo (baseline automático)
 *   Cenário B — E2E Puppeteer + ZAP passivo (baseline guiado)
 *   Cenário C — Agentic DAST autônomo (experimental)
 *
 * Todos os cenários produzem o mesmo JSON, permitindo comparação
 * direta de Precision, Recall e F1-Score por categoria.
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
exports.saveScenarioReport = saveScenarioReport;
exports.printScenarioSummary = printScenarioSummary;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
/**
 * Salva o relatório do cenário em JSON no diretório /reports.
 * Retorna o caminho do arquivo gerado.
 */
function saveScenarioReport(report) {
    const reportsDir = path.join(__dirname, '..', '..', 'reports');
    if (!fs.existsSync(reportsDir)) {
        fs.mkdirSync(reportsDir, { recursive: true });
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = path.join(reportsDir, `scenario-${report.scenario.toLowerCase()}-${timestamp}.json`);
    fs.writeFileSync(filename, JSON.stringify(report, null, 2), 'utf-8');
    return filename;
}
/** Exibe resumo formatado no console */
function printScenarioSummary(report) {
    const divider = '─'.repeat(60);
    console.log(`\n${divider}`);
    console.log(`CENÁRIO ${report.scenario} — ${report.description}`);
    console.log(divider);
    console.log(`Gerado em  : ${report.generatedAt}`);
    console.log(`Duração    : ${(report.durationMs / 1000).toFixed(1)}s`);
    console.log(`Alvo       : ${report.targetUrl}`);
    console.log(`Findings   : ${report.findingsCount}`);
    console.log(divider);
    if (report.findings.length === 0) {
        console.log('\nNenhuma vulnerabilidade encontrada.');
    }
    else {
        console.log(`\n${report.findings.length} vulnerabilidade(s) encontrada(s):\n`);
        report.findings.forEach((f, i) => {
            console.log(`  ${i + 1}. [${f.severity}] ${f.title}`);
            console.log(`     Categoria : ${f.category}`);
        });
    }
    console.log(`\n${divider}\n`);
}
//# sourceMappingURL=report.js.map