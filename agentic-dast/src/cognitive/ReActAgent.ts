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
  buildSystemPrompt,
  buildInitialUserMessage,
  buildObservationMessage,
  InitialMessageOptions,
} from './prompts';
import {
  ContextManagementOptions,
  truncateObservation,
  compactHistory,
  buildCoverageNote,
} from './ContextManager';
import { ActionDispatcher, ParsedAction, Finding } from '../executor/ActionDispatcher';
import { ChatMessage, LLMClient, createLLMClient } from './LLMClient';
import { TARGET_DOWN_MARKER } from '../executor/abilities/HttpClient';

/** Uma etapa do raciocínio do agente */
export interface ReActStep {
  iteration: number;
  thought: string;
  action: ParsedAction;
  observation: string;
  timestamp: Date;
}

/**
 * Opções de execução do loop ReAct. Ambos os campos são opcionais e,
 * quando ausentes (caso do entrypoint oficial do TCC), o comportamento
 * é idêntico ao histórico: prompt inicial padrão e histórico sem
 * gestão de contexto. Só o caminho de produção as preenche.
 */
export interface RunOptions {
  /** Opções da mensagem inicial (priorização/quantidade de endpoints). */
  initialMessage?: InitialMessageOptions;
  /** Gestão de contexto + memória de cobertura (ver ContextManager). */
  contextManagement?: ContextManagementOptions;
  /** Anexa exemplos few-shot ao system prompt (reduz alucinação). */
  fewShot?: boolean;
  /** Autoriza/obriga reportar achados passivos (headers/config/disclosure). */
  passiveFindings?: boolean;
  /** Documenta as ações page_fetch/execute_js (app autenticado por sessão). */
  pageJs?: boolean;
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
  async run(appMap: AppMap, opts?: RunOptions): Promise<AgentResult> {
    const ctxOpts = opts?.contextManagement;
    // System prompt estático da sessão (com ou sem few-shot). Sem opts,
    // é idêntico byte-a-byte ao SYSTEM_PROMPT do baseline do TCC.
    const systemPrompt = buildSystemPrompt({
      fewShot: opts?.fewShot,
      passiveFindings: opts?.passiveFindings,
      pageJs: opts?.pageJs,
    });
    console.log('\n[Cognitivo] Iniciando loop ReAct...');
    console.log(`[Cognitivo] LLM: ${this.llm.name}`);
    console.log(`[Cognitivo] Máximo de iterações: ${config.maxReactIterations}\n`);

    const steps: ReActStep[] = [];

    // Primeira mensagem: o AppMap para o LLM analisar
    const initialMessage = buildInitialUserMessage(appMap, opts?.initialMessage);
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

    for (let i = 1; i <= config.maxReactIterations; i++) {
      console.log(`\n[Cognitivo] ── Iteração ${i}/${config.maxReactIterations} ──`);

      // 0. Gestão de contexto (produção apenas): compacta Observations
      // antigas quando o histórico excede o orçamento, preservando o
      // AppMap inicial e os turnos recentes. Os steps[] mantêm o texto
      // completo, então o relatório/evidência não é afetado.
      if (ctxOpts) {
        this.conversationHistory = compactHistory(this.conversationHistory, ctxOpts);
      }

      // 1. Chama o LLM (Anthropic ou Ollama, transparente para o loop)
      const rawText = await this.llm.chat(systemPrompt, this.conversationHistory);

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
        console.warn(
          `[Cognitivo] Parser falhou (${consecutiveParseFailures}/${MAX_CONSECUTIVE_PARSE_FAILURES}). ` +
          `Solicitando reformatacao ao LLM.`
        );

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
          content:
            'Sua ultima resposta nao pode ser parseada. Voce PRECISA seguir o ' +
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
        const summary = (parsed.action as { action: string; summary?: string }).summary
          ?? 'Testes concluídos.';
        const currentFindings = this.dispatcher.getFindings();

        // 4a. Guarda anti-alucinacao: se o summary contem afirmacoes de
        // vulnerabilidades mas nenhum report_finding foi emitido nesta
        // sessao, o finish e rejeitado. O agente recebe uma observation
        // exigindo que emita report_finding real ou que reformule o
        // summary sem afirmar findings. Evita o padrao de "LLM inventa
        // 8 vulns no summary de finish para parecer produtivo".
        if (currentFindings.length === 0 && summaryClaimsVulnerabilities(summary)) {
          console.warn(
            '[Cognitivo] Finish rejeitado: summary afirma vulnerabilidades mas ' +
            'nenhum report_finding foi emitido. Devolvendo ao LLM para corrigir.'
          );
          this.conversationHistory.push({
            role: 'user',
            content: buildObservationMessage(
              'REJEITADO: seu summary de finish contem afirmacoes de vulnerabilidades ' +
              '(palavras como CRITICAL, HIGH, IDOR, SQL injection, XSS, vulnerability, ' +
              'etc.) mas voce NAO emitiu nenhum Action:report_finding nesta sessao. ' +
              'Regra 3a do system prompt: proibicao absoluta de alucinacao. Voce tem ' +
              'duas opcoes: (a) se realmente encontrou vulnerabilidades, emita agora ' +
              'um Action:report_finding para CADA uma, com titulo/severidade/categoria/' +
              'evidencia real coletada das Observations desta sessao; (b) se nao ' +
              'encontrou nada testavel, emita Action:finish com summary HONESTO que ' +
              'declare "0 findings, sessao inconclusiva porque X" — nao invente ' +
              'achados. Nao ha terceira opcao.'
            ),
          });
          continue;   // volta ao loop, LLM tenta de novo
        }

        console.log(`\n[Cognitivo] Agente encerrou: ${summary}`);

        return {
          findings: currentFindings,
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

      // 6b. Circuit breaker: se o HttpClient abriu o breaker (alvo caiu
      // apos N falhas consecutivas), nao adianta continuar iterando —
      // cada iteracao adicional so gasta tokens contra um servidor que
      // nao vai voltar dentro deste run. Encerra graciosamente aqui.
      if (observation.includes(TARGET_DOWN_MARKER)) {
        console.warn(
          `[Cognitivo] TARGET_DOWN_MARKER detectado. Encerrando loop cedo ` +
          `para nao gastar tokens contra alvo indisponivel.`
        );
        return {
          findings: this.dispatcher.getFindings(),
          steps,
          totalIterations: i,
          finishedCleanly: false,
          summary: `Alvo indisponivel mid-run (juice-shop caiu apos ${i} iteracoes). ` +
                   `Circuit breaker aberto no HttpClient. Findings coletados antes da ` +
                   `queda foram preservados. Marque este run como parcial no analise.`,
        };
      }

      // 7. Adiciona a Observation ao histórico para a próxima iteração.
      // Em produção (ctxOpts): trunca Observations grandes ao guardar
      // (o texto completo permanece em steps[]) e injeta periodicamente
      // uma nota de cobertura para reforçar breadth e reduzir repetição.
      let observationForHistory = observation;
      if (ctxOpts?.maxObservationChars) {
        observationForHistory = truncateObservation(observation, ctxOpts.maxObservationChars);
      }

      let observationMessage = buildObservationMessage(observationForHistory);
      const coverageCadence = ctxOpts?.coverageEveryNIters ?? 0;
      if (coverageCadence > 0 && i % coverageCadence === 0) {
        const categoriesWithFindings = Array.from(
          new Set(this.dispatcher.getFindings().map((f) => f.category).filter(Boolean)),
        );
        const endpointsTested = steps.filter((s) => s.action.action === 'make_request').length;
        observationMessage += buildCoverageNote({
          categoriesWithFindings,
          endpointsTested,
          iteration: i,
          maxIterations: config.maxReactIterations,
        });
      }

      this.conversationHistory.push({
        role: 'user',
        content: observationMessage,
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

        // Escalada em niveis. Antes o parser tentava JSON.parse do
        // texto inteiro e caia em cascata; agora fazemos brace-matching
        // deterministico primeiro, o que resolve o caso mais comum de
        // falha (finish com summary multi-linha contendo aspas nao
        // escapadas ou o LLM continuar escrevendo depois do JSON).
        //
        // parseJsonObjectLenient ainda tenta uma sanitizacao de control
        // chars crus (quebras de linha/tabs literais dentro de strings),
        // padrao frequente do Haiku em summary multi-linha com bullets —
        // que faz o JSON.parse estrito lancar "Bad control character in
        // string literal".
        const extracted = extractFirstJsonObject(jsonText);
        const parsed =
          (extracted !== null ? parseJsonObjectLenient(extracted) : null) ??
          parseJsonObjectLenient(jsonText);

        if (parsed === null) {
          // Falhou mesmo apos sanitizacao: retorna null e o loop pede
          // reformatacao ao LLM.
          console.warn('[Cognitivo] Action Input não é JSON válido mesmo após sanitização.');
          return null;
        }
        actionInput = parsed;
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

/**
 * Extrai o primeiro objeto JSON balanceado do texto, respeitando
 * aspas e escapes. Retorna null se nao encontrar objeto valido.
 *
 * Motivacao: o LLM as vezes emite JSON multi-linha longo (tipico do
 * summary de finish) seguido de texto adicional ou terminando abrupto
 * quando o max_tokens do LLM corta o output no meio. JSON.parse do
 * texto todo quebra; brace-matching manual acha o primeiro '{...}'
 * completo e ignora o resto.
 */
function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;

    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.substring(start, i + 1);
    }
  }
  return null; // objeto nao fechado (LLM truncou)
}

/**
 * Tenta interpretar um trecho como objeto JSON, primeiro estrito e,
 * se falhar, apos escapar control chars crus (quebras de linha, tabs,
 * etc.) que aparecam DENTRO de strings. O Haiku costuma emitir
 * summary multi-linha com bullets literais, o que JSON.parse estrito
 * rejeita com "Bad control character in string literal". Retorna null
 * quando nenhum dos dois caminhos produz um objeto.
 */
function parseJsonObjectLenient(text: string): Record<string, unknown> | null {
  for (const candidate of [text, escapeControlCharsInStrings(text)]) {
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return value as Record<string, unknown>;
      }
    } catch {
      /* tenta o proximo candidato */
    }
  }
  return null;
}

/**
 * Escapa control chars crus (U+0000–U+001F) que estejam DENTRO de
 * strings JSON, deixando intactos os que estao fora (a indentacao de
 * um JSON pretty-printed, por exemplo). Preserva escapes ja existentes.
 * Nao altera JSON valido: sem control chars crus em string, a saida e
 * identica a entrada.
 */
function escapeControlCharsInStrings(json: string): string {
  let out = '';
  let inString = false;
  let escape = false;

  for (let i = 0; i < json.length; i++) {
    const ch = json[i];

    if (escape) { out += ch; escape = false; continue; }
    if (ch === '\\') { out += ch; escape = true; continue; }
    if (ch === '"') { inString = !inString; out += ch; continue; }

    if (inString) {
      const code = ch.charCodeAt(0);
      if (code < 0x20) {
        switch (ch) {
          case '\n': out += '\\n'; break;
          case '\r': out += '\\r'; break;
          case '\t': out += '\\t'; break;
          case '\b': out += '\\b'; break;
          case '\f': out += '\\f'; break;
          default:   out += '\\u' + code.toString(16).padStart(4, '0');
        }
        continue;
      }
    }

    out += ch;
  }

  return out;
}

/**
 * Heuristica anti-alucinacao. Retorna true se o texto do summary
 * emitido junto com Action:finish contem afirmacoes de vulnerabilidades.
 * Usado para rejeitar finish quando o LLM tenta encerrar afirmando
 * vulns sem ter emitido report_finding formal (padrao de alucinacao
 * observado no Haiku em prompts grandes de pentest).
 *
 * Falsos positivos aqui sao aceitaveis (leva a mais rounds de reflexao,
 * nao a falhas silenciosas); falsos negativos deixam alucinacoes
 * passarem, entao a lista e propositalmente ampla.
 */
export function summaryClaimsVulnerabilities(summary: string): boolean {
  const text = summary.toLowerCase();
  const keywords = [
    // Severidades OWASP explicitas
    'critical', 'critico', 'crítico',
    'high severity', 'severidade alta', 'severidade high',
    'medium severity',
    // Termos genericos de vulnerabilidade
    'vulnerability', 'vulnerabilidade', 'vulneráveis', 'vulneraveis',
    'exploit ', 'exploitable', 'exploravel', 'explorável',
    'security flaw', 'falha de seguranca', 'falha de segurança',
    // Classes de ataque mais comuns
    'sql injection', 'sqli',
    'xss', 'cross-site scripting', 'cross site scripting',
    'idor', 'insecure direct object',
    'ssrf', 'server-side request forgery',
    'csrf', 'cross-site request forgery',
    'rce', 'remote code execution',
    'xxe', 'xml external entity',
    'path traversal', 'directory traversal',
    'command injection',
    'mass assignment',
    'privilege escalation', 'escalacao de privilegio', 'escalação de privilégio',
    'account takeover', 'ato ',
    'authentication bypass', 'auth bypass',
    'jwt', 'alg:none', 'algorithm confusion',
    'stored xss', 'reflected xss', 'dom xss',
    'business logic',
    'race condition',
    'deserialization',
    'user enumeration', 'enumeracao de usuario',
    'information disclosure', 'exposicao de dados', 'exposição de dados',
    'sensitive data exposure',
    'broken access control',
    'weak crypto', 'criptografia fraca',
    'default credential', 'credencial padrao',
  ];
  return keywords.some((k) => text.includes(k));
}
