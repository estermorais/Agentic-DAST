/**
 * cognitive/ContextManager.ts
 * ---------------------------------------------------------------
 * Gestão de contexto e memória de cobertura para o loop ReAct.
 *
 * PROBLEMA QUE RESOLVE. Em alvos complexos (apps reais, não o Juice
 * Shop), duas coisas degradam o agente ao longo da sessão:
 *
 *   1. ESTOURO DE CONTEXTO. Cada Observation (resposta HTTP, DOM,
 *      bundle JS) é empilhada no histórico e nunca é reduzida. Em
 *      poucas iterações o histórico passa de dezenas de milhares de
 *      tokens; o modelo perde o fio, passa a divagar em prosa (o loop
 *      já trata isso como falha de parser) e a alucinar mais — porque
 *      não "enxerga" mais o começo da própria investigação.
 *
 *   2. AMNÉSIA DE COBERTURA. Sem um resumo explícito do que já foi
 *      testado, o modelo repete testes e não sabe quais das categorias
 *      OWASP ainda faltam — justamente o oposto do princípio
 *      "cobertura antes de profundidade" do system prompt.
 *
 * SOLUÇÃO (determinística, sem chamada extra de LLM):
 *   a) Trunca cada Observation grande ao ser guardada no histórico
 *      (mantém cabeça + cauda, elide o miolo).
 *   b) Compacta Observations antigas quando o histórico passa de um
 *      orçamento de caracteres, preservando a mensagem inicial
 *      (AppMap) e as últimas N mensagens verbatim.
 *   c) Injeta periodicamente uma nota compacta de COBERTURA (categorias
 *      com finding, nº de endpoints testados, iterações restantes).
 *
 * ISOLAMENTO DO TCC. Nada aqui roda por padrão. O ReActAgent só usa
 * este módulo quando recebe `contextManagement` nas opções de `run`,
 * o que só acontece no caminho de produção. O entrypoint oficial
 * (`src/index.ts`) chama `run(appMap)` sem opções → histórico intacto,
 * baseline n=30 preservado.
 * ---------------------------------------------------------------
 */

import { ChatMessage } from './LLMClient';

export interface ContextManagementOptions {
  /**
   * Tamanho máximo (em caracteres) de uma Observation guardada no
   * histórico. Acima disso, mantém cabeça+cauda e elide o miolo.
   * Default 4000 (~1k tokens). 0 desativa a truncagem.
   */
  maxObservationChars?: number;
  /**
   * Orçamento total de caracteres do histórico. Ao ser excedido,
   * Observations antigas (fora das últimas `recentTurnsVerbatim`) são
   * elididas até caber. Default 60000 (~15k tokens). 0 desativa.
   */
  historyCharBudget?: number;
  /**
   * Quantas mensagens finais preservar verbatim na compactação.
   * Default 8 (≈ 4 turnos Thought/Observation). A mensagem inicial
   * (AppMap, índice 0) é sempre preservada.
   */
  recentTurnsVerbatim?: number;
  /**
   * A cada quantas iterações injetar a nota de cobertura. Default 5.
   * 0 desativa a nota.
   */
  coverageEveryNIters?: number;
}

export const DEFAULT_CONTEXT_OPTIONS: Required<ContextManagementOptions> = {
  maxObservationChars: 4000,
  historyCharBudget: 60000,
  recentTurnsVerbatim: 8,
  coverageEveryNIters: 5,
};

/** Marcador visível de conteúdo elidido (o LLM entende que houve corte). */
const ELISION = '\n[…conteúdo elidido para gerir a janela de contexto…]\n';

/**
 * Trunca um texto de Observation preservando cabeça e cauda. Mantém o
 * início (onde costuma vir status/headers) e o fim (onde costuma vir a
 * evidência final), elidindo o miolo.
 */
export function truncateObservation(text: string, maxChars: number): string {
  if (maxChars <= 0 || text.length <= maxChars) return text;
  const headLen = Math.floor(maxChars * 0.6);
  const tailLen = maxChars - headLen;
  return text.slice(0, headLen) + ELISION + text.slice(text.length - tailLen);
}

/** Soma de caracteres de todo o histórico. */
function totalChars(history: ChatMessage[]): number {
  return history.reduce((sum, m) => sum + m.content.length, 0);
}

