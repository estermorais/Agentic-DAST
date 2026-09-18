/**
 * production-mode/report-render.ts
 * ---------------------------------------------------------------
 * Renderiza o relatorio de uma execucao em modo producao como um
 * documento Markdown tecnico e legivel — complementar ao JSON bruto.
 * Voltado ao operador/red team: sumario executivo, findings detalhados
 * (severidade, categoria, passos de reproducao, evidencia) e o trace
 * ReAct completo (thought -> action -> observation por iteracao).
 * ---------------------------------------------------------------
 */

import { Finding } from '../executor/ActionDispatcher';

/** Passo do loop ReAct, como armazenado no relatorio. */
export interface ReportStep {
  iteration: number;
  thought: string;
  action: unknown;
  observation: string;
  timestamp: string | Date;
}

/** Estrutura do relatorio de producao (a mesma serializada em JSON). */
export interface ProductionReport {
  mode: string;
  generatedAt: string;
  target: string;
  llmModel: string;
  summary: string;
  finishedCleanly: boolean;
  totalIterations: number;
  costUSD?: number;
  warnings: string[];
  config: {
    readOnly: boolean;
    interactive: boolean;
    rateLimitMs: number;
    sessionReused?: boolean;
    maxReactIterations?: number;
    maxCostUSD?: number;
  };
  findingsSummary: {
    reactAgent: number;
    abuseCases: number;
    zapPassive: number;
    total: number;
  };
  findings: Finding[];
  steps: ReportStep[];
}

const SEVERITY_ORDER: Record<string, number> = {
  CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, INFO: 4,
};

const SEVERITY_BADGE: Record<string, string> = {
  CRITICAL: '🔴 CRITICAL',
  HIGH:     '🟠 HIGH',
  MEDIUM:   '🟡 MEDIUM',
  LOW:      '🔵 LOW',
  INFO:     '⚪ INFO',
};

function esc(text: string): string {
  // Escapa apenas o que quebra tabela/estrutura Markdown.
  return String(text ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function fence(text: string): string {
  const body = String(text ?? '').replace(/```/g, '`​``');
  return '```\n' + body + '\n```';
}

function actionToString(action: unknown): string {
  if (action == null) return '(sem acao)';
  if (typeof action === 'string') return action;
  try {
    return JSON.stringify(action, null, 2);
  } catch {
    return String(action);
  }
}

/** Gera o relatorio Markdown completo a partir do objeto de relatorio. */
export function renderMarkdownReport(r: ProductionReport): string {
  const out: string[] = [];
  const p = (s = '') => out.push(s);

  // ── Cabecalho ────────────────────────────────────────────
  p(`# Relatório de Teste de Segurança — Agentic DAST`);
  p();
  p(`> Modo **produção** · gerado em ${r.generatedAt}`);
  p();
  p(`| Campo | Valor |`);
  p(`| --- | --- |`);
  p(`| Alvo | \`${esc(r.target)}\` |`);
  p(`| LLM | \`${esc(r.llmModel)}\` |`);
  p(`| Iterações ReAct | ${r.totalIterations}${
      r.config.maxReactIterations ? ` / ${r.config.maxReactIterations}` : ''} |`);
  if (r.costUSD !== undefined) {
    const budget = r.config.maxCostUSD && r.config.maxCostUSD > 0
      ? ` / $${r.config.maxCostUSD.toFixed(2)}` : '';
    p(`| Custo estimado (LLM) | $${r.costUSD.toFixed(4)}${budget} |`);
  }
  p(`| Encerramento limpo | ${r.finishedCleanly ? 'sim' : 'não'} |`);
  p(`| Read-only | ${r.config.readOnly ? 'sim' : 'não'} |`);
  p(`| Aprovação interativa | ${r.config.interactive ? 'sim' : 'não'} |`);
  if (r.config.sessionReused !== undefined) {
    p(`| Sessão reutilizada do cache | ${r.config.sessionReused ? 'sim' : 'não'} |`);
  }
  p(`| Rate limit | ${r.config.rateLimitMs} ms |`);
  p();

  // ── Avisos ───────────────────────────────────────────────
  if (r.warnings.length > 0) {
    p(`## ⚠️ Avisos`);
    p();
    for (const w of r.warnings) p(`- ${w}`);
    p();
  }

  // ── Sumario executivo ────────────────────────────────────
  p(`## Sumário executivo`);
  p();
  p(`| Fonte | Findings |`);
  p(`| --- | --- |`);
  p(`| Loop ReAct (LLM) | ${r.findingsSummary.reactAgent} |`);
  p(`| Casos de abuso | ${r.findingsSummary.abuseCases} |`);
  p(`| ZAP (passivo) | ${r.findingsSummary.zapPassive} |`);
  p(`| **Total (deduplicado)** | **${r.findingsSummary.total}** |`);
  p();
  if (r.summary && r.summary.trim()) {
    p(`**Resumo do agente:**`);
    p();
    p(`> ${esc(r.summary)}`);
    p();
  }

  // ── Findings detalhados ──────────────────────────────────
  p(`## Vulnerabilidades encontradas`);
  p();
  if (r.findings.length === 0) {
    p(`Nenhuma vulnerabilidade estruturada foi materializada nesta execução.`);
    p();
  } else {
    const sorted = [...r.findings].sort(
      (a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9),
    );

    // Tabela-resumo.
    p(`| # | Severidade | Categoria | Título |`);
    p(`| --- | --- | --- | --- |`);
    sorted.forEach((f, i) => {
      p(`| ${i + 1} | ${SEVERITY_BADGE[f.severity] ?? f.severity} | ${esc(f.category)} | ${esc(f.title)} |`);
    });
    p();

    // Detalhamento.
    sorted.forEach((f, i) => {
      p(`### ${i + 1}. ${f.title}`);
      p();
      p(`- **Severidade:** ${SEVERITY_BADGE[f.severity] ?? f.severity}`);
      p(`- **Categoria:** ${f.category}`);
      if (f.discoveredAt) p(`- **Descoberto em:** ${new Date(f.discoveredAt).toISOString()}`);
      p();
      if (f.description) {
        p(`**Descrição**`);
        p();
        p(f.description);
        p();
      }
      if (Array.isArray(f.steps) && f.steps.length > 0) {
        p(`**Passos para reproduzir**`);
        p();
        f.steps.forEach((s, k) => p(`${k + 1}. ${s}`));
        p();
      }
      if (f.evidence) {
        p(`**Evidência**`);
        p();
        p(fence(f.evidence));
        p();
      }
    });
  }

  // ── Trace ReAct ──────────────────────────────────────────
  p(`## Trace de raciocínio (ReAct)`);
  p();
  if (r.steps.length === 0) {
    p(`Nenhum passo registrado.`);
    p();
  } else {
    for (const s of r.steps) {
      p(`### Iteração ${s.iteration}`);
      p();
      if (s.timestamp) {
        const ts = s.timestamp instanceof Date
          ? s.timestamp.toISOString()
          : String(s.timestamp);
        p(`_${ts}_`);
      }
      p();
      if (s.thought) {
        p(`**Thought:** ${esc(s.thought)}`);
        p();
      }
      p(`**Action:**`);
      p(fence(actionToString(s.action)));
      p();
      p(`**Observation:**`);
      p(fence(s.observation));
      p();
    }
  }

  p(`---`);
  p();
  p(`_Relatório gerado automaticamente pelo Agentic DAST (modo produção)._`);
  p();

  return out.join('\n');
}
