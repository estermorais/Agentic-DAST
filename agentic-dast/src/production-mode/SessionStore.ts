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

import * as fs     from 'fs';
import * as path   from 'path';
import * as os     from 'os';
import * as crypto from 'crypto';

import { BrowserSession } from '../perception/types';

const CACHE_DIR   = path.join(__dirname, '..', '..', '.session-cache');
const FILE_VERSION = 1;
const ALG          = 'aes-256-gcm';
// Salt fixo por instalacao: permite derivar a MESMA chave em execucoes
// futuras sem armazenar a chave em lugar nenhum. A entropia real vem da
// passphrase (ou do material da maquina no fallback).
const KDF_SALT = crypto.createHash('sha256')
  .update('agentic-dast/session-store/v1')
  .digest();

/** Metadados nao sensiveis, guardados em texto plano ao lado do blob. */
export interface CachedSessionMeta {
  targetUrl: string;
  capturedAt: string;              // ISO-8601
  encryptedWithPassphrase: boolean;
}

/** Resultado de um load() bem-sucedido. */
export interface CachedSessionEntry {
  session: BrowserSession;
  meta: CachedSessionMeta;
  ageMinutes: number;
}

/** Formato serializado em disco. */
interface SessionFile {
  v: number;
  alg: string;
  meta: CachedSessionMeta;
  iv: string;                      // hex
  tag: string;                     // hex (auth tag GCM)
  data: string;                    // hex (ciphertext)
}

export class SessionStore {
  private readonly passphrase: string;

  /**
   * @param passphrase SESSION_PASSPHRASE (string vazia = usar fallback
   *                   derivado da maquina).
   */
  constructor(passphrase = '') {
    this.passphrase = passphrase ?? '';
  }

  get usingPassphrase(): boolean {
    return this.passphrase.length > 0;
  }

  private deriveKey(): Buffer {
    const secret = this.usingPassphrase
      ? this.passphrase
      : `${os.hostname()}::${os.userInfo().username}`;
    return crypto.scryptSync(secret, KDF_SALT, 32);
  }

  private fileFor(host: string): string {
    const safe = host.replace(/[^a-zA-Z0-9._-]/g, '_') || 'default';
    return path.join(CACHE_DIR, `session-${safe}.enc`);
  }

  /** Persiste (cifrado) a sessao de browser para um host-alvo. */
  save(host: string, session: BrowserSession, targetUrl: string): void {
    if (!fs.existsSync(CACHE_DIR)) {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
    }

    const key = this.deriveKey();
    const iv  = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALG, key, iv);
    const plaintext = Buffer.from(JSON.stringify(session), 'utf-8');
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();

    const fileObj: SessionFile = {
      v: FILE_VERSION,
      alg: ALG,
      meta: {
        targetUrl,
        capturedAt: new Date().toISOString(),
        encryptedWithPassphrase: this.usingPassphrase,
      },
      iv:   iv.toString('hex'),
      tag:  tag.toString('hex'),
      data: ciphertext.toString('hex'),
    };

    const file = this.fileFor(host);
    fs.writeFileSync(file, JSON.stringify(fileObj), 'utf-8');
    // Permissao restritiva (best-effort; no-op no Windows).
    try { fs.chmodSync(file, 0o600); } catch { /* ignore */ }
  }

  /**
   * Le e descriptografa a sessao salva para um host-alvo. Retorna null
   * se nao existir, se estiver corrompida, ou se a chave nao bater
   * (por ex. a SESSION_PASSPHRASE mudou desde a gravacao).
   */
  load(host: string): CachedSessionEntry | null {
    const file = this.fileFor(host);
    if (!fs.existsSync(file)) return null;

    let parsed: SessionFile;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as SessionFile;
    } catch {
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
      const session = JSON.parse(dec.toString('utf-8')) as BrowserSession;
      const ageMinutes = (Date.now() - Date.parse(parsed.meta.capturedAt)) / 60_000;
      return { session, meta: parsed.meta, ageMinutes };
    } catch {
      console.warn(
        '[SessionStore] Nao foi possivel descriptografar a sessao salva ' +
        '(SESSION_PASSPHRASE mudou, ou cache adulterado). Sera necessario ' +
        'reautenticar.',
      );
      return null;
    }
  }

  /** Remove a sessao salva de um host-alvo (se existir). */
  clear(host: string): void {
    const file = this.fileFor(host);
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch { /* ignore */ }
  }
}
