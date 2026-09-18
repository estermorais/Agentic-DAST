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
 *   MAX_COST_USD=1.50          Orcamento de gasto (USD) do loop ReAct: o
 *                              agente para quando o custo do LLM passa
 *                              disso (o que vier antes de MAX_REACT_
 *                              ITERATIONS). Default: 0 (desativado).
 *   SESSION_CACHE=true|false   Salva a sessao do login manual CIFRADA em
 *                              .session-cache/ e reaproveita nas proximas
 *                              runs (se valida). Default: true.
 *   FORCE_REAUTH=true|false    Ignora o cache e refaz o login manual,
 *                              sobrescrevendo a sessao salva. Default: false.
 *   SESSION_PASSPHRASE=...     Senha p/ cifrar a sessao (AES-256-GCM).
 *                              Vazio: chave derivada da maquina.
 *
 * Ao final grava DOIS relatorios em reports/: report-production-<ts>.json
 * (bruto) e report-production-<ts>.md (tecnico, legivel).
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
const ProductionPerception_1 = require("./ProductionPerception");
const ActionDispatcher_1 = require("../executor/ActionDispatcher");
const ReActAgent_1 = require("../cognitive/ReActAgent");
const runner_1 = require("../executor/tasks/runner");
const ZapClient_1 = require("../auditor/ZapClient");
const config_1 = require("../config");
const SafeDispatcher_1 = require("./SafeDispatcher");
const ReActAgent_2 = require("../cognitive/ReActAgent");
const SurfacePrioritizer_1 = require("./SurfacePrioritizer");
const report_render_1 = require("./report-render");
/** Limite de caracteres do contexto da aplicacao anexado ao prompt. */
const APP_CONTEXT_MAX_CHARS = parseEnvNumber('APP_CONTEXT_MAX_CHARS', 20_000);
/**
 * Trunca `text` para no maximo `max` caracteres, preferindo cortar numa
 * fronteira de linha para nao partir uma frase (ou um par surrogate de um
 * emoji/caractere multi-byte) no meio. Se nao houver quebra de linha na
 * janela final (ate metade do limite), cai no corte direto. Retorna o
 * texto inalterado quando ja cabe.
 */
function truncateAppContext(text, max) {
    if (text.length <= max)
        return text;
    let hardCut = text.slice(0, max);
    // Se o corte caiu no meio de um par surrogate (emoji/caractere multi-byte),
    // descarta o high surrogate orfao para nao emitir um code unit invalido.
    const lastCode = hardCut.charCodeAt(hardCut.length - 1);
    if (lastCode >= 0xd800 && lastCode <= 0xdbff)
        hardCut = hardCut.slice(0, -1);
    const lastNl = hardCut.lastIndexOf('\n');
    // So respeita a fronteira de linha se ela nao descartar mais da metade
    // do conteudo permitido (evita perder quase tudo por causa de uma unica
    // linha muito longa).
    const cut = lastNl >= max / 2 ? hardCut.slice(0, lastNl) : hardCut;
    return cut + '\n[...contexto truncado...]';
}
/**
 * Carrega o arquivo de contexto da aplicacao (APP_CONTEXT_FILE), se
 * definido. Falha graciosa: arquivo ausente/ilegivel apenas avisa e segue
 * sem contexto. Trunca com aviso se exceder o limite (protege a janela de
 * contexto do LLM).
 */
