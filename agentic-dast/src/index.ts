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

import * as fs   from 'fs';
import * as path from 'path';

import { DOMExtractor }    from './perception/DOMExtractor';
import { ActionDispatcher } from './executor/ActionDispatcher';
import { ReActAgent, AgentResult, summaryClaimsVulnerabilities } from './cognitive/ReActAgent';
import { runAbuseCases }   from './executor/tasks/runner';
import { ZapClient }       from './auditor/ZapClient';
import { Finding }         from './executor/ActionDispatcher';
import { config }          from './config';

async function main(): Promise<void> {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║          AGENTIC DAST — INICIANDO        ║');
  console.log('╚══════════════════════════════════════════╝\n');

  const extractor  = new DOMExtractor();
  const zapClient  = new ZapClient();
  let dispatcher: ActionDispatcher | null = null;

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
    dispatcher = await ActionDispatcher.create();
    dispatcher.applyAuthContext(appMap.auth);

    // ── Fase 3: Cognição (loop ReAct) ──────────────────────
    console.log('[ FASE 3 ] Cognição — executando loop ReAct...\n');
    const agent = new ReActAgent(dispatcher);
    const result: AgentResult = await agent.run(appMap);

    // ── Fase 3b: Abuse Cases predefinidos ──────────────────
    // Rodam sempre, mesmo sem JWT — a maioria dos casos testa
    // endpoints públicos (FTP, SQL injection no login, /api/Users
    // sem auth, etc.). Casos que dependem de JWT (IDOR, basket)
    // simplesmente retornarão null sem causar erro.
    console.log('[ FASE 3b ] Abuse Cases — testes estruturados...');
    if (!appMap.auth.jwt) {
      console.log('[ FASE 3b ] Aviso: JWT não foi capturado pelo DOMExtractor. ' +
                  'Casos que dependem de autenticação (IDOR, basket) serão limitados.');
    }
    const abuseFingdings: Finding[] = await runAbuseCases(
      appMap.auth.jwt ?? '',
      config.targetUrl,
    );

    // ── Fase 3c: Alertas ZAP (scan passivo) ────────────────
    console.log('[ FASE 3c ] Auditoria — coletando alertas ZAP...\n');
    // Usa browserBaseUrl porque as mensagens que chegaram ao ZAP tem a
    // URL literal que o Chrome enviou (juice-shop:3000 quando proxy ativo,
    // localhost:3000 caso contrario). O filtro em getPassiveAlerts casa
    // por substring de URL, entao precisa bater com o que foi gravado.
    const zapFindings: Finding[] = await zapClient.getPassiveAlerts(config.browserBaseUrl);

    // ── Fase 4: Relatório consolidado ──────────────────────
    const allFindings = deduplicateFindings([
      ...result.findings,
      ...abuseFingdings,
      ...zapFindings,
    ]);

    console.log('\n[ FASE 4 ] Relatório final\n');
    printReport(result, abuseFingdings, zapFindings, allFindings);
    saveReport(result, abuseFingdings, zapFindings, allFindings);

  } catch (err) {
    console.error('\n[ERRO FATAL]', (err as Error).message);
    console.error((err as Error).stack);
    process.exit(1);

  } finally {
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
function deduplicateFindings(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  return findings.filter((f) => {
    const key = f.title.toLowerCase().trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ===========================================================
// Relatório
// ===========================================================

function printReport(
  agentResult: AgentResult,
  abuseFindings: Finding[],
  zapFindings: Finding[],
  allFindings: Finding[],
): void {
  const divider = '─'.repeat(60);

  console.log(divider);
  console.log('RESUMO DA SESSÃO');
  console.log(divider);
  console.log(`Iterações ReAct      : ${agentResult.totalIterations}`);
  console.log(`Encerramento limpo   : ${agentResult.finishedCleanly ? 'sim' : 'não'}`);
  console.log(`Sumário do agente    : ${agentResult.summary}`);
  console.log(divider);
  console.log(`Findings (ReAct)     : ${agentResult.findings.length}`);
  console.log(`Findings (AbuseCases): ${abuseFindings.length}`);
  console.log(`Findings (ZAP)       : ${zapFindings.length}`);
  console.log(`Total (deduplicado)  : ${allFindings.length}`);
  console.log(divider);

  if (allFindings.length === 0) {
    console.log('\nNenhuma vulnerabilidade encontrada.');
  } else {
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

function saveReport(
  agentResult: AgentResult,
  abuseFindings: Finding[],
  zapFindings: Finding[],
  allFindings: Finding[],
): void {
  const reportsDir = path.join(__dirname, '..', 'reports');
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename  = path.join(reportsDir, `report-${timestamp}.json`);

  const suspectedHallucination =
    allFindings.length === 0 && summaryClaimsVulnerabilities(agentResult.summary);

  const report = {
    generatedAt:      new Date().toISOString(),
    summary:          agentResult.summary,
    finishedCleanly:  agentResult.finishedCleanly,
    totalIterations:  agentResult.totalIterations,
    warnings:         suspectedHallucination ? [
      'suspected-hallucination: summary claims vulnerabilities but no ' +
      'structured findings were emitted via Action:report_finding.'
    ] : [],
    findingsSummary: {
      reactAgent:  agentResult.findings.length,
      abuseCases:  abuseFindings.length,
      zapPassive:  zapFindings.length,
      total:       allFindings.length,
    },
    findings: allFindings,
    steps: agentResult.steps.map((s) => ({
      iteration:   s.iteration,
      thought:     s.thought,
      action:      s.action,
      observation: s.observation.substring(0, 500),
      timestamp:   s.timestamp,
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
