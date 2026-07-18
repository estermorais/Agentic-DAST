"use strict";
/**
 * perception/DOMExtractor.ts
 * ---------------------------------------------------------------
 * Módulo de Percepção — usa Puppeteer (Chrome DevTools Protocol)
 * para navegar na SPA e construir o AppMap semântico.
 *
 * Responsabilidades:
 *  1. Abrir o browser e navegar pelas rotas conhecidas do Juice Shop
 *  2. Interceptar todas as chamadas HTTP (XHR/Fetch) via CDP
 *  3. Extrair formulários e elementos interativos do DOM
 *  4. Registrar tokens de autenticação (JWT, cookies)
 *  5. Retornar um AppMap completo para o módulo Cognitivo
 * ---------------------------------------------------------------
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DOMExtractor = void 0;
const puppeteer_1 = __importDefault(require("puppeteer"));
const axios_1 = __importDefault(require("axios"));
const config_1 = require("../config");
// Credenciais de usuários default do Juice Shop (vem pré-criados na imagem
// bkimminich/juice-shop:latest). Tentadas em ordem; o primeiro que autenticar
// é usado. Se nenhum funcionar, cai para login via browser.
const DEFAULT_USERS = [
    { email: 'jim@juice-sh.op', password: 'ncc-1701' },
    { email: 'bender@juice-sh.op', password: 'OhG0dPlease1nsertLiquor!' },
    { email: 'admin@juice-sh.op', password: 'admin123' },
];
// Rotas do Juice Shop que o extrator vai visitar.
// São as rotas Angular (hash routing: /#/...)
const JUICE_SHOP_ROUTES = [
    '/',
    '/#/login',
    '/#/register',
    '/#/basket',
    '/#/order-history',
    '/#/administration',
    '/#/score-board',
    '/#/contact',
    '/#/about',
    '/#/search',
];
class DOMExtractor {
    browser = null;
    interceptedEndpoints = [];
    /** Inicializa o browser Puppeteer com ou sem proxy ZAP */
    async launch() {
        const args = ['--no-sandbox', '--disable-setuid-sandbox'];
        if (config_1.config.useZapProxy) {
            // Roteia o tráfego pelo ZAP para auditoria passiva.
            // O Chrome faz bypass do proxy para localhost por padrão, o que
            // faria o ZAP não ver nada. Duas flags corrigem isso:
            //   1. --proxy-bypass-list=<-loopback>: força o Chrome a rotear
            //      inclusive localhost pelo proxy (não fazer bypass).
            //   2. --host-resolver-rules=MAP localhost host.docker.internal:
            //      reescreve 'localhost' para 'host.docker.internal' antes de
            //      enviar a requisição ao proxy. Isso é necessário porque, do
            //      ponto de vista do ZAP dentro do container, 'localhost' é o
            //      próprio ZAP, não o Juice Shop. 'host.docker.internal' é o
            //      alias que Docker Desktop provê para acessar o host.
            args.push(`--proxy-server=http://${config_1.config.zapProxyHost}:${config_1.config.zapProxyPort}`);
            args.push('--proxy-bypass-list=<-loopback>');
            args.push('--host-resolver-rules=MAP localhost host.docker.internal');
            args.push('--ignore-certificate-errors');
            console.log(`[Percepção] Usando proxy ZAP em ${config_1.config.zapProxyHost}:${config_1.config.zapProxyPort} (localhost -> host.docker.internal)`);
        }
        this.browser = await puppeteer_1.default.launch({
            headless: true, // true = sem janela, false = útil para depuração
            args,
        });
        console.log('[Percepção] Browser iniciado.');
    }
    /** Fecha o browser ao final */
    async close() {
        await this.browser?.close();
        console.log('[Percepção] Browser encerrado.');
    }
    /**
     * Ponto de entrada principal — navega pelo alvo e retorna o AppMap.
     */
    async extract() {
        if (!this.browser)
            throw new Error('Chame launch() antes de extract().');
        const routes = [];
        for (const routePath of JUICE_SHOP_ROUTES) {
            const url = `${config_1.config.targetUrl}${routePath}`;
            console.log(`[Percepção] Visitando: ${url}`);
            const page = await this.browser.newPage();
            // Ativa interceptação de rede nesta página
            await this.enableNetworkInterception(page);
            try {
                await page.goto(url, { waitUntil: 'networkidle2', timeout: 15_000 });
                // Aguarda a SPA Angular renderizar o conteúdo dinâmico
                await this.sleep(1500);
                const route = await this.extractRoute(page, routePath);
                routes.push(route);
            }
            catch (err) {
                console.warn(`[Percepção] Erro ao visitar ${url}: ${err.message}`);
            }
            finally {
                await page.close();
            }
        }
        // Coleta tokens fazendo login com conta de teste
        const auth = await this.collectAuthTokens();
        // Coleta endpoints autenticados (repete algumas rotas logado)
        const authEndpoints = await this.collectAuthenticatedEndpoints(auth);
        const allEndpoints = this.deduplicateEndpoints([
            ...this.interceptedEndpoints,
            ...authEndpoints,
        ]);
        const appMap = {
            baseUrl: config_1.config.targetUrl,
            routes,
            apiEndpoints: allEndpoints,
            auth,
            metadata: {
                framework: 'Angular',
                title: 'OWASP Juice Shop',
                capturedAt: new Date(),
                totalForms: routes.reduce((sum, r) => sum + r.forms.length, 0),
                totalEndpoints: allEndpoints.length,
            },
        };
        console.log(`[Percepção] AppMap gerado: ${routes.length} rotas, ` +
            `${allEndpoints.length} endpoints, ` +
            `${appMap.metadata.totalForms} formulários.`);
        return appMap;
    }
    // ===========================================================
    // Métodos privados
    // ===========================================================
    /** Intercepta chamadas XHR/Fetch e registra como ApiEndpoint */
    async enableNetworkInterception(page) {
        // Escuta respostas de rede
        page.on('response', async (response) => {
            const url = response.url();
            const method = response.request().method();
            // Filtra apenas chamadas à API do Juice Shop (ignora estáticos)
            if (!url.includes('/api/') && !url.includes('/rest/'))
                return;
            if (method === 'OPTIONS')
                return;
            let requestBody;
            let responseBody;
            try {
                const postData = response.request().postData();
                if (postData)
                    requestBody = JSON.parse(postData);
            }
            catch {
                // postData pode não ser JSON válido
            }
            try {
                if (response.headers()['content-type']?.includes('application/json')) {
                    responseBody = await response.json().catch(() => null);
                }
            }
            catch {
                // resposta pode ter sido consumida
            }
            this.interceptedEndpoints.push({
                method,
                url,
                requestBody,
                responseBody,
                responseStatus: response.status(),
                contentType: response.headers()['content-type'],
                authRequired: response.status() === 401 || response.status() === 403,
            });
        });
    }
    /** Extrai formulários e elementos interativos de uma página */
    async extractRoute(page, routePath) {
        const title = await page.title();
        // Extrai todos os formulários do DOM via page.evaluate()
        // (código executado dentro do browser, não no Node.js)
        const forms = await page.evaluate(() => {
            const result = [];
            const formElements = document.querySelectorAll('form, mat-card');
            formElements.forEach((formEl, formIdx) => {
                const fields = [];
                const inputs = formEl.querySelectorAll('input, textarea, select, mat-select');
                inputs.forEach((input, inputIdx) => {
                    const el = input;
                    // Gera um seletor CSS único baseado na posição
                    const selector = el.id ? `#${el.id}` :
                        el.name ? `[name="${el.name}"]` :
                            `form:nth-child(${formIdx + 1}) input:nth-child(${inputIdx + 1})`;
                    fields.push({
                        name: el.name || el.id || `field_${inputIdx}`,
                        type: el.type || 'text',
                        placeholder: el.placeholder,
                        required: el.required,
                        selector,
                    });
                });
                if (fields.length > 0) {
                    const submitBtn = formEl.querySelector('button[type="submit"], button.mat-raised-button');
                    result.push({
                        id: `form_${formIdx}`,
                        pageUrl: window.location.href,
                        action: formEl.action || undefined,
                        method: formEl.method || 'POST',
                        fields,
                        submitSelector: submitBtn?.id
                            ? `#${submitBtn.id}`
                            : 'button[type="submit"]',
                    });
                }
            });
            return result;
        });
        // Extrai botões e links interativos
        const interactiveElements = await page.evaluate(() => {
            const result = [];
            const buttons = document.querySelectorAll('button, a[href], mat-menu-item');
            buttons.forEach((el, idx) => {
                const text = (el.textContent || '').trim();
                if (!text || text.length > 80)
                    return;
                const href = el.href;
                const selector = el.id ? `#${el.id}` : `button:nth-of-type(${idx + 1})`;
                result.push({
                    type: el.tagName === 'A' ? 'link' : 'button',
                    text,
                    selector,
                    href: href || undefined,
                });
            });
            return result;
        });
        // Verifica se a rota exige autenticação
        const requiresAuth = await page.evaluate(() => {
            return (document.body.innerText.includes('Please login') ||
                document.title.includes('Login') ||
                document.querySelector('app-login') !== null);
        });
        return {
            path: routePath,
            title,
            requiresAuth,
            forms,
            interactiveElements,
        };
    }
    /**
     * Faz login com a conta padrão de teste e retorna os tokens.
     * Juice Shop sempre tem o usuário: customer@juice-sh.op / customer
     * (criado automaticamente)
     */
    async collectAuthTokens() {
        // ── Estratégia 1: Login via API direta ─────────────────────
        // Mais rápida e confiável que browser. Tenta cada usuário default
        // do Juice Shop até um autenticar.
        for (const user of DEFAULT_USERS) {
            try {
                const response = await axios_1.default.post(`${config_1.config.targetUrl}/rest/user/login`, { email: user.email, password: user.password }, { timeout: 10_000, validateStatus: () => true });
                const jwt = response.data?.authentication?.token;
                if (response.status === 200 && typeof jwt === 'string' && jwt.length > 0) {
                    console.log(`[Percepção] Auth coletado via API. ` +
                        `Usuário: ${user.email} | JWT: ${jwt.substring(0, 20)}...`);
                    return {
                        jwt,
                        bearerToken: `Bearer ${jwt}`,
                        cookies: {},
                        userEmail: user.email,
                    };
                }
            }
            catch {
                // tenta o próximo usuário
            }
        }
        // ── Estratégia 2: Login via browser (fallback) ─────────────
        // Se a API não respondeu (ex: endpoint mudou), tenta automatizar
        // o formulário Angular como último recurso.
        console.warn('[Percepção] Login via API falhou para todos os usuários default. Tentando via browser...');
        const page = await this.browser.newPage();
        await this.enableNetworkInterception(page);
        let jwt;
        page.on('response', async (response) => {
            if (response.url().includes('/rest/user/login') && response.status() === 200) {
                try {
                    const body = await response.json();
                    jwt = body?.authentication?.token;
                }
                catch { /* ignora */ }
            }
        });
        try {
            await page.goto(`${config_1.config.targetUrl}/#/login`, {
                waitUntil: 'networkidle2',
                timeout: 15_000,
            });
            await this.sleep(1500);
            try {
                await page.type('#email', DEFAULT_USERS[0].email, { delay: 30 });
                await page.type('#password', DEFAULT_USERS[0].password, { delay: 30 });
                await page.click('#loginButton');
            }
            catch (err) {
                console.warn(`[Percepção] Falha ao preencher login: ${err.message}`);
            }
            await this.sleep(3000);
            if (!jwt) {
                jwt = await page.evaluate(() => {
                    const t = localStorage.getItem('token');
                    if (t)
                        return t;
                    for (let i = 0; i < localStorage.length; i++) {
                        const key = localStorage.key(i);
                        if (key && /token|auth|jwt/i.test(key)) {
                            const v = localStorage.getItem(key);
                            if (v && v.includes('.'))
                                return v;
                        }
                    }
                    return undefined;
                });
            }
            const puppeteerCookies = await page.cookies();
            const cookies = {};
            for (const c of puppeteerCookies)
                cookies[c.name] = c.value;
            console.log(`[Percepção] Auth coletado via browser. JWT: ${jwt ? 'sim' : 'não encontrado'}`);
            return {
                jwt,
                bearerToken: jwt ? `Bearer ${jwt}` : undefined,
                cookies,
                userEmail: DEFAULT_USERS[0].email,
            };
        }
        finally {
            await page.close();
        }
    }
    /**
     * Navega por rotas autenticadas para capturar endpoints que
     * exigem login (ex: /api/Baskets, /rest/user/whoami)
     */
    async collectAuthenticatedEndpoints(auth) {
        if (!auth.jwt)
            return [];
        const page = await this.browser.newPage();
        const authEndpoints = [];
        // Injeta o JWT em todas as requisições
        await page.setExtraHTTPHeaders({
            Authorization: `Bearer ${auth.jwt}`,
        });
        page.on('response', async (response) => {
            const url = response.url();
            if (!url.includes('/api/') && !url.includes('/rest/'))
                return;
            let responseBody;
            try {
                responseBody = await response.json().catch(() => null);
            }
            catch {
                // ignora
            }
            authEndpoints.push({
                method: response.request().method(),
                url,
                responseStatus: response.status(),
                responseBody,
                contentType: response.headers()['content-type'],
                authRequired: false,
            });
        });
        const authenticatedRoutes = [
            '/#/basket',
            '/#/order-history',
            '/#/administration',
            '/#/privacy-security/privacy-policy',
        ];
        try {
            for (const route of authenticatedRoutes) {
                await page.goto(`${config_1.config.targetUrl}${route}`, {
                    waitUntil: 'networkidle2',
                    timeout: 10_000,
                });
                await this.sleep(1000);
            }
        }
        finally {
            await page.close();
        }
        return authEndpoints;
    }
    /** Remove endpoints duplicados (mesma URL + método) */
    deduplicateEndpoints(endpoints) {
        const seen = new Set();
        return endpoints.filter((ep) => {
            const key = `${ep.method}:${ep.url}`;
            if (seen.has(key))
                return false;
            seen.add(key);
            return true;
        });
    }
    sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}
exports.DOMExtractor = DOMExtractor;
//# sourceMappingURL=DOMExtractor.js.map