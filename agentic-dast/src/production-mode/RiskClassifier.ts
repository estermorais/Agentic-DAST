/**
 * production-mode/RiskClassifier.ts
 * ---------------------------------------------------------------
 * Classifica cada ParsedAction em quatro niveis de risco. Usado
 * pelo SafeDispatcher para decidir se pede confirmacao humana antes
 * de executar.
 *
 * NAO faz parte do fluxo oficial do experimento (Juice Shop, n=30).
 * Usado apenas pelo entrypoint alternativo production-runner.ts.
 * ---------------------------------------------------------------
 */

import { ParsedAction } from '../executor/ActionDispatcher';

export type RiskLevel = 'safe' | 'medium' | 'high' | 'critical';

/**
 * Substrings de path que caracterizam endpoint CRITICAL. Executar
 * qualquer coisa contra elas pode disparar efeito colateral no mundo
 * externo (envio de mensagem, webhook, exportacao de dados).
 * Comparacao case-insensitive.
 */
export const CRITICAL_PATH_PATTERNS = [
  /\/message/i,
  /\/mail/i,
  /\/email/i,
  /\/sms/i,
  /\/whatsapp/i,
  /\/notif/i,
  /\/webhook/i,
  /\/hook/i,
  /\/trigger/i,
  /\/automation/i,
  /\/export/i,
  /\/import/i,
  /\/billing/i,
  /\/invoice/i,
  /\/payment/i,
  /\/charge/i,
];

/**
 * Substrings de path que caracterizam endpoint HIGH quando combinado
 * com metodo destrutivo. Rotas de administracao, gestao de usuarios,
 * permissoes, etc.
 */
export const HIGH_PATH_PATTERNS = [
  /\/admin/i,
  /\/user/i,
  /\/permission/i,
  /\/role/i,
  /\/config/i,
  /\/setting/i,
];

const DESTRUCTIVE_METHODS = new Set(['PUT', 'PATCH', 'DELETE']);

/**
 * Heuristica de payload suspeito: tenta detectar SQL injection ou
 * XSS por padroes comuns no corpo ou na URL da request. Falsos
 * positivos aqui sao aceitaveis (leva a mais confirmacoes, nao
 * menos).
 */
