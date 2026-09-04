"use strict";
/**
 * production-mode/ProductionPerception.ts
 * ---------------------------------------------------------------
 * Percepção para alvos de PRODUÇÃO reais (fora do Juice Shop).
 *
 * NAO substitui e NAO modifica o DOMExtractor oficial (perception/
 * DOMExtractor.ts), que foi validado contra o Juice Shop na rodada
 * n=30 do TCC. Esta é uma implementação paralela, usada apenas pelo
 * production-runner, que resolve dois problemas que impediam rodar
 * contra um app real:
 *
 *   1. HANDOFF DE SESSAO. O extrator oficial, ao reabrir em headless
 *      apos o login manual, so restaura cookies do host do alvo e
 *      ignora localStorage/sessionStorage. Em apps com auth OAuth/SSO
 *      (token em storage, cookies de sessao em outro subdominio) a
 *      sessao nao sobrevive e o headless cai de volta no login.
 *      Aqui capturamos TODOS os cookies (todos os dominios, via CDP)
 *      + localStorage + sessionStorage, e reinjetamos tudo com o
 *      dominio/origem corretos.
 *
 *   2. DESCOBERTA DE ROTAS. O extrator oficial visita uma lista fixa
 *      de rotas do Juice Shop (/#/administration, /#/basket, ...).
 *      Contra outro app isso so gera ruido. Aqui fazemos um crawl
 *      real a partir do alvo, seguindo links e rotas de hash da SPA.
 *
 * Produz um AppMap com o mesmo formato consumido pelo ReActAgent.
 * ---------------------------------------------------------------
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProductionPerception = void 0;
const puppeteer_1 = __importDefault(require("puppeteer"));
const readline = __importStar(require("readline"));
const config_1 = require("../config");
const TargetProfile_1 = require("./TargetProfile");
/** Limites do crawl para nao varrer o app inteiro. */
const MAX_PAGES = parseInt(process.env.CRAWL_MAX_PAGES ?? '25', 10);
const NAV_TIMEOUT_MS = 20_000;
class ProductionPerception {
    browser = null;
    interceptedEndpoints = [];
    targetUrl = config_1.config.targetUrl;
    targetHost = safeHost(config_1.config.targetUrl);
    /** Perfil do alvo (TARGET_PROFILE), se fornecido. */
    profile;
    constructor() {
        this.profile = (0, TargetProfile_1.loadTargetProfile)();
    }
    // ---------------------------------------------------------------
    // Ciclo de vida (mesma interface publica do DOMExtractor oficial)
    // ---------------------------------------------------------------
    async launch() {
        // Se INTERACTIVE_LOGIN=true, o browser abre visivel para o login
        // manual e so depois reabre em headless. Caso contrario, ja abre
        // headless.
        await this.launchInternal(!config_1.config.interactiveLogin);
    }
    async close() {
        await this.browser?.close();
        this.browser = null;
        console.log('[Percepção/prod] Browser encerrado.');
    }
    async extract() {
        if (!this.browser)
            throw new Error('Chame launch() antes de extract().');
        // 1. Autenticacao: login manual interativo OU sessao via env vars.
        const auth = await this.acquireSession();
        // 2. Crawl real do alvo (headless, ja autenticado).
        const crawledRoutes = await this.crawl();
        // 3. Semeia rotas/endpoints do perfil do alvo (superficie
        //    autoritativa) e faz merge com o que o crawl observou.
        //    Perfil vem primeiro (verdade); crawl confirma e complementa.
        const routes = this.mergeRoutes(this.profileRoutes(), crawledRoutes);
        const apiEndpoints = this.dedupeEndpoints([
            ...this.profileEndpoints(),
            ...this.interceptedEndpoints,
        ]);
        const observedHosts = this.collectObservedHosts(apiEndpoints);
        auth.cookies = this.filterCookiesForHosts(this.lastCapturedCookies, observedHosts);
        const framework = this.profile?.framework ?? (await this.detectFramework());
        const appMap = {
            baseUrl: this.targetUrl,
            routes,
            apiEndpoints,
            auth,
            metadata: {
                framework,
                title: this.lastTitle || this.targetHost,
                capturedAt: new Date(),
                totalForms: routes.reduce((sum, r) => sum + r.forms.length, 0),
                totalEndpoints: apiEndpoints.length,
            },
        };
        console.log(`[Percepção/prod] AppMap gerado: ${routes.length} rota(s), ` +
            `${apiEndpoints.length} endpoint(s), ` +
            `${appMap.metadata.totalForms} formulário(s).`);
        return appMap;
    }
    // ---------------------------------------------------------------
    // Autenticacao
    // ---------------------------------------------------------------
    lastCapturedCookies = [];
    lastTitle = '';
    async acquireSession() {
        if (config_1.config.interactiveLogin) {
            const session = await this.captureAfterManualLogin();
            await this.reopenHeadlessWithSession(session);
            const jwt = this.extractJwtFromStorage(session.storage);
            return {
                jwt,
                bearerToken: jwt,
                cookies: {}, // preenchido em extract(), apos saber os hosts
                userEmail: '(login interativo)',
            };
        }
        // Sessao via env vars (MANUAL_JWT / MANUAL_COOKIES). Cookies sao
        // injetados; storage nao se aplica nesse fluxo.
        if (config_1.config.manualJwt || config_1.config.manualCookies) {
            const cookieDict = parseCookieString(config_1.config.manualCookies);
            if (Object.keys(cookieDict).length > 0) {
                await this.injectSimpleCookies(cookieDict);
            }
            // Guarda os cookies manuais como "capturados" para o filtro por host.
            this.lastCapturedCookies = Object.entries(cookieDict).map(([name, value]) => simpleCookie(name, value, this.targetHost));
            return {
                jwt: config_1.config.manualJwt || undefined,
                bearerToken: config_1.config.manualJwt || undefined,
                cookies: {},
                userEmail: '(sessao manual via env)',
            };
        }
        console.warn('[Percepção/prod] Nenhuma sessao fornecida (sem INTERACTIVE_LOGIN, ' +
            'MANUAL_JWT ou MANUAL_COOKIES). Rodando como anonimo — a superficie ' +
            'autenticada nao sera visivel.');
        return { cookies: {}, userEmail: '(anonimo)' };
    }
    /**
     * Abre o alvo em browser VISIVEL, aguarda o operador logar
     * manualmente (senha + MFA + SSO), e ao ENTER captura a sessao
     * completa: todos os cookies (todos os dominios, via CDP) +
     * localStorage + sessionStorage da origem final.
     */
    async captureAfterManualLogin() {
        if (!this.browser)
            throw new Error('browser nao inicializado');
        const page = await this.browser.newPage();
        const cdp = await page.target().createCDPSession();
        console.log('');
        console.log('━'.repeat(72));
        console.log('  MODO INTERATIVO — LOGIN MANUAL');
        console.log('━'.repeat(72));
        console.log(`  Abrindo ${this.targetUrl} no browser visivel.`);
        console.log('  Faca login normalmente (senha + MFA + SSO conforme');
        console.log('  aplicavel). Quando estiver DENTRO da aplicacao');
        console.log('  autenticada, volte ao terminal e pressione ENTER.');
        console.log('━'.repeat(72));
        console.log('');
        try {
            await page.goto(this.targetUrl, {
                waitUntil: 'domcontentloaded',
                timeout: 60_000,
            });
        }
        catch (err) {
            console.warn(`[Percepção/prod] Aviso ao carregar pagina de login: ${err.message}`);
        }
        await waitForEnter('  Pressione ENTER apos concluir o login > ');
        // Cookies de TODOS os dominios (nao apenas o host do alvo). Isso
        // captura cookies de sessao emitidos por subdominios de auth/SSO.
        const { cookies } = await cdp.send('Network.getAllCookies');
        // Storage da origem final (onde o app autenticado carregou).
        const storage = await this.dumpStorage(page);
        const finalUrl = page.url();
        await page.close();
        const jwtKey = firstJwtKey(storage);
        console.log('');
        console.log('[Percepção/prod] Sessao capturada:');
        console.log(`  Cookies coletados  : ${cookies.length} (todos os dominios)`);
        console.log(`  localStorage keys  : ${Object.keys(storage.local).length}`);
        console.log(`  sessionStorage keys: ${Object.keys(storage.session).length}`);
        console.log(`  Token em storage   : ${jwtKey ? `sim (${jwtKey})` : 'nao'}`);
        console.log(`  URL final          : ${finalUrl}`);
        console.log('');
        this.lastCapturedCookies = cookies;
        return { cookies, storage, finalUrl };
    }
    /**
     * Fecha a janela visivel e reabre em headless, restaurando a sessao:
     * cookies (com dominio/path originais, via CDP) e localStorage/
     * sessionStorage (escritos na origem correta). Ao final, verifica se
     * a sessao realmente sobreviveu (nao redirecionou de volta ao login).
     */
    async reopenHeadlessWithSession(session) {
        console.log('[Percepção/prod] Fechando janela visivel e reabrindo em headless...');
        await this.browser?.close();
        await this.launchInternal(true);
        if (!this.browser)
            throw new Error('falha ao reabrir browser headless');
        const page = await this.browser.newPage();
        const cdp = await page.target().createCDPSession();
        // 1. Restaura cookies preservando dominio/path/flags originais.
        const restorable = session.cookies
            .map(toCookieParam)
            .filter((c) => c !== null);
        if (restorable.length > 0) {
            await cdp.send('Network.setCookies', { cookies: restorable });
            console.log(`[Percepção/prod] ${restorable.length} cookie(s) restaurado(s).`);
        }
        // 2. Restaura storage na origem correta (precisa estar na origem
        //    para escrever no localStorage/sessionStorage).
        const origin = session.storage.origin;
        const hasStorage = Object.keys(session.storage.local).length > 0 ||
            Object.keys(session.storage.session).length > 0;
        if (origin && hasStorage) {
            try {
                await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
                await page.evaluate((snap) => {
                    try {
                        for (const [k, v] of Object.entries(snap.local))
                            localStorage.setItem(k, v);
                        for (const [k, v] of Object.entries(snap.session))
                            sessionStorage.setItem(k, v);
                    }
                    catch {
                        /* storage indisponivel nesta origem */
                    }
                }, session.storage);
                console.log(`[Percepção/prod] Storage restaurado na origem ${origin}.`);
            }
            catch (err) {
                console.warn(`[Percepção/prod] Nao foi possivel restaurar storage: ${err.message}`);
            }
        }
        // 3. Verifica se a sessao sobreviveu.
        try {
            await page.goto(this.targetUrl, { waitUntil: 'networkidle2', timeout: NAV_TIMEOUT_MS });
            await sleep(1200);
            const landedHost = safeHost(page.url());
            const looksLikeLogin = await pageLooksLikeLogin(page);
            if (landedHost !== this.targetHost || looksLikeLogin) {
                console.warn(`[Percepção/prod] ATENCAO: apos restaurar a sessao, o alvo redirecionou ` +
                    `para "${page.url()}" ${looksLikeLogin ? '(pagina de login) ' : ''}` +
                    `— a autenticacao pode NAO ter sido preservada. Verifique se o token ` +
                    `esta em storage/cookie httpOnly de outra origem.`);
            }
            else {
                console.log('[Percepção/prod] Sessao verificada: alvo carregou autenticado. ✓');
            }
        }
        catch (err) {
            console.warn(`[Percepção/prod] Falha ao verificar sessao: ${err.message}`);
        }
        finally {
            await page.close();
        }
    }
    async injectSimpleCookies(cookieDict) {
        if (!this.browser)
            return;
        const page = await this.browser.newPage();
        const cdp = await page.target().createCDPSession();
        const cookies = Object.entries(cookieDict).map(([name, value]) => ({ name, value, domain: this.targetHost, path: '/' }));
        try {
            await cdp.send('Network.setCookies', { cookies });
            console.log(`[Percepção/prod] ${cookies.length} cookie(s) manual(is) injetado(s).`);
        }
        finally {
            await page.close();
        }
    }
    // ---------------------------------------------------------------
    // Crawl real
    // ---------------------------------------------------------------
    async crawl() {
        if (!this.browser)
            throw new Error('browser nao inicializado');
        const routes = [];
        const visited = new Set();
        const queue = [this.targetUrl];
        while (queue.length > 0 && visited.size < MAX_PAGES) {
            const url = queue.shift();
            const key = normalizeUrl(url);
            if (visited.has(key))
                continue;
            visited.add(key);
            // Guarda de escopo (perfil): nunca navegar para paths excluidos.
            if (this.isExcludedByScope(url)) {
                console.log(`[Percepção/prod] Fora de escopo (excludePaths), pulando: ${url}`);
                continue;
            }
            const page = await this.browser.newPage();
            this.attachInterceptor(page);
            try {
                console.log(`[Percepção/prod] Visitando: ${url}`);
                await page.goto(url, { waitUntil: 'networkidle2', timeout: NAV_TIMEOUT_MS });
                await sleep(1200);
                if (!this.lastTitle)
                    this.lastTitle = await page.title().catch(() => '');
                const route = await this.extractRoute(page, url);
                routes.push(route);
                // Enfileira novos links same-origin (paths e rotas de hash).
                const links = await this.extractLinks(page);
                for (const link of links) {
                    const nk = normalizeUrl(link);
                    if (!visited.has(nk) && queue.length + visited.size < MAX_PAGES * 3) {
                        queue.push(link);
                    }
                }
            }
            catch (err) {
                console.warn(`[Percepção/prod] Erro em ${url}: ${err.message}`);
            }
            finally {
                await page.close();
            }
        }
        return routes;
    }
    // ---------------------------------------------------------------
    // Seed a partir do perfil do alvo
    // ---------------------------------------------------------------
    /**
     * Converte rotas do perfil em AppRoute. Como o prompt do core so
     * expoe path/title/requiresAuth, dicas de papeis sao dobradas no
     * title (unica forma de leva-las ao LLM sem tocar no nucleo).
     */
    profileRoutes() {
        const routes = this.profile?.routes ?? [];
        return routes.map((r) => ({
            path: r.path,
            title: composeRouteTitle(r),
            requiresAuth: !!r.requiresAuth,
            forms: [],
            interactiveElements: [],
        }));
    }
    /**
     * Converte endpoints do perfil em ApiEndpoint. Exemplos de params de
     * query sao embutidos na URL (o agente pode usa-los direto); params
     * de body/notes ficam registrados no objeto, mas o prompt do core so
     * expoe method/url/authRequired.
     */
    profileEndpoints() {
        const endpoints = this.profile?.endpoints ?? [];
        return endpoints.map((e) => {
            const url = withQueryExamples((0, TargetProfile_1.resolveEndpointUrl)(e, this.profile?.apiBaseUrl), e);
            const endpoint = {
                method: e.method.toUpperCase(),
                url,
                authRequired: !!e.authRequired,
            };
            // Intel extra fica no objeto (nao chega ao prompt do core, mas
            // permanece no AppMap para relatorio / uso futuro).
            if (e.notes || e.idor || e.roles) {
                endpoint.responseBody = { notes: e.notes, idor: !!e.idor, roles: e.roles };
            }
            return endpoint;
        });
    }
    /** Une rotas do perfil (primeiro) com as do crawl, dedupe por path. */
    mergeRoutes(seed, crawled) {
        const byPath = new Map();
        for (const r of [...seed, ...crawled]) {
            const key = r.path.trim().toLowerCase();
            if (!byPath.has(key)) {
                byPath.set(key, r);
            }
            else {
                // Se o crawl trouxe forms/elementos, enriquece a entrada do perfil.
                const existing = byPath.get(key);
                if (existing.forms.length === 0 && r.forms.length > 0)
                    existing.forms = r.forms;
                if (existing.interactiveElements.length === 0 && r.interactiveElements.length > 0) {
                    existing.interactiveElements = r.interactiveElements;
                }
            }
        }
        return [...byPath.values()];
    }
    /** Verdadeiro se o path da URL casa com algum scope.excludePaths. */
    isExcludedByScope(url) {
        const excludes = this.profile?.scope?.excludePaths ?? [];
        if (excludes.length === 0)
            return false;
        let pathAndHash;
        try {
            const u = new URL(url);
            pathAndHash = `${u.pathname}${u.hash}`;
        }
        catch {
            pathAndHash = url;
        }
        return excludes.some((glob) => (0, TargetProfile_1.matchesGlob)(pathAndHash, glob));
    }
    async extractLinks(page) {
        const raw = await page.evaluate(() => {
            const out = [];
            document.querySelectorAll('a[href]').forEach((a) => {
                const href = a.href;
                if (href)
                    out.push(href);
            });
            // Angular/router usa routerLink; alguns viram href, outros nao.
            document.querySelectorAll('[routerLink]').forEach((el) => {
                const rl = el.getAttribute('routerLink');
                if (rl)
                    out.push(rl);
            });
            return out;
        });
        const result = [];
        for (const href of raw) {
            const abs = this.toSameOriginUrl(href);
            if (abs)
                result.push(abs);
        }
        return result;
    }
    /**
     * Resolve um href/routerLink para URL absoluta se e mesma origem do
     * alvo. Retorna null caso contrario (externo, mailto:, javascript:).
     */
    toSameOriginUrl(href) {
        try {
            if (/^(mailto:|tel:|javascript:|blob:|data:)/i.test(href))
                return null;
            // routerLink relativo (ex: "/settings" ou "settings")
            if (!/^https?:\/\//i.test(href) && !href.startsWith('#')) {
                const base = new URL(this.targetUrl);
                const resolved = new URL(href.startsWith('/') ? href : `/${href}`, base.origin);
                return resolved.toString();
            }
            // Rota de hash pura (ex: "#/contact")
            if (href.startsWith('#')) {
                const base = new URL(this.targetUrl);
                return `${base.origin}${base.pathname}${base.search}${href}`;
            }
            const u = new URL(href);
            if (safeHost(u.toString()) !== this.targetHost)
                return null;
            return u.toString();
        }
        catch {
            return null;
        }
    }
    async extractRoute(page, url) {
        const title = await page.title().catch(() => '');
        const forms = await page.evaluate(() => {
            const result = [];
            const formElements = document.querySelectorAll('form, mat-card');
            formElements.forEach((formEl, formIdx) => {
                const fields = [];
                const inputs = formEl.querySelectorAll('input, textarea, select, mat-select');
                inputs.forEach((input, inputIdx) => {
                    const el = input;
                    const selector = el.id
                        ? `#${el.id}`
                        : el.name
                            ? `[name="${el.name}"]`
                            : `form:nth-child(${formIdx + 1}) input:nth-child(${inputIdx + 1})`;
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
                        submitSelector: submitBtn?.id ? `#${submitBtn.id}` : 'button[type="submit"]',
                    });
                }
            });
            return result;
        });
        const interactiveElements = await page.evaluate(() => {
            const result = [];
            document.querySelectorAll('button, a[href], mat-menu-item').forEach((el, idx) => {
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
        const requiresAuth = await pageLooksLikeLogin(page);
        return {
            path: routePathOf(url, this.targetUrl),
            title,
            requiresAuth,
            forms,
            interactiveElements,
        };
    }
    // ---------------------------------------------------------------
    // Interceptacao de rede (endpoints de API)
    // ---------------------------------------------------------------
    attachInterceptor(page) {
        page.on('response', async (response) => {
            try {
                const req = response.request();
                const resType = req.resourceType();
                // So interessa API (xhr/fetch), nao assets estaticos.
                if (resType !== 'xhr' && resType !== 'fetch')
                    return;
                const url = response.url();
                const contentType = response.headers()['content-type'];
                let responseBody;
                if (contentType && contentType.includes('application/json')) {
                    responseBody = await response.text().catch(() => undefined);
                }
                this.interceptedEndpoints.push({
                    method: req.method(),
                    url,
                    responseStatus: response.status(),
                    responseBody,
                    contentType,
                    authRequired: response.status() === 401 || response.status() === 403,
                });
            }
            catch {
                /* resposta ja liberada / navegacao — ignora */
            }
        });
    }
    // ---------------------------------------------------------------
    // Helpers de sessao / storage / cookies
    // ---------------------------------------------------------------
    async dumpStorage(page) {
        const snap = await page
            .evaluate(() => {
            const dump = (s) => {
                const o = {};
                for (let i = 0; i < s.length; i++) {
                    const k = s.key(i);
                    if (k)
                        o[k] = s.getItem(k) ?? '';
                }
                return o;
            };
            return {
                origin: location.origin,
                local: dump(localStorage),
                session: dump(sessionStorage),
            };
        })
            .catch(() => ({ origin: '', local: {}, session: {} }));
        return snap;
    }
    extractJwtFromStorage(storage) {
        for (const bag of [storage.local, storage.session]) {
            for (const [, value] of Object.entries(bag)) {
                if (looksLikeJwt(value))
                    return value;
            }
        }
        // Fallback: chaves comuns mesmo que nao pareçam JWT (tokens opacos).
        const commonKeys = ['token', 'accessToken', 'access_token', 'id_token', 'authToken'];
        for (const bag of [storage.local, storage.session]) {
            for (const k of commonKeys) {
                const v = bag[k];
                if (v && v.length > 20)
                    return v;
            }
        }
        return undefined;
    }
    collectObservedHosts(endpoints) {
        const hosts = new Set([this.targetHost]);
        for (const e of endpoints) {
            const h = safeHost(e.url);
            if (h)
                hosts.add(h);
        }
        return hosts;
    }
    filterCookiesForHosts(cookies, hosts) {
        const dict = {};
        for (const c of cookies) {
            const domain = c.domain.replace(/^\./, '');
            const applies = [...hosts].some((h) => h === domain || h.endsWith(`.${domain}`) || domain.endsWith(`.${h}`));
            if (applies)
                dict[c.name] = c.value;
        }
        return dict;
    }
    async detectFramework() {
        if (!this.browser)
            return 'unknown';
        const page = await this.browser.newPage();
        try {
            await page.goto(this.targetUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
            return await page.evaluate(() => {
                const w = window;
                if (document.querySelector('[ng-version]') || w['ng'])
                    return 'Angular';
                if (w['React'] || document.querySelector('[data-reactroot], #root'))
                    return 'React';
                if (w['Vue'] || document.querySelector('[data-v-app], #app'))
                    return 'Vue';
                return 'unknown';
            });
        }
        catch {
            return 'unknown';
        }
        finally {
            await page.close();
        }
    }
    // ---------------------------------------------------------------
    // Browser
    // ---------------------------------------------------------------
    async launchInternal(headless) {
        const args = ['--no-sandbox', '--disable-setuid-sandbox'];
        if (config_1.config.useZapProxy) {
            args.push(`--proxy-server=http://${config_1.config.zapProxyHost}:${config_1.config.zapProxyPort}`);
            args.push('--proxy-bypass-list=<-loopback>');
            args.push('--ignore-certificate-errors');
            console.log(`[Percepção/prod] Usando proxy ZAP em ${config_1.config.zapProxyHost}:${config_1.config.zapProxyPort}`);
        }
        this.browser = await puppeteer_1.default.launch({ headless, args });
        console.log(`[Percepção/prod] Browser iniciado (headless=${headless}).`);
    }
    dedupeEndpoints(endpoints) {
        const seen = new Set();
        return endpoints.filter((e) => {
            const key = `${e.method} ${stripQuery(e.url)}`;
            if (seen.has(key))
                return false;
            seen.add(key);
            return true;
        });
    }
}
exports.ProductionPerception = ProductionPerception;
// ===============================================================
// Helpers puros
// ===============================================================
/** Title da rota com dica de papeis dobrada (unico canal p/ o LLM). */
function composeRouteTitle(r) {
    const base = r.title && r.title.trim() ? r.title.trim() : r.path;
    const roles = r.roles && r.roles.length > 0 ? ` [roles: ${r.roles.join(', ')}]` : '';
    return `${base}${roles}`;
}
/**
 * Embute exemplos de params de query na URL, para o agente ter um
 * request valido de partida. Nao inclui params de body/path (esses
 * o agente monta a partir das Observations).
 */
function withQueryExamples(url, e) {
    const queryParams = (e.params ?? []).filter((p) => p.in === 'query');
    if (queryParams.length === 0)
        return url;
    try {
        const u = new URL(url);
        for (const p of queryParams) {
            if (!u.searchParams.has(p.name))
                u.searchParams.set(p.name, p.example ?? '');
        }
        return u.toString();
    }
    catch {
        // URL relativa/nao parseavel: anexa query manualmente.
        const qs = queryParams
            .map((p) => `${encodeURIComponent(p.name)}=${encodeURIComponent(p.example ?? '')}`)
            .join('&');
        return url.includes('?') ? `${url}&${qs}` : `${url}?${qs}`;
    }
}
function safeHost(url) {
    try {
        return new URL(url).host;
    }
    catch {
        return '';
    }
}
function stripQuery(url) {
    try {
        const u = new URL(url);
        return `${u.origin}${u.pathname}`;
    }
    catch {
        return url;
    }
}
/** Chave de dedupe do crawl: origem+path+hash, sem query volatil. */
function normalizeUrl(url) {
    try {
        const u = new URL(url);
        return `${u.origin}${u.pathname}${u.hash}`;
    }
    catch {
        return url;
    }
}
/** Deriva um "path" legivel da rota, relativo ao alvo. */
function routePathOf(url, targetUrl) {
    try {
        const u = new URL(url);
        const t = new URL(targetUrl);
        if (u.hash)
            return u.hash; // SPA hash routing (#/algo)
        const rel = u.pathname.replace(t.pathname, '') || u.pathname;
        return rel.startsWith('/') ? rel : `/${rel}`;
    }
    catch {
        return url;
    }
}
function looksLikeJwt(value) {
    return typeof value === 'string' && /^[\w-]+\.[\w-]+\.[\w-]+$/.test(value);
}
function firstJwtKey(storage) {
    for (const [bagName, bag] of [
        ['local', storage.local],
        ['session', storage.session],
    ]) {
        for (const [k, v] of Object.entries(bag)) {
            if (looksLikeJwt(v))
                return `${bagName}Storage.${k}`;
        }
    }
    return null;
}
/** Converte um Cookie capturado (CDP) num CookieParam restauravel. */
function toCookieParam(c) {
    if (!c.name || !c.domain)
        return null;
    const param = {
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path || '/',
        secure: c.secure,
        httpOnly: c.httpOnly,
    };
    if (typeof c.expires === 'number' && c.expires > 0)
        param.expires = c.expires;
    if (c.sameSite === 'Strict' || c.sameSite === 'Lax' || c.sameSite === 'None') {
        param.sameSite = c.sameSite;
    }
    return param;
}
function simpleCookie(name, value, host) {
    return {
        name,
        value,
        domain: host,
        path: '/',
        expires: -1,
        size: name.length + value.length,
        httpOnly: false,
        secure: true,
        session: true,
    };
}
async function pageLooksLikeLogin(page) {
    return page
        .evaluate(() => {
        const body = (document.body?.innerText || '').toLowerCase();
        const url = location.href.toLowerCase();
        return (/\/(login|signin|sign-in|auth|oauth|sso)(\b|\/|\?|#)/.test(url) ||
            document.querySelector('input[type="password"]') !== null ||
            body.includes('please login') ||
            /login|entrar|sign in/.test(document.title.toLowerCase()));
    })
        .catch(() => false);
}
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
function waitForEnter(prompt) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
        rl.question(prompt, () => {
            rl.close();
            resolve();
        });
    });
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
//# sourceMappingURL=ProductionPerception.js.map