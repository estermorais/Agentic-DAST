"use strict";
/**
 * executor/abilities/BrowseTheWeb.ts
 * ---------------------------------------------------------------
 * Ability do Screenplay Pattern responsável por todas as
 * interações com o browser via Puppeteer.
 *
 * Uma Ability encapsula uma capacidade do Actor — neste caso,
 * a capacidade de controlar um browser Chrome headless.
 *
 * Referência: Freeman & Pryce, "Growing Object-Oriented Software,
 * Guided by Tests", Addison-Wesley, 2009 (origem do padrão).
 * ---------------------------------------------------------------
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.BrowseTheWeb = void 0;
const puppeteer_1 = __importDefault(require("puppeteer"));
const config_1 = require("../../config");
const logoutGuard_1 = require("./logoutGuard");
/** Resolve URL relativa contra o targetUrl (mesmo helper do HttpClient) */
function resolveUrl(url) {
    if (/^https?:\/\//i.test(url))
        return url;
    try {
        return new URL(url, config_1.config.browserBaseUrl).toString();
    }
    catch {
        return url;
    }
}
class BrowseTheWeb {
    browser = null;
    page = null;
    /**
     * Factory estático — inicia o browser e retorna a ability pronta.
     * Roteia o tráfego pelo ZAP se USE_ZAP_PROXY=true.
     */
    static async launch() {
        const ability = new BrowseTheWeb();
        await ability.init();
        return ability;
    }
    async init() {
        const args = ['--no-sandbox', '--disable-setuid-sandbox'];
        if (config_1.config.useZapProxy) {
            // Roteia o browser do Actor pelo ZAP. Chrome, com proxy HTTP para
            // URL HTTP, envia a URL LITERAL ao proxy e quem resolve o hostname
            // e o ZAP. Por isso o resolveUrl acima ja usa config.browserBaseUrl
            // (juice-shop:3000), que o ZAP resolve via Docker network dast-net.
            // A flag --proxy-bypass-list=<-loopback> continua necessaria porque
            // o proxy vive em localhost:8080 e o Chrome, por padrao, faria
            // bypass para hosts loopback.
            args.push(`--proxy-server=http://${config_1.config.zapProxyHost}:${config_1.config.zapProxyPort}`);
            args.push('--proxy-bypass-list=<-loopback>');
            args.push('--ignore-certificate-errors');
            console.log(`[Executor] Proxy ZAP ativo em ${config_1.config.zapProxyHost}:${config_1.config.zapProxyPort} (navegação via ${config_1.config.browserBaseUrl})`);
        }
        this.browser = await puppeteer_1.default.launch({ headless: true, args });
        this.page = await this.browser.newPage();
        // Timeout padrão de navegação
        this.page.setDefaultNavigationTimeout(20_000);
        this.page.setDefaultTimeout(10_000);
        console.log('[Executor] Browser do Actor iniciado.');
    }
    /**
     * Restaura no browser do Actor a sessao capturada na Percepcao:
     * cookies (todos os dominios, via CDP Network.setCookies) e
     * localStorage/sessionStorage (escritos na origem correta).
     *
     * Sem isso, o browser do Actor sobe limpo e toda acao `navigate`
     * numa SPA autenticada (OAuth/SSO com token em storage) e
     * redirecionada de volta ao login. O AppMap.auth cobre apenas os
     * headers do HttpClient (make_request), nao o estado do browser.
     */
    async applySession(session) {
        const page = this.requirePage();
        const cdp = await page.target().createCDPSession();
        // 1. Cookies (preservando dominio/path/flags originais).
        if (session.cookies.length > 0) {
            await cdp.send('Network.setCookies', {
                cookies: session.cookies,
            });
            console.log(`[Executor] ${session.cookies.length} cookie(s) de sessao restaurado(s) no browser do Actor.`);
        }
        // 2. Storage — precisa estar NA origem para escrever local/session.
        const { origin, local, session: sessionStore } = session.storage;
        const hasStorage = Object.keys(local).length > 0 || Object.keys(sessionStore).length > 0;
        if (origin && hasStorage) {
            try {
                await page.goto(origin, { waitUntil: 'domcontentloaded' });
                await page.evaluate((snap) => {
                    try {
                        for (const [k, v] of Object.entries(snap.local)) {
                            localStorage.setItem(k, v);
                        }
                        for (const [k, v] of Object.entries(snap.session)) {
                            sessionStorage.setItem(k, v);
                        }
                    }
                    catch {
                        /* storage indisponivel nesta origem */
                    }
                }, session.storage);
                console.log(`[Executor] Storage de sessao restaurado na origem ${origin}.`);
            }
            catch (err) {
                console.warn(`[Executor] Nao foi possivel restaurar storage no browser do Actor: ${err.message}`);
            }
        }
    }
    /**
     * Navega para uma URL e aguarda a SPA renderizar.
     * Retorna o título da página após a navegação.
     */
    async navigate(url) {
        const page = this.requirePage();
        const fullUrl = resolveUrl(url);
        // Guard de logout: nao navegar para paginas que destroem a sessao.
        if (!config_1.config.allowLogoutNavigation && (0, logoutGuard_1.isLogoutUrl)(fullUrl)) {
            console.warn(`[Executor] Navegação para logout bloqueada: ${fullUrl}`);
            return (0, logoutGuard_1.logoutBlockedMessage)(fullUrl);
        }
        try {
            await page.goto(fullUrl, { waitUntil: 'networkidle2' });
            await this.sleep(500);
            const title = await page.title();
            return `Navegou para ${fullUrl}. Título: "${title}". URL atual: ${page.url()}`;
        }
        catch (err) {
            return `ERRO ao navegar para ${fullUrl}: ${err.message}`;
        }
    }
    /**
     * Preenche um campo de formulário identificado por seletor CSS.
     * Limpa o valor existente antes de digitar.
     */
    async fillField(selector, value) {
        const page = this.requirePage();
        try {
            await page.waitForSelector(selector, { timeout: 5_000 });
            // Limpa o campo e então digita o novo valor
            await page.$eval(selector, (el) => {
                el.value = '';
            });
            await page.type(selector, value, { delay: 30 });
            return `Campo "${selector}" preenchido com "${value}".`;
        }
        catch (err) {
            return `ERRO: campo "${selector}" não encontrado ou não preenchível. ${err.message}`;
        }
    }
    /**
     * Clica em um elemento e aguarda possível navegação/re-render.
     */
    async clickElement(selector) {
        const page = this.requirePage();
        try {
            await page.waitForSelector(selector, { timeout: 5_000 });
            // Guard de logout: inspeciona destino (href) e rotulo do elemento
            // antes de clicar. Um clique em "Sair"/"Logout" destroi a sessao
            // tanto quanto navegar para a URL de logout.
            if (!config_1.config.allowLogoutNavigation) {
                const target = await page.$eval(selector, (el) => ({
                    href: el.href || el.getAttribute('href') || '',
                    text: el.innerText || el.getAttribute('aria-label') || '',
                })).catch(() => null);
                if (target && ((0, logoutGuard_1.isLogoutUrl)(target.href) || (0, logoutGuard_1.isLogoutText)(target.text))) {
                    const what = target.href || target.text.trim() || selector;
                    console.warn(`[Executor] Clique em logout bloqueado: ${selector} (${what})`);
                    return (0, logoutGuard_1.logoutBlockedMessage)(what);
                }
            }
            await page.click(selector);
            await this.sleep(800);
            // Salvaguarda pos-clique: se um clique nao previsto (JS handler,
            // redirect) levou a uma pagina de logout, avisa o LLM. Nao ha como
            // reverter aqui, mas o handoff de sessao permanece em memoria e o
            // operador pode reiniciar.
            if (!config_1.config.allowLogoutNavigation && (0, logoutGuard_1.isLogoutUrl)(page.url())) {
                console.warn(`[Executor] Clique resultou em URL de logout: ${page.url()}`);
                return (`ATENÇÃO: o clique em "${selector}" levou a uma URL de logout ` +
                    `(${page.url()}). A sessão pode ter sido encerrada. Evite este ` +
                    `elemento e não repita a ação.`);
            }
            return `Elemento "${selector}" clicado. URL atual: ${page.url()}`;
        }
        catch (err) {
            return `ERRO: não foi possível clicar em "${selector}". ${err.message}`;
        }
    }
    /**
     * Lê o conteúdo textual da página atual (URL + título + body).
     * Limita a 2000 caracteres para não saturar o contexto do LLM.
     */
    async readPage() {
        const page = this.requirePage();
        const url = page.url();
        const title = await page.title();
        const text = await page.evaluate(() => document.body.innerText);
        const truncated = text.substring(0, 2000);
        const truncationNote = text.length > 2000
            ? `\n[... conteúdo truncado — ${text.length} chars total]`
            : '';
        return `URL: ${url}\nTítulo: ${title}\nConteúdo:\n${truncated}${truncationNote}`;
    }
    /**
     * Extrai tokens de autenticação do browser (JWT do localStorage + cookies).
     * Útil para o LLM reutilizar tokens obtidos via login.
     */
    async extractTokens() {
        const page = this.requirePage();
        const jwt = await page.evaluate(() => {
            return localStorage.getItem('token') ?? localStorage.getItem('jwt') ?? null;
        });
        const puppeteerCookies = await page.cookies();
        const cookies = puppeteerCookies.reduce((acc, c) => {
            acc[c.name] = c.value;
            return acc;
        }, {});
        const result = {
            jwt: jwt ?? null,
            bearerToken: jwt ? `Bearer ${jwt}` : null,
            cookies,
            currentUrl: page.url(),
        };
        return JSON.stringify(result, null, 2);
    }
    /** Fecha o browser ao final da sessão */
    async close() {
        await this.browser?.close();
        console.log('[Executor] Browser do Actor encerrado.');
    }
    // -----------------------------------------------------------
    requirePage() {
        if (!this.page)
            throw new Error('BrowseTheWeb não iniciada. Chame launch() primeiro.');
        return this.page;
    }
    sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}
exports.BrowseTheWeb = BrowseTheWeb;
//# sourceMappingURL=BrowseTheWeb.js.map