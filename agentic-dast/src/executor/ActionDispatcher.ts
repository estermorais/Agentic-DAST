/**
 * executor/ActionDispatcher.ts
 * ---------------------------------------------------------------
 * Componente central do Módulo Executor.
 *
 * Responsabilidade: receber uma ParsedAction gerada pelo
 * Módulo Cognitivo (ReActAgent) e executá-la no mundo real,
 * delegando ao Actor e suas Abilities.
 *
 * Também é o repositório de Findings — cada vulnerabilidade
 * registrada pelo LLM via report_finding é acumulada aqui.
 * ---------------------------------------------------------------
 */

import { Actor } from './screenplay/Actor';
import { BrowseTheWeb } from './abilities/BrowseTheWeb';
import { HttpClient } from './abilities/HttpClient';
import { BrowserSession } from '../perception/types';

// ===========================================================
// Tipos exportados (consumidos pelo ReActAgent)
// ===========================================================

/**
 * União discriminada de todas as ações que o LLM pode solicitar.
 * Cada tipo mapeia exatamente para um caso no SYSTEM_PROMPT.
 */
export type ParsedAction =
  | { action: 'navigate'; url: string }
  | { action: 'fill_field'; selector: string; value: string }
  | { action: 'click_element'; selector: string }
  | { action: 'read_page' }
  | {
      action: 'make_request';
      method: string;
      url: string;
      headers?: Record<string, string>;
      body?: unknown;
    }
  | { action: 'extract_tokens' }
  | {
      action: 'page_fetch';
      method?: string;
      url: string;
      headers?: Record<string, string>;
      body?: unknown;
    }
  | { action: 'execute_js'; script: string }
  | {
      action: 'report_finding';
      title: string;
      severity: string;
      category: string;
      description: string;
      steps: string[];
      evidence: string;
    }
  | { action: 'finish'; summary?: string };

/** Uma vulnerabilidade encontrada e reportada pelo agente */
export interface Finding {
  title: string;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';
  category: string;
  description: string;
  steps: string[];
  evidence: string;
  discoveredAt: Date;
}

// ===========================================================
// ActionDispatcher
// ===========================================================

export class ActionDispatcher {
  private actor: Actor;
  private findings: Finding[] = [];

  private constructor(actor: Actor) {
    this.actor = actor;
  }

  /**
   * Factory assíncrono — inicializa o Actor com todas as suas
   * Abilities antes de disponibilizar o dispatcher.
   */
  static async create(): Promise<ActionDispatcher> {
    const browser = await BrowseTheWeb.launch();
    const http = new HttpClient();

    const actor = Actor.named('SecurityAgent')
      .withBrowser(browser)
      .withHttpClient(http);

    console.log(`[Executor] Actor "${actor.getName()}" pronto.`);
    return new ActionDispatcher(actor);
  }

  /**
   * Despacha uma ação para a Ability correta e retorna a
   * Observation como string (será enviada de volta ao LLM).
   */
  async dispatch(action: ParsedAction): Promise<string> {
    const browser = this.actor.getBrowseTheWeb();
    const http = this.actor.getHttpClient();

    switch (action.action) {
      case 'navigate':
        return await browser.navigate(action.url);

      case 'fill_field':
        return await browser.fillField(action.selector, action.value);

      case 'click_element':
        return await browser.clickElement(action.selector);

      case 'read_page':
        return await browser.readPage();

      case 'extract_tokens': {
        const tokens = await browser.extractTokens();
        // Propaga o JWT para o HttpClient automaticamente
        try {
          const parsed = JSON.parse(tokens) as { bearerToken?: string | null };
          if (parsed.bearerToken) {
            http.setDefaultHeader('Authorization', parsed.bearerToken);
            console.log('[Executor] JWT extraído e configurado no HttpClient.');
          }
        } catch {
          // ignora falha no parse — o LLM receberá os tokens como string
        }
        return tokens;
      }

      case 'make_request':
        return await http.request(
          action.method,
          action.url,
          action.headers,
          action.body,
        );

      case 'page_fetch':
        return await browser.pageFetch(
          action.method ?? 'GET',
          action.url,
          action.headers,
          action.body,
        );

      case 'execute_js':
        return await browser.executeJs(action.script);

      case 'report_finding': {
        const finding: Finding = {
          title: action.title,
          severity: this.normalizeSeverity(action.severity),
          category: action.category,
          description: action.description,
          steps: action.steps ?? [],
          evidence: action.evidence ?? '',
          discoveredAt: new Date(),
        };

        this.findings.push(finding);

        const banner = `\n${'='.repeat(60)}\n` +
          `[FINDING #${this.findings.length}] ${finding.title}\n` +
          `Severidade: ${finding.severity} | Categoria: ${finding.category}\n` +
          `${'='.repeat(60)}\n`;
        console.log(banner);

        return (
          `Finding registrado com sucesso.\n` +
          `Título: "${finding.title}" | Severidade: ${finding.severity}\n` +
          `Total de findings até agora: ${this.findings.length}.`
        );
      }

      case 'finish':
        return `Sessão de testes encerrada. ${action.summary ?? ''}`;

      default:
        // TypeScript garante que nunca chegamos aqui, mas protege em runtime
        return `Ação desconhecida: ${(action as { action: string }).action}`;
    }
  }

  /** Retorna cópia imutável dos findings acumulados */
  getFindings(): Finding[] {
    return [...this.findings];
  }

  /**
   * Injeta credenciais do AppMap (JWT e/ou cookies coletados na
   * Fase 1 de Percepcao) como headers default do HttpClient. Sem
   * isso, cada make_request emitido pelo LLM sairia sem sessao,
   * mesmo que o AppMap.auth tivesse token/cookie disponivel.
   *
   * Deve ser chamado uma vez pelo entrypoint (index.ts ou
   * production-runner.ts) logo apos criar o ActionDispatcher.
   */
  applyAuthContext(auth: { jwt?: string; bearerToken?: string; cookies?: Record<string, string> }): void {
    const http = this.actor.getHttpClient();
    const token = auth.bearerToken ?? auth.jwt;
    if (token) {
      http.setDefaultHeader('Authorization', `Bearer ${token}`);
    }
    if (auth.cookies && Object.keys(auth.cookies).length > 0) {
      const cookieString = Object.entries(auth.cookies)
        .map(([k, v]) => `${k}=${v}`)
        .join('; ');
      http.setDefaultHeader('Cookie', cookieString);
    }
  }

  /**
   * Faz o handoff da sessao de browser capturada na Percepcao para o
   * browser do Actor (cookies + localStorage/sessionStorage). Sem
   * isso, applyAuthContext cobre apenas os make_request (headers do
   * HttpClient) e as acoes `navigate` do agente caem no login.
   *
   * Deve ser chamado uma vez, logo apos applyAuthContext.
   */
  async applyBrowserSession(session: BrowserSession): Promise<void> {
    const browser = this.actor.getBrowseTheWeb();
    await browser.applySession(session);
  }

  /** Encerra o Actor (fecha o browser) */
  async teardown(): Promise<void> {
    await this.actor.teardown();
  }

  // -----------------------------------------------------------

  private normalizeSeverity(raw: string): Finding['severity'] {
    const upper = raw.toUpperCase();
    if (upper === 'CRITICAL') return 'CRITICAL';
    if (upper === 'HIGH')     return 'HIGH';
    if (upper === 'MEDIUM')   return 'MEDIUM';
    if (upper === 'LOW')      return 'LOW';
    return 'INFO';
  }
}
