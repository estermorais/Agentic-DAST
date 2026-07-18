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

import puppeteer, { Browser, Page } from 'puppeteer';
import { config } from '../../config';

/** Resolve URL relativa contra o targetUrl (mesmo helper do HttpClient) */
function resolveUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  try {
    return new URL(url, config.browserBaseUrl).toString();
  } catch {
    return url;
  }
}

export class BrowseTheWeb {
  private browser: Browser | null = null;
  private page: Page | null = null;

  /**
   * Factory estático — inicia o browser e retorna a ability pronta.
   * Roteia o tráfego pelo ZAP se USE_ZAP_PROXY=true.
   */
  static async launch(): Promise<BrowseTheWeb> {
    const ability = new BrowseTheWeb();
    await ability.init();
    return ability;
  }

  private async init(): Promise<void> {
    const args = ['--no-sandbox', '--disable-setuid-sandbox'];

    if (config.useZapProxy) {
      // Roteia o browser do Actor pelo ZAP. Chrome, com proxy HTTP para
      // URL HTTP, envia a URL LITERAL ao proxy e quem resolve o hostname
      // e o ZAP. Por isso o resolveUrl acima ja usa config.browserBaseUrl
      // (juice-shop:3000), que o ZAP resolve via Docker network dast-net.
      // A flag --proxy-bypass-list=<-loopback> continua necessaria porque
      // o proxy vive em localhost:8080 e o Chrome, por padrao, faria
      // bypass para hosts loopback.
      args.push(`--proxy-server=http://${config.zapProxyHost}:${config.zapProxyPort}`);
      args.push('--proxy-bypass-list=<-loopback>');
      args.push('--ignore-certificate-errors');
      console.log(`[Executor] Proxy ZAP ativo em ${config.zapProxyHost}:${config.zapProxyPort} (navegação via ${config.browserBaseUrl})`);
    }

    this.browser = await puppeteer.launch({ headless: true, args });
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
  async navigate(url: string): Promise<string> {
    const page = this.requirePage();
    const fullUrl = resolveUrl(url);
    try {
      await page.goto(fullUrl, { waitUntil: 'networkidle2' });
      await this.sleep(500);
      const title = await page.title();
      return `Navegou para ${fullUrl}. Título: "${title}". URL atual: ${page.url()}`;
    } catch (err) {
      return `ERRO ao navegar para ${fullUrl}: ${(err as Error).message}`;
    }
  }

  /**
   * Preenche um campo de formulário identificado por seletor CSS.
   * Limpa o valor existente antes de digitar.
   */
  async fillField(selector: string, value: string): Promise<string> {
    const page = this.requirePage();
    try {
      await page.waitForSelector(selector, { timeout: 5_000 });

      // Limpa o campo e então digita o novo valor
      await page.$eval(selector, (el) => {
        (el as HTMLInputElement).value = '';
      });
      await page.type(selector, value, { delay: 30 });

      return `Campo "${selector}" preenchido com "${value}".`;
    } catch (err) {
      return `ERRO: campo "${selector}" não encontrado ou não preenchível. ${(err as Error).message}`;
    }
  }

  /**
   * Clica em um elemento e aguarda possível navegação/re-render.
   */
  async clickElement(selector: string): Promise<string> {
    const page = this.requirePage();
    try {
      await page.waitForSelector(selector, { timeout: 5_000 });
      await page.click(selector);
      await this.sleep(800);
      return `Elemento "${selector}" clicado. URL atual: ${page.url()}`;
    } catch (err) {
      return `ERRO: não foi possível clicar em "${selector}". ${(err as Error).message}`;
    }
  }

  /**
   * Lê o conteúdo textual da página atual (URL + título + body).
   * Limita a 2000 caracteres para não saturar o contexto do LLM.
   */
  async readPage(): Promise<string> {
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
  async extractTokens(): Promise<string> {
    const page = this.requirePage();

    const jwt = await page.evaluate(() => {
      return localStorage.getItem('token') ?? localStorage.getItem('jwt') ?? null;
    });

    const puppeteerCookies = await page.cookies();
    const cookies = puppeteerCookies.reduce<Record<string, string>>((acc, c) => {
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
  async close(): Promise<void> {
    await this.browser?.close();
    console.log('[Executor] Browser do Actor encerrado.');
  }

  // -----------------------------------------------------------

  private requirePage(): Page {
    if (!this.page) throw new Error('BrowseTheWeb não iniciada. Chame launch() primeiro.');
    return this.page;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
