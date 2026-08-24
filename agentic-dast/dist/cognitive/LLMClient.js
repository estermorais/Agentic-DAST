"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createLLMClient = createLLMClient;
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
const axios_1 = __importDefault(require("axios"));
const config_1 = require("../config");
// ===========================================================
// Implementação 1: OpenRouter (proxy multi-provedor)
// ===========================================================
// A API do OpenRouter é compatível com o formato /chat/completions
// do OpenAI, então usamos axios diretamente em vez de instalar
// mais uma SDK. Uma única chave dá acesso a modelos da Anthropic,
// OpenAI, Google, Meta e outros — o modelo é escolhido pelo campo
// 'model' no corpo da requisição (ex.: 'anthropic/claude-haiku-4.5').
class OpenRouterClient {
    name;
    apiKey;
    model;
    baseUrl;
    constructor() {
        this.apiKey = config_1.config.openrouterApiKey;
        this.model = config_1.config.openrouterModel;
        this.baseUrl = config_1.config.openrouterUrl;
        this.name = `openrouter/${this.model}`;
    }
    async chat(systemPrompt, history) {
        try {
            const response = await axios_1.default.post(`${this.baseUrl}/chat/completions`, {
                model: this.model,
                max_tokens: 2048,
                messages: [
                    // Prompt Caching estilo Anthropic via OpenRouter: o campo
                    // 'content' de string vira array de blocos com cache_control
                    // ephemeral no primeiro. O system prompt (~10k tokens, 677
                    // linhas em prompts.ts) e imutavel entre as ~25-40 iteracoes
                    // do ReAct — cachea-lo economiza ~70-90% do custo total do
                    // Cenario C. Sem esse header o system era faturado
                    // integralmente a cada iteracao.
                    //
                    // Docs: https://openrouter.ai/docs/features/prompt-caching
                    //       https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
                    {
                        role: 'system',
                        content: [
                            {
                                type: 'text',
                                text: systemPrompt,
                                cache_control: { type: 'ephemeral' },
                            },
                        ],
                    },
                    ...history,
                ],
            }, {
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json',
                    // Identificação da aplicação (recomendado pelo OpenRouter
                    // para aparecer no dashboard de uso — não é obrigatório)
                    'HTTP-Referer': 'https://github.com/estermorais/Agentic-DAST',
                    'X-Title': 'Agentic DAST (TCC CEFET-MG)',
                },
                timeout: 120_000,
                validateStatus: () => true,
            });
            if (response.status >= 400) {
                const errMsg = response.data?.error?.message
                    ?? JSON.stringify(response.data).substring(0, 500);
                throw new Error(`OpenRouter HTTP ${response.status}: ${errMsg}`);
            }
            const content = response.data?.choices?.[0]?.message?.content;
            if (typeof content !== 'string') {
                throw new Error(`OpenRouter retornou resposta inesperada: ${JSON.stringify(response.data).substring(0, 500)}`);
            }
            // Telemetria de custo por chamada — instrumentacao para diagnosticar
            // se o prompt caching esta funcionando via OpenRouter. Precos de
            // referencia (anthropic/claude-haiku-4.5 no OpenRouter, USD/MTok):
            //   input regular : 1.00
            //   cache write   : 1.25 (default_write nao vem explicito na resposta)
            //   cache read    : 0.10 (~90% de desconto sobre input regular)
            //   output        : 5.00
            const usage = response.data?.usage;
            if (usage) {
                const inputTotal = usage.prompt_tokens ?? 0;
                const cacheRead = usage.prompt_tokens_details?.cached_tokens ?? 0;
                const cacheWrite = usage.prompt_tokens_details?.cache_creation_input_tokens ?? 0;
                const inputRegular = Math.max(0, inputTotal - cacheRead - cacheWrite);
                const output = usage.completion_tokens ?? 0;
                const costUSD = (inputRegular * 1.00 + cacheWrite * 1.25 + cacheRead * 0.10 + output * 5.00) / 1_000_000;
                const cacheHit = inputTotal > 0 ? (cacheRead / inputTotal * 100).toFixed(0) : '0';
                console.log(`  [LLM] input=${inputTotal} (cache_read=${cacheRead}/${cacheHit}%, ` +
                    `cache_write=${cacheWrite}, regular=${inputRegular}) ` +
                    `output=${output} custo≈$${costUSD.toFixed(4)}`);
            }
            return content;
        }
        catch (err) {
            if (axios_1.default.isAxiosError(err) && err.response) {
                const data = err.response.data;
                const errMsg = data?.error?.message
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
// Implementação 3: Ollama (LLM local — free)
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
// Claude Code CLI (usa assinatura Claude Pro autenticada via OAuth)
// ===========================================================
/**
 * Cliente que invoca o Claude Code CLI local via subprocess. Nao
 * consome API key comprada — usa a assinatura Claude Pro autenticada
 * previamente no CLI (`claude login`). Adicionado para permitir que
 * o red team execute o framework sem custo adicional de creditos.
 *
 * Trade-offs importantes:
 *   - Rate limit da assinatura Pro pode bater durante rodadas longas.
 *   - Cada iteracao spawna um subprocess (overhead ~1s versus API REST).
 *   - Prompt caching Anthropic-style nao funciona por este canal.
 *   - Para dados comparaveis cientificamente com a rodada oficial n=30
 *     do TCC 2, use LLM_MODEL=claude-haiku-4-5-20251001 (mesmo modelo).
 *     Outros modelos (Sonnet, Opus) sao aceitos mas mudam o objeto de
 *     estudo — o desempenho medido reflete o modelo escolhido, nao o
 *     mesmo LLM que gerou os resultados publicados do TCC.
 */
class ClaudeCliClient {
    name;
    model;
    constructor() {
        this.model = config_1.config.llmModel;
        this.name = `claude-cli/${this.model}`;
    }
    async chat(systemPrompt, history) {
        // O CLI aceita um unico prompt; concatenamos system + historico em
        // um bloco monolitico marcando os papeis com prefixos textuais que
        // o modelo reconhece pela convencao ChatML-like.
        const parts = [];
        parts.push(`SYSTEM:\n${systemPrompt}\n`);
        for (const msg of history) {
            const label = msg.role === 'user' ? 'USER' : 'ASSISTANT';
            parts.push(`${label}:\n${msg.content}\n`);
        }
        parts.push('ASSISTANT:\n');
        const fullPrompt = parts.join('\n');
        // Invoca o CLI. Requer `claude` no PATH e login OAuth previo.
        const { spawn } = await Promise.resolve().then(() => __importStar(require('child_process')));
        const cliArgs = ['-p', '--model', this.model, '--output-format', 'text'];
        return new Promise((resolve, reject) => {
            const proc = spawn('claude', cliArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
            let stdout = '';
            let stderr = '';
            proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
            proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
            proc.on('error', (err) => {
                reject(new Error(`Falha ao invocar Claude Code CLI: ${err.message}. ` +
                    `Verifique que o binario 'claude' esta no PATH e que voce fez ` +
                    `login com 'claude login'.`));
            });
            proc.on('close', (code) => {
                if (code !== 0) {
                    // Muitas versoes do CLI escrevem erros no stdout (nao stderr)
                    // e as vezes ambos ficam vazios (erro apenas via exit code).
                    // Mostramos tudo que temos + o comando executado, para o
                    // operador conseguir reproduzir e diagnosticar manualmente.
                    const cmdShown = `claude ${cliArgs.join(' ')}`;
                    const detailParts = [];
                    if (stderr.trim())
                        detailParts.push(`stderr:\n${stderr.substring(0, 800)}`);
                    if (stdout.trim())
                        detailParts.push(`stdout:\n${stdout.substring(0, 800)}`);
                    if (!detailParts.length)
                        detailParts.push('(nenhuma saida em stdout nem stderr — provavelmente CLI nao logado, ' +
                            'quota Pro esgotada, ou flag/modelo invalido)');
                    reject(new Error(`Claude Code CLI encerrou com codigo ${code}.\n` +
                        `Comando: ${cmdShown}\n` +
                        detailParts.join('\n\n') + '\n\n' +
                        `Reproduza manualmente:\n` +
                        `  echo "teste" | ${cmdShown}\n` +
                        `Se nao funcionar, tente ` +
                        `'claude login' e 'claude --version' para diagnosticar.`));
                    return;
                }
                resolve(stdout.trim());
            });
            // Envia o prompt via stdin
            proc.stdin.write(fullPrompt);
            proc.stdin.end();
        });
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
        case 'openrouter':
            return new OpenRouterClient();
        case 'anthropic':
            return new AnthropicClient();
        case 'ollama':
            return new OllamaClient();
        case 'claude-cli':
            return new ClaudeCliClient();
        default:
            throw new Error(`LLM_PROVIDER desconhecido: "${config_1.config.llmProvider}". ` +
                `Use "openrouter", "anthropic", "ollama" ou "claude-cli".`);
    }
}
//# sourceMappingURL=LLMClient.js.map