/**
 * cognitive/LLMClient.ts
 * ---------------------------------------------------------------
 * Abstração mínima sobre o provedor de LLM.
 *
 * Permite alternar entre dois back-ends sem mexer no ReActAgent:
 *   • AnthropicClient  → API da Anthropic (Claude), com Prompt Caching
 *   • OllamaClient     → modelo local servido pelo Ollama (free)
 *
 * Seleção via variável de ambiente:
 *   LLM_PROVIDER=anthropic   (default — usado nos experimentos finais)
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
// Implementação 1: Anthropic (Claude)
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
// Implementação 2: Ollama (LLM local — free)
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
            // Janela de contexto: 32K para acomodar AppMap completo + histórico
            // (Qwen 2.5 suporta até 128K; 32K cobre casos reais com folga)
            num_ctx: 32768,
            // Temperatura padrão (mantém variabilidade similar ao Claude)
            temperature: 1.0,
          },
        },
        {
          timeout: 180_000,
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
    case 'ollama':
      return new OllamaClient();
    case 'anthropic':
      return new AnthropicClient();
    default:
      throw new Error(
        `LLM_PROVIDER desconhecido: "${config.llmProvider}". Use "anthropic" ou "ollama".`,
      );
  }
}
