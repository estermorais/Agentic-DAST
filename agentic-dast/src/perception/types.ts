/**
 * perception/types.ts
 * ---------------------------------------------------------------
 * Define as estruturas de dados que representam o "mapa semântico"
 * da aplicação descoberto pelo módulo de Percepção.
 *
 * AppMap é o principal artefato deste módulo — ele resume tudo que
 * o agente precisa saber sobre a SPA antes de começar o ataque.
 * ---------------------------------------------------------------
 */

/** Um campo de formulário encontrado na página */
export interface FormField {
  name: string;
  type: string;           // text, password, email, number, hidden, etc.
  placeholder?: string;
  required: boolean;
  selector: string;       // seletor CSS para o Puppeteer interagir
  currentValue?: string;
}

/** Um formulário completo encontrado na página */
export interface AppForm {
  id: string;
  pageUrl: string;
  action?: string;        // para onde o form envia os dados
  method?: string;        // GET ou POST
  fields: FormField[];
  submitSelector?: string;
}

/** Uma chamada HTTP interceptada durante a navegação */
export interface ApiEndpoint {
  method: string;         // GET, POST, PUT, DELETE, PATCH
  url: string;
  requestBody?: unknown;
  responseStatus?: number;
  responseBody?: unknown;
  contentType?: string;
  authRequired: boolean;  // se a rota retornou 401/403 sem token
}

/** Uma rota da SPA descoberta */
export interface AppRoute {
  path: string;           // ex: /rest/user/login, /#/administration
  title: string;
  requiresAuth: boolean;
  forms: AppForm[];
  interactiveElements: InteractiveElement[];
}

/** Botão, link ou elemento clicável identificado na página */
export interface InteractiveElement {
  type: 'button' | 'link' | 'input';
  text: string;
  selector: string;
  href?: string;
}

/** Tokens de autenticação coletados durante a navegação */
export interface AuthContext {
  jwt?: string;           // token JWT do localStorage/cookie
  bearerToken?: string;   // Authorization: Bearer ...
  cookies: Record<string, string>;
  userEmail?: string;
  userId?: number;
}

/** Snapshot de storage de uma origem (localStorage + sessionStorage). */
export interface StorageSnapshot {
  origin: string;
  local: Record<string, string>;
  session: Record<string, string>;
}

/**
 * Cookie no formato aceito pelo CDP (Network.setCookies). Estrutural
 * — compativel com Protocol.Network.CookieParam do Puppeteer — para
 * nao acoplar este modulo de tipos ao Puppeteer.
 */
export interface CdpCookieParam {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  url?: string;
  secure?: boolean;
  httpOnly?: boolean;
  expires?: number;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

/**
 * Sessao de browser capturada na Percepcao, empacotada para handoff
 * ao browser do Executor (BrowseTheWeb). Diferente do AuthContext,
 * que so carrega token/cookies para os headers do HttpClient, esta
 * carrega a sessao COMPLETA do browser: cookies de todos os dominios
 * + localStorage/sessionStorage. Sem isso, navegacoes do Actor em
 * SPAs OAuth/SSO (token em storage) caem de volta no login.
 */
export interface BrowserSession {
  cookies: CdpCookieParam[];
  storage: StorageSnapshot;
  finalUrl: string;
}

/**
 * AppMap — artefato central do módulo de Percepção.
 * É o "modelo mental" da aplicação que será passado ao LLM.
 */
export interface AppMap {
  baseUrl: string;
  routes: AppRoute[];
  apiEndpoints: ApiEndpoint[];
  auth: AuthContext;
  metadata: {
    framework: string;    // Angular, React, Vue, etc.
    title: string;
    capturedAt: Date;
    totalForms: number;
    totalEndpoints: number;
  };
}
