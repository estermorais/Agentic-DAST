/**
 * scenarios/scenario-b.ts
 * ---------------------------------------------------------------
 * CENÁRIO B — Baseline guiado: ZAP + script E2E de navegação humana.
 *
 * Fluxo:
 *   1. Inicia Chrome com proxy → ZAP:8888
 *   2. Executa roteiro de navegação que cobre os principais fluxos
 *      do Juice Shop como um testador humano faria:
 *        - Home, busca de produto
 *        - Registro e login
 *        - Carrinho, checkout (parcial)
 *        - Formulário de feedback
 *        - Perfil do usuário
 *        - Rotas administrativas (tentativa)
 *        - Diretório FTP (exposição de dados)
 *        - Chamadas API diretas (sem autenticação)
 *   3. Fecha o navegador
 *   4. Coleta alertas passivos acumulados pelo ZAP
 *   5. Dispara scan ativo nas URLs visitadas
 *   6. Salva relatório JSON em /reports
 *
 * A diferença para o Cenário A: o ZAP agora vê muito mais superfície
 * de ataque porque o script E2E navega as rotas Angular que o spider
 * tradicional não consegue alcançar.
 *
 * A diferença para o Cenário C: o roteiro é fixo — não há raciocínio
 * semântico nem adaptação dinâmica ao estado da aplicação.
 * ---------------------------------------------------------------
 */

import puppeteer, { Browser, Page } from 'puppeteer';
import axios                        from 'axios';
import { ZapClient }                from '../auditor/ZapClient';
import { config }                   from '../config';
import { saveScenarioReport, printScenarioSummary } from './report';

// Credenciais de teste do Juice Shop
const TEST_EMAIL    = 'customer@juice-sh.op';
const TEST_PASSWORD = 'customer';

// ================================================================
// Navegação E2E
// ================================================================

async function runE2ENavigation(
  page: Page,
  baseUrl: string,
): Promise<void> {
  const goto = async (path: string, waitMs = 2000) => {
    const url = path.startsWith('http') ? path : `${baseUrl}${path}`;
    try {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 20_000 });
      await sleep(waitMs);
    } catch {
      // SPAs às vezes não disparam networkidle2; prossegue
      await sleep(waitMs);
    }
  };

  // ── 1. Home ──────────────────────────────────────────────────
  console.log('  [Nav] Home...');
  await goto('/#/', 2000);

  // ── 2. Busca de produto ──────────────────────────────────────
  console.log('  [Nav] Busca...');
  await goto('/#/search?q=apple', 1500);
  await goto('/#/search?q=<script>', 1500);  // payload potencial de XSS

  // ── 3. Página de produto individual ──────────────────────────
  console.log('  [Nav] Produto...');
  await goto('/#/', 1000);
  try {
    const productLink = await page.$('.mat-card');
    if (productLink) await productLink.click();
    await sleep(1500);
  } catch { /* sem produto clicável */ }

  // ── 4. Registro de novo usuário ──────────────────────────────
  console.log('  [Nav] Registro...');
  await goto('/#/register', 2000);
  try {
    await page.type('input[name="emailControl"]',    `test_${Date.now()}@test.com`);
    await page.type('input[name="passwordControl"]', 'Test1234!');
    await page.type('input[name="repeatPasswordControl"]', 'Test1234!');
    await sleep(500);
    // Não clica em submit — apenas preenche para ZAP ver o formulário
  } catch { /* formulário não encontrado */ }

  // ── 5. Login ──────────────────────────────────────────────────
  console.log('  [Nav] Login...');
  await goto('/#/login', 2000);
  try {
    await page.type('input[name="email"]',    TEST_EMAIL);
    await page.type('input[name="password"]', TEST_PASSWORD);
    await page.click('button[type="submit"]');
    await sleep(3000);
  } catch { /* formulário de login não encontrado */ }

  // ── 6. Carrinho ───────────────────────────────────────────────
  console.log('  [Nav] Carrinho...');
  await goto('/#/basket', 2000);

  // Tenta adicionar produto ao carrinho via API diretamente
  try {
    const jwt = await page.evaluate(() => localStorage.getItem('token') ?? '');
    if (jwt) {
      await axios.post(
        `${baseUrl}/api/BasketItems`,
        { BasketId: 1, ProductId: 1, quantity: 1 },
        { headers: { Authorization: `Bearer ${jwt}` }, timeout: 5000, validateStatus: () => true },
      );
    }
  } catch { /* opcional */ }

  // ── 7. Formulário de feedback (Contact) ───────────────────────
  console.log('  [Nav] Feedback...');
  await goto('/#/contact', 2000);
  try {
    await page.type('textarea[name="comment"]', '<iframe src="javascript:alert(1)">');
    await sleep(500);
    // Não submete — apenas exposição ao ZAP passive
  } catch { /* textarea não encontrada */ }

  // ── 8. Perfil do usuário ─────────────────────────────────────
  console.log('  [Nav] Perfil...');
  await goto('/#/profile', 2000);

  // ── 9. Histórico de pedidos ───────────────────────────────────
  console.log('  [Nav] Order history...');
  await goto('/#/order-history', 2000);

  // ── 10. Rota administrativa (acesso não autorizado) ───────────
  console.log('  [Nav] Admin route...');
  await goto('/#/administration', 2000);

  // ── 11. Score Board (rota oculta) ─────────────────────────────
  console.log('  [Nav] Score board...');
  await goto('/#/score-board', 2000);

  // ── 12. Diretório FTP ─────────────────────────────────────────
  console.log('  [Nav] FTP directory...');
  await goto('/ftp', 2000);
  await goto('/ftp/acquisitions.md', 2000);
  await goto('/ftp/package.json.bak', 1500);

  // ── 13. Endpoints de API sem autenticação ─────────────────────
  console.log('  [Nav] API endpoints...');
  await goto('/api/Users',                            1500);
  await goto('/rest/admin/application-configuration', 1500);
  await goto('/api/Products',                         1500);
  await goto('/api/Challenges',                       1500);

  // ── 14. SQL Injection na URL de busca ─────────────────────────
  console.log('  [Nav] SQL injection probe...');
  await goto("/#/search?q='%20OR%201=1--", 1500);

  // ── 15. Sobre ─────────────────────────────────────────────────
  console.log('  [Nav] About...');
  await goto('/#/about', 1500);

  console.log('  [Nav] Roteiro E2E concluído.\n');
}

