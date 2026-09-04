"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadTargetProfile = loadTargetProfile;
exports.resolveEndpointUrl = resolveEndpointUrl;
exports.matchesGlob = matchesGlob;
const fs = __importStar(require("fs"));
const VALID_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
/**
 * Carrega e valida o perfil apontado por TARGET_PROFILE (ou pelo path
 * dado). Retorna null se a env nao estiver setada. Lanca erro com
 * mensagem util se o arquivo existir mas for invalido.
 */
function loadTargetProfile(explicitPath) {
    const profilePath = explicitPath ?? process.env.TARGET_PROFILE ?? '';
    if (!profilePath)
        return null;
    if (!fs.existsSync(profilePath)) {
        throw new Error(`TARGET_PROFILE aponta para arquivo inexistente: ${profilePath}`);
    }
    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(profilePath, 'utf-8'));
    }
    catch (err) {
        throw new Error(`Perfil ${profilePath} nao e JSON valido: ${err.message}`);
    }
    const profile = validateProfile(parsed, profilePath);
    console.log(`[TargetProfile] Carregado "${profile.name}" — ` +
        `${profile.routes?.length ?? 0} rota(s), ${profile.endpoints?.length ?? 0} endpoint(s).`);
    return profile;
}
function validateProfile(raw, path) {
    if (typeof raw !== 'object' || raw === null) {
        throw new Error(`Perfil ${path} deve ser um objeto JSON.`);
    }
    const p = raw;
    if (typeof p.name !== 'string' || !p.name.trim()) {
        throw new Error(`Perfil ${path}: campo "name" (string) e obrigatorio.`);
    }
    const routes = Array.isArray(p.routes) ? p.routes : [];
    routes.forEach((r, i) => {
        const rr = r;
        if (typeof rr.path !== 'string' || !rr.path.trim()) {
            throw new Error(`Perfil ${path}: routes[${i}].path (string) e obrigatorio.`);
        }
    });
    const endpoints = Array.isArray(p.endpoints) ? p.endpoints : [];
    endpoints.forEach((e, i) => {
        const ee = e;
        if (typeof ee.method !== 'string' || !VALID_METHODS.includes(ee.method.toUpperCase())) {
            throw new Error(`Perfil ${path}: endpoints[${i}].method invalido ("${String(ee.method)}"). ` +
                `Use um de: ${VALID_METHODS.join(', ')}.`);
        }
        if (typeof ee.path !== 'string' || !ee.path.trim()) {
            throw new Error(`Perfil ${path}: endpoints[${i}].path (string) e obrigatorio.`);
        }
    });
    // Retorna o objeto ja tipado (campos extras sao preservados/ignorados).
    return raw;
}
/** Aplica apiBaseUrl a um path relativo; deixa absolutos intactos. */
function resolveEndpointUrl(ep, apiBaseUrl) {
    if (/^https?:\/\//i.test(ep.path))
        return ep.path;
    if (!apiBaseUrl)
        return ep.path;
    const base = apiBaseUrl.replace(/\/+$/, '');
    const rel = ep.path.startsWith('/') ? ep.path : `/${ep.path}`;
    return `${base}${rel}`;
}
/** Casa um path contra um glob simples com '*' (usado em excludePaths). */
function matchesGlob(value, pattern) {
    const rx = new RegExp('^' + pattern.split('*').map(escapeRegex).join('.*') + '$', 'i');
    return rx.test(value);
}
function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
//# sourceMappingURL=TargetProfile.js.map