/** Uma mensagem de usuário é uma Observation se começa com "Observation:". */
function isObservation(m: ChatMessage): boolean {
  return m.role === 'user' && m.content.startsWith('Observation:');
}

/**
 * Compacta o histórico quando excede `historyCharBudget`. Preserva:
 *   - a mensagem inicial (índice 0, o AppMap);
 *   - as últimas `recentTurnsVerbatim` mensagens.
 * Elide o conteúdo de Observations antigas no meio, da mais antiga para
 * a mais nova, até caber no orçamento. Não remove mensagens (mantém o
 * alinhamento user/assistant do histórico); apenas encurta conteúdo.
 *
 * Retorna um NOVO array; não muta o original.
 */
export function compactHistory(
  history: ChatMessage[],
  opts: ContextManagementOptions = {},
): ChatMessage[] {
  const budget = opts.historyCharBudget ?? DEFAULT_CONTEXT_OPTIONS.historyCharBudget;
  const keepRecent = opts.recentTurnsVerbatim ?? DEFAULT_CONTEXT_OPTIONS.recentTurnsVerbatim;
  if (budget <= 0 || totalChars(history) <= budget) return history;

  const out = history.map((m) => ({ ...m }));
  const lastProtectedIndex = out.length - keepRecent; // >= este índice = protegido

  for (let i = 1; i < lastProtectedIndex && totalChars(out) > budget; i++) {
    if (isObservation(out[i]) && out[i].content.length > ELISION.length + 40) {
      // Preserva a primeira linha (geralmente "Observation: <status>")
      const firstLineEnd = out[i].content.indexOf('\n');
      const head = firstLineEnd > 0 ? out[i].content.slice(0, firstLineEnd) : 'Observation:';
      out[i] = { ...out[i], content: `${head}${ELISION}` };
    }
  }
  return out;
}

export interface CoverageState {
  /** Categorias que já têm ao menos um finding reportado. */
  categoriesWithFindings: string[];
  /** Nº de requisições make_request emitidas até agora. */
  endpointsTested: number;
  /** Iteração atual e limite, para o modelo dosar o tempo restante. */
  iteration: number;
  maxIterations: number;
}

/**
 * Famílias canônicas de vulnerabilidade (espelham a §2 do system
 * prompt). Usadas só para lembrar o modelo do que ainda não tocou —
 * a categoria real do finding continua livre.
 */
const CANONICAL_CATEGORIES = [
  'BROKEN_ACCESS_CONTROL', 'BUSINESS_LOGIC', 'INJECTION', 'SSRF',
  'MASS_ASSIGNMENT', 'XSS', 'JWT', 'PATH_TRAVERSAL',
  'SENSITIVE_DATA_EXPOSURE', 'SECURITY_HEADERS', 'CSRF', 'CORS',
  'DESERIALIZATION', 'AUTH_FLOWS', 'GRAPHQL_API',
];

/**
 * Constrói uma nota compacta de cobertura para injetar como parte de
 * uma Observation. Lembra o agente do que já cobriu, do que falta, e
 * de quanto orçamento resta — reforçando "cobertura antes de
 * profundidade" sem depender da memória do modelo.
 */
export function buildCoverageNote(state: CoverageState): string {
  const withFindings = state.categoriesWithFindings.length
    ? state.categoriesWithFindings.join(', ')
    : '(nenhuma ainda)';
  const covered = new Set(state.categoriesWithFindings.map((c) => c.toUpperCase()));
  const untouched = CANONICAL_CATEGORIES.filter((c) => !covered.has(c));
  const iterationsLeft = Math.max(0, state.maxIterations - state.iteration);

  return (
    `\n\n---\n[ESTADO DE COBERTURA — memória do framework, não é resultado de ação]\n` +
    `- Requisições emitidas: ${state.endpointsTested}\n` +
    `- Categorias com finding: ${withFindings}\n` +
    `- Categorias ainda sem cobertura evidente: ${untouched.join(', ') || '(todas tocadas)'}\n` +
    `- Iterações restantes: ~${iterationsLeft} de ${state.maxIterations}\n` +
    `Priorize as categorias sem cobertura enquanto houver orçamento; evite repetir ` +
    `testes idênticos. Se o orçamento estiver curto, consolide e chame \`finish\` com ` +
    `summary honesto.`
  );
}