// ================================================================
// Helpers
// ================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ================================================================
// Entry point
// ================================================================

async function main(): Promise<void> {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   CENÁRIO B — ZAP + NAVEGAÇÃO E2E        ║');
  console.log('╚══════════════════════════════════════════╝\n');

  const startTime = Date.now();
  const zapClient = new ZapClient();
  // No Cenário B, o browser usa a URL interna do ZAP (juice-shop:3000)
  // porque todo o tráfego passa pelo proxy ZAP e quem resolve o hostname
  // é o próprio ZAP (que está na Docker network 'dast-net'). Se usássemos
  // 'localhost', ZAP receberia a request mas não conseguiria resolver
  // 'localhost' como Juice Shop dentro do contêiner.
  const targetUrl    = config.zapTargetUrl;     // navegação via proxy
  const reportTargetUrl = config.targetUrl;     // URL exibida no relatório
  let browser: Browser | null = null;

  try {
    // ── Etapa 1: Lança Chrome com proxy ZAP ──────────────────
    console.log('[ ETAPA 1 ] Iniciando Chrome com proxy ZAP...\n');

    browser = await puppeteer.launch({
      headless: true,
      args: [
        `--proxy-server=http://${config.zapProxyHost}:${config.zapProxyPort}`,
        // CRÍTICO: por padrão o Chrome NÃO usa proxy para localhost/127.0.0.1
        // (otimização de segurança). Sem essa flag, todo o tráfego para o
        // Juice Shop em localhost pula o ZAP e ele não captura nada.
        '--proxy-bypass-list=<-loopback>',
        '--ignore-certificate-errors',
        '--no-sandbox',
        '--disable-setuid-sandbox',
      ],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });

    // Ignora erros de certificado SSL do proxy ZAP
    await page.setBypassCSP(true);

    // ── Etapa 2: Navega pela aplicação ───────────────────────
    console.log('[ ETAPA 2 ] Executando roteiro de navegação E2E...\n');
    await runE2ENavigation(page, targetUrl);

    // ── Etapa 3: Fecha o browser ─────────────────────────────
    await browser.close();
    browser = null;
    console.log('[ ETAPA 3 ] Browser encerrado.\n');

    // ── Etapa 4: Alertas passivos do ZAP ─────────────────────
    // Aguarda o ZAP terminar de processar passivamente todas as
    // requisições que passaram pelo proxy durante a navegação.
    // Sem essa pausa, alertas mais lentos podem ficar de fora.
    console.log('[ ETAPA 4 ] Aguardando ZAP processar tráfego (15s)...');
    await sleep(15_000);
    console.log('[ ETAPA 4 ] Coletando alertas passivos do ZAP...\n');
    const passiveFindings = await zapClient.getPassiveAlerts(targetUrl);

    // ── Etapa 5: Scan ativo nas URLs visitadas ────────────────
    // Usa a URL interna ZAP→juice-shop (não localhost) porque a chamada
    // é executada de dentro do contêiner ZAP.
    console.log('[ ETAPA 5 ] Iniciando scan ativo...\n');
    const scanId = await zapClient.startActiveScan(config.zapTargetUrl);
    if (scanId) {
      await zapClient.waitForScanCompletion(scanId, 600_000);
    }
    const activeFindings = await zapClient.getActiveScanAlerts(config.zapTargetUrl);

    // Deduplicação simples por título
    const seen = new Set<string>();
    const allFindings = [...passiveFindings, ...activeFindings].filter((f) => {
      const key = f.title.toLowerCase().trim();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // ── Etapa 6: Relatório ───────────────────────────────────
    const report = {
      scenario:      'B' as const,
      description:   'ZAP + roteiro E2E de navegação humana + scan ativo',
      generatedAt:   new Date().toISOString(),
      durationMs:    Date.now() - startTime,
      targetUrl:     reportTargetUrl,  // URL canônica do alvo no host
      findingsCount: allFindings.length,
      findings:      allFindings,
    };

    printScenarioSummary(report);

    const filepath = saveScenarioReport(report);
    console.log(`Relatório salvo em: ${filepath}\n`);

  } catch (err) {
    console.error('[ERRO FATAL]', (err as Error).message);
    process.exit(1);
  } finally {
    await browser?.close();
  }
}

main().catch((err) => {
  console.error('[ERRO NÃO TRATADO]', err);
  process.exit(1);
});
