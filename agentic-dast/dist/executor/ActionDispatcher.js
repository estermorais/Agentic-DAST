"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.ActionDispatcher = void 0;
const Actor_1 = require("./screenplay/Actor");
const BrowseTheWeb_1 = require("./abilities/BrowseTheWeb");
const HttpClient_1 = require("./abilities/HttpClient");
// ===========================================================
// ActionDispatcher
// ===========================================================
class ActionDispatcher {
    actor;
    findings = [];
    constructor(actor) {
        this.actor = actor;
    }
    /**
     * Factory assíncrono — inicializa o Actor com todas as suas
     * Abilities antes de disponibilizar o dispatcher.
     */
    static async create() {
        const browser = await BrowseTheWeb_1.BrowseTheWeb.launch();
        const http = new HttpClient_1.HttpClient();
        const actor = Actor_1.Actor.named('SecurityAgent')
            .withBrowser(browser)
            .withHttpClient(http);
        console.log(`[Executor] Actor "${actor.getName()}" pronto.`);
        return new ActionDispatcher(actor);
    }
    /**
     * Despacha uma ação para a Ability correta e retorna a
     * Observation como string (será enviada de volta ao LLM).
     */
    async dispatch(action) {
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
                    const parsed = JSON.parse(tokens);
                    if (parsed.bearerToken) {
                        http.setDefaultHeader('Authorization', parsed.bearerToken);
                        console.log('[Executor] JWT extraído e configurado no HttpClient.');
                    }
                }
                catch {
                    // ignora falha no parse — o LLM receberá os tokens como string
                }
                return tokens;
            }
            case 'make_request':
                return await http.request(action.method, action.url, action.headers, action.body);
            case 'report_finding': {
                const finding = {
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
                return (`Finding registrado com sucesso.\n` +
                    `Título: "${finding.title}" | Severidade: ${finding.severity}\n` +
                    `Total de findings até agora: ${this.findings.length}.`);
            }
            case 'finish':
                return `Sessão de testes encerrada. ${action.summary ?? ''}`;
            default:
                // TypeScript garante que nunca chegamos aqui, mas protege em runtime
                return `Ação desconhecida: ${action.action}`;
        }
    }
    /** Retorna cópia imutável dos findings acumulados */
    getFindings() {
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
    applyAuthContext(auth) {
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
    async applyBrowserSession(session) {
        const browser = this.actor.getBrowseTheWeb();
        await browser.applySession(session);
    }
    /** Encerra o Actor (fecha o browser) */
    async teardown() {
        await this.actor.teardown();
    }
    // -----------------------------------------------------------
    normalizeSeverity(raw) {
        const upper = raw.toUpperCase();
        if (upper === 'CRITICAL')
            return 'CRITICAL';
        if (upper === 'HIGH')
            return 'HIGH';
        if (upper === 'MEDIUM')
            return 'MEDIUM';
        if (upper === 'LOW')
            return 'LOW';
        return 'INFO';
    }
}
exports.ActionDispatcher = ActionDispatcher;
//# sourceMappingURL=ActionDispatcher.js.map