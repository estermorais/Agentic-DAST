/**
 * production-mode/SafeDispatcher.ts
 * ---------------------------------------------------------------
 * Decorator do ActionDispatcher oficial. Antes de executar cada
 * acao proposta pelo LLM, classifica o risco e pede aprovacao
 * humana quando necessario.
 *
 * Mantem a mesma interface publica que ReActAgent consome:
 *   - dispatch(action): Promise<string>
 *   - getFindings(): Finding[]
 *   - teardown(): Promise<void>
 *
 * NENHUMA mudanca eh feita no ActionDispatcher original. Este arquivo
 * apenas envolve uma instancia existente.
 * ---------------------------------------------------------------
 */

import * as fs from 'fs';
import * as path from 'path';

import { ActionDispatcher, ParsedAction, Finding } from '../executor/ActionDispatcher';
import { classifyActionRisk, RiskLevel } from './RiskClassifier';
import { HumanApproval } from './HumanApproval';

export interface SafeDispatcherOptions {
  /** Se true, bloqueia qualquer acao MEDIUM/HIGH/CRITICAL sem sequer perguntar. */
  readOnly: boolean;
  /** Se true, aciona HumanApproval para MEDIUM/HIGH/CRITICAL. */
  interactive: boolean;
  /** Path de arquivo de audit log em CSV. Vazio = nao grava. */
  auditLogPath?: string;
  /** Delay entre requests para evitar disparar WAF. Default 500ms. */
  rateLimitMs?: number;
  /** Encerra a sessao apos N findings HIGH/CRITICAL. 0 = desativado. */
  circuitBreakerFindings?: number;
}

export class SafeDispatcher {
  private inner: ActionDispatcher;
  private opts: Required<SafeDispatcherOptions>;
  private approval: HumanApproval;
  private highSeverityCount = 0;
  private currentThought = '';
  private currentIteration = 0;
  private breakerTripped = false;

  constructor(inner: ActionDispatcher, opts: SafeDispatcherOptions) {
    this.inner = inner;
    this.opts = {
      readOnly: opts.readOnly,
      interactive: opts.interactive,
      auditLogPath: opts.auditLogPath ?? '',
      rateLimitMs: opts.rateLimitMs ?? 500,
      circuitBreakerFindings: opts.circuitBreakerFindings ?? 0,
    };
    this.approval = new HumanApproval();

    if (this.opts.auditLogPath) {
      this.initAuditLog();
    }
  }

  /**
   * Contexto que o ReActAgent passa antes de chamar dispatch. Como o
   * ReActAgent nao passa isso naturalmente, usamos setters — o
   * production-runner intercepta cada iteracao e chama esses setters.
   */
  setContext(iteration: number, thought: string): void {
    this.currentIteration = iteration;
    this.currentThought = thought;
  }

