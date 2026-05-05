/**
 * evaluation/evaluate.ts
 * ---------------------------------------------------------------
 * CLI de avaliação dos relatórios de cenário.
 *
 * Uso:
 *   npm run evaluate                    → todos os relatórios
 *   npm run evaluate -- scenario-a      → apenas relatórios do cenário A
 *
 * Fluxo:
 *   1. Carrega o Ground Truth (ground-truth.json)
 *   2. Lê todos os JSONs de /reports
 *   3. Para cada relatório:
 *        - Classifica findings em TP/FP/FN
 *        - Calcula Precision/Recall/F1 (overall e por categoria)
 *   4. Imprime tabelas no console
 *   5. Salva o resumo agregado em /reports/_evaluation-summary.json
 *
 * Quando há múltiplas execuções do mesmo cenário (n=3 rodadas),
 * computa também a média e desvio padrão de F1.
 * ---------------------------------------------------------------
 */

import * as fs   from 'fs';
import * as path from 'path';
import { Finding } from '../executor/ActionDispatcher';
import { GroundTruthEntry, classify, ClassificationResult } from './classify';
import { computeScenarioMetrics, ScenarioMetrics, Metrics } from './metrics';
import { CANONICAL_CATEGORIES, CanonicalCategory } from './categories';

// ===========================================================
// Tipos auxiliares
// ===========================================================

interface ReportFile {
  filename:      string;
  scenario:      string;       // 'A', 'B', 'C' ou 'main' (Cenário C via index.ts)
  findings:      Finding[];
  durationMs?:   number;
}

interface EvaluatedReport {
  filename:        string;
  scenario:        string;
  durationMs?:     number;
  classification:  ClassificationResult;
  metrics:         ScenarioMetrics;
}

interface AggregatedScenario {
  scenario:    string;
  runs:        number;
  meanF1:      number;
  stdevF1:     number;
  meanPrec:    number;
  meanRecall:  number;
  individualMetrics: Metrics[];
}

// ===========================================================
// Loader
// ===========================================================

function loadGroundTruth(): GroundTruthEntry[] {
  const gtPath = path.join(__dirname, 'ground-truth.json');
  const raw    = fs.readFileSync(gtPath, 'utf-8');
  const parsed = JSON.parse(raw) as { entries: GroundTruthEntry[] };
  return parsed.entries;
}

function loadReports(filterPrefix?: string): ReportFile[] {
  const reportsDir = path.join(__dirname, '..', '..', 'reports');
  if (!fs.existsSync(reportsDir)) {
    console.warn(`[Evaluate] Diretório de relatórios não existe: ${reportsDir}`);
    return [];
  }

  const files = fs
    .readdirSync(reportsDir)
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .filter((f) => !filterPrefix || f.toLowerCase().includes(filterPrefix.toLowerCase()))
    .sort();

  return files.map((filename) => {
    const fullPath = path.join(reportsDir, filename);
    const raw      = fs.readFileSync(fullPath, 'utf-8');
    const data     = JSON.parse(raw);

    // Detecta cenário
    let scenario: string;
    if (data.scenario)             scenario = data.scenario;       // scenarios A/B
    else if (filename.startsWith('report-')) scenario = 'C';       // index.ts (Cenário C)
    else                           scenario = 'unknown';

    return {
      filename,
      scenario,
      findings:  data.findings ?? [],
      durationMs: data.durationMs,
    };
  });
}

// ===========================================================
// Estatística
// ===========================================================

