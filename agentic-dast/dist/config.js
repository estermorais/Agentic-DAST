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
const llmProvider = optional('LLM_PROVIDER', 'anthropic');
exports.config = {
    // ── Provedor de LLM ────────────────────────────────────────
    // Aceita: 'anthropic' (default, experimentos finais) ou 'ollama' (smoke tests)
    llmProvider,
    // ── Anthropic ──────────────────────────────────────────────
    // anthropicApiKey é obrigatório APENAS quando llmProvider === 'anthropic'
    anthropicApiKey: llmProvider === 'anthropic'
        ? required('ANTHROPIC_API_KEY')
        : optional('ANTHROPIC_API_KEY', ''),
    llmModel: optional('LLM_MODEL', 'claude-haiku-4-5-20251001'),
    // ── Ollama (LLM local) ─────────────────────────────────────
    ollamaUrl: optional('OLLAMA_URL', 'http://localhost:11434'),
    ollamaModel: optional('OLLAMA_MODEL', 'qwen2.5:7b'),
    // ── Alvo ───────────────────────────────────────────────────
    // URL do alvo do ponto de vista do HOST (browser, agente, axios)
    targetUrl: optional('TARGET_URL', 'http://localhost:3000'),
    // URL do alvo do ponto de vista do CONTÊINER ZAP — necessária porque
    // 'localhost' dentro do container ZAP é ele próprio, não o Juice Shop.
    // O nome 'juice-shop' resolve via Docker network 'dast-net'.
    zapTargetUrl: optional('ZAP_TARGET_URL', 'http://juice-shop:3000'),
    // ── ZAP ────────────────────────────────────────────────────
    zapApiUrl: optional('ZAP_API_URL', 'http://localhost:8080'),
    zapApiKey: optional('ZAP_API_KEY', 'zapkey123'),
    zapProxyHost: optional('ZAP_PROXY_HOST', 'localhost'),
    zapProxyPort: parseInt(optional('ZAP_PROXY_PORT', '8888')),
    // ── Comportamento do agente ────────────────────────────────
    maxReactIterations: parseInt(optional('MAX_REACT_ITERATIONS', '25')),
    useZapProxy: optional('USE_ZAP_PROXY', 'true') === 'true',
};
//# sourceMappingURL=config.js.map