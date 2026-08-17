"use strict";
/**
 * production-mode/SafeDispatcher.ts
 * ---------------------------------------------------------------
 * Decorator do ActionDispatcher oficial. Antes de executar cada
 * acao proposta pelo LLM, classifica o risco e pede aprovacao
 * humana quando necessario.
 *
 * Mantem a mesma interface publica que ReActAgent consome:
 *   - dispatch(action): Promise<string>
 *   - getFindings(): Finding[]
 *   - teardown(): Promise<void>
 *
 * NENHUMA mudanca eh feita no ActionDispatcher original. Este arquivo
 * apenas envolve uma instancia existente.
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
exports.SafeDispatcher = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const RiskClassifier_1 = require("./RiskClassifier");
const HumanApproval_1 = require("./HumanApproval");
class SafeDispatcher {
    inner;
    opts;
    approval;
    highSeverityCount = 0;
    currentThought = '';
    currentIteration = 0;
    breakerTripped = false;
    constructor(inner, opts) {
        this.inner = inner;
        this.opts = {
            readOnly: opts.readOnly,
            interactive: opts.interactive,
            auditLogPath: opts.auditLogPath ?? '',
            rateLimitMs: opts.rateLimitMs ?? 500,
            circuitBreakerFindings: opts.circuitBreakerFindings ?? 0,
        };
        this.approval = new HumanApproval_1.HumanApproval();
        if (this.opts.auditLogPath) {
            this.initAuditLog();
        }
    }
    /**
     * Contexto que o ReActAgent passa antes de chamar dispatch. Como o
     * ReActAgent nao passa isso naturalmente, usamos setters — o
     * production-runner intercepta cada iteracao e chama esses setters.
     */
    setContext(iteration, thought) {
        this.currentIteration = iteration;
        this.currentThought = thought;
    }
    async dispatch(action) {
        if (this.breakerTripped) {
            return 'Circuit breaker ativo: sessão encerrada após atingir limite de findings HIGH/CRITICAL. Emita finish.';
        }
        const classification = (0, RiskClassifier_1.classifyActionRisk)(action);
        // Modo read-only: bloqueia qualquer coisa fora do SAFE
        if (this.opts.readOnly && classification.level !== 'safe') {
            this.audit(action, classification.level, 'blocked-readonly');
            return (`Ação bloqueada por modo READ_ONLY (nível ${classification.level}). ` +
                `Motivo: ${classification.reason}. Tente uma variação apenas de leitura (GET).`);
        }
        // Modo interativo: pede aprovacao em MEDIUM/HIGH/CRITICAL
        if (this.opts.interactive &&
            classification.level !== 'safe') {
            const decision = await this.approval.prompt(action, classification, this.currentIteration, this.currentThought);
            if (decision.type === 'skip') {
                this.audit(action, classification.level, 'skipped-by-human');
                return decision.feedback;
            }
            if (decision.type === 'quit') {
                this.audit(action, classification.level, 'quit-by-human');
                this.breakerTripped = true;
                return 'Operador humano encerrou a sessão. Emita finish com o que foi descoberto até aqui.';
            }
        }
        // Rate limit
        if (this.opts.rateLimitMs > 0 && action.action === 'make_request') {
            await sleep(this.opts.rateLimitMs);
        }
        // Executa via dispatcher oficial
        const observation = await this.inner.dispatch(action);
        this.audit(action, classification.level, 'executed');
        // Circuit breaker
        if (this.opts.circuitBreakerFindings > 0) {
            const findings = this.inner.getFindings();
            const highCount = findings.filter((f) => f.severity === 'HIGH' || f.severity === 'CRITICAL').length;
            if (highCount >= this.opts.circuitBreakerFindings) {
                this.breakerTripped = true;
                console.log(`\n[SafeDispatcher] Circuit breaker ativado: ${highCount} findings HIGH/CRITICAL atingidos. ` +
                    `Próximas ações serão bloqueadas.\n`);
            }
        }
        return observation;
    }
    getFindings() {
        return this.inner.getFindings();
    }
    async teardown() {
        const anyInner = this.inner;
        if (typeof anyInner.teardown === 'function') {
            await anyInner.teardown();
        }
    }
    // ---------------------------------------------------------------
    // Audit log
    // ---------------------------------------------------------------
    initAuditLog() {
        const dir = path.dirname(this.opts.auditLogPath);
        if (dir && !fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        if (!fs.existsSync(this.opts.auditLogPath)) {
            fs.writeFileSync(this.opts.auditLogPath, 'timestamp_iso,iteration,action,method,url,risk_level,outcome\n', 'utf-8');
        }
    }
    audit(action, level, outcome) {
        if (!this.opts.auditLogPath)
            return;
        const now = new Date().toISOString();
        const method = action.action === 'make_request' ? action.method : '';
        const url = action.action === 'make_request' ? action.url : '';
        const csvRow = [
            now,
            this.currentIteration,
            action.action,
            method,
            csvEscape(url),
            level,
            outcome,
        ].join(',') + '\n';
        fs.appendFileSync(this.opts.auditLogPath, csvRow, 'utf-8');
    }
}
exports.SafeDispatcher = SafeDispatcher;
function csvEscape(s) {
    if (!s)
        return '';
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
        return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
//# sourceMappingURL=SafeDispatcher.js.map