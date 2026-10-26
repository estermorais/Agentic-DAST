/**
 * scripts/decomposicao-por-fonte.js
 * ---------------------------------------------------------------
 * Separa os findings do Cenario C pela fonte que os gerou e mede
 * cada fonte isoladamente com o mesmo classify() da rodada oficial.
 *
 * Fontes:
 *   - abuse : titulo comeca com o titulo fixo de um Abuse Case
 *   - zap   : titulo comeca com "[ZAP]"
 *   - react : todo o resto (loop ReAct)
 *
 * Uso (na raiz de agentic-dast, depois de `npm run build`):
 *   node scripts/decomposicao-por-fonte.js
 *
 * Saida: reports/tcc-artifacts/decomposicao-por-fonte.json
 * (contagens brutas, cobertura por fonte, frequencia de deteccao
 * por GT nos Cenarios C e D e F1 por rodada de cada configuracao).
 * Os testes de Wilcoxon/Mann-Whitney sobre os vetores de F1 sao
 * feitos com SciPy, como em statistical-analysis.py.
 * ---------------------------------------------------------------
 */

const fs   = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const { classify }              = require(path.join(root, 'dist/evaluation/classify.js'));
const { computeScenarioMetrics } = require(path.join(root, 'dist/evaluation/metrics.js'));

const gt = JSON.parse(
  fs.readFileSync(path.join(root, 'src/evaluation/ground-truth.json'), 'utf8'),
).entries;

// Titulos fixos emitidos por src/executor/tasks/Abuse*.ts
const ABUSE_TITLES = [
  'Acesso Não-Autorizado a Endpoints Administrativos',
  'IDOR — Acesso ao Carrinho de Outro Usuário',
  'Vulnerabilidade de Verificação de Assinatura JWT',
  'Manipulação de Quantidade Negativa no Carrinho',
  'SQL Injection no Endpoint de Autenticação',
  'Exposição de Dados Sensíveis — Recursos Acessíveis Sem Autenticação',
  'Cross-Site Scripting (XSS) Armazenado',
  'Bypass de Validação de Rating — Zero Estrelas',
];

function sourceOf(finding) {
  if (finding.title.startsWith('[ZAP]')) return 'zap';
  if (ABUSE_TITLES.some((t) => finding.title.startsWith(t))) return 'abuse';
  return 'react';
}

function scenarioOf(filename) {
  if (filename.startsWith('report-'))     return 'C';
  if (filename.startsWith('scenario-d-')) return 'D';
  return null;
}

const mean  = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
const stdev = (xs) => Math.sqrt(xs.reduce((s, x) => s + (x - mean(xs)) ** 2, 0) / (xs.length - 1));
const r3    = (x) => Math.round(x * 1000) / 1000;

function cliffsDelta(a, b) {
  let gtCount = 0, ltCount = 0;
  for (const x of a) for (const y of b) {
    if (x > y) gtCount++;
    else if (x < y) ltCount++;
  }
  return (gtCount - ltCount) / (a.length * b.length);
}

const reportsDir = path.join(root, 'reports');
const files = fs.readdirSync(reportsDir)
  .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
  .sort();

const rawCount  = { react: 0, abuse: 0, zap: 0 };
const gtBySource = { react: {}, abuse: {}, zap: {} };
const freq      = { C: {}, D: {} };
const f1        = { C_completo: [], C_react: [], C_abuse: [], D: [] };

for (const filename of files) {
  const scenario = scenarioOf(filename);
  if (!scenario) continue;

  const findings = JSON.parse(fs.readFileSync(path.join(reportsDir, filename), 'utf8')).findings ?? [];
  const full = classify(findings, gt);
  for (const id of new Set(full.truePositives.map((t) => t.matchedGtId))) {
    freq[scenario][id] = (freq[scenario][id] ?? 0) + 1;
  }

  if (scenario === 'D') {
    f1.D.push(computeScenarioMetrics(full, gt).overall.f1);
    continue;
  }

  f1.C_completo.push(computeScenarioMetrics(full, gt).overall.f1);
  for (const f of findings) rawCount[sourceOf(f)]++;

  for (const source of ['react', 'abuse', 'zap']) {
    const subset = classify(findings.filter((f) => sourceOf(f) === source), gt);
    for (const id of new Set(subset.truePositives.map((t) => t.matchedGtId))) {
      gtBySource[source][id] = (gtBySource[source][id] ?? 0) + 1;
    }
    if (source === 'react') f1.C_react.push(computeScenarioMetrics(subset, gt).overall.f1);
    if (source === 'abuse') f1.C_abuse.push(computeScenarioMetrics(subset, gt).overall.f1);
  }
}

const union = (...sets) => new Set(sets.flatMap((s) => Object.keys(s)));
const coverage = {
  react:             union(gtBySource.react).size,
  abuse:             union(gtBySource.abuse).size,
  zap:               union(gtBySource.zap).size,
  react_abuse:       union(gtBySource.react, gtBySource.abuse).size,
  react_abuse_zap:   union(gtBySource.react, gtBySource.abuse, gtBySource.zap).size,
  D:                 Object.keys(freq.D).length,
};

const summary = Object.fromEntries(
  Object.entries(f1).map(([k, v]) => [k, { n: v.length, mean: r3(mean(v)), stdev: r3(stdev(v)) }]),
);

const out = {
  generatedAt: new Date().toISOString(),
  groundTruthSize: gt.length,
  rawFindingsBySource: rawCount,
  coverageBySource: coverage,
  detectionsPerGtBySource: gtBySource,
  detectionFrequency: freq,
  f1Summary: summary,
  cliffsDelta_CReact_vs_D: r3(cliffsDelta(f1.C_react, f1.D)),
  f1PerRun: f1,
};

const outPath = path.join(reportsDir, 'tcc-artifacts', 'decomposicao-por-fonte.json');
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));

console.log('Findings brutos por fonte:', rawCount);
console.log('Cobertura (GTs distintos):', coverage);
console.log('F1 por configuracao:', summary);
console.log('Cliff delta (C-ReAct vs D):', out.cliffsDelta_CReact_vs_D);
console.log(`Salvo em ${outPath}`);
