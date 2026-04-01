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
