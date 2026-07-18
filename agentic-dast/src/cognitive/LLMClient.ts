/**
 * cognitive/LLMClient.ts
 * ---------------------------------------------------------------
 * Abstração mínima sobre o provedor de LLM.
 *
 * Permite alternar entre três back-ends sem mexer no ReActAgent:
 *   • OpenRouterClient → proxy que dá acesso a Claude, GPT-4 e outros
 *                        com uma única chave (formato compatível OpenAI)
 *   • AnthropicClient  → API da Anthropic (Claude), com Prompt Caching
 *   • OllamaClient     → modelo local servido pelo Ollama (free)
 *
 * Seleção via variável de ambiente:
 *   LLM_PROVIDER=openrouter  (default — experimentos finais)
 *   LLM_PROVIDER=anthropic   (chamada direta à API da Anthropic)
 *   LLM_PROVIDER=ollama      (smoke tests sem custo)
 * ---------------------------------------------------------------
 */

import Anthropic from '@anthropic-ai/sdk';
import axios from 'axios';
import { config } from '../config';

// ===========================================================
// Tipos
// ===========================================================

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface LLMClient {
  /** Envia (system + histórico) ao modelo e retorna a resposta de texto */
  chat(systemPrompt: string, history: ChatMessage[]): Promise<string>;

  /** Identificador legível para logging e relatórios */
  readonly name: string;
}

// ===========================================================
// Implementação 1: OpenRouter (proxy multi-provedor)
// ===========================================================
// A API do OpenRouter é compatível com o formato /chat/completions
// do OpenAI, então usamos axios diretamente em vez de instalar
// mais uma SDK. Uma única chave dá acesso a modelos da Anthropic,
// OpenAI, Google, Meta e outros — o modelo é escolhido pelo campo
// 'model' no corpo da requisição (ex.: 'anthropic/claude-haiku-4.5').

class OpenRouterClient implements LLMClient {
  readonly name: string;
  private readonly apiKey: string;
  private readonly model:  string;
  private readonly baseUrl: string;

  constructor() {
    this.apiKey  = config.openrouterApiKey;
    this.model   = config.openrouterModel;
    this.baseUrl = config.openrouterUrl;
    this.name    = `openrouter/${this.model}`;
  }

  async chat(systemPrompt: string, history: ChatMessage[]): Promise<string> {
    try {
      const response = await axios.post(
        `${this.baseUrl}/chat/completions`,
        {
          model: this.model,
          max_tokens: 2048,
          messages: [
            { role: 'system', content: systemPrompt },
            ...history,
          ],
        },
        {
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type':  'application/json',
            // Identificação da aplicação (recomendado pelo OpenRouter
            // para aparecer no dashboard de uso — não é obrigatório)
            'HTTP-Referer':  'https://github.com/estermorais/Agentic-DAST',
            'X-Title':       'Agentic DAST (TCC CEFET-MG)',
          },
          timeout: 120_000,
          validateStatus: () => true,
        },
      );

      if (response.status >= 400) {
        const errMsg = response.data?.error?.message
          ?? JSON.stringify(response.data).substring(0, 500);
        throw new Error(`OpenRouter HTTP ${response.status}: ${errMsg}`);
      }

      const content = response.data?.choices?.[0]?.message?.content;
      if (typeof content !== 'string') {
        throw new Error(
          `OpenRouter retornou resposta inesperada: ${JSON.stringify(response.data).substring(0, 500)}`,
        );
      }
      return content;
    } catch (err) {
      if (axios.isAxiosError(err) && err.response) {
        const data = err.response.data;
        const errMsg = (data as { error?: { message?: string } })?.error?.message
          ?? JSON.stringify(data).substring(0, 500);
        throw new Error(`OpenRouter HTTP ${err.response.status}: ${errMsg}`);
      }
      throw err;
    }
  }
}

// ===========================================================
// Implementação 2: Anthropic (Claude, chamada direta)
// ===========================================================