const SUSPICIOUS_PAYLOAD_PATTERNS = [
  /'\s*OR\s*'?1'?\s*=\s*'?1/i,      // SQLi classico
  /UNION\s+SELECT/i,                  // SQLi UNION
  /DROP\s+TABLE/i,
  /<script/i,                         // XSS
  /javascript:/i,
  /alg["\s:]+none/i,                  // JWT alg:none bypass
  /\.\.\/\.\.\//,                     // path traversal
];

/**
 * Paths cuja INTENÇÃO é leitura mesmo quando chamados via POST
 * (busca/agregação/consulta com corpo grande). Um POST nesses paths, sem
 * verbo de mutação no corpo, é tratado como leitura ('safe') — desbloqueia
 * recon read-only de endpoints como /v2/segments/aggregation.
 */
const READ_INTENT_PATH_PATTERNS = [
  /\/search\b/i, /\/query\b/i, /\/aggregations?\b/i, /\/aggregate\b/i,
  /\/reports?\b/i, /\/facets?\b/i, /\/count\b/i, /\/preview\b/i,
  /\/validate\b/i, /\/lookup\b/i, /\/autocomplete\b/i, /\/suggest\b/i,
  /\/_search\b/i, /\/resolve\b/i,
];

/** Verbos claros de mutação no corpo — se presentes, NÃO é leitura. */
const MUTATION_KEYWORD = /\b(create|update|delete|insert|remove|drop|mutation)\b/i;

/**
 * Detecta a operação GraphQL a partir da URL e do corpo. A operação é
 * sinal autoritativo (não spoofável pelo path): 'mutation' modifica estado
 * (high), 'query' é leitura (safe). Retorna null quando não é GraphQL
 * reconhecível — cai na heurística normal de POST.
 */
function graphqlOperation(url: string, body: unknown): 'mutation' | 'query' | null {
  let queryStr: string | null = null;
  if (body && typeof body === 'object' && 'query' in (body as Record<string, unknown>)) {
    const q = (body as Record<string, unknown>).query;
    if (typeof q === 'string') queryStr = q;
  } else if (typeof body === 'string') {
    try {
      const parsed = JSON.parse(body) as { query?: unknown };
      if (typeof parsed.query === 'string') queryStr = parsed.query;
    } catch {
      /* corpo não é JSON — não dá para ler a operação */
    }
  }
  if (queryStr === null) return null;
  return /\b(mutation|subscription)\b/i.test(queryStr) ? 'mutation' : 'query';
}

/**
 * Heurística conservadora: o clique é claramente navegacional (link, aba,
 * paginação) e não parece submeter formulário nem confirmar ação? Só então
 * rebaixa de 'medium' para 'safe'. Qualquer sinal de submit/save/delete/
 * confirm mantém 'medium'.
 */
function isNavigationalClick(selector: string): boolean {
  const s = (selector || '').toLowerCase();
  if (/submit|salvar|\bsave\b|delete|excluir|remove|confirm|enviar|apply|aplicar|criar|create|update|atualizar/.test(s)) {
    return false;
  }
  return /\[href|role=["']?link|\bnav\b|\btab\b|paginat|\bnext\b|\bprev\b|\bexpand\b|\btoggle\b|accordion|breadcrumb|(^|[\s,>~+])a[\s.#:[]/i.test(selector || '');
}

export interface ClassificationResult {
  level: RiskLevel;
  reason: string;
}

export function classifyActionRisk(action: ParsedAction): ClassificationResult {
  switch (action.action) {
    case 'navigate':
    case 'read_page':
    case 'extract_tokens':
    case 'report_finding':
    case 'finish':
      return { level: 'safe', reason: 'Ação apenas de leitura/registro local.' };

    case 'fill_field':
      return {
        level: 'safe',
        reason: 'Preenche campo mas não submete formulário sozinho.',
      };

    case 'click_element':
      if (isNavigationalClick(action.selector)) {
        return {
          level: 'safe',
          reason: 'Clique navegacional (link/aba/paginação), não submete formulário.',
        };
      }
      return {
        level: 'medium',
        reason: 'Click pode disparar submit de formulário ou POST.',
      };

    case 'make_request':
      return classifyRequest(action);

    case 'page_fetch':
      // Mesma heurística de método/URL/payload de make_request: um
      // page_fetch GET de leitura é 'safe'; POST/métodos destrutivos e
      // rotas sensíveis sobem de nível igual a uma requisição normal.
      return classifyRequest({
        action: 'make_request',
        method: action.method ?? 'GET',
        url: action.url,
        headers: action.headers,
        body: action.body,
      });

    case 'execute_js':
      // Executa JS arbitrário na página autenticada — sempre exige
      // aprovação humana (bloqueado em READ_ONLY, que só deixa passar 'safe').
      return {
        level: 'high',
        reason: 'Executa JavaScript arbitrário no contexto da página autenticada.',
      };
  }
}

function classifyRequest(
  action: Extract<ParsedAction, { action: 'make_request' }>,
): ClassificationResult {
  const method = (action.method || 'GET').toUpperCase();
  const url = action.url || '';
  const headers = action.headers || {};
  const bodyStr = action.body ? JSON.stringify(action.body) : '';
  const fullText = `${url} ${bodyStr}`;

  // Endpoints CRITICAL: qualquer metodo contra eles pode causar efeito externo
  for (const pattern of CRITICAL_PATH_PATTERNS) {
    if (pattern.test(url)) {
      return {
        level: 'critical',
        reason: `Endpoint casa com padrão CRITICAL (${pattern.source}). Pode disparar comunicação, webhook ou movimentação financeira.`,
      };
    }
  }

  // Payload suspeito de exploit
  for (const pattern of SUSPICIOUS_PAYLOAD_PATTERNS) {
    if (pattern.test(fullText)) {
      return {
        level: 'high',
        reason: `Payload contém padrão de exploit (${pattern.source}).`,
      };
    }
  }

  // JWT forjado no header Authorization (heuristica: header presente + valor
  // curto ou contendo 'none')
  const auth = headers['Authorization'] || headers['authorization'] || '';
  if (auth && /alg["\s:]+none|Bearer\s+eyJ[^.]+\.eyJ[^.]*\.$/i.test(auth)) {
    return {
      level: 'high',
      reason: 'Header Authorization parece conter JWT forjado (alg:none ou assinatura vazia).',
    };
  }

  // Metodo destrutivo
  if (DESTRUCTIVE_METHODS.has(method)) {
    return {
      level: 'high',
      reason: `Método ${method} modifica estado no servidor.`,
    };
  }

  // POST: distingue mutação de leitura (GraphQL, rota admin, read-intent)
  if (method === 'POST') {
    // GraphQL: a operação é sinal autoritativo, não o path.
    const gql = graphqlOperation(url, action.body);
    if (gql === 'mutation') {
      return { level: 'high', reason: 'Mutation GraphQL modifica estado no servidor.' };
    }

    // POST em rota administrativa/usuarios (antes do downgrade de leitura,
    // para uma query GraphQL a /admin permanecer high).
    for (const pattern of HIGH_PATH_PATTERNS) {
      if (pattern.test(url)) {
        return {
          level: 'high',
          reason: `POST em rota administrativa (casa com ${pattern.source}).`,
        };
      }
    }

    if (gql === 'query') {
      return { level: 'safe', reason: 'Query GraphQL é apenas leitura.' };
    }

    // POST de intenção de leitura (busca/agregação/consulta) sem verbo de
    // mutação no corpo → tratado como leitura, liberando recon read-only.
    if (READ_INTENT_PATH_PATTERNS.some((p) => p.test(url)) && !MUTATION_KEYWORD.test(bodyStr)) {
      return {
        level: 'safe',
        reason: 'POST de leitura (busca/agregação/consulta), sem verbo de mutação no corpo.',
      };
    }

    return {
      level: 'medium',
      reason: 'POST genérico pode criar recurso no servidor.',
    };
  }

  // GET, HEAD, OPTIONS: seguros
  return { level: 'safe', reason: `Método ${method} é apenas de leitura.` };
}
