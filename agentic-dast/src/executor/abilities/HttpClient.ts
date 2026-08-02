/**
 * executor/abilities/HttpClient.ts
 * ---------------------------------------------------------------
 * Ability do Screenplay Pattern responsável por requisições HTTP
 * diretas, sem passar pelo browser (útil para abusar APIs REST).
 *
 * Usa Axios para suporte a todos os métodos HTTP, headers e body
 * personalizados. Não lança exceção em respostas 4xx/5xx —
 * retorna o status como parte da Observation para o LLM.
 * ---------------------------------------------------------------
 */

import axios, { AxiosRequestConfig } from 'axios';
import { config } from '../../config';

/**
 * Resolve uma URL que pode vir relativa (ex: "/api/Users") contra a
 * URL-base do alvo. Necessário porque o LLM, ao gerar make_request,
 * tipicamente usa paths relativos — sem isso, o axios falha com
 * "Invalid URL".
 *
 * Usa browserBaseUrl (nao targetUrl) porque, com proxy ZAP ativo, o
 * axios envia essa URL literal ao proxy e quem resolve o hostname
 * destino e o ZAP, de dentro do seu container. 'localhost' la dentro
 * seria o proprio ZAP, entao usamos 'juice-shop:3000', que resolve
 * pela Docker network 'dast-net' (mesma logica do Chrome/Puppeteer).
 */
function resolveUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  try {
    return new URL(url, config.browserBaseUrl).toString();
  } catch {
    return url;
  }
}

// Marker string returned quando o alvo cai (circuit breaker aberto). O
// ReActAgent detecta este prefixo e para o loop com finish, evitando
// gastar tokens em iteracoes repetidas contra um servidor morto.
export const TARGET_DOWN_MARKER = 'ERRO_ALVO_INDISPONIVEL';

// Numero de falhas de conexao consecutivas antes de abrir o breaker.
const CIRCUIT_BREAKER_THRESHOLD = 3;

// Padroes que indicam que o alvo caiu (nao um erro de payload, mas
// indisponibilidade). Nao inclui erros HTTP 5xx do proprio alvo, so os
// que vem de conexao recusada / proxy sem destino.
const CONNECTION_FAILURE_PATTERNS = [
  /ECONNREFUSED/i,
  /Connection refused/i,
  /ZAP Error.*HttpHostConnectException/i,
  /HTTP 502 .* ZAP Error/,
];

function looksLikeConnectionFailure(observation: string): boolean {
  return CONNECTION_FAILURE_PATTERNS.some((p) => p.test(observation));
}

export class HttpClient {
  private defaultHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  // Circuit breaker: se as ultimas N requests seguidas indicam servidor
  // fora do ar, todas as chamadas subsequentes retornam TARGET_DOWN_MARKER
  // sem tocar na rede. O LLM viu duas vezes hoje o juice-shop cair
  // no meio de um run e continuar emitindo make_request contra
  // localhost:3000 com 502 em loop, gastando tokens em iteracoes vazias.
  private consecutiveFailures = 0;
  private breakerOpen = false;

  /**
   * Define um header padrão que será enviado em todas as requisições.
   * Útil para configurar o Authorization: Bearer após login.
   */
  setDefaultHeader(key: string, value: string): void {
    this.defaultHeaders[key] = value;
  }

  /**
   * Faz uma requisição HTTP e retorna uma Observation formatada.
   *
   * @param method  - Método HTTP (GET, POST, PUT, DELETE, PATCH)
   * @param url     - URL completa do endpoint
   * @param headers - Headers adicionais (merged com os defaults)
   * @param body    - Body da requisição (serializado como JSON)
   */
  async request(
    method: string,
    url: string,
    headers?: Record<string, string>,
    body?: unknown,
  ): Promise<string> {
    const fullUrl = resolveUrl(url);
    const mergedHeaders = { ...this.defaultHeaders, ...headers };

    const axiosConfig: AxiosRequestConfig = {
      method: method.toUpperCase() as AxiosRequestConfig['method'],
      url: fullUrl,
      headers: mergedHeaders,
      data: body !== null && body !== undefined ? body : undefined,
      // Não lança exceção em 4xx/5xx para que o LLM possa analisar
      validateStatus: () => true,
      timeout: 10_000,
    };

    // Roteia pelo ZAP quando o proxy esta ativo, para que as chamadas
    // que o LLM emite via 'make_request' tambem alimentem a auditoria
    // passiva. Sem isso, so o trafego do Chrome era gravado e o scan
    // passivo perdia toda a superficie de API testada pelo agente.
    if (config.useZapProxy) {
      axiosConfig.proxy = {
        host: config.zapProxyHost,
        port: config.zapProxyPort,
        protocol: 'http',
      };
    }

    // Se o circuit breaker ja abriu, nao tenta mais. Retorna o marker
    // que o ReActAgent vai detectar para encerrar o loop cedo.
    if (this.breakerOpen) {
      return `${TARGET_DOWN_MARKER}: alvo indisponivel apos ${CIRCUIT_BREAKER_THRESHOLD} ` +
             `falhas de conexao consecutivas. Nao ha mais tentativas nesta sessao. ` +
             `Encerre com Action: finish e sumario indicando servidor caiu mid-run.`;
    }

    try {
      const response = await axios(axiosConfig);

      const bodyStr = typeof response.data === 'object'
        ? JSON.stringify(response.data, null, 2).substring(0, 1500)
        : String(response.data).substring(0, 1500);

      const truncationNote = JSON.stringify(response.data).length > 1500
        ? '\n[... resposta truncada]'
        : '';

      const observation = (
        `HTTP ${response.status} ${method.toUpperCase()} ${fullUrl}\n` +
        `Headers de resposta: ${JSON.stringify(response.headers)}\n` +
        `Body:\n${bodyStr}${truncationNote}`
      );

      // Circuit breaker: uma 502 do ZAP com HttpHostConnectException
      // significa que o ZAP nao conseguiu se conectar ao alvo (juice-shop
      // caiu). Nao e um 502 legitimo da aplicacao — e um sinal de servidor
      // fora. HTTP 200/4xx/5xx do proprio alvo reseta o contador.
      if (response.status === 502 && looksLikeConnectionFailure(observation)) {
        this.consecutiveFailures += 1;
      } else {
        this.consecutiveFailures = 0;
      }

      if (this.consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
        this.breakerOpen = true;
        console.warn(
          `[HttpClient] Circuit breaker ABERTO apos ${CIRCUIT_BREAKER_THRESHOLD} ` +
          `falhas consecutivas. Chamadas subsequentes retornarao TARGET_DOWN_MARKER.`
        );
      }

      return observation;
    } catch (err) {
      const msg = (err as Error).message;
      if (looksLikeConnectionFailure(msg)) {
        this.consecutiveFailures += 1;
        if (this.consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
          this.breakerOpen = true;
          console.warn(
            `[HttpClient] Circuit breaker ABERTO (${CIRCUIT_BREAKER_THRESHOLD} erros ` +
            `de rede consecutivos). Chamadas subsequentes retornarao TARGET_DOWN_MARKER.`
          );
        }
      }
      return `ERRO de rede em ${method.toUpperCase()} ${fullUrl}: ${msg}`;
    }
  }
}
