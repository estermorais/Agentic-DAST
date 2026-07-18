/**
 * config.ts
 * ---------------------------------------------------------------
 * Centraliza todas as configurações do sistema.
 * Lê do arquivo .env (via dotenv) e valida os campos obrigatórios.
 * ---------------------------------------------------------------
 */

import * as dotenv from 'dotenv';
dotenv.config();

function required(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Variável de ambiente obrigatória não definida: ${key}`);
  }
  return value;
}

function optional(key: string, defaultValue: string): string {
  return process.env[key] ?? defaultValue;
}

// Provedor de LLM
const llmProvider = optional('LLM_PROVIDER', 'openrouter') as
  'anthropic' | 'ollama' | 'openrouter';

export const config = {
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
  openrouterUrl:   optional('OPENROUTER_URL',   'https://openrouter.ai/api/v1'),

  // ── Anthropic (chamada direta, alternativa ao OpenRouter) ──
  anthropicApiKey: llmProvider === 'anthropic'
    ? required('ANTHROPIC_API_KEY')
    : optional('ANTHROPIC_API_KEY', ''),
  llmModel: optional('LLM_MODEL', 'claude-haiku-4-5-20251001'),

  // ── Ollama (LLM local) ─────────────────────────────────────
  ollamaUrl:   optional('OLLAMA_URL',   'http://localhost:11434'),
  ollamaModel: optional('OLLAMA_MODEL', 'qwen2.5:7b'),

  // ── Alvo ───────────────────────────────────────────────────
  // URL do alvo do ponto de vista do HOST (browser, agente, axios)
  targetUrl: optional('TARGET_URL', 'http://localhost:3000'),
  // URL do alvo do ponto de vista do CONTÊINER ZAP — necessária porque
  // 'localhost' dentro do container ZAP é ele próprio, não o Juice Shop.
  // O nome 'juice-shop' resolve via Docker network 'dast-net'.
  zapTargetUrl: optional('ZAP_TARGET_URL', 'http://juice-shop:3000'),

  // ── ZAP ────────────────────────────────────────────────────
  zapApiUrl:    optional('ZAP_API_URL', 'http://localhost:8080'),
  zapApiKey:    optional('ZAP_API_KEY', 'zapkey123'),
  zapProxyHost: optional('ZAP_PROXY_HOST', 'localhost'),
  zapProxyPort: parseInt(optional('ZAP_PROXY_PORT', '8888')),

  // ── Comportamento do agente ────────────────────────────────
  maxReactIterations: parseInt(optional('MAX_REACT_ITERATIONS', '25')),
  useZapProxy:        optional('USE_ZAP_PROXY', 'true') === 'true',
} as const;
