"use strict";
/**
 * cognitive/ReActAgent.ts
 * ---------------------------------------------------------------
 * Módulo Cognitivo — implementa o loop ReAct usando a API Claude.
 *
 * O padrão ReAct (Yao et al., ICLR 2023) intercala raciocínio
 * (Thought) com ações (Action) e observações (Observation):
 *
 *   Thought → Action → [executor] → Observation → Thought → ...
 *
 * O LLM decide qual ação executar; o ActionDispatcher a executa
 * no mundo real (browser/HTTP); o resultado volta como Observation.
 * ---------------------------------------------------------------
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ReActAgent = void 0;
const config_1 = require("../config");
const prompts_1 = require("./prompts");
const LLMClient_1 = require("./LLMClient");
class ReActAgent {
    llm;
    dispatcher;
    conversationHistory = [];
    constructor(dispatcher, llm) {
        this.llm = llm ?? (0, LLMClient_1.createLLMClient)();
        this.dispatcher = dispatcher;
    }
    /**
     * Executa o loop ReAct completo dado um AppMap.
     * Retorna todas as vulnerabilidades encontradas e os passos tomados.
     */
    async run(appMap) {
        console.log('\n[Cognitivo] Iniciando loop ReAct...');
        console.log(`[Cognitivo] LLM: ${this.llm.name}`);
        console.log(`[Cognitivo] Máximo de iterações: ${config_1.config.maxReactIterations}\n`);
        const steps = [];
        // Primeira mensagem: o AppMap para o LLM analisar
        const initialMessage = (0, prompts_1.buildInitialUserMessage)(appMap);
        this.conversationHistory.push({
            role: 'user',
            content: initialMessage,
        });
        // Contador de falhas consecutivas de parser. Modelos capazes (Haiku,
        // GPT-4o, etc.) as vezes divagam em prosa quando o contexto cresce e
        // param de emitir 'Action:'. Em vez de encerrar na primeira falha
        // (comportamento antigo, custava as iteracoes restantes), damos ate
        // MAX_CONSECUTIVE_PARSE_FAILURES chances com feedback explicito para
        // reformatar. Se falhar N vezes em sequencia, ai sim encerra.
        const MAX_CONSECUTIVE_PARSE_FAILURES = 3;
        let consecutiveParseFailures = 0;
        for (let i = 1; i <= config_1.config.maxReactIterations; i++) {
            console.log(`\n[Cognitivo] ── Iteração ${i}/${config_1.config.maxReactIterations} ──`);
            // 1. Chama o LLM (Anthropic ou Ollama, transparente para o loop)
            const rawText = await this.llm.chat(prompts_1.SYSTEM_PROMPT, this.conversationHistory);
            console.log('[Cognitivo] LLM respondeu:\n', rawText.substring(0, 300), '...');
            // 2. Salva a resposta do assistente no histórico
            this.conversationHistory.push({
                role: 'assistant',
                content: rawText,
            });
            // 3. Parseia Thought + Action do texto
            const parsed = this.parseReActOutput(rawText);
            if (!parsed) {
                consecutiveParseFailures++;
                console.warn(`[Cognitivo] Parser falhou (${consecutiveParseFailures}/${MAX_CONSECUTIVE_PARSE_FAILURES}). ` +
                    `Solicitando reformatacao ao LLM.`);
                if (consecutiveParseFailures >= MAX_CONSECUTIVE_PARSE_FAILURES) {
                    console.warn('[Cognitivo] Excedeu falhas consecutivas de parser. Encerrando.');
                    return {
                        findings: this.dispatcher.getFindings(),
                        steps,
                        totalIterations: i,
                        finishedCleanly: false,
                        summary: `Parser falhou ${MAX_CONSECUTIVE_PARSE_FAILURES}x consecutivas ate a iteracao ${i}. ` +
                            `O modelo (${this.llm.name}) parou de seguir o formato ReAct.`,
                    };
                }
                // Feedback explicito para o LLM reformatar. Nao registra step
                // porque nao houve Action executada.
                this.conversationHistory.push({
                    role: 'user',
                    content: 'Sua ultima resposta nao pode ser parseada. Voce PRECISA seguir o ' +
                        'formato ReAct exato, mesmo ao resumir ou planejar:\n\n' +
                        'Thought: [seu raciocinio]\n' +
                        'Action: [nome_da_acao]\n' +
                        'Action Input:\n' +
                        '{ ... json valido ... }\n\n' +
                        'Acoes validas: make_request, navigate, fill_field, click_element, ' +
                        'read_page, extract_tokens, report_finding, finish.\n' +
                        'Se voce ja completou a analise, use Action: finish com um summary.',
                });
                continue;
            }
            // Parser passou — zera o contador.
            consecutiveParseFailures = 0;
            console.log(`[Cognitivo] Thought: ${parsed.thought.substring(0, 150)}...`);
            console.log(`[Cognitivo] Action: ${parsed.action.action}`);
            // 4. Verifica se o agente quer encerrar
            if (parsed.action.action === 'finish') {
                const summary = parsed.action.summary
                    ?? 'Testes concluídos.';
                console.log(`\n[Cognitivo] Agente encerrou: ${summary}`);
                return {
                    findings: this.dispatcher.getFindings(),
                    steps,
                    totalIterations: i,
                    finishedCleanly: true,
                    summary,
                };
            }
            // 5. Executa a ação no mundo real via ActionDispatcher
            let observation;
            try {
                observation = await this.dispatcher.dispatch(parsed.action);
            }
            catch (err) {
                observation = `ERRO ao executar ação: ${err.message}`;
                console.error(`[Cognitivo] ${observation}`);
            }
            console.log(`[Cognitivo] Observation: ${observation.substring(0, 200)}...`);
            // 6. Registra o passo
            steps.push({
                iteration: i,
                thought: parsed.thought,
                action: parsed.action,
                observation,
                timestamp: new Date(),
            });
            // 7. Adiciona a Observation ao histórico para a próxima iteração
            this.conversationHistory.push({
                role: 'user',
                content: (0, prompts_1.buildObservationMessage)(observation),
            });
        }
        console.warn('[Cognitivo] Limite de iterações atingido.');
        return {
            findings: this.dispatcher.getFindings(),
            steps,
            totalIterations: config_1.config.maxReactIterations,
            finishedCleanly: false,
            summary: `Limite de ${config_1.config.maxReactIterations} iterações atingido.`,
        };
    }
    // ===========================================================
    // Métodos privados
    // ===========================================================
    /**
     * Parseia a resposta do LLM no formato ReAct.
     *
     * Formato esperado:
     *   Thought: [texto livre]
     *   Action: [nome_da_acao]
     *   Action Input:
     *   { ... json ... }
     */
    parseReActOutput(text) {
        try {
            // Extrai Thought
            const thoughtMatch = text.match(/Thought:\s*([\s\S]*?)(?=Action:|$)/i);
            const thought = thoughtMatch?.[1]?.trim() ?? '';
            // Extrai Action name
            const actionMatch = text.match(/Action:\s*(\w+)/i);
            const actionName = actionMatch?.[1]?.trim().toLowerCase() ?? '';
            if (!actionName) {
                console.warn('[Cognitivo] Nenhuma Action encontrada na resposta.');
                return null;
            }
            // Extrai Action Input (JSON)
            const actionInputMatch = text.match(/Action Input:\s*\n?([\s\S]*?)(?=Thought:|Observation:|$)/i);
            let actionInput = {};
            if (actionInputMatch?.[1]) {
                const jsonText = actionInputMatch[1]
                    .trim()
                    .replace(/```json\n?/g, '')
                    .replace(/```\n?/g, '');
                try {
                    actionInput = JSON.parse(jsonText);
                }
                catch {
                    // Tenta extrair JSON de dentro de backticks
                    const innerJson = jsonText.match(/\{[\s\S]*\}/)?.[0];
                    if (innerJson) {
                        actionInput = JSON.parse(innerJson);
                    }
                }
            }
            return {
                thought,
                action: { action: actionName, ...actionInput },
            };
        }
        catch (err) {
            console.error('[Cognitivo] Erro ao parsear ReAct output:', err);
            return null;
        }
    }
}
exports.ReActAgent = ReActAgent;
//# sourceMappingURL=ReActAgent.js.map