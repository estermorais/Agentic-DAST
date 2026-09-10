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

import puppeteer, {
  Browser,
  Page,
  Protocol,
} from 'puppeteer';
import * as readline from 'readline';

import { config } from '../config';
import {
  AppMap,
  AppRoute,
  ApiEndpoint,
  AppForm,
  FormField,
  InteractiveElement,
  AuthContext,
  StorageSnapshot,
  BrowserSession,
} from '../perception/types';
import {
  TargetProfile,
  ProfileRoute,
  ProfileEndpoint,
  loadTargetProfile,
  resolveEndpointUrl,
  matchesGlob,
} from './TargetProfile';

/** Sessao capturada apos o login manual. */
interface CapturedSession {
  cookies: Protocol.Network.Cookie[];
  storage: StorageSnapshot;
  finalUrl: string;
}

/** Limites do crawl para nao varrer o app inteiro. */
const MAX_PAGES = parseInt(process.env.CRAWL_MAX_PAGES ?? '25', 10);
const NAV_TIMEOUT_MS = 20_000;

export class ProductionPerception {
  private browser: Browser | null = null;
  private interceptedEndpoints: ApiEndpoint[] = [];

  private readonly targetUrl = config.targetUrl;
  private readonly targetHost = safeHost(config.targetUrl);

  /** Perfil do alvo (TARGET_PROFILE), se fornecido. */
  private readonly profile: TargetProfile | null;

  constructor() {
    this.profile = loadTargetProfile();
  }

  // ---------------------------------------------------------------
  // Ciclo de vida (mesma interface publica do DOMExtractor oficial)
  // ---------------------------------------------------------------

  async launch(): Promise<void> {
    // Se INTERACTIVE_LOGIN=true, o browser abre visivel para o login
    // manual e so depois reabre em headless. Caso contrario, ja abre
    // headless.
    await this.launchInternal(!config.interactiveLogin);
  }

  async close(): Promise<void> {
    await this.browser?.close();
    this.browser = null;
    console.log('[Percepção/prod] Browser encerrado.');
  }

