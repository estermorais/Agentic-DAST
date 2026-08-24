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
        // Se INTERACTIVE_LOGIN=true, abre janela visivel apenas para o
        // login manual (MFA/SSO/CAPTCHA). Depois de capturar a sessao,
        // o extract() chama restartHeadless() para fechar essa janela
        // e reabrir em headless para o resto da rodada.
        await this._launchInternal(!config_1.config.interactiveLogin);
    }
    /**
     * Fecha o browser atual (tipicamente o visivel usado para login
     * manual) e reabre em modo headless. Os cookies capturados do
     * login precisam ser reinjetados pelo caller, ja que o browser
     * novo comeca sem sessao.
     */
    async restartHeadless(cookiesToRestore) {
        console.log('[Percepção] Fechando janela visivel e reabrindo browser em modo headless...');
        await this.browser?.close();
        await this._launchInternal(true);
        if (Object.keys(cookiesToRestore).length > 0 && this.browser) {
            const targetHost = new URL(config_1.config.browserBaseUrl).hostname;
            const tmpPage = await this.browser.newPage();
            try {
                await tmpPage.setCookie(...Object.entries(cookiesToRestore).map(([name, value]) => ({
                    name, value, domain: targetHost, path: '/',
                })));
                console.log(`[Percepção] ${Object.keys(cookiesToRestore).length} cookie(s) reinjetado(s) no browser headless.`);
            }
            finally {
                await tmpPage.close();
            }
        }
    }
    /** Implementacao real do launch, extraida para permitir restart. */
    async _launchInternal(headless) {
        const args = ['--no-sandbox', '--disable-setuid-sandbox'];
        if (config_1.config.useZapProxy) {
            // Roteia o trafego pelo ZAP para auditoria passiva.
            // Chrome, ao usar proxy HTTP para uma URL HTTP, envia a URL LITERAL
            // ao proxy sem resolver o hostname destino localmente — quem resolve
            // e o proprio ZAP, de dentro do seu container. Como 'localhost' no
            // container do ZAP e o proprio ZAP (nao o alvo), navegamos direto
            // para 'juice-shop:3000' (config.browserBaseUrl), hostname que o
            // ZAP resolve via Docker network 'dast-net'.
            //
            // A flag --proxy-bypass-list=<-loopback> continua necessaria porque
            // o proxy em si mora em 'localhost:8080' e o Chrome, por padrao,
            // faria bypass do proxy para hosts loopback — o que impediria a
            // conexao ate o proprio ZAP.
            args.push(`--proxy-server=http://${config_1.config.zapProxyHost}:${config_1.config.zapProxyPort}`);
            args.push('--proxy-bypass-list=<-loopback>');
            args.push('--ignore-certificate-errors');
            console.log(`[Percepção] Usando proxy ZAP em ${config_1.config.zapProxyHost}:${config_1.config.zapProxyPort} (navegação via ${config_1.config.browserBaseUrl})`);
        }
        this.browser = await puppeteer_1.default.launch({ headless, args });
        console.log(`[Percepção] Browser iniciado (headless=${headless}).`);
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
        // Se o operador forneceu sessao manual (JWT/cookies) via env vars,
        // injeta os cookies no browser ANTES das navegacoes. Sem isso, a
        // Fase 1 rodaria como anonima e nao enxergaria a superficie
        // autenticada do alvo. Usado para alvos com MFA/SSO/CAPTCHA que
        // impedem login automatizado.
        const manualAuth = await this.applyManualSessionIfProvided();
        const routes = [];
        for (const routePath of JUICE_SHOP_ROUTES) {
            const url = `${config_1.config.browserBaseUrl}${routePath}`;
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
        // Coleta tokens. Se sessao manual ja foi aplicada acima, reusa;
        // caso contrario, tenta o login automatico com credenciais default
        // (funciona apenas contra Juice Shop).
        const auth = manualAuth ?? await this.collectAuthTokens();
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
        // Login por API: usa browserBaseUrl e passa pelo ZAP (quando ativo)
        // pela mesma razao do HttpClient — a request precisa alimentar a
        // auditoria passiva. Detalhes em executor/abilities/HttpClient.ts.
        const axiosProxy = config_1.config.useZapProxy
            ? { host: config_1.config.zapProxyHost, port: config_1.config.zapProxyPort, protocol: 'http' }
            : false;
        for (const user of DEFAULT_USERS) {
            try {
                const response = await axios_1.default.post(`${config_1.config.browserBaseUrl}/rest/user/login`, { email: user.email, password: user.password }, { timeout: 10_000, validateStatus: () => true, proxy: axiosProxy });
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
            await page.goto(`${config_1.config.browserBaseUrl}/#/login`, {
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
                await page.goto(`${config_1.config.browserBaseUrl}${route}`, {
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
    /**
     * Tres caminhos de sessao manual, em ordem de prioridade:
     *   1. INTERACTIVE_LOGIN=true: abre browser visivel, aguarda operador
     *      logar (MFA/SSO), captura cookies + localStorage['token'|'jwt'].
     *   2. MANUAL_JWT e/ou MANUAL_COOKIES preenchidos: monta AuthContext
     *      diretamente e injeta cookies no Puppeteer.
     *   3. Nenhuma das acima: retorna null (login automatico assume).
     */
    async applyManualSessionIfProvided() {
        if (config_1.config.interactiveLogin) {
            const auth = await this.captureSessionAfterManualLogin();
            // Fecha a janela visivel e reabre em headless para o resto da
            // rodada (loop de rotas, HttpClient, etc). Os cookies capturados
            // sao reinjetados no novo browser para manter a sessao ativa.
            await this.restartHeadless(auth.cookies);
            return auth;
        }
        const hasJwt = !!config_1.config.manualJwt;
        const hasCookies = !!config_1.config.manualCookies;
        if (!hasJwt && !hasCookies)
            return null;
        const flags = [
            hasJwt ? 'MANUAL_JWT' : null,
            hasCookies ? 'MANUAL_COOKIES' : null,
        ].filter(Boolean).join(' + ');
        console.log(`[Percepcao] ${flags} presente(s). Pulando login automatico.`);
        const cookieDict = parseCookieString(config_1.config.manualCookies);
        const auth = {
            jwt: config_1.config.manualJwt || undefined,
            bearerToken: config_1.config.manualJwt || undefined,
            cookies: cookieDict,
            userEmail: '(sessao manual fornecida via env vars)',
        };
        if (hasCookies && Object.keys(cookieDict).length > 0 && this.browser) {
            const targetHost = new URL(config_1.config.browserBaseUrl).hostname;
            const tmpPage = await this.browser.newPage();
            try {
                await tmpPage.setCookie(...Object.entries(cookieDict).map(([name, value]) => ({
                    name, value, domain: targetHost, path: '/',
                })));
                console.log(`[Percepcao] ${Object.keys(cookieDict).length} cookie(s) injetado(s) no Puppeteer.`);
            }
            finally {
                await tmpPage.close();
            }
        }
        return auth;
    }
    /**
     * Fluxo INTERACTIVE_LOGIN: abre uma pagina do CRM no Chromium
     * VISIVEL, aguarda o operador logar manualmente (passando MFA,
     * SSO, CAPTCHA etc.), pergunta no terminal quando terminou e
     * captura a sessao resultante (cookies + token comum de
     * localStorage). A partir daqui o resto da rodada continua
     * automatico com essa sessao.
     */
    async captureSessionAfterManualLogin() {
        if (!this.browser)
            throw new Error('browser nao inicializado');
        const page = await this.browser.newPage();
        console.log('');
        console.log('━'.repeat(72));
        console.log('  MODO INTERATIVO — LOGIN MANUAL');
        console.log('━'.repeat(72));
        console.log(`  Abrindo ${config_1.config.browserBaseUrl} no browser visivel.`);
        console.log('  Faca login normalmente (senha + MFA + SSO conforme');
        console.log('  aplicavel). Quando estiver DENTRO da aplicacao');
        console.log('  autenticada, volte ao terminal e pressione ENTER.');
        console.log('━'.repeat(72));
        console.log('');
        try {
            await page.goto(config_1.config.browserBaseUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        }
        catch (err) {
            console.warn(`[Percepcao] Aviso ao carregar pagina de login: ${err.message}`);
        }
        await this.waitForEnter('  Pressione ENTER apos concluir o login > ');
        // Captura cookies do dominio inteiro (nao apenas da URL atual)
        const targetHost = new URL(config_1.config.browserBaseUrl).hostname;
        const puppeteerCookies = await page.cookies();
        const cookiesForHost = puppeteerCookies.filter((c) => c.domain.replace(/^\./, '') === targetHost
            || targetHost.endsWith(c.domain.replace(/^\./, '')));
        const cookieDict = {};
        for (const c of cookiesForHost)
            cookieDict[c.name] = c.value;
        // Tenta detectar JWT em chaves comuns de localStorage
        const jwtFromStorage = await page.evaluate(() => {
            const candidates = ['token', 'jwt', 'accessToken', 'access_token',
                'authToken', 'auth_token', 'idToken', 'id_token'];
            for (const key of candidates) {
                const v = localStorage.getItem(key) || sessionStorage.getItem(key);
                if (v && v.length > 20)
                    return { key, value: v };
            }
            return null;
        }).catch(() => null);
        await page.close();
        const jwt = jwtFromStorage?.value;
        console.log('');
        console.log('[Percepcao] Sessao capturada:');
        console.log(`  Cookies coletados : ${Object.keys(cookieDict).length}`);
        console.log(`  JWT detectado     : ${jwt ? `sim (${jwtFromStorage.key} do storage)` : 'nao'}`);
        console.log('');
        return {
            jwt,
            bearerToken: jwt,
            cookies: cookieDict,
            userEmail: '(login interativo)',
        };
    }
    /** Pausa a execucao ate o operador pressionar ENTER no terminal. */
    waitForEnter(prompt) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const readline = require('readline');
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        return new Promise((resolve) => {
            rl.question(prompt, () => { rl.close(); resolve(); });
        });
    }
}
exports.DOMExtractor = DOMExtractor;
/**
 * Parseia uma string de cookies no formato do header HTTP
 * ('nome1=valor1; nome2=valor2') em um dicionario. Aceita valores
 * com '=' internos (ex: JWT em base64). Ignora entradas malformadas.
 */
function parseCookieString(raw) {
    const dict = {};
    if (!raw)
        return dict;
    for (const chunk of raw.split(';')) {
        const trimmed = chunk.trim();
        if (!trimmed)
            continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx < 1)
            continue;
        const name = trimmed.substring(0, eqIdx).trim();
        const value = trimmed.substring(eqIdx + 1).trim();
        if (name)
            dict[name] = value;
    }
    return dict;
}
//# sourceMappingURL=DOMExtractor.js.map