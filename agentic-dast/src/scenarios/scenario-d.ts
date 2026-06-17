/**
 * scenarios/scenario-d.ts
 * ---------------------------------------------------------------
 * CENÁRIO D — PentestGPT como controle tecnológico de LLM generalista.
 *
 * Objetivo metodológico: isolar a variável "uso bruto de um LLM"
 * da variável "arquitetura especializada do Agentic DAST". Se o
 * Cenário C superar o Cenário D, a contribuição do framework não
 * pode ser atribuída apenas à presença de um LLM no pipeline.
 *
 * Fluxo:
 *   1. Invoca o adaptador Python (run_pentestgpt.py) via subprocess
 *   2. O adaptador opera em um de dois modos:
 *        - real : importa o pacote pentestgpt (pip install pentestgpt)
 *                 e executa contra TARGET_URL. Requer OPENAI_API_KEY.
 *        - mock : produz findings sintéticos para validar o pipeline
 *                 de avaliação sem custo de API. Acionado por
 *                 PENTESTGPT_MOCK=1 ou pela flag --mock.
 *   3. Lê o JSON intermediário gerado pelo adaptador
 *   4. Converte cada finding para o formato Finding do framework
 *   5. Salva como reports/scenario-d-{timestamp}.json
 *
 * Variáveis de ambiente relevantes:
 *   PYTHON_BIN         caminho do interpretador Python (default: "python")
 *   PENTESTGPT_MOCK    "1" para forçar o modo mock
 *   OPENAI_API_KEY     usada pelo PentestGPT no modo real
 *   TARGET_URL         alvo do experimento (default: http://localhost:3000)
 * ---------------------------------------------------------------
 */

import { spawn } from 'child_process';
import * as fs   from 'fs';
import * as path from 'path';
import { config }         from '../config';
import { Finding }        from '../executor/ActionDispatcher';
import { saveScenarioReport, printScenarioSummary } from './report';

const PYTHON_SCRIPT = path.join(__dirname, 'pentestgpt', 'run_pentestgpt.py');
const PYTHON_BIN    = process.env.PYTHON_BIN ?? 'python';
const MOCK_MODE     = process.env.PENTESTGPT_MOCK === '1';

// ================================================================
// Interface esperada do JSON intermediário produzido pelo adaptador
// ================================================================
interface RawFinding {
  title:        string;
  severity?:    string;
  category?:    string;
  description?: string;
  evidence?:    string;
  steps?:       string[];
}

interface RawReport {
  target:         string;
  generatedAt?:   string;
  mode:           'mock' | 'real';
  findingsCount:  number;
  findings:       RawFinding[];
}

// ================================================================
// Execução do adaptador Python via subprocess
// ================================================================
async function runPentestGPT(rawOutputPath: string): Promise<RawReport> {
  return new Promise<RawReport>((resolve, reject) => {
    const args: string[] = [
      PYTHON_SCRIPT,
      '--target', config.targetUrl,
      '--output', rawOutputPath,
    ];
    if (MOCK_MODE) args.push('--mock');

    console.log(`[Cenário D] Executando: ${PYTHON_BIN} ${args.join(' ')}`);
    const proc = spawn(PYTHON_BIN, args, { stdio: 'inherit' });

    proc.on('error', (err) => reject(err));
    proc.on('exit', (code) => {
      if (code !== 0) {
        return reject(new Error(`PentestGPT terminou com código ${code}`));
      }
      try {
        const raw = JSON.parse(fs.readFileSync(rawOutputPath, 'utf-8'));
        resolve(raw as RawReport);
      } catch (err) {
        reject(err);
      }
    });
  });
}

// ================================================================
// Conversão para o formato Finding do framework
// ================================================================
function adaptFindings(raw: RawReport): Finding[] {
  const allowedSeverities: Finding['severity'][] =
    ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];

  return raw.findings.map((f) => {
    const sev = (f.severity ?? 'INFO').toUpperCase() as Finding['severity'];
    const severity: Finding['severity'] =
      allowedSeverities.includes(sev) ? sev : 'INFO';

    return {
      title:        f.title,
      severity,
      category:     f.category ?? 'PENTESTGPT_OTHER',
      description:  f.description ?? '',
      steps:        f.steps ?? [],
      evidence:     f.evidence ?? '',
      discoveredAt: new Date(),
    };
  });
}

// ================================================================
// Entry point
// ================================================================
async function main(): Promise<void> {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   CENÁRIO D — PENTESTGPT (CONTROLE LLM)  ║');
  console.log('╚══════════════════════════════════════════╝\n');

  if (MOCK_MODE) {
    console.log('[Cenário D] Executando em MOCK MODE (PENTESTGPT_MOCK=1).');
    console.log('[Cenário D] Findings são sintéticos e não refletem execução real.\n');
  }

  const startTime = Date.now();

  // Caminho do JSON intermediário do adaptador Python
  const reportsDir = path.join(__dirname, '..', '..', 'reports');
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
  const rawOutputPath = path.join(
    reportsDir,
    `_pentestgpt-raw-${Date.now()}.json`,
  );

  let raw: RawReport;
  try {
    raw = await runPentestGPT(rawOutputPath);
  } catch (err) {
    console.error('\n[Cenário D] Falha na execução do adaptador PentestGPT:');
    console.error('           ', (err as Error).message);
    console.error('\nVerifique:');
    console.error('  • Python instalado e acessível (variável PYTHON_BIN)');
    console.error('  • Para modo real: pip install pentestgpt + OPENAI_API_KEY');
    console.error('  • Para validar a integração sem custo: PENTESTGPT_MOCK=1 npm run scenario:d');
    process.exit(1);
    return;
  }

  console.log(`[Cenário D] ${raw.findingsCount} finding(s) bruto(s) recebido(s) do PentestGPT.`);

  const findings = adaptFindings(raw);

  const description = raw.mode === 'mock'
    ? 'PentestGPT (modo mock) — controle tecnológico de LLM generalista'
    : 'PentestGPT — controle tecnológico de LLM generalista';

  const report = {
    scenario:       'D' as const,
    description,
    generatedAt:    new Date().toISOString(),
    durationMs:     Date.now() - startTime,
    targetUrl:      config.targetUrl,
    findingsCount:  findings.length,
    findings,
  };

  printScenarioSummary(report);

  const filepath = saveScenarioReport(report);
  console.log(`Relatório salvo em: ${filepath}\n`);
}

main().catch((err) => {
  console.error('[ERRO NÃO TRATADO]', err);
  process.exit(1);
});