  async extract(): Promise<AppMap> {
    if (!this.browser) throw new Error('Chame launch() antes de extract().');

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

    const appMap: AppMap = {
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

    console.log(
      `[Percepção/prod] AppMap gerado: ${routes.length} rota(s), ` +
      `${apiEndpoints.length} endpoint(s), ` +
      `${appMap.metadata.totalForms} formulário(s).`,
    );

    return appMap;
  }

  // ---------------------------------------------------------------
  // Autenticacao
  // ---------------------------------------------------------------

  private lastCapturedCookies: Protocol.Network.Cookie[] = [];
  private lastStorage: StorageSnapshot | null = null;
  private lastFinalUrl = '';
  private lastTitle = '';

  private async acquireSession(): Promise<AuthContext> {
    if (config.interactiveLogin) {
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
    if (config.manualJwt || config.manualCookies) {
      const cookieDict = parseCookieString(config.manualCookies);
      if (Object.keys(cookieDict).length > 0) {
        await this.injectSimpleCookies(cookieDict);
      }
      // Guarda os cookies manuais como "capturados" para o filtro por host.
      this.lastCapturedCookies = Object.entries(cookieDict).map(([name, value]) =>
        simpleCookie(name, value, this.targetHost),
      );
      return {
        jwt: config.manualJwt || undefined,
        bearerToken: config.manualJwt || undefined,
        cookies: {},
        userEmail: '(sessao manual via env)',
      };
    }

    console.warn(
      '[Percepção/prod] Nenhuma sessao fornecida (sem INTERACTIVE_LOGIN, ' +
      'MANUAL_JWT ou MANUAL_COOKIES). Rodando como anonimo — a superficie ' +
      'autenticada nao sera visivel.',
    );
    return { cookies: {}, userEmail: '(anonimo)' };
  }

  /**
   * Abre o alvo em browser VISIVEL, aguarda o operador logar
   * manualmente (senha + MFA + SSO), e ao ENTER captura a sessao
   * completa: todos os cookies (todos os dominios, via CDP) +
   * localStorage + sessionStorage da origem final.
   */
  private async captureAfterManualLogin(): Promise<CapturedSession> {
    if (!this.browser) throw new Error('browser nao inicializado');

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
    } catch (err) {
      console.warn(
        `[Percepção/prod] Aviso ao carregar pagina de login: ${(err as Error).message}`,
      );
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
    this.lastStorage = storage;
    this.lastFinalUrl = finalUrl;
    return { cookies, storage, finalUrl };
  }

  /**
   * Fecha a janela visivel e reabre em headless, restaurando a sessao:
   * cookies (com dominio/path originais, via CDP) e localStorage/
   * sessionStorage (escritos na origem correta). Ao final, verifica se
   * a sessao realmente sobreviveu (nao redirecionou de volta ao login).
   */
  private async reopenHeadlessWithSession(session: CapturedSession): Promise<void> {
    console.log('[Percepção/prod] Fechando janela visivel e reabrindo em headless...');
    await this.browser?.close();
    await this.launchInternal(true);
    if (!this.browser) throw new Error('falha ao reabrir browser headless');

    const page = await this.browser.newPage();
    const cdp = await page.target().createCDPSession();

    // 1. Restaura cookies preservando dominio/path/flags originais.
    const restorable = session.cookies
      .map(toCookieParam)
      .filter((c): c is Protocol.Network.CookieParam => c !== null);
    if (restorable.length > 0) {
      await cdp.send('Network.setCookies', { cookies: restorable });
      console.log(`[Percepção/prod] ${restorable.length} cookie(s) restaurado(s).`);
    }

    // 2. Restaura storage na origem correta (precisa estar na origem
    //    para escrever no localStorage/sessionStorage).
    const origin = session.storage.origin;
    const hasStorage =
      Object.keys(session.storage.local).length > 0 ||
      Object.keys(session.storage.session).length > 0;
    if (origin && hasStorage) {
      try {
        await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
        await page.evaluate((snap: StorageSnapshot) => {
          try {
            for (const [k, v] of Object.entries(snap.local)) localStorage.setItem(k, v);
            for (const [k, v] of Object.entries(snap.session)) sessionStorage.setItem(k, v);
          } catch {
            /* storage indisponivel nesta origem */
          }
        }, session.storage);
        console.log(`[Percepção/prod] Storage restaurado na origem ${origin}.`);
      } catch (err) {
        console.warn(
          `[Percepção/prod] Nao foi possivel restaurar storage: ${(err as Error).message}`,
        );
      }
    }

    // 3. Verifica se a sessao sobreviveu.
    try {
      await page.goto(this.targetUrl, { waitUntil: 'networkidle2', timeout: NAV_TIMEOUT_MS });
      await sleep(1200);
      const landedHost = safeHost(page.url());
      const looksLikeLogin = await pageLooksLikeLogin(page);
      if (landedHost !== this.targetHost || looksLikeLogin) {
        console.warn(
          `[Percepção/prod] ATENCAO: apos restaurar a sessao, o alvo redirecionou ` +
          `para "${page.url()}" ${looksLikeLogin ? '(pagina de login) ' : ''}` +
          `— a autenticacao pode NAO ter sido preservada. Verifique se o token ` +
          `esta em storage/cookie httpOnly de outra origem.`,
        );
      } else {
        console.log('[Percepção/prod] Sessao verificada: alvo carregou autenticado. ✓');
      }
    } catch (err) {
      console.warn(`[Percepção/prod] Falha ao verificar sessao: ${(err as Error).message}`);
    } finally {
      await page.close();
    }
  }

  private async injectSimpleCookies(cookieDict: Record<string, string>): Promise<void> {
    if (!this.browser) return;
    const page = await this.browser.newPage();
    const cdp = await page.target().createCDPSession();
    const cookies: Protocol.Network.CookieParam[] = Object.entries(cookieDict).map(
      ([name, value]) => ({ name, value, domain: this.targetHost, path: '/' }),
    );
    try {
      await cdp.send('Network.setCookies', { cookies });
      console.log(`[Percepção/prod] ${cookies.length} cookie(s) manual(is) injetado(s).`);
    } finally {
      await page.close();
    }
  }

  /**
   * Empacota a sessao capturada (cookies de todos os dominios +
   * localStorage/sessionStorage) para handoff ao browser do Executor.
   * Deve ser chamado apos extract(). Retorna null quando nao ha
   * sessao a propagar (rodada anonima).
   *
   * Diferente do AppMap.auth (que so alimenta os headers do
   * HttpClient), esta sessao restaura o estado de browser necessario
   * para que as acoes `navigate` do agente permanecam autenticadas
   * em SPAs OAuth/SSO — cujo token vive em storage, nao em header.
   */
  getBrowserSession(): BrowserSession | null {
    const cookies = this.lastCapturedCookies
      .map(toCookieParam)
      .filter((c): c is Protocol.Network.CookieParam => c !== null);

    const storage: StorageSnapshot =
      this.lastStorage ?? { origin: '', local: {}, session: {} };
    const hasStorage =
      Object.keys(storage.local).length > 0 ||
      Object.keys(storage.session).length > 0;

    if (cookies.length === 0 && !hasStorage) return null;

    return {
      cookies,
      storage,
      finalUrl: this.lastFinalUrl || this.targetUrl,
    };
  }

  // ---------------------------------------------------------------
  // Crawl real
  // ---------------------------------------------------------------

  private async crawl(): Promise<AppRoute[]> {
    if (!this.browser) throw new Error('browser nao inicializado');

    const routes: AppRoute[] = [];
    const visited = new Set<string>();
    const queue: string[] = [this.targetUrl];

    while (queue.length > 0 && visited.size < MAX_PAGES) {
      const url = queue.shift()!;
      const key = normalizeUrl(url);
      if (visited.has(key)) continue;
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

        if (!this.lastTitle) this.lastTitle = await page.title().catch(() => '');

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
      } catch (err) {
        console.warn(`[Percepção/prod] Erro em ${url}: ${(err as Error).message}`);
      } finally {
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
  private profileRoutes(): AppRoute[] {
    const routes = this.profile?.routes ?? [];
    return routes.map((r: ProfileRoute) => ({
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
  private profileEndpoints(): ApiEndpoint[] {
    const endpoints = this.profile?.endpoints ?? [];
    return endpoints.map((e: ProfileEndpoint) => {
      const url = withQueryExamples(
        resolveEndpointUrl(e, this.profile?.apiBaseUrl),
        e,
      );
      const endpoint: ApiEndpoint = {
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
  private mergeRoutes(seed: AppRoute[], crawled: AppRoute[]): AppRoute[] {
    const byPath = new Map<string, AppRoute>();
    for (const r of [...seed, ...crawled]) {
      const key = r.path.trim().toLowerCase();
      if (!byPath.has(key)) {
        byPath.set(key, r);
      } else {
        // Se o crawl trouxe forms/elementos, enriquece a entrada do perfil.
        const existing = byPath.get(key)!;
        if (existing.forms.length === 0 && r.forms.length > 0) existing.forms = r.forms;
        if (existing.interactiveElements.length === 0 && r.interactiveElements.length > 0) {
          existing.interactiveElements = r.interactiveElements;
        }
      }
    }
    return [...byPath.values()];
  }

  /** Verdadeiro se o path da URL casa com algum scope.excludePaths. */
  private isExcludedByScope(url: string): boolean {
    const excludes = this.profile?.scope?.excludePaths ?? [];
    if (excludes.length === 0) return false;
    let pathAndHash: string;
    try {
      const u = new URL(url);
      pathAndHash = `${u.pathname}${u.hash}`;
    } catch {
      pathAndHash = url;
    }
    return excludes.some((glob) => matchesGlob(pathAndHash, glob));
  }

  private async extractLinks(page: Page): Promise<string[]> {
    const raw = await page.evaluate(() => {
      const out: string[] = [];
      document.querySelectorAll('a[href]').forEach((a) => {
        const href = (a as HTMLAnchorElement).href;
        if (href) out.push(href);
      });
      // Angular/router usa routerLink; alguns viram href, outros nao.
      document.querySelectorAll('[routerLink]').forEach((el) => {
        const rl = el.getAttribute('routerLink');
        if (rl) out.push(rl);
      });
      return out;
    });

    const result: string[] = [];
    for (const href of raw) {
      const abs = this.toSameOriginUrl(href);
      if (abs) result.push(abs);
    }
    return result;
  }

  /**
   * Resolve um href/routerLink para URL absoluta se e mesma origem do
   * alvo. Retorna null caso contrario (externo, mailto:, javascript:).
   */
  private toSameOriginUrl(href: string): string | null {
    try {
      if (/^(mailto:|tel:|javascript:|blob:|data:)/i.test(href)) return null;

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
      if (safeHost(u.toString()) !== this.targetHost) return null;
      return u.toString();
    } catch {
      return null;
    }
  }

  private async extractRoute(page: Page, url: string): Promise<AppRoute> {
    const title = await page.title().catch(() => '');

    const forms = await page.evaluate((): AppForm[] => {
      const result: AppForm[] = [];
      const formElements = document.querySelectorAll('form, mat-card');

      formElements.forEach((formEl, formIdx) => {
        const fields: FormField[] = [];
        const inputs = formEl.querySelectorAll('input, textarea, select, mat-select');

        inputs.forEach((input, inputIdx) => {
          const el = input as HTMLInputElement;
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
          const submitBtn = formEl.querySelector(
            'button[type="submit"], button.mat-raised-button',
          ) as HTMLElement | null;
          result.push({
            id: `form_${formIdx}`,
            pageUrl: window.location.href,
            action: (formEl as HTMLFormElement).action || undefined,
            method: (formEl as HTMLFormElement).method || 'POST',
            fields,
            submitSelector: submitBtn?.id ? `#${submitBtn.id}` : 'button[type="submit"]',
          });
        }
      });

      return result;
    });

    const interactiveElements = await page.evaluate((): InteractiveElement[] => {
      const result: InteractiveElement[] = [];
      document.querySelectorAll('button, a[href], mat-menu-item').forEach((el, idx) => {
        const text = (el.textContent || '').trim();
        if (!text || text.length > 80) return;
        const href = (el as HTMLAnchorElement).href;
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

  private attachInterceptor(page: Page): void {
    page.on('response', async (response) => {
      try {
        const req = response.request();
        const resType = req.resourceType();
        // So interessa API (xhr/fetch), nao assets estaticos.
        if (resType !== 'xhr' && resType !== 'fetch') return;

        const url = response.url();
        const contentType = response.headers()['content-type'];

        let responseBody: unknown;
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
      } catch {
        /* resposta ja liberada / navegacao — ignora */
      }
    });
  }

  // ---------------------------------------------------------------
  // Helpers de sessao / storage / cookies
  // ---------------------------------------------------------------

  private async dumpStorage(page: Page): Promise<StorageSnapshot> {
    const snap = await page
      .evaluate(() => {
        const dump = (s: Storage): Record<string, string> => {
          const o: Record<string, string> = {};
          for (let i = 0; i < s.length; i++) {
            const k = s.key(i);
            if (k) o[k] = s.getItem(k) ?? '';
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

  private extractJwtFromStorage(storage: StorageSnapshot): string | undefined {
    for (const bag of [storage.local, storage.session]) {
      for (const [, value] of Object.entries(bag)) {
        if (looksLikeJwt(value)) return value;
      }
    }
    // Fallback: chaves comuns mesmo que nao pareçam JWT (tokens opacos).
    const commonKeys = ['token', 'accessToken', 'access_token', 'id_token', 'authToken'];
    for (const bag of [storage.local, storage.session]) {
      for (const k of commonKeys) {
        const v = bag[k];
        if (v && v.length > 20) return v;
      }
    }
    return undefined;
  }

  private collectObservedHosts(endpoints: ApiEndpoint[]): Set<string> {
    const hosts = new Set<string>([this.targetHost]);
    for (const e of endpoints) {
      const h = safeHost(e.url);
      if (h) hosts.add(h);
    }
    return hosts;
  }

  private filterCookiesForHosts(
    cookies: Protocol.Network.Cookie[],
    hosts: Set<string>,
  ): Record<string, string> {
    const dict: Record<string, string> = {};
    for (const c of cookies) {
      const domain = c.domain.replace(/^\./, '');
      const applies = [...hosts].some(
        (h) => h === domain || h.endsWith(`.${domain}`) || domain.endsWith(`.${h}`),
      );
      if (applies) dict[c.name] = c.value;
    }
    return dict;
  }

  private async detectFramework(): Promise<string> {
    if (!this.browser) return 'unknown';
    const page = await this.browser.newPage();
    try {
      await page.goto(this.targetUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
      return await page.evaluate(() => {
        const w = window as unknown as Record<string, unknown>;
        if (document.querySelector('[ng-version]') || w['ng']) return 'Angular';
        if (w['React'] || document.querySelector('[data-reactroot], #root')) return 'React';
        if (w['Vue'] || document.querySelector('[data-v-app], #app')) return 'Vue';
        return 'unknown';
      });
    } catch {
      return 'unknown';
    } finally {
      await page.close();
    }
  }

  // ---------------------------------------------------------------
  // Browser
  // ---------------------------------------------------------------

  private async launchInternal(headless: boolean): Promise<void> {
    const args = ['--no-sandbox', '--disable-setuid-sandbox'];

    if (config.useZapProxy) {
      args.push(`--proxy-server=http://${config.zapProxyHost}:${config.zapProxyPort}`);
      args.push('--proxy-bypass-list=<-loopback>');
      args.push('--ignore-certificate-errors');
      console.log(
        `[Percepção/prod] Usando proxy ZAP em ${config.zapProxyHost}:${config.zapProxyPort}`,
      );
    }

    this.browser = await puppeteer.launch({ headless, args });
    console.log(`[Percepção/prod] Browser iniciado (headless=${headless}).`);
  }

  private dedupeEndpoints(endpoints: ApiEndpoint[]): ApiEndpoint[] {
    const seen = new Set<string>();
    return endpoints.filter((e) => {
      const key = `${e.method} ${stripQuery(e.url)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
}

// ===============================================================
// Helpers puros
// ===============================================================

/** Title da rota com dica de papeis dobrada (unico canal p/ o LLM). */
function composeRouteTitle(r: ProfileRoute): string {
  const base = r.title && r.title.trim() ? r.title.trim() : r.path;
  const roles = r.roles && r.roles.length > 0 ? ` [roles: ${r.roles.join(', ')}]` : '';
  return `${base}${roles}`;
}

/**
 * Embute exemplos de params de query na URL, para o agente ter um
 * request valido de partida. Nao inclui params de body/path (esses
 * o agente monta a partir das Observations).
 */
function withQueryExamples(url: string, e: ProfileEndpoint): string {
  const queryParams = (e.params ?? []).filter((p) => p.in === 'query');
  if (queryParams.length === 0) return url;
  try {
    const u = new URL(url);
    for (const p of queryParams) {
      if (!u.searchParams.has(p.name)) u.searchParams.set(p.name, p.example ?? '');
    }
    return u.toString();
  } catch {
    // URL relativa/nao parseavel: anexa query manualmente.
    const qs = queryParams
      .map((p) => `${encodeURIComponent(p.name)}=${encodeURIComponent(p.example ?? '')}`)
      .join('&');
    return url.includes('?') ? `${url}&${qs}` : `${url}?${qs}`;
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

function stripQuery(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url;
  }
}

/** Chave de dedupe do crawl: origem+path+hash, sem query volatil. */
function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}${u.hash}`;
  } catch {
    return url;
  }
}

/** Deriva um "path" legivel da rota, relativo ao alvo. */
function routePathOf(url: string, targetUrl: string): string {
  try {
    const u = new URL(url);
    const t = new URL(targetUrl);
    if (u.hash) return u.hash; // SPA hash routing (#/algo)
    const rel = u.pathname.replace(t.pathname, '') || u.pathname;
    return rel.startsWith('/') ? rel : `/${rel}`;
  } catch {
    return url;
  }
}

function looksLikeJwt(value: string): boolean {
  return typeof value === 'string' && /^[\w-]+\.[\w-]+\.[\w-]+$/.test(value);
}

function firstJwtKey(storage: StorageSnapshot): string | null {
  for (const [bagName, bag] of [
    ['local', storage.local],
    ['session', storage.session],
  ] as const) {
    for (const [k, v] of Object.entries(bag)) {
      if (looksLikeJwt(v)) return `${bagName}Storage.${k}`;
    }
  }
  return null;
}

/** Converte um Cookie capturado (CDP) num CookieParam restauravel. */
function toCookieParam(c: Protocol.Network.Cookie): Protocol.Network.CookieParam | null {
  if (!c.name || !c.domain) return null;
  const param: Protocol.Network.CookieParam = {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || '/',
    secure: c.secure,
    httpOnly: c.httpOnly,
  };
  if (typeof c.expires === 'number' && c.expires > 0) param.expires = c.expires;
  if (c.sameSite === 'Strict' || c.sameSite === 'Lax' || c.sameSite === 'None') {
    param.sameSite = c.sameSite;
  }
  return param;
}

function simpleCookie(name: string, value: string, host: string): Protocol.Network.Cookie {
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
  } as Protocol.Network.Cookie;
}

async function pageLooksLikeLogin(page: Page): Promise<boolean> {
  return page
    .evaluate(() => {
      const body = (document.body?.innerText || '').toLowerCase();
      const url = location.href.toLowerCase();
      return (
        /\/(login|signin|sign-in|auth|oauth|sso)(\b|\/|\?|#)/.test(url) ||
        document.querySelector('input[type="password"]') !== null ||
        body.includes('please login') ||
        /login|entrar|sign in/.test(document.title.toLowerCase())
      );
    })
    .catch(() => false);
}

function parseCookieString(raw: string): Record<string, string> {
  const dict: Record<string, string> = {};
  if (!raw) return dict;
  for (const chunk of raw.split(';')) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 1) continue;
    const name = trimmed.substring(0, eqIdx).trim();
    const value = trimmed.substring(eqIdx + 1).trim();
    if (name) dict[name] = value;
  }
  return dict;
}

function waitForEnter(prompt: string): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<void>((resolve) => {
    rl.question(prompt, () => {
      rl.close();
      resolve();
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
