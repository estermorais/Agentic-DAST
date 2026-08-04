/**
 * coverage-analysis.js
 * Calcula cobertura acumulada de GTs por cenario a partir dos reports JSON.
 * Uso: node scripts/coverage-analysis.js         # imprime relatorio humano
 *      node scripts/coverage-analysis.js --json  # imprime JSON estruturado
 */
const fs = require('fs');
const path = require('path');

const { classify } = require('../dist/evaluation/classify.js');

const JSON_MODE = process.argv.includes('--json');
function log(...args) { if (!JSON_MODE) log(...args); }

const reportsDir = path.resolve(__dirname, '..', 'reports');
const gtPath = path.resolve(__dirname, '..', 'dist', 'evaluation', 'ground-truth.json');
const gt = JSON.parse(fs.readFileSync(gtPath, 'utf-8'));
const entries = gt.entries || gt;

const scenarios = {
  A: files => files.filter(f => /^scenario-a/.test(f)),
  B: files => files.filter(f => /^scenario-b/.test(f)),
  C: files => files.filter(f => /^report-/.test(f)),
  D: files => files.filter(f => /^scenario-d/.test(f)),
};

const allFiles = fs.readdirSync(reportsDir).filter(f =>
  f.endsWith('.json') && !f.startsWith('_')
);

const gtById = Object.fromEntries(entries.map(e => [e.id, e]));

log('='.repeat(72));
log('COBERTURA ACUMULADA POR CENARIO');
log('='.repeat(72));

const perScenarioDetected = {};
const perScenarioFreq = {};   // scen -> {gtId: count}
const perScenarioN = {};      // scen -> n_reports

for (const [letter, filterFn] of Object.entries(scenarios)) {
  const files = filterFn(allFiles);
  const detected = new Map(); // gtId -> count of runs where it appeared

  for (const file of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(reportsDir, file), 'utf-8'));
      // Findings podem estar em raw.findings ou raw.result.findings
      const findings = raw.findings || (raw.result && raw.result.findings) || [];
      const result = classify(findings, entries);
      const seen = new Set();
      for (const tp of result.truePositives) {
        if (tp.matchedGtId) seen.add(tp.matchedGtId);
      }
      for (const gid of seen) {
        detected.set(gid, (detected.get(gid) || 0) + 1);
      }
    } catch (err) {
      if (!JSON_MODE) console.error(`  [warn] ${file}: ${err.message}`);
    }
  }

  const n = files.length;
  const covered = detected.size;
  const total = entries.length;
  log(`\nCENARIO ${letter} — n=${n} reports`);
  log(`Cobertura acumulada: ${covered}/${total} (${Math.round(covered*100/total)}%)`);

  if (covered > 0) {
    log('\n  GTs detectados (freq / n_runs):');
    const sorted = [...detected.entries()].sort((a,b) => b[1] - a[1]);
    for (const [gid, count] of sorted) {
      const e = gtById[gid];
      const pct = Math.round(count*100/n);
      log(`    [${gid}] ${(e?.challengeName || '?').padEnd(45)} ${String(count).padStart(3)}/${n} (${pct}%)`);
    }
  }

  const missing = entries.filter(e => !detected.has(e.id));
  if (missing.length > 0) {
    log(`\n  GTs NAO detectados (${missing.length}):`);
    for (const e of missing) {
      log(`    [${e.id}] ${e.challengeName} (${e.category})`);
    }
  }

  perScenarioDetected[letter] = new Set(detected.keys());
  perScenarioFreq[letter] = Object.fromEntries(detected);
  perScenarioN[letter] = n;
}

// Cobertura por categoria (Cenario C)
log('\n' + '='.repeat(72));
log('COBERTURA POR CATEGORIA — Cenario C');
log('='.repeat(72));
const gtByCat = {};
for (const e of entries) {
  if (!gtByCat[e.category]) gtByCat[e.category] = [];
  gtByCat[e.category].push(e.id);
}
const cSet = perScenarioDetected.C;
for (const [cat, ids] of Object.entries(gtByCat).sort()) {
  const hit = ids.filter(i => cSet.has(i)).length;
  const pct = Math.round(hit*100/ids.length);
  const bar = pct === 100 ? ' ✓' : '';
  log(`  ${cat.padEnd(30)} ${hit}/${ids.length} (${pct}%)${bar}`);
}

// Comparativo direto C vs D
log('\n' + '='.repeat(72));
log('DIFF C vs D — vulns detectadas SÓ por C, SÓ por D, ou por AMBOS');
log('='.repeat(72));
const cOnly = [...perScenarioDetected.C].filter(g => !perScenarioDetected.D.has(g));
const dOnly = [...perScenarioDetected.D].filter(g => !perScenarioDetected.C.has(g));
const both  = [...perScenarioDetected.C].filter(g => perScenarioDetected.D.has(g));
log(`\nSó C detectou (${cOnly.length}):`);
for (const g of cOnly) log(`  [${g}] ${gtById[g]?.challengeName}`);
log(`\nSó D detectou (${dOnly.length}):`);
for (const g of dOnly) log(`  [${g}] ${gtById[g]?.challengeName}`);
log(`\nAmbos detectaram (${both.length}):`);
for (const g of both) log(`  [${g}] ${gtById[g]?.challengeName}`);

// Modo JSON: emite estrutura consumivel por scripts Python
if (JSON_MODE) {
  const output = {
    ground_truth_total: entries.length,
    per_scenario: {},
  };
  for (const s of ['A', 'B', 'C', 'D']) {
    output.per_scenario[s] = {
      n_reports: perScenarioN[s] || 0,
      matched: perScenarioFreq[s] || {},
      detected_count: perScenarioDetected[s]?.size || 0,
    };
  }
  process.stdout.write(JSON.stringify(output, null, 2));
}
