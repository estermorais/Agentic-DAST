/**
 * executor/screenplay/Actor.ts
 * ---------------------------------------------------------------
 * Implementação do Actor do Screenplay Pattern.
 *
 * O Actor é a peça central do padrão: ele representa o agente
 * que interage com o sistema. Um Actor possui Abilities (o que
 * ele é capaz de fazer) e realiza Tasks (o que ele faz).
 *
 * Neste framework, o Actor representa o agente de segurança
 * automatizado que possui as capacidades de navegar no browser
 * e fazer requisições HTTP diretamente.
 *
 * Uso:
 *   const actor = await Actor.named('SecurityAgent')
 *     .withBrowser(await BrowseTheWeb.launch())
 *     .withHttpClient(new HttpClient());
 * ---------------------------------------------------------------
 */

import { BrowseTheWeb } from '../abilities/BrowseTheWeb';
import { HttpClient } from '../abilities/HttpClient';

export class Actor {
  private readonly name: string;
  private browser: BrowseTheWeb | null = null;
  private http: HttpClient | null = null;

  private constructor(name: string) {
    this.name = name;
  }

  /** Cria um Actor com o nome fornecido (interface fluente) */
  static named(name: string): Actor {
    return new Actor(name);
  }

  /** Equipa o Actor com a ability de navegar no browser */
  withBrowser(browser: BrowseTheWeb): this {
    this.browser = browser;
    return this;
  }

  /** Equipa o Actor com a ability de fazer requisições HTTP */
  withHttpClient(http: HttpClient): this {
    this.http = http;
    return this;
  }

  /** Retorna a ability BrowseTheWeb (lança erro se não disponível) */
  getBrowseTheWeb(): BrowseTheWeb {
    if (!this.browser) {
      throw new Error(`Actor "${this.name}" não possui a ability BrowseTheWeb.`);
    }
    return this.browser;
  }

  /** Retorna a ability HttpClient (lança erro se não disponível) */
  getHttpClient(): HttpClient {
    if (!this.http) {
      throw new Error(`Actor "${this.name}" não possui a ability HttpClient.`);
    }
    return this.http;
  }

  getName(): string {
    return this.name;
  }

  /** Encerra todas as resources do Actor (fecha browser) */
  async teardown(): Promise<void> {
    await this.browser?.close();
  }
}