function aggregateScenario(scenario: string, evaluated: EvaluatedReport[]): AggregatedScenario {
  const runs = evaluated.length;
  const f1s         = evaluated.map((e) => e.metrics.overall.f1);
  const precisions  = evaluated.map((e) => e.metrics.overall.precision);
  const recalls     = evaluated.map((e) => e.metrics.overall.recall);

  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const stdev = (xs: number[]) => {
    if (xs.length < 2) return 0;
    const m = mean(xs);
    const variance = xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
    return Math.sqrt(variance);
  };

  return {
    scenario,
    runs,
    meanF1:     round(mean(f1s)),
    stdevF1:    round(stdev(f1s)),
    meanPrec:   round(mean(precisions)),
    meanRecall: round(mean(recalls)),
    individualMetrics: evaluated.map((e) => e.metrics.overall),
  };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// ===========================================================
// Impressão
// ===========================================================

function printReport(evaluated: EvaluatedReport, gt: GroundTruthEntry[]): void {
  const divider = '─'.repeat(70);
  console.log(`\n${divider}`);
  console.log(`Arquivo: ${evaluated.filename}`);
  console.log(`Cenário: ${evaluated.scenario}` +
              (evaluated.durationMs ? `  |  Duração: ${(evaluated.durationMs / 1000).toFixed(1)}s` : ''));
  console.log(divider);

  const { overall, perCategory } = evaluated.metrics;
  const { truePositives, falsePositives, falseNegatives } = evaluated.classification;

  console.log(
    `TP: ${overall.truePositives}  |  ` +
    `FP: ${overall.falsePositives}  |  ` +
    `FN: ${overall.falseNegatives}  |  ` +
    `GT total: ${gt.length}`
  );
  console.log(
    `Precision: ${overall.precision.toFixed(3)}  |  ` +
    `Recall: ${overall.recall.toFixed(3)}  |  ` +
    `F1: ${overall.f1.toFixed(3)}`
  );

  console.log('\nPor categoria:');
  console.log('  CATEGORIA                         TP  FP  FN   PREC   RECALL   F1');
  for (const cm of perCategory) {
    const m = cm.metrics;
    const cat = cm.category.padEnd(34);
    console.log(
      `  ${cat}` +
      `${String(m.truePositives).padStart(2)}  ` +
      `${String(m.falsePositives).padStart(2)}  ` +
      `${String(m.falseNegatives).padStart(2)}  ` +
      `${m.precision.toFixed(3)}  ` +
      `${m.recall.toFixed(3)}  ` +
      `${m.f1.toFixed(3)}`
    );
  }

  if (truePositives.length > 0) {
    console.log('\n  ✓ TPs (vulnerabilidades detectadas):');
    truePositives.forEach((cf) =>
      console.log(`    [${cf.matchedGtId}] ${cf.finding.title}`)
    );
  }

  if (falsePositives.length > 0) {
    console.log('\n  ✗ FPs (findings sem correspondência no GT):');
    falsePositives.forEach((cf) =>
      console.log(`    [${cf.inferredCategory}] ${cf.finding.title}`)
    );
  }

  if (falseNegatives.length > 0) {
    console.log('\n  ⚠ FNs (vulnerabilidades não detectadas):');
    falseNegatives.forEach((gtEntry) =>
      console.log(`    [${gtEntry.id}] ${gtEntry.challengeName}`)
    );
  }
}

function printAggregated(aggs: AggregatedScenario[]): void {
  if (aggs.length === 0) return;

  const divider = '═'.repeat(70);
  console.log(`\n${divider}`);
  console.log('AGREGAÇÃO POR CENÁRIO (média ± desvio padrão)');
  console.log(divider);
  console.log('CENÁRIO   RODADAS   F1 (média ± dp)        PRECISION    RECALL');
  for (const a of aggs) {
    console.log(
      `   ${a.scenario.padEnd(6)} ` +
      `   ${String(a.runs).padStart(3)}    ` +
      `   ${a.meanF1.toFixed(3)} ± ${a.stdevF1.toFixed(3)}    ` +
      `   ${a.meanPrec.toFixed(3)}    ` +
      `${a.meanRecall.toFixed(3)}`
    );
  }
  console.log(divider);
}

function saveSummary(
  evaluated: EvaluatedReport[],
  aggregated: AggregatedScenario[],
  gtTotal: number,
): string {
  const reportsDir = path.join(__dirname, '..', '..', 'reports');
  const filename   = path.join(reportsDir, '_evaluation-summary.json');

  const summary = {
    generatedAt: new Date().toISOString(),
    groundTruthSize: gtTotal,
    perReport: evaluated.map((e) => ({
      filename:    e.filename,
      scenario:    e.scenario,
      durationMs:  e.durationMs,
      tp: e.metrics.overall.truePositives,
      fp: e.metrics.overall.falsePositives,
      fn: e.metrics.overall.falseNegatives,
      precision:   e.metrics.overall.precision,
      recall:      e.metrics.overall.recall,
      f1:          e.metrics.overall.f1,
      perCategory: e.metrics.perCategory,
    })),
    aggregated,
  };

  fs.writeFileSync(filename, JSON.stringify(summary, null, 2), 'utf-8');
  return filename;
}

// ===========================================================
// Main
// ===========================================================

function main(): void {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   AGENTIC DAST — AVALIAÇÃO COMPARATIVA   ║');
  console.log('╚══════════════════════════════════════════╝\n');

  const filterArg = process.argv[2];
  const groundTruth = loadGroundTruth();
  const reports = loadReports(filterArg);

  console.log(`Ground Truth: ${groundTruth.length} vulnerabilidades em ${CANONICAL_CATEGORIES.length} categorias`);
  console.log(`Relatórios encontrados: ${reports.length}` +
              (filterArg ? ` (filtro: "${filterArg}")` : ''));

  if (reports.length === 0) {
    console.log('\nNenhum relatório para avaliar. Execute primeiro algum cenário:');
    console.log('  npm run scenario:a   |   npm run scenario:b   |   npm run scenario:c');
    return;
  }

  // Avalia cada relatório
  const evaluated: EvaluatedReport[] = reports.map((r) => {
    const classification = classify(r.findings, groundTruth);
    const metrics        = computeScenarioMetrics(classification, groundTruth);
    return {
      filename:    r.filename,
      scenario:    r.scenario,
      durationMs:  r.durationMs,
      classification,
      metrics,
    };
  });

  evaluated.forEach((e) => printReport(e, groundTruth));

  // Agrega por cenário (se houver múltiplas rodadas)
  const scenarios = [...new Set(evaluated.map((e) => e.scenario))].sort();
  const aggregated = scenarios.map((s) =>
    aggregateScenario(s, evaluated.filter((e) => e.scenario === s))
  );
  printAggregated(aggregated);

  const summaryPath = saveSummary(evaluated, aggregated, groundTruth.length);
  console.log(`\nResumo salvo em: ${summaryPath}\n`);
}

main();
