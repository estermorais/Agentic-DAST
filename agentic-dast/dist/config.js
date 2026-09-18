"use strict";
/**
 * config.ts
 * ---------------------------------------------------------------
 * Centraliza todas as configurações do sistema.
 * Lê do arquivo .env (via dotenv) e valida os campos obrigatórios.
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
exports.config = void 0;
const dotenv = __importStar(require("dotenv"));
dotenv.config();
function required(key) {
    const value = process.env[key];
    if (!value) {
        throw new Error(`Variável de ambiente obrigatória não definida: ${key}`);
    }
    return value;
}
function optional(key, defaultValue) {
    return process.env[key] ?? defaultValue;
}
// Provedor de LLM
const llmProvider = optional('LLM_PROVIDER', 'openrouter');
// Variaveis pre-computadas usadas em campos derivados abaixo.
const _targetUrl = optional('TARGET_URL', 'http://localhost:3000');
const _zapTargetUrl = optional('ZAP_TARGET_URL', 'http://juice-shop:3000');
const _useZapProxy = optional('USE_ZAP_PROXY', 'true') === 'true';
// Modelo do OpenRouter — usado tanto no campo openrouterModel quanto para
// derivar as tarifas default da telemetria de custo (Kimi vs Haiku).
const _openrouterModel = optional('OPENROUTER_MODEL', 'anthropic/claude-haiku-4.5');
const _isMoonshot = /moonshot|kimi/i.test(_openrouterModel);
exports.config = {
    // ── Provedor de LLM ────────────────────────────────────────
    // Aceita:
    //   'openrouter' (default, proxy que dá acesso a Claude, GPT-4, etc.
    //                 com uma única chave — usado nos experimentos finais)
    //   'anthropic'  (chamada direta à API da Anthropic, requer conta paga)
    //   'ollama'     (LLM local, smoke tests sem custo)
    llmProvider,
    // ── OpenRouter ─────────────────────────────────────────────
    // Proxy que expõe Claude, GPT-4, Gemini e outros com API compatível
    // com o formato OpenAI. Chave obtida em https://openrouter.ai/keys
    openrouterApiKey: llmProvider === 'openrouter'
        ? required('OPENROUTER_API_KEY')
        : optional('OPENROUTER_API_KEY', ''),
    openrouterModel: _openrouterModel,
    openrouterUrl: optional('OPENROUTER_URL', 'https://openrouter.ai/api/v1'),
    // ── Tarifas USD/MTok para a telemetria de custo ([LLM] custo≈$) ──
    // O default deriva do modelo: quando OPENROUTER_MODEL casa moonshot/kimi,
    // usa as tarifas do Kimi (input 0.71 / output 3.21 / cache read 0.18);
    // caso contrario mantem as do Claude Haiku 4.5 (1.00 / 5.00 / 0.10), que
    // eram as chumbadas antes. Sobrescreva por env para outros modelos. Isto
    // so afeta o LOG de custo, nao o comportamento do agente.
    llmPriceInput: parseFloat(optional('LLM_PRICE_INPUT', _isMoonshot ? '0.71' : '1.00')),
    llmPriceCacheRead: parseFloat(optional('LLM_PRICE_CACHE_READ', _isMoonshot ? '0.18' : '0.10')),
    llmPriceCacheWrite: parseFloat(optional('LLM_PRICE_CACHE_WRITE', _isMoonshot ? '0.71' : '1.25')),
    llmPriceOutput: parseFloat(optional('LLM_PRICE_OUTPUT', _isMoonshot ? '3.21' : '5.00')),
    // ── Anthropic (chamada direta, alternativa ao OpenRouter) ──
    anthropicApiKey: llmProvider === 'anthropic'
        ? required('ANTHROPIC_API_KEY')
        : optional('ANTHROPIC_API_KEY', ''),
    llmModel: optional('LLM_MODEL', 'claude-haiku-4-5-20251001'),
    // ── Temperatura dos provedores hospedados (OpenRouter/Anthropic) ──
    // O loop ReAct exige JSON estrito e disciplina anti-alucinacao — nao
    // e uma tarefa criativa. O default dos provedores hospedados e 1.0,
    // que aumenta variancia de formato e a chance de findings inventados.
    // Se LLM_TEMPERATURE estiver definida, ela e enviada nas requisicoes
    // OpenRouter/Anthropic; se NAO estiver, nada e enviado e o
    // comportamento fica identico ao historico (default 1.0 do provedor),
    // preservando byte-a-byte o baseline do TCC. Para producao, recomenda-se
    // LLM_TEMPERATURE=0.2 (ver src/production-mode/README.md). Ollama tem a
    // sua propria OLLAMA_TEMPERATURE (default 0.2) e ignora esta.
    llmTemperature: process.env.LLM_TEMPERATURE !== undefined
        ? parseFloat(process.env.LLM_TEMPERATURE)
        : undefined,
    // ── Ollama (LLM local) ─────────────────────────────────────
    ollamaUrl: optional('OLLAMA_URL', 'http://localhost:11434'),
    ollamaModel: optional('OLLAMA_MODEL', 'qwen2.5:7b'),
    // Temperatura baixa por padrao: o loop ReAct exige JSON estrito e
    // disciplina anti-alucinacao. 1.0 (o default antigo) gerava erro de
    // formato e findings inventados; ~0.2 estabiliza o comportamento.
    ollamaTemperature: parseFloat(optional('OLLAMA_TEMPERATURE', '0.2')),
    // Janela de contexto do Ollama. 16384 acomoda o prompt (~10-12k) +
    // historico em maquinas modestas; suba para 32768 quando tiver RAM
    // (ex.: 32 GB rodando um 32B) para evitar truncar o historico no meio
    // do loop. O KV-cache cresce linearmente com este valor.
    ollamaNumCtx: parseInt(optional('OLLAMA_NUM_CTX', '16384'), 10),
    // ── Autenticacao manual (para alvos com MFA ou SSO) ────────
    // Se qualquer uma destas variaveis estiver preenchida, o
    // DOMExtractor pula o fluxo de login automatico e usa os valores
    // fornecidos. Usado quando o alvo exige MFA/SSO/CAPTCHA que
    // Puppeteer nao consegue passar sozinho.
    //
    // MANUAL_JWT: valor do header Authorization (sem 'Bearer ').
    //   Obter em: DevTools -> Network -> request autenticada -> Headers.
    //
    // MANUAL_COOKIES: string no formato 'nome1=valor1; nome2=valor2'
    //   (mesmo formato do header Cookie que o browser envia).
    //   Obter em: DevTools -> Application -> Cookies -> copiar tudo.
    //   Injetado no Puppeteer (para navegacoes) e no HttpClient (para
    //   requests programaticas do agente).
    manualJwt: optional('MANUAL_JWT', ''),
    manualCookies: optional('MANUAL_COOKIES', ''),
    // INTERACTIVE_LOGIN: se 'true', o DOMExtractor abre o Chromium
    // visivel (headless=false), aguarda o operador logar manualmente
    // (senha + MFA + SSO como fizer no browser normal) e captura a
    // sessao resultante (cookies + JWT do localStorage) apos ENTER
    // no terminal. Alternativa ao MANUAL_JWT/MANUAL_COOKIES quando
    // e mais pratico logar interativamente do que colar tokens.
    interactiveLogin: optional('INTERACTIVE_LOGIN', 'false').toLowerCase() === 'true',
    // ── Cache de sessao (modo producao) ────────────────────────
    // SESSION_CACHE: se 'true' (default), a sessao capturada no login
    //   manual (INTERACTIVE_LOGIN) e salva CIFRADA em .session-cache/ e
    //   reaproveitada nas execucoes seguintes — se ainda for valida. Evita
    //   refazer o login (senha+MFA+SSO) a cada teste. So tem efeito no
    //   entrypoint de producao (production-runner.ts).
    sessionCache: optional('SESSION_CACHE', 'true').toLowerCase() === 'true',
    // FORCE_REAUTH: se 'true', ignora qualquer sessao em cache e forca o
    //   login manual de novo, sobrescrevendo a sessao salva. Use quando a
    //   sessao expirou de forma que a verificacao nao pegou, ou quando quer
    //   trocar de usuario/permissao.
    forceReauth: optional('FORCE_REAUTH', 'false').toLowerCase() === 'true',
    // SESSION_PASSPHRASE: senha para cifrar/decifrar a sessao salva. Se
    //   vazia, usa-se uma chave derivada da maquina (protege contra leitura
    //   casual do disco, nao contra um atacante com acesso a mesma conta).
    //   Defina para endurecer. Se mudar a passphrase, o cache antigo vira
    //   ilegivel e o login e refeito.
    sessionPassphrase: optional('SESSION_PASSPHRASE', ''),
    // SESSION_MAX_AGE_MIN: idade maxima (minutos) de uma sessao em cache
    //   antes de ser considerada velha e descartada sem sequer testar.
    //   Default 720 (12h). 0 = sem limite de idade (so a verificacao real
    //   decide).
    sessionMaxAgeMin: parseInt(optional('SESSION_MAX_AGE_MIN', '720'), 10),
    // ── Alvo ───────────────────────────────────────────────────
    // URL do alvo do ponto de vista do HOST (axios direto, relatório)
    targetUrl: _targetUrl,
    // URL do alvo do ponto de vista do CONTÊINER ZAP — necessária porque
    // 'localhost' dentro do container ZAP é ele próprio, não o Juice Shop.
    // O nome 'juice-shop' resolve via Docker network 'dast-net'.
    zapTargetUrl: _zapTargetUrl,
    // URL-base que o BROWSER (Puppeteer) usa nas navegacoes. Precisa ser
    // 'juice-shop:3000' quando o trafego passa pelo ZAP, porque o Chrome
    // envia a URL literal ao proxy e quem resolve o hostname destino e o
    // proprio ZAP (do interior do seu container). Sem proxy, cai em
    // localhost:3000 (que o host acessa direto via port mapping).
    browserBaseUrl: _useZapProxy ? _zapTargetUrl : _targetUrl,
    // ── ZAP ────────────────────────────────────────────────────
    zapApiUrl: optional('ZAP_API_URL', 'http://localhost:8080'),
    zapApiKey: optional('ZAP_API_KEY', 'zapkey123'),
    zapProxyHost: optional('ZAP_PROXY_HOST', 'localhost'),
    zapProxyPort: parseInt(optional('ZAP_PROXY_PORT', '8080')),
    // ── Comportamento do agente ────────────────────────────────
    maxReactIterations: parseInt(optional('MAX_REACT_ITERATIONS', '25')),
    // MAX_COST_USD: orcamento de gasto (USD) do loop ReAct. Quando > 0, o
    //   agente encerra assim que o custo acumulado das chamadas ao LLM
    //   ultrapassa esse valor — criterio de parada por dinheiro, alternativo/
    //   complementar ao MAX_REACT_ITERATIONS (o que vier primeiro para o
    //   loop). 0 = desativado (so o numero de iteracoes limita). So tem
    //   efeito com providers que medem custo (OpenRouter, Anthropic); em
    //   Ollama/claude-cli o custo e sempre 0 e este limite nunca dispara.
    maxCostUSD: parseFloat(optional('MAX_COST_USD', '0')),
    // APP_CONTEXT_FILE: caminho para um arquivo (texto/Markdown) que descreve
    //   o contexto da aplicacao-alvo — papeis/permissoes, o que e dado
    //   publico por design, fluxos esperados etc. E anexado ao system prompt
    //   para o LLM distinguir vulnerabilidade real de caso de uso legitimo
    //   (reduz falso-positivo). Vazio = sem contexto extra. So tem efeito no
    //   modo producao.
    appContextFile: optional('APP_CONTEXT_FILE', ''),
    useZapProxy: _useZapProxy,
    // ── Caps de tamanho de corpo nas Observations ──────────────
    // Defaults IDENTICOS ao comportamento historico: sem estas envs, as
    // Observations saem byte-a-byte iguais as do baseline do TCC. Em app
    // real, o corpo cortado em 1500/2000 impedia o recon de ler bundles JS
    // e o HTML completo; eleve por env no modo producao (ex.:
    // HTTP_MAX_BODY_CHARS=200000, READ_PAGE_MAX_CHARS=20000).
    httpMaxBodyChars: parseInt(optional('HTTP_MAX_BODY_CHARS', '1500'), 10),
    readPageMaxChars: parseInt(optional('READ_PAGE_MAX_CHARS', '2000'), 10),
    // Quando true, read_page inclui tambem o HTML-fonte (page.content), nao
    // so o innerText — necessario para achar <script src> de bundles no
    // recon (innerText nunca traz <script>). Default off (baseline intacto).
    readPageIncludeSource: optional('READ_PAGE_INCLUDE_SOURCE', 'false').toLowerCase() === 'true',
    // ALLOW_LOGOUT_NAV: por padrao (false) o browser do Actor RECUSA
    // navegar ou clicar para paginas de logout/signout/sair. Isso evita
    // que o agente destrua a sessao autenticada (o alvo invalida o
    // token/cookie e as proximas acoes caem no login). Defina 'true'
    // apenas se o objetivo do teste for exatamente exercitar o logout
    // (ex.: session fixation, verificar invalidacao de token).
    allowLogoutNavigation: optional('ALLOW_LOGOUT_NAV', 'false').toLowerCase() === 'true',
    // SKIP_AUTH_PROBE: por padrao (false) a Fase 1 de producao re-sonda
    // cada endpoint GET SEM sessao, para inferir o authRequired REAL. Sem
    // isso, como o crawl roda autenticado, todo endpoint retorna 200 e
    // aparece como authRequired:false (enganoso — parece publico, mas so
    // significa "minha sessao teve 200"). Defina 'true' para pular a
    // re-sondagem (menos trafego anonimo no alvo, mas authRequired volta
    // a ser so o derivado do crawl autenticado).
    skipAuthProbe: optional('SKIP_AUTH_PROBE', 'false').toLowerCase() === 'true',
    // ACTIVE_DISCOVERY: descoberta ativa na Fase 1 (opt-in, default off).
    // Quando 'true', alem do crawl passivo, a percepcao (a) baixa os
    // bundles JS da SPA e extrai caminhos de API por regex, e (b) sonda
    // uma lista curada de caminhos comuns (swagger/openapi/graphql/etc.).
    // Tudo GET-only, mesmo dominio, respeitando scope.excludePaths, com
    // rate limit. Default off porque adiciona trafego ativo ao alvo —
    // ligue deliberadamente quando quiser mapear mais superficie.
    activeDiscovery: optional('ACTIVE_DISCOVERY', 'false').toLowerCase() === 'true',
    // ── Backend claude-cli (LLM_PROVIDER=claude-cli) ───────────
    // CLAUDE_CLI_HARDEN: por padrao (true) o prompt de pentest e
    // injetado como system REAL via --append-system-prompt, com um
    // role-lock que impede o Claude Code de "quebrar o personagem" —
    // reconhecer que roda dentro do proprio Claude Code e recusar o
    // formato ReAct (observado com modelos mais capazes, ex.: Sonnet).
    // 'false' volta ao modo antigo (system concatenado no stdin).
    claudeCliHarden: optional('CLAUDE_CLI_HARDEN', 'true').toLowerCase() !== 'false',
    // CLAUDE_CLI_EXTRA_ARGS: args crus extras repassados ao binario
    // 'claude' (separados por espaco). Ex.: para desligar as tools do
    // Claude Code (reduz ainda mais a quebra de personagem) se a sua
    // versao do CLI suportar:
    //   CLAUDE_CLI_EXTRA_ARGS="--disallowedTools Bash,Edit,Write,Read"
    // Vazio = nenhum arg extra. Nao passe flags que a sua versao nao
    // reconheca — o CLI aborta a rodada.
    claudeCliExtraArgs: optional('CLAUDE_CLI_EXTRA_ARGS', ''),
};
//# sourceMappingURL=config.js.map