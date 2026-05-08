"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createLLMClient = createLLMClient;
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
const axios_1 = __importDefault(require("axios"));
const config_1 = require("../config");
// ===========================================================
// Implementação 1: Anthropic (Claude)
// ===========================================================
class AnthropicClient {
    name;
    client;
    constructor() {
        this.client = new sdk_1.default({ apiKey: config_1.config.anthropicApiKey });
        this.name = `anthropic/${config_1.config.llmModel}`;
    }
    async chat(systemPrompt, history) {
        const response = await this.client.messages.create({
            model: config_1.config.llmModel,
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
class OllamaClient {
    name;
    baseUrl;
    model;
    constructor() {
        this.baseUrl = config_1.config.ollamaUrl;
        this.model = config_1.config.ollamaModel;
        this.name = `ollama/${this.model}`;
    }
    async chat(systemPrompt, history) {
        try {
            const response = await axios_1.default.post(`${this.baseUrl}/api/chat`, {
                model: this.model,
                stream: false,
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
            }, {
                // 10 minutos: a 1ª chamada inclui carga do modelo na RAM (~30-90s
                // no Windows + CPU) e cada inferência subsequente pode levar 30-120s
                // dependendo do tamanho do histórico. Com Claude esse timeout seria
                // 30s, mas Ollama local em CPU é bem mais lento.
                timeout: 600_000,
                // Não rejeita automaticamente em status >= 400 — deixa a gente
                // extrair a mensagem de erro do corpo da resposta
                validateStatus: () => true,
            });
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
        }
        catch (err) {
            // Re-emite o erro com mensagem útil em vez do stack trace genérico do axios
            if (axios_1.default.isAxiosError(err) && err.response) {
                const data = err.response.data;
                const errMsg = data?.error
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
function createLLMClient() {
    switch (config_1.config.llmProvider) {
        case 'ollama':
            return new OllamaClient();
        case 'anthropic':
            return new AnthropicClient();
        default:
            throw new Error(`LLM_PROVIDER desconhecido: "${config_1.config.llmProvider}". Use "anthropic" ou "ollama".`);
    }
}
//# sourceMappingURL=LLMClient.js.map