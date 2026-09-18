"use strict";
/**
 * production-mode/SessionStore.ts
 * ---------------------------------------------------------------
 * Persistencia local e criptografada da sessao de browser capturada
 * na Percepcao (cookies de todos os dominios + localStorage +
 * sessionStorage). Objetivo: o operador loga manualmente UMA vez e,
 * nas execucoes seguintes, a sessao salva e reaproveitada — desde que
 * ainda seja valida (a validacao real acontece na ProductionPerception,
 * que restaura a sessao e verifica se o alvo carrega autenticado).
 *
 * Seguranca:
 *   - Cifra AES-256-GCM (confidencialidade + integridade/autenticacao).
 *   - Chave derivada via scrypt. A senha vem de SESSION_PASSPHRASE se
 *     definida (modo forte); caso contrario, deriva-se uma chave ligada
 *     a maquina (hostname + usuario). Esse fallback NAO protege contra
 *     um atacante com acesso a mesma conta/maquina — apenas evita que a
 *     sessao fique em texto plano no disco. Para uso serio, defina
 *     SESSION_PASSPHRASE.
 *   - O IV e aleatorio por gravacao; a tag GCM detecta adulteracao.
 *
 * O diretorio .session-cache/ deve estar no .gitignore (nunca versionar
 * material de sessao).
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
exports.SessionStore = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const crypto = __importStar(require("crypto"));
const CACHE_DIR = path.join(__dirname, '..', '..', '.session-cache');
const FILE_VERSION = 1;
const ALG = 'aes-256-gcm';
// Salt fixo por instalacao: permite derivar a MESMA chave em execucoes
// futuras sem armazenar a chave em lugar nenhum. A entropia real vem da
// passphrase (ou do material da maquina no fallback).
const KDF_SALT = crypto.createHash('sha256')
    .update('agentic-dast/session-store/v1')
    .digest();
class SessionStore {
    passphrase;
    /**
     * @param passphrase SESSION_PASSPHRASE (string vazia = usar fallback
     *                   derivado da maquina).
     */
    constructor(passphrase = '') {
        this.passphrase = passphrase ?? '';
    }
    get usingPassphrase() {
        return this.passphrase.length > 0;
    }
    deriveKey() {
        const secret = this.usingPassphrase
            ? this.passphrase
            : `${os.hostname()}::${os.userInfo().username}`;
        return crypto.scryptSync(secret, KDF_SALT, 32);
    }
    fileFor(host) {
        const safe = host.replace(/[^a-zA-Z0-9._-]/g, '_') || 'default';
        return path.join(CACHE_DIR, `session-${safe}.enc`);
    }
    /** Persiste (cifrado) a sessao de browser para um host-alvo. */
    save(host, session, targetUrl) {
        if (!fs.existsSync(CACHE_DIR)) {
            fs.mkdirSync(CACHE_DIR, { recursive: true });
        }
        const key = this.deriveKey();
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv(ALG, key, iv);
        const plaintext = Buffer.from(JSON.stringify(session), 'utf-8');
        const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        const tag = cipher.getAuthTag();
        const fileObj = {
            v: FILE_VERSION,
            alg: ALG,
            meta: {
                targetUrl,
                capturedAt: new Date().toISOString(),
                encryptedWithPassphrase: this.usingPassphrase,
            },
            iv: iv.toString('hex'),
            tag: tag.toString('hex'),
            data: ciphertext.toString('hex'),
        };
        const file = this.fileFor(host);
        fs.writeFileSync(file, JSON.stringify(fileObj), 'utf-8');
        // Permissao restritiva (best-effort; no-op no Windows).
        try {
            fs.chmodSync(file, 0o600);
        }
        catch { /* ignore */ }
    }
    /**
     * Le e descriptografa a sessao salva para um host-alvo. Retorna null
     * se nao existir, se estiver corrompida, ou se a chave nao bater
     * (por ex. a SESSION_PASSPHRASE mudou desde a gravacao).
     */
    load(host) {
        const file = this.fileFor(host);
        if (!fs.existsSync(file))
            return null;
        let parsed;
        try {
            parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
        }
        catch {
            console.warn(`[SessionStore] Cache corrompido em ${file} — ignorando.`);
            return null;
        }
        if (parsed.v !== FILE_VERSION || parsed.alg !== ALG) {
            console.warn('[SessionStore] Formato de cache incompativel — ignorando.');
            return null;
        }
        try {
            const key = this.deriveKey();
            const decipher = crypto.createDecipheriv(ALG, key, Buffer.from(parsed.iv, 'hex'));
            decipher.setAuthTag(Buffer.from(parsed.tag, 'hex'));
            const dec = Buffer.concat([
                decipher.update(Buffer.from(parsed.data, 'hex')),
                decipher.final(),
            ]);
            const session = JSON.parse(dec.toString('utf-8'));
            const ageMinutes = (Date.now() - Date.parse(parsed.meta.capturedAt)) / 60_000;
            return { session, meta: parsed.meta, ageMinutes };
        }
        catch {
            console.warn('[SessionStore] Nao foi possivel descriptografar a sessao salva ' +
                '(SESSION_PASSPHRASE mudou, ou cache adulterado). Sera necessario ' +
                'reautenticar.');
            return null;
        }
    }
    /** Remove a sessao salva de um host-alvo (se existir). */
    clear(host) {
        const file = this.fileFor(host);
        try {
            if (fs.existsSync(file))
                fs.unlinkSync(file);
        }
        catch { /* ignore */ }
    }
}
exports.SessionStore = SessionStore;
//# sourceMappingURL=SessionStore.js.map