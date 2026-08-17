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
const CRITICAL_PATH_PATTERNS = [
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
const HIGH_PATH_PATTERNS = [
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
      return {
        level: 'medium',
        reason: 'Click pode disparar submit de formulário ou POST.',
      };

    case 'make_request':
      return classifyRequest(action);
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

  // POST em rota administrativa/usuarios
  if (method === 'POST') {
    for (const pattern of HIGH_PATH_PATTERNS) {
      if (pattern.test(url)) {
        return {
          level: 'high',
          reason: `POST em rota administrativa (casa com ${pattern.source}).`,
        };
      }
    }
    return {
      level: 'medium',
      reason: 'POST genérico pode criar recurso no servidor.',
    };
  }

  // GET, HEAD, OPTIONS: seguros
  return { level: 'safe', reason: `Método ${method} é apenas de leitura.` };
}
