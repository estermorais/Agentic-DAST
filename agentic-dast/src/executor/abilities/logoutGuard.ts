/**
 * executor/abilities/logoutGuard.ts
 * ---------------------------------------------------------------
 * Deteccao de URLs/elementos de LOGOUT.
 *
 * O agente opera com uma sessao autenticada propagada para o browser
 * do Actor (cookies + token em storage). Se ele navegar para — ou
 * clicar em — um endpoint de logout/signout/sair, o alvo invalida a
 * sessao e TODAS as acoes seguintes caem de volta no login, perdendo
 * o token que custou (as vezes um login manual + MFA) para obter.
 *
 * Este guard e puramente heuristico e conservador: na duvida, bloqueia
 * (falso positivo custa uma navegacao, falso negativo custa a sessao).
 * Pode ser desativado com ALLOW_LOGOUT_NAV=true quando o objetivo do
 * teste for exatamente exercitar o logout.
 * ---------------------------------------------------------------
 */

/**
 * Padroes de URL (path/hash/query) que caracterizam logout. Cobre
 * variacoes em ingles/portugues e endpoints de logout de OAuth/SSO
 * (Auth0 /v2/logout, OIDC end_session, SAML SLO, sessions/destroy).
 */
const LOGOUT_URL_PATTERNS: RegExp[] = [
  /\/logout\b/i,
  /\/log-?out\b/i,
  /\/sign-?out\b/i,
  /\/signoff\b/i,
  /\/log-?off\b/i,
  /\/sair\b/i,
  /\/deslogar\b/i,
  /\/desconectar\b/i,
  /\/encerrar-?sessao\b/i,
  /\/sessions?\/(?:destroy|end|delete)\b/i,
  /\/(?:end-?session|slo|single-?logout)\b/i, // OIDC/SAML single logout
  /[?&#](?:action|do|op)=logout\b/i,
  /[?&#]logout(?:=|\b)/i,
];

/**
 * Textos de elementos clicaveis que indicam logout. Comparado contra
 * o texto visivel do elemento (innerText/aria-label). Case-insensitive.
 */
const LOGOUT_TEXT_PATTERNS: RegExp[] = [
  /\blog\s*out\b/i,
  /\bsign\s*out\b/i,
  /\blog\s*off\b/i,
  /\bsair\b/i,
  /\bdeslogar\b/i,
  /\bdesconectar\b/i,
  /\bencerrar sess/i, // "encerrar sessao"
];

/** Verdadeiro se a URL aparenta ser um endpoint de logout. */
export function isLogoutUrl(url: string): boolean {
  if (!url) return false;
  return LOGOUT_URL_PATTERNS.some((re) => re.test(url));
}

/** Verdadeiro se o texto/label de um elemento aparenta ser logout. */
export function isLogoutText(text: string | null | undefined): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 40) return false; // rotulos de logout sao curtos
  return LOGOUT_TEXT_PATTERNS.some((re) => re.test(trimmed));
}

/** Mensagem de Observation devolvida ao LLM quando o guard bloqueia. */
export function logoutBlockedMessage(what: string): string {
  return (
    `AÇÃO BLOQUEADA: "${what}" aparenta ser um logout/signout. ` +
    `Navegar para logout destruiria a sessão autenticada e faria todas as ` +
    `ações seguintes caírem no login. A ação NÃO foi executada e a sessão ` +
    `permanece intacta. Continue os testes em rotas autenticadas; não tente ` +
    `deslogar. (Se o logout for realmente o alvo do teste, o operador deve ` +
    `reiniciar com ALLOW_LOGOUT_NAV=true.)`
  );
}
