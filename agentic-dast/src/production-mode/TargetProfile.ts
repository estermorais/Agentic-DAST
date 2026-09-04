/**
 * production-mode/TargetProfile.ts
 * ---------------------------------------------------------------
 * "Perfil do alvo": um arquivo JSON, mantido por quem conhece a
 * aplicacao (idealmente gerado a partir do codigo-fonte do alvo via
 * tools/generate-target-profile.ts e revisado a mao), que descreve a
 * superficie de ataque REAL — rotas de front, endpoints de API,
 * escopo permitido e dicas de intel.
 *
 * O ProductionPerception carrega esse perfil (env TARGET_PROFILE) e o
 * semeia no AppMap antes do crawl. Perfil = verdade autoritativa;
 * crawl ao vivo = confirmacao + coleta de tokens de sessao.
 *
 * NAO toca no nucleo (perception/DOMExtractor, prompts, ReActAgent).
 * ---------------------------------------------------------------
 */

import * as fs from 'fs';

/** Parametro de um endpoint (ajuda o agente a montar requests validos). */
export interface ProfileParam {
  name: string;
  in: 'query' | 'body' | 'path' | 'header';
  type?: string;
  example?: string;
}

/** Rota de front-end (SPA). */
export interface ProfileRoute {
  path: string; // ex: "#/survey" ou "/admin"
  title?: string;
  requiresAuth?: boolean;
  /** Papeis que acessam a rota — vira dica de authz/BFLA. */
  roles?: string[];
}

/** Endpoint de API do backend. */
export interface ProfileEndpoint {
  method: string; // GET, POST, PUT, PATCH, DELETE
  path: string; // absoluto (https://...) ou relativo ("/api/..."); relativo casa com apiBaseUrl
  authRequired?: boolean;
  roles?: string[];
  params?: ProfileParam[];
  /** Marca recurso com ID direto — candidato a IDOR/BOLA. */
  idor?: boolean;
  notes?: string;
}

/** Escopo permitido — guarda de seguranca em producao. */
export interface ProfileScope {
  includeHosts?: string[];
  excludePaths?: string[]; // glob simples com '*' — nunca navegar/testar
}

export interface TargetProfile {
  name: string;
  baseUrl?: string;
  /** Base para endpoints relativos (ex: "https://openapi.dito.com.br"). */
  apiBaseUrl?: string;
  framework?: string;
  scope?: ProfileScope;
  routes?: ProfileRoute[];
  endpoints?: ProfileEndpoint[];
  auth?: {
    type?: 'oauth' | 'jwt' | 'cookie' | 'none';
    tokenLocation?: string;
  };
  notes?: string;
  /** Metadados do gerador (nao usados em runtime). */
  _generatedBy?: string;
}

const VALID_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

/**
 * Carrega e valida o perfil apontado por TARGET_PROFILE (ou pelo path
 * dado). Retorna null se a env nao estiver setada. Lanca erro com
 * mensagem util se o arquivo existir mas for invalido.
 */
export function loadTargetProfile(explicitPath?: string): TargetProfile | null {
  const profilePath = explicitPath ?? process.env.TARGET_PROFILE ?? '';
  if (!profilePath) return null;

  if (!fs.existsSync(profilePath)) {
    throw new Error(`TARGET_PROFILE aponta para arquivo inexistente: ${profilePath}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(profilePath, 'utf-8'));
  } catch (err) {
    throw new Error(`Perfil ${profilePath} nao e JSON valido: ${(err as Error).message}`);
  }

  const profile = validateProfile(parsed, profilePath);
  console.log(
    `[TargetProfile] Carregado "${profile.name}" — ` +
    `${profile.routes?.length ?? 0} rota(s), ${profile.endpoints?.length ?? 0} endpoint(s).`,
  );
  return profile;
}

function validateProfile(raw: unknown, path: string): TargetProfile {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`Perfil ${path} deve ser um objeto JSON.`);
  }
  const p = raw as Record<string, unknown>;

  if (typeof p.name !== 'string' || !p.name.trim()) {
    throw new Error(`Perfil ${path}: campo "name" (string) e obrigatorio.`);
  }

  const routes = Array.isArray(p.routes) ? p.routes : [];
  routes.forEach((r, i) => {
    const rr = r as Record<string, unknown>;
    if (typeof rr.path !== 'string' || !rr.path.trim()) {
      throw new Error(`Perfil ${path}: routes[${i}].path (string) e obrigatorio.`);
    }
  });

  const endpoints = Array.isArray(p.endpoints) ? p.endpoints : [];
  endpoints.forEach((e, i) => {
    const ee = e as Record<string, unknown>;
    if (typeof ee.method !== 'string' || !VALID_METHODS.includes(ee.method.toUpperCase())) {
      throw new Error(
        `Perfil ${path}: endpoints[${i}].method invalido ("${String(ee.method)}"). ` +
        `Use um de: ${VALID_METHODS.join(', ')}.`,
      );
    }
    if (typeof ee.path !== 'string' || !ee.path.trim()) {
      throw new Error(`Perfil ${path}: endpoints[${i}].path (string) e obrigatorio.`);
    }
  });

  // Retorna o objeto ja tipado (campos extras sao preservados/ignorados).
  return raw as TargetProfile;
}

/** Aplica apiBaseUrl a um path relativo; deixa absolutos intactos. */
export function resolveEndpointUrl(ep: ProfileEndpoint, apiBaseUrl?: string): string {
  if (/^https?:\/\//i.test(ep.path)) return ep.path;
  if (!apiBaseUrl) return ep.path;
  const base = apiBaseUrl.replace(/\/+$/, '');
  const rel = ep.path.startsWith('/') ? ep.path : `/${ep.path}`;
  return `${base}${rel}`;
}

/** Casa um path contra um glob simples com '*' (usado em excludePaths). */
export function matchesGlob(value: string, pattern: string): boolean {
  const rx = new RegExp(
    '^' + pattern.split('*').map(escapeRegex).join('.*') + '$',
    'i',
  );
  return rx.test(value);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
