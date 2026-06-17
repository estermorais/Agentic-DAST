/**
 * scenarios/report.ts
 * ---------------------------------------------------------------
 * Formato de relatório compartilhado entre os quatro cenários do
 * experimento comparativo:
 *
 *   Cenário A — ZAP spider + scan ativo (baseline automático)
 *   Cenário B — E2E Puppeteer + ZAP passivo (baseline guiado)
 *   Cenário C — Agentic DAST autônomo (experimental)
 *   Cenário D — PentestGPT (controle de LLM generalista)
 *
 * Todos os cenários produzem o mesmo JSON, permitindo comparação
 * direta de Precision, Recall e F1-Score por categoria.
 * ---------------------------------------------------------------
 */

import * as fs   from 'fs';
import * as path from 'path';
import { Finding } from '../executor/ActionDispatcher';

export interface ScenarioReport {
  scenario:       'A' | 'B' | 'C' | 'D';
  description:    string;
  generatedAt:    string;
  durationMs:     number;
  targetUrl:      string;
  findingsCount:  number;
  findings:       Finding[];
}

/**
 * Salva o relatório do cenário em JSON no diretório /reports.
 * Retorna o caminho do arquivo gerado.
 */
export function saveScenarioReport(report: ScenarioReport): string {
  const reportsDir = path.join(__dirname, '..', '..', 'reports');
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename  = path.join(
    reportsDir,
    `scenario-${report.scenario.toLowerCase()}-${timestamp}.json`
  );

  fs.writeFileSync(filename, JSON.stringify(report, null, 2), 'utf-8');
  return filename;
}

/** Exibe resumo formatado no console */
export function printScenarioSummary(report: ScenarioReport): void {
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
  } else {
    console.log(`\n${report.findings.length} vulnerabilidade(s) encontrada(s):\n`);
    report.findings.forEach((f, i) => {
      console.log(`  ${i + 1}. [${f.severity}] ${f.title}`);
      console.log(`     Categoria : ${f.category}`);
    });
  }

  console.log(`\n${divider}\n`);
}
