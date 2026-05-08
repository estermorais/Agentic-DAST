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

import { config } from '../config';
import { AppMap } from '../perception/types';
import {
  SYSTEM_PROMPT,
  buildInitialUserMessage,
  buildObservationMessage,
} from './prompts';
import { ActionDispatcher, ParsedAction, Finding } from '../executor/ActionDispatcher';
import { ChatMessage, LLMClient, createLLMClient } from './LLMClient';

/** Uma etapa do raciocínio do agente */
export interface ReActStep {
  iteration: number;
  thought: string;
  action: ParsedAction;
  observation: string;
  timestamp: Date;
}

/** Resultado final da sessão de testes */
export interface AgentResult {
  findings: Finding[];
  steps: ReActStep[];
  totalIterations: number;
  finishedCleanly: boolean;
  summary: string;
}

export class ReActAgent {
  private llm: LLMClient;
  private dispatcher: ActionDispatcher;
  private conversationHistory: ChatMessage[] = [];

  constructor(dispatcher: ActionDispatcher, llm?: LLMClient) {
    this.llm = llm ?? createLLMClient();
    this.dispatcher = dispatcher;
  }

  /**
   * Executa o loop ReAct completo dado um AppMap.
   * Retorna todas as vulnerabilidades encontradas e os passos tomados.
   */
  async run(appMap: AppMap): Promise<AgentResult> {
    console.log('\n[Cognitivo] Iniciando loop ReAct...');
    console.log(`[Cognitivo] LLM: ${this.llm.name}`);
    console.log(`[Cognitivo] Máximo de iterações: ${config.maxReactIterations}\n`);

    const steps: ReActStep[] = [];

    // Primeira mensagem: o AppMap para o LLM analisar
    const initialMessage = buildInitialUserMessage(appMap);
    this.conversationHistory.push({
      role: 'user',
      content: initialMessage,
    });

    for (let i = 1; i <= config.maxReactIterations; i++) {
      console.log(`\n[Cognitivo] ── Iteração ${i}/${config.maxReactIterations} ──`);

      // 1. Chama o LLM (Anthropic ou Ollama, transparente para o loop)
      const rawText = await this.llm.chat(SYSTEM_PROMPT, this.conversationHistory);

      console.log('[Cognitivo] LLM respondeu:\n', rawText.substring(0, 300), '...');

      // 2. Salva a resposta do assistente no histórico
      this.conversationHistory.push({
        role: 'assistant',
        content: rawText,
      });

      // 3. Parseia Thought + Action do texto
      const parsed = this.parseReActOutput(rawText);

      if (!parsed) {
        // O LLM não seguiu o formato ReAct. Comum em modelos pequenos
        // (Llama 3B etc.). Encerra graciosamente em vez de "limite atingido".
        console.warn('[Cognitivo] Não foi possível parsear a resposta. Encerrando.');
        return {
          findings: this.dispatcher.getFindings(),
          steps,
          totalIterations: i,
          finishedCleanly: false,
          summary: `Parser falhou na iteração ${i}. O modelo (${this.llm.name}) ` +
                   `pode estar gerando saída fora do formato ReAct esperado.`,
        };
      }

      console.log(`[Cognitivo] Thought: ${parsed.thought.substring(0, 150)}...`);
      console.log(`[Cognitivo] Action: ${parsed.action.action}`);

      // 4. Verifica se o agente quer encerrar
      if (parsed.action.action === 'finish') {
        const summary = (parsed.action as { action: string; summary?: string }).summary
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
      let observation: string;
      try {
        observation = await this.dispatcher.dispatch(parsed.action);
      } catch (err) {
        observation = `ERRO ao executar ação: ${(err as Error).message}`;
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
        content: buildObservationMessage(observation),
      });
    }

    console.warn('[Cognitivo] Limite de iterações atingido.');

    return {
      findings: this.dispatcher.getFindings(),
      steps,
      totalIterations: config.maxReactIterations,
      finishedCleanly: false,
      summary: `Limite de ${config.maxReactIterations} iterações atingido.`,
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
  private parseReActOutput(text: string): { thought: string; action: ParsedAction } | null {
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
      let actionInput: Record<string, unknown> = {};

      if (actionInputMatch?.[1]) {
        const jsonText = actionInputMatch[1]
          .trim()
          .replace(/```json\n?/g, '')
          .replace(/```\n?/g, '');
        try {
          actionInput = JSON.parse(jsonText);
        } catch {
          // Tenta extrair JSON de dentro de backticks
          const innerJson = jsonText.match(/\{[\s\S]*\}/)?.[0];
          if (innerJson) {
            actionInput = JSON.parse(innerJson);
          }
        }
      }

      return {
        thought,
        action: { action: actionName, ...actionInput } as ParsedAction,
      };
    } catch (err) {
      console.error('[Cognitivo] Erro ao parsear ReAct output:', err);
      return null;
    }
  }
}