class AnthropicClient implements LLMClient {
  readonly name: string;
  private readonly client: Anthropic;

  constructor() {
    this.client = new Anthropic({ apiKey: config.anthropicApiKey });
    this.name   = `anthropic/${config.llmModel}`;
  }

  async chat(systemPrompt: string, history: ChatMessage[]): Promise<string> {
    const response = await this.client.messages.create({
      model: config.llmModel,
      max_tokens: 2048,
      system: [
        {
          type: 'text',
          text: systemPrompt,
          // Prompt Caching: o system é estático entre iterações e
          // será cobrado apenas na 1ª chamada (até 90% de economia).
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: history,
    });

    return response.content[0]?.type === 'text' ? response.content[0].text : '';
  }
}

// ===========================================================
// Implementação 3: Ollama (LLM local — free)
// ===========================================================

class OllamaClient implements LLMClient {
  readonly name: string;
  private readonly baseUrl: string;
  private readonly model:   string;

  constructor() {
    this.baseUrl = config.ollamaUrl;
    this.model   = config.ollamaModel;
    this.name    = `ollama/${this.model}`;
  }

  async chat(systemPrompt: string, history: ChatMessage[]): Promise<string> {
    try {
      const response = await axios.post(
        `${this.baseUrl}/api/chat`,
        {
          model:   this.model,
          stream:  false,
          messages: [
            { role: 'system', content: systemPrompt },
            ...history,
          ],
          options: {
            // Janela de contexto: 16K — balanço entre acomodar AppMap +
            // histórico do loop ReAct (~10-12K) e não estourar RAM em
            // máquinas com 8 GB. Qwen 2.5 e Llama 3.2 suportam até 128K
            // mas o KV-cache cresce linearmente com num_ctx.
            num_ctx: 16384,
            temperature: 1.0,
          },
        },
        {
          // 10 minutos: a 1ª chamada inclui carga do modelo na RAM (~30-90s
          // no Windows + CPU) e cada inferência subsequente pode levar 30-120s
          // dependendo do tamanho do histórico. Com Claude esse timeout seria
          // 30s, mas Ollama local em CPU é bem mais lento.
          timeout: 600_000,
          // Não rejeita automaticamente em status >= 400 — deixa a gente
          // extrair a mensagem de erro do corpo da resposta
          validateStatus: () => true,
        },
      );

      // Tratamento explícito de erros com a mensagem real do Ollama
      if (response.status >= 400) {
        const errMsg = response.data?.error
          ?? JSON.stringify(response.data).substring(0, 500);
        throw new Error(`Ollama HTTP ${response.status}: ${errMsg}`);
      }

      const content = response.data?.message?.content;
      if (typeof content !== 'string') {
        throw new Error(`Ollama retornou resposta inesperada: ${JSON.stringify(response.data).substring(0, 500)}`);
      }
      return content;
    } catch (err) {
      // Re-emite o erro com mensagem útil em vez do stack trace genérico do axios
      if (axios.isAxiosError(err) && err.response) {
        const data = err.response.data;
        const errMsg = (data as { error?: string })?.error
          ?? JSON.stringify(data).substring(0, 500);
        throw new Error(`Ollama HTTP ${err.response.status}: ${errMsg}`);
      }
      throw err;
    }
  }
}

// ===========================================================
// Factory
// ===========================================================

/**
 * Cria a instância de LLMClient apropriada com base na variável
 * de ambiente LLM_PROVIDER.
 */
export function createLLMClient(): LLMClient {
  switch (config.llmProvider) {
    case 'openrouter':
      return new OpenRouterClient();
    case 'anthropic':
      return new AnthropicClient();
    case 'ollama':
      return new OllamaClient();
    default:
      throw new Error(
        `LLM_PROVIDER desconhecido: "${config.llmProvider}". ` +
        `Use "openrouter", "anthropic" ou "ollama".`,
      );
  }
}
