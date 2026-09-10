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
    openrouterModel: optional('OPENROUTER_MODEL', 'anthropic/claude-haiku-4.5'),
    openrouterUrl: optional('OPENROUTER_URL', 'https://openrouter.ai/api/v1'),
    // ── Anthropic (chamada direta, alternativa ao OpenRouter) ──
    anthropicApiKey: llmProvider === 'anthropic'
        ? required('ANTHROPIC_API_KEY')
        : optional('ANTHROPIC_API_KEY', ''),
    llmModel: optional('LLM_MODEL', 'claude-haiku-4-5-20251001'),
    // ── Ollama (LLM local) ─────────────────────────────────────
    ollamaUrl: optional('OLLAMA_URL', 'http://localhost:11434'),
    ollamaModel: optional('OLLAMA_MODEL', 'qwen2.5:7b'),
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
    useZapProxy: _useZapProxy,
    // ALLOW_LOGOUT_NAV: por padrao (false) o browser do Actor RECUSA
    // navegar ou clicar para paginas de logout/signout/sair. Isso evita
    // que o agente destrua a sessao autenticada (o alvo invalida o
    // token/cookie e as proximas acoes caem no login). Defina 'true'
    // apenas se o objetivo do teste for exatamente exercitar o logout
    // (ex.: session fixation, verificar invalidacao de token).
    allowLogoutNavigation: optional('ALLOW_LOGOUT_NAV', 'false').toLowerCase() === 'true',
};
//# sourceMappingURL=config.js.map