  async dispatch(action: ParsedAction): Promise<string> {
    if (this.breakerTripped) {
      return 'Circuit breaker ativo: sessão encerrada após atingir limite de findings HIGH/CRITICAL. Emita finish.';
    }

    // O ActionDispatcher oficial chama severity.toUpperCase() sem checar
    // undefined (ActionDispatcher.normalizeSeverity). Quando o LLM emite
    // report_finding sem 'severity' (ou sem outros campos obrigatorios),
    // isso lança "Cannot read properties of undefined". Como nao podemos
    // tocar no core, saneamos a ação aqui, na camada de produção, antes
    // de repassá-la — preenchendo defaults seguros.
    action = sanitizeAction(action);

    const classification = classifyActionRisk(action);

    // Modo read-only: bloqueia qualquer coisa fora do SAFE
    if (this.opts.readOnly && classification.level !== 'safe') {
      this.audit(action, classification.level, 'blocked-readonly');
      return (
        `Ação bloqueada por modo READ_ONLY (nível ${classification.level}). ` +
        `Motivo: ${classification.reason}. Tente uma variação apenas de leitura (GET).`
      );
    }

    // Modo interativo: pede aprovacao em MEDIUM/HIGH/CRITICAL
    if (
      this.opts.interactive &&
      classification.level !== 'safe'
    ) {
      const decision = await this.approval.prompt(
        action,
        classification,
        this.currentIteration,
        this.currentThought,
      );

      if (decision.type === 'skip') {
        this.audit(action, classification.level, 'skipped-by-human');
        return decision.feedback;
      }
      if (decision.type === 'quit') {
        this.audit(action, classification.level, 'quit-by-human');
        this.breakerTripped = true;
        return 'Operador humano encerrou a sessão. Emita finish com o que foi descoberto até aqui.';
      }
    }

    // Rate limit
    if (this.opts.rateLimitMs > 0 && action.action === 'make_request') {
      await sleep(this.opts.rateLimitMs);
    }

    // Executa via dispatcher oficial
    const observation = await this.inner.dispatch(action);
    this.audit(action, classification.level, 'executed');

    // Circuit breaker
    if (this.opts.circuitBreakerFindings > 0) {
      const findings = this.inner.getFindings();
      const highCount = findings.filter(
        (f) => f.severity === 'HIGH' || f.severity === 'CRITICAL',
      ).length;
      if (highCount >= this.opts.circuitBreakerFindings) {
        this.breakerTripped = true;
        console.log(
          `\n[SafeDispatcher] Circuit breaker ativado: ${highCount} findings HIGH/CRITICAL atingidos. ` +
          `Próximas ações serão bloqueadas.\n`,
        );
      }
    }

    return observation;
  }

  getFindings(): Finding[] {
    return this.inner.getFindings();
  }

  async teardown(): Promise<void> {
    const anyInner = this.inner as unknown as { teardown?: () => Promise<void> };
    if (typeof anyInner.teardown === 'function') {
      await anyInner.teardown();
    }
  }

  // ---------------------------------------------------------------
  // Audit log
  // ---------------------------------------------------------------

  private initAuditLog(): void {
    const dir = path.dirname(this.opts.auditLogPath);
    if (dir && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(this.opts.auditLogPath)) {
      fs.writeFileSync(
        this.opts.auditLogPath,
        'timestamp_iso,iteration,action,method,url,risk_level,outcome\n',
        'utf-8',
      );
    }
  }

  private audit(
    action: ParsedAction,
    level: RiskLevel,
    outcome: 'executed' | 'skipped-by-human' | 'quit-by-human' | 'blocked-readonly',
  ): void {
    if (!this.opts.auditLogPath) return;
    const now = new Date().toISOString();
    const method = action.action === 'make_request' ? action.method : '';
    const url = action.action === 'make_request' ? action.url : '';
    const csvRow = [
      now,
      this.currentIteration,
      action.action,
      method,
      csvEscape(url),
      level,
      outcome,
    ].join(',') + '\n';
    fs.appendFileSync(this.opts.auditLogPath, csvRow, 'utf-8');
  }
}

/**
 * Preenche campos ausentes de report_finding para que o
 * ActionDispatcher oficial nao quebre em normalizeSeverity() nem em
 * outros acessos a campos obrigatorios. Nao altera acoes de outros
 * tipos. Severity vazia vira 'INFO' (mesmo default do core quando o
 * valor nao casa com CRITICAL/HIGH/MEDIUM/LOW).
 */
function sanitizeAction(action: ParsedAction): ParsedAction {
  if (action.action !== 'report_finding') return action;

  const validSeverities = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];
  const rawSeverity = typeof action.severity === 'string' ? action.severity.trim() : '';
  const severity = validSeverities.includes(rawSeverity.toUpperCase())
    ? rawSeverity
    : 'INFO';

  return {
    ...action,
    title: nonEmpty(action.title, '(sem título)'),
    severity,
    category: nonEmpty(action.category, 'Uncategorized'),
    description: nonEmpty(action.description, ''),
    steps: Array.isArray(action.steps) ? action.steps : [],
    evidence: typeof action.evidence === 'string' ? action.evidence : '',
  };
}

function nonEmpty(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value : fallback;
}

function csvEscape(s: string): string {
  if (!s) return '';
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
