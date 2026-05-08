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
/** Resolve URL relativa contra o targetUrl (mesmo helper do HttpClient) */
function resolveUrl(url) {
    if (/^https?:\/\//i.test(url))
        return url;
    try {
        return new URL(url, config_1.config.targetUrl).toString();
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
            args.push(`--proxy-server=http://${config_1.config.zapProxyHost}:${config_1.config.zapProxyPort}`);
            // Obs.: Chrome faz bypass do proxy para localhost por padrão.
            // Para o Cenário C tudo bem — os Abuse Cases fazem as detecções.
            args.push('--ignore-certificate-errors');
            console.log(`[Executor] Proxy ZAP ativo em ${config_1.config.zapProxyHost}:${config_1.config.zapProxyPort}`);
        }
        this.browser = await puppeteer_1.default.launch({ headless: true, args });
        this.page = await this.browser.newPage();
        // Timeout padrão de navegação
        this.page.setDefaultNavigationTimeout(20_000);
        this.page.setDefaultTimeout(10_000);
        console.log('[Executor] Browser do Actor iniciado.');
    }
    /**
     * Navega para uma URL e aguarda a SPA renderizar.
     * Retorna o título da página após a navegação.
     */
    async navigate(url) {
        const page = this.requirePage();
        const fullUrl = resolveUrl(url);
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
            await page.click(selector);
            await this.sleep(800);
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