function loadAppContext() {
    const p = config_1.config.appContextFile;
    if (!p)
        return '';
    const resolved = path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
    if (!fs.existsSync(resolved)) {
        console.warn(`[Config] APP_CONTEXT_FILE aponta para "${resolved}", que nao existe. ` +
            `Rodando sem contexto da aplicacao.`);
        return '';
    }
    try {
        let text = fs.readFileSync(resolved, 'utf-8');
        if (text.length > APP_CONTEXT_MAX_CHARS) {
            console.warn(`[Config] Contexto da aplicacao tem ${text.length} chars (> ` +
                `APP_CONTEXT_MAX_CHARS=${APP_CONTEXT_MAX_CHARS}) — truncando.`);
            text = truncateAppContext(text, APP_CONTEXT_MAX_CHARS);
        }
        console.log(`[Config] Contexto da aplicacao carregado de "${resolved}" ` +
            `(${text.length} chars) — sera anexado ao prompt para reduzir falso-positivo.`);
        return text;
    }
    catch (err) {
        console.warn(`[Config] Falha ao ler APP_CONTEXT_FILE ("${resolved}"): ` +
            `${err.message}. Rodando sem contexto da aplicacao.`);
        return '';
    }
}
/** Rotulo do modelo LLM ativo, para o relatorio. */
function llmLabel() {
    switch (config_1.config.llmProvider) {
        case 'openrouter': return `openrouter/${config_1.config.openrouterModel}`;
        case 'anthropic': return config_1.config.llmModel;
        case 'ollama': return `ollama/${config_1.config.ollamaModel}`;
        default: return config_1.config.llmProvider;
    }
}
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
    console.log(`  MAX_REACT_ITER   : ${config_1.config.maxReactIterations}`);
    console.log(`  MAX_COST_USD     : ${config_1.config.maxCostUSD > 0
        ? '$' + config_1.config.maxCostUSD : '(desativado — só limita por iterações)'}`);
    console.log(`  SESSION_CACHE    : ${config_1.config.sessionCache}${config_1.config.forceReauth ? ' (FORCE_REAUTH=true — vai reautenticar)' : ''}`);
    console.log(`  APP_CONTEXT_FILE : ${config_1.config.appContextFile || '(nenhum)'}`);
    console.log(`  Alvo (targetUrl) : ${config_1.config.targetUrl}\n`);
    // Contexto da aplicacao (opcional): anexado ao system prompt para o LLM
    // separar vulnerabilidade real de caso de uso legitimo.
    const appContext = loadAppContext();
    if (!readOnly && !interactive) {
        console.warn('[AVISO] READ_ONLY=false e INTERACTIVE=false — nenhuma proteção ativa. ' +
            'Isso equivale ao modo oficial. Continue apenas se for intencional.\n');
    }
    const extractor = new ProductionPerception_1.ProductionPerception();
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
        dispatcher.applyAuthContext(appMap.auth);
        // Handoff da sessao de browser (cookies + localStorage/sessionStorage)
        // para o browser do Actor. Sem isso, as acoes `navigate` do ReActAgent
        // sobem num browser limpo e sao redirecionadas de volta ao login em
        // alvos OAuth/SSO — mesmo com o AppMap.auth preenchido.
        const browserSession = extractor.getBrowserSession();
        if (browserSession) {
            await dispatcher.applyBrowserSession(browserSession);
            console.log('[Executor] Sessao de browser propagada ao Actor.\n');
        }
        else {
            console.warn('[Executor] Nenhuma sessao de browser capturada para o handoff — ' +
                'as navegacoes do agente podem cair no login. Use INTERACTIVE_LOGIN ' +
                'ou MANUAL_COOKIES para autenticar.\n');
        }
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
        // Priorização da superfície de ataque (só no caminho de produção).
        // Em app real a Percepção descobre centenas de endpoints; o resumo
        // enviado ao LLM lista apenas os primeiros N. Reordenamos por RISCO
        // para que os N que sobrevivem ao corte sejam os mais promissores,
        // e elevamos N (PROD_MAX_ENDPOINTS, default 80). Nada é descartado —
        // só a ordem muda. O baseline do TCC (src/index.ts) não passa por aqui.
        const prioritizedAppMap = (0, SurfacePrioritizer_1.prioritizeAppMap)(appMap);
        const maxEndpoints = parseInt(process.env.PROD_MAX_ENDPOINTS ?? '80', 10);
        if (process.env.PROD_LOG_PRIORITIZATION === 'true') {
            const top = (0, SurfacePrioritizer_1.rankEndpoints)(appMap.apiEndpoints).slice(0, 10);
            console.log('[Priorização] Top endpoints por risco:');
            top.forEach((r, i) => console.log(`  ${String(i + 1).padStart(2)}. [score ${r.score}] ${r.endpoint.method} ` +
                `${r.endpoint.url}  (${r.reasons.join('; ')})`));
            console.log('');
        }
        const result = await agent.run(prioritizedAppMap, {
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
            // Contexto da aplicação (APP_CONTEXT_FILE): reduz falso-positivo
            // ajudando o LLM a distinguir vuln real de caso de uso legítimo.
            appContext,
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
        const sessionReused = appMap.auth.userEmail === '(sessao em cache)';
        saveReport(result, abuseFindings, zapFindings, allFindings, sessionReused);
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
    console.log(`Custo estimado (LLM) : $${agentResult.totalCostUSD.toFixed(4)}${config_1.config.maxCostUSD > 0 ? ` / $${config_1.config.maxCostUSD} (orçamento)` : ''}`);
    console.log(`Encerramento limpo   : ${agentResult.finishedCleanly ? 'sim' : 'não'}`);
    console.log(`Findings (ReAct)     : ${agentResult.findings.length}`);
    console.log(`Findings (AbuseCases): ${abuseFindings.length}`);
    console.log(`Findings (ZAP)       : ${zapFindings.length}`);
    console.log(`Total (deduplicado)  : ${allFindings.length}`);
    console.log(divider);
    if (allFindings.length === 0) {
        console.log('\nNenhuma vulnerabilidade encontrada.');
        if ((0, ReActAgent_2.summaryClaimsVulnerabilities)(agentResult.summary)) {
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
function saveReport(agentResult, abuseFindings, zapFindings, allFindings, sessionReused = false) {
    const reportsDir = path.join(__dirname, '..', '..', 'reports');
    if (!fs.existsSync(reportsDir)) {
        fs.mkdirSync(reportsDir, { recursive: true });
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = path.join(reportsDir, `report-production-${timestamp}.json`);
    const mdFilename = path.join(reportsDir, `report-production-${timestamp}.md`);
    // Warning anti-alucinacao: se o summary do finish afirma vulnerabilidades
    // mas nenhum finding estruturado foi materializado, adiciona um flag
    // explicito no relatorio. Segunda linha de defesa; a primeira e o guard
    // no ReActAgent que rejeita finish nessas condicoes, mas se o LLM
    // insistir apos os retries e conseguir emitir mesmo assim, o warning
    // sinaliza ao leitor do relatorio.
    const suspectedHallucination = allFindings.length === 0 && (0, ReActAgent_2.summaryClaimsVulnerabilities)(agentResult.summary);
    if (suspectedHallucination) {
        console.warn('\n[AVISO] O summary do agente contem afirmacoes de vulnerabilidades ' +
            'mas nenhum finding estruturado foi materializado. Provavel alucinacao ' +
            'do LLM. Nao confie no summary sem verificar os steps manualmente.\n');
    }
    const report = {
        mode: 'production',
        generatedAt: new Date().toISOString(),
        target: config_1.config.targetUrl,
        llmModel: llmLabel(),
        summary: agentResult.summary,
        finishedCleanly: agentResult.finishedCleanly,
        totalIterations: agentResult.totalIterations,
        costUSD: agentResult.totalCostUSD,
        warnings: suspectedHallucination ? [
            'suspected-hallucination: summary claims vulnerabilities but no ' +
                'structured findings were emitted via Action:report_finding. Do not ' +
                'trust the summary at face value; review the steps array manually to ' +
                'verify each claim against actual HTTP responses recorded.'
        ] : [],
        config: {
            readOnly: parseEnvBool('READ_ONLY', false),
            interactive: parseEnvBool('INTERACTIVE', true),
            rateLimitMs: parseEnvNumber('RATE_LIMIT_MS', 500),
            sessionReused,
            maxReactIterations: config_1.config.maxReactIterations,
            maxCostUSD: config_1.config.maxCostUSD,
        },
        findingsSummary: {
            reactAgent: agentResult.findings.length,
            abuseCases: abuseFindings.length,
            zapPassive: zapFindings.length,
            total: allFindings.length,
        },
        findings: allFindings,
        // O JSON trunca a observation em 500 chars (baseline). O Markdown,
        // gerado a partir do MESMO objeto, herda esse corte — mantendo o
        // relatorio legivel e os dois artefatos consistentes.
        steps: agentResult.steps.map((s) => ({
            iteration: s.iteration,
            thought: s.thought,
            action: s.action,
            observation: s.observation.substring(0, 500),
            timestamp: s.timestamp,
        })),
    };
    fs.writeFileSync(filename, JSON.stringify(report, null, 2), 'utf-8');
    console.log(`\nRelatório (JSON) salvo em: ${filename}`);
    try {
        fs.writeFileSync(mdFilename, (0, report_render_1.renderMarkdownReport)(report), 'utf-8');
        console.log(`Relatório (Markdown) salvo em: ${mdFilename}`);
    }
    catch (err) {
        console.warn(`Falha ao gerar relatório Markdown: ${err.message}`);
    }
}
main().catch((err) => {
    console.error('[ERRO NÃO TRATADO]', err);
    process.exit(1);
});
//# sourceMappingURL=production-runner.js.map