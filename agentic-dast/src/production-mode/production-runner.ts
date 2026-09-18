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

import * as fs   from 'fs';
import * as path from 'path';

import { ProductionPerception }      from './ProductionPerception';
import { ActionDispatcher, Finding } from '../executor/ActionDispatcher';
import { ReActAgent, AgentResult }   from '../cognitive/ReActAgent';
import { runAbuseCases }             from '../executor/tasks/runner';
import { ZapClient }                 from '../auditor/ZapClient';
import { config }                    from '../config';

import { SafeDispatcher } from './SafeDispatcher';
import { summaryClaimsVulnerabilities } from '../cognitive/ReActAgent';
import { prioritizeAppMap, rankEndpoints } from './SurfacePrioritizer';

function parseEnvBool(name: string, defaultValue: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) return defaultValue;
  return v.toLowerCase() === 'true' || v === '1';
}

function parseEnvNumber(name: string, defaultValue: number): number {
  const v = process.env[name];
  if (v === undefined) return defaultValue;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : defaultValue;
}

async function main(): Promise<void> {
  const readOnly     = parseEnvBool('READ_ONLY', false);
  const interactive  = parseEnvBool('INTERACTIVE', true);
  const auditLog     = process.env.AUDIT_LOG ?? '';
  const rateLimitMs  = parseEnvNumber('RATE_LIMIT_MS', 500);
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
  console.log(`  Alvo (targetUrl) : ${config.targetUrl}\n`);

  if (!readOnly && !interactive) {
    console.warn(
      '[AVISO] READ_ONLY=false e INTERACTIVE=false — nenhuma proteção ativa. ' +
      'Isso equivale ao modo oficial. Continue apenas se for intencional.\n',
    );
  }

  const extractor = new ProductionPerception();
  const zapClient = new ZapClient();
  let dispatcher: ActionDispatcher | null = null;
  let safeDispatcher: SafeDispatcher | null = null;

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
    dispatcher = await ActionDispatcher.create();
    dispatcher.applyAuthContext(appMap.auth);

    // Handoff da sessao de browser (cookies + localStorage/sessionStorage)
    // para o browser do Actor. Sem isso, as acoes `navigate` do ReActAgent
    // sobem num browser limpo e sao redirecionadas de volta ao login em
    // alvos OAuth/SSO — mesmo com o AppMap.auth preenchido.
    const browserSession = extractor.getBrowserSession();
    if (browserSession) {
      await dispatcher.applyBrowserSession(browserSession);
      console.log('[Executor] Sessao de browser propagada ao Actor.\n');
    } else {
      console.warn(
        '[Executor] Nenhuma sessao de browser capturada para o handoff — ' +
        'as navegacoes do agente podem cair no login. Use INTERACTIVE_LOGIN ' +
        'ou MANUAL_COOKIES para autenticar.\n',
      );
    }

    safeDispatcher = new SafeDispatcher(dispatcher, {
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
    const agent = new ReActAgent(safeDispatcher as unknown as ActionDispatcher);

    // Priorização da superfície de ataque (só no caminho de produção).
    // Em app real a Percepção descobre centenas de endpoints; o resumo
    // enviado ao LLM lista apenas os primeiros N. Reordenamos por RISCO
    // para que os N que sobrevivem ao corte sejam os mais promissores,
    // e elevamos N (PROD_MAX_ENDPOINTS, default 80). Nada é descartado —
    // só a ordem muda. O baseline do TCC (src/index.ts) não passa por aqui.
    const prioritizedAppMap = prioritizeAppMap(appMap);
    const maxEndpoints = parseInt(process.env.PROD_MAX_ENDPOINTS ?? '80', 10);

    if (process.env.PROD_LOG_PRIORITIZATION === 'true') {
      const top = rankEndpoints(appMap.apiEndpoints).slice(0, 10);
      console.log('[Priorização] Top endpoints por risco:');
      top.forEach((r, i) =>
        console.log(
          `  ${String(i + 1).padStart(2)}. [score ${r.score}] ${r.endpoint.method} ` +
          `${r.endpoint.url}  (${r.reasons.join('; ')})`,
        ),
      );
      console.log('');
    }

    const result: AgentResult = await agent.run(prioritizedAppMap, {
      initialMessage: { maxEndpoints, prioritized: true },
      // Few-shot opt-in (USE_FEWSHOT=true): anexa 2 exemplos ilustrativos
      // (achado legítimo + sessão inconclusiva honesta) ao system prompt,
      // para reduzir alucinação. Default off.
      fewShot: process.env.USE_FEWSHOT === 'true',
      // Achados passivos (headers/config/CORS/cookies/disclosure) são
      // reportáveis com evidência de header. Ligado por padrão em produção
      // e SEMPRE em READ_ONLY (cuja saída primária são achados passivos).
      // Desligue com REPORT_PASSIVE=false.
      passiveFindings: readOnly || process.env.REPORT_PASSIVE !== 'false',
      // Ações page_fetch/execute_js para app autenticado por sessão de
      // browser (SPA/Auth0 com token em memória). Opt-in: USE_PAGE_JS=true.
      pageJs: process.env.USE_PAGE_JS === 'true',
      // Gestão de contexto ligada em produção: sessões contra apps reais
      // são longas e as respostas grandes. Trunca Observations, compacta
      // histórico antigo e injeta memória de cobertura a cada 5 iterações.
      // Ajustável por env (defaults do ContextManager se não definido).
      contextManagement: {
        maxObservationChars: parseInt(process.env.PROD_MAX_OBS_CHARS ?? '4000', 10),
        historyCharBudget: parseInt(process.env.PROD_HISTORY_BUDGET ?? '60000', 10),
        recentTurnsVerbatim: parseInt(process.env.PROD_RECENT_TURNS ?? '8', 10),
        coverageEveryNIters: parseInt(process.env.PROD_COVERAGE_EVERY ?? '5', 10),
      },
    });

    // Fase 3b: Abuse Cases (rodam via HttpClient direto, NAO passam pelo
    // SafeDispatcher). Em modo produção autorizado, o operador humano deve
    // desativar essa fase se quiser controle absoluto sobre cada request.
    let abuseFindings: Finding[] = [];
    if (process.env.SKIP_ABUSE_CASES !== 'true') {
      console.log('[ FASE 3b ] Abuse Cases — testes estruturados...');
      console.log(
        '[ FASE 3b ] AVISO: rodam via HttpClient direto, sem passar pela camada de guardas. ' +
        'Para desativar, use SKIP_ABUSE_CASES=true.',
      );
      abuseFindings = await runAbuseCases(
        appMap.auth.jwt ?? '',
        config.targetUrl,
      );
    } else {
      console.log('[ FASE 3b ] Pulado (SKIP_ABUSE_CASES=true).');
    }

    // Fase 3c: Auditoria ZAP (passiva, sem risco adicional)
    console.log('[ FASE 3c ] Auditoria — coletando alertas ZAP...\n');
    const zapFindings: Finding[] = await zapClient.getPassiveAlerts(
      config.browserBaseUrl,
    );

    // Fase 4: Relatório
    const allFindings = deduplicateFindings([
      ...result.findings,
      ...abuseFindings,
      ...zapFindings,
    ]);

    console.log('\n[ FASE 4 ] Relatório final\n');
    printReport(result, abuseFindings, zapFindings, allFindings);
    saveReport(result, abuseFindings, zapFindings, allFindings);
  } catch (err) {
    console.error('\n[ERRO FATAL]', (err as Error).message);
    console.error((err as Error).stack);
    process.exit(1);
  } finally {
    await safeDispatcher?.teardown();
  }
}

function deduplicateFindings(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  return findings.filter((f) => {
    const key = f.title.toLowerCase().trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function printReport(
  agentResult: AgentResult,
  abuseFindings: Finding[],
  zapFindings: Finding[],
  allFindings: Finding[],
): void {
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
    if (summaryClaimsVulnerabilities(agentResult.summary)) {
      console.log('');
      console.log('⚠️  AVISO: o summary do agente afirma vulnerabilidades');
      console.log('    (palavras como CRITICAL, IDOR, XSS, etc.), mas nenhum');
      console.log('    finding estruturado foi materializado via');
      console.log('    Action:report_finding. Provavel alucinacao do LLM.');
      console.log('    NAO confie no summary; revise os steps manualmente');
      console.log('    para verificar cada afirmacao contra o que foi de');
      console.log('    fato testado.');
    }
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

function saveReport(
  agentResult: AgentResult,
  abuseFindings: Finding[],
  zapFindings: Finding[],
  allFindings: Finding[],
): void {
  const reportsDir = path.join(__dirname, '..', '..', 'reports');
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename  = path.join(reportsDir, `report-production-${timestamp}.json`);

  // Warning anti-alucinacao: se o summary do finish afirma vulnerabilidades
  // mas nenhum finding estruturado foi materializado, adiciona um flag
  // explicito no relatorio. Segunda linha de defesa; a primeira e o guard
  // no ReActAgent que rejeita finish nessas condicoes, mas se o LLM
  // insistir apos os retries e conseguir emitir mesmo assim, o warning
  // sinaliza ao leitor do relatorio.
  const suspectedHallucination =
    allFindings.length === 0 && summaryClaimsVulnerabilities(agentResult.summary);
  if (suspectedHallucination) {
    console.warn(
      '\n[AVISO] O summary do agente contem afirmacoes de vulnerabilidades ' +
      'mas nenhum finding estruturado foi materializado. Provavel alucinacao ' +
      'do LLM. Nao confie no summary sem verificar os steps manualmente.\n'
    );
  }

  const report = {
    mode:            'production',
    generatedAt:     new Date().toISOString(),
    summary:         agentResult.summary,
    finishedCleanly: agentResult.finishedCleanly,
    totalIterations: agentResult.totalIterations,
    warnings:        suspectedHallucination ? [
      'suspected-hallucination: summary claims vulnerabilities but no ' +
      'structured findings were emitted via Action:report_finding. Do not ' +
      'trust the summary at face value; review the steps array manually to ' +
      'verify each claim against actual HTTP responses recorded.'
    ] : [],
    config: {
      readOnly:    parseEnvBool('READ_ONLY', false),
      interactive: parseEnvBool('INTERACTIVE', true),
      rateLimitMs: parseEnvNumber('RATE_LIMIT_MS', 500),
    },
    findingsSummary: {
      reactAgent: agentResult.findings.length,
      abuseCases: abuseFindings.length,
      zapPassive: zapFindings.length,
      total:      allFindings.length,
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

main().catch((err) => {
  console.error('[ERRO NÃO TRATADO]', err);
  process.exit(1);
});
