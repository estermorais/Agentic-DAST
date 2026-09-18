"use strict";
/**
 * util/sameSite.ts
 * ---------------------------------------------------------------
 * Domínio registrável e checagem "mesmo site" cientes de public
 * suffixes multi-label (com.br, co.uk, ...). Usado em dois pontos
 * sensíveis:
 *   - Percepção: só capturar o Bearer de hosts do PRÓPRIO alvo
 *     (nunca de terceiros como Auth0/Pendo).
 *   - HttpClient: só injetar Authorization/Cookie do alvo em
 *     requisições para o próprio alvo (nunca vazar o token para
 *     hosts de terceiros que o agente resolva chamar).
 *
 * NÃO é uma Public Suffix List completa (o projeto não tem deps
 * externas). Cobre os sufixos multi-label comuns; o resto usa a
 * regra de 2 labels. Conservador: na dúvida, dois hosts diferentes
 * NÃO são tratados como o mesmo site.
 * ---------------------------------------------------------------
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.hostOf = hostOf;
exports.registrableDomain = registrableDomain;
exports.sameSite = sameSite;
/** Sufixos com mais de um label (eTLDs) que precisam de 3 labels. */
const MULTI_PART_SUFFIXES = new Set([
    'com.br', 'net.br', 'org.br', 'gov.br', 'edu.br', 'app.br',
    'co.uk', 'org.uk', 'gov.uk', 'ac.uk', 'me.uk',
    'com.au', 'net.au', 'org.au', 'gov.au', 'edu.au',
    'co.jp', 'or.jp', 'ne.jp',
    'co.nz', 'co.za', 'co.in', 'co.kr',
    'com.mx', 'com.ar', 'com.co', 'com.pt', 'com.tr', 'com.cn', 'com.hk', 'com.sg',
]);
/**
 * Extrai o host (sem porta) de uma URL ou host cru. Retorna '' se
 * não for parseável como host.
 */
function hostOf(urlOrHost) {
    if (!urlOrHost)
        return '';
    let h = urlOrHost;
    if (/^[a-z]+:\/\//i.test(urlOrHost)) {
        try {
            h = new URL(urlOrHost).host;
        }
        catch {
            return '';
        }
    }
    return h.split('/')[0].split(':')[0].toLowerCase().replace(/\.$/, '');
}
/**
 * Domínio registrável de um host. Ex.:
 *   app.dito.com.br      -> dito.com.br
 *   us-east.openapi.dito.com.br -> dito.com.br
 *   acme.auth0.com       -> auth0.com
 *   acme.com             -> acme.com
 *   juice-shop           -> juice-shop
 */
function registrableDomain(host) {
    const h = hostOf(host);
    const parts = h.split('.').filter(Boolean);
    if (parts.length <= 2)
        return h;
    const last2 = parts.slice(-2).join('.');
    if (MULTI_PART_SUFFIXES.has(last2))
        return parts.slice(-3).join('.');
    return last2;
}
/**
 * Verdadeiro se `a` e `b` pertencem ao mesmo domínio registrável.
 * Falso quando qualquer um é vazio.
 */
function sameSite(a, b) {
    const ra = registrableDomain(a);
    const rb = registrableDomain(b);
    return !!ra && !!rb && ra === rb;
}
//# sourceMappingURL=sameSite.js.map