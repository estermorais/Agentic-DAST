"use strict";
/**
 * production-mode/tools/generate-target-profile.ts
 * ---------------------------------------------------------------
 * Gerador do "target profile" a partir do CODIGO-FONTE do alvo.
 *
 * Voce aponta o caminho do checkout do repositorio do alvo; o script
 * detecta a stack (front + back) e extrai rotas e endpoints por regex,
 * emitindo um JSON no formato de TargetProfile.ts para revisao manual.
 *
 * Uso:
 *   node dist/production-mode/tools/generate-target-profile.js \
 *        <caminho-do-repo-alvo> [saida.json] [nome]
 *
 *   # ou via env:
 *   TARGET_REPO=/path/alvo TARGET_PROFILE_OUT=targets/alvo.json \
 *     node dist/production-mode/tools/generate-target-profile.js
 *
 * IMPORTANTE: a extracao e heuristica (regex sobre o fonte). O
 * resultado e um PONTO DE PARTIDA — revise authRequired, params,
 * prefixos e o formato dos paths (hash routing?) antes de usar.
 *
 * Sem dependencias externas: usa apenas fs/path. Nao importa config.
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
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const SKIP_DIRS = new Set([
    'node_modules', '.git', 'dist', 'build', 'out', 'coverage',
    'vendor', '__pycache__', '.next', '.nuxt', '.venv', 'venv', 'target',
]);
const MAX_FILE_BYTES = 512 * 1024;
function walk(dir, acc = []) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    }
    catch {
        return acc;
    }
    for (const e of entries) {
        if (e.isDirectory()) {
            if (SKIP_DIRS.has(e.name))
                continue;
            walk(path.join(dir, e.name), acc);
        }
        else if (e.isFile()) {
            acc.push(path.join(dir, e.name));
        }
    }
    return acc;
}
function read(file) {
    try {
        const stat = fs.statSync(file);
        if (stat.size > MAX_FILE_BYTES)
            return '';
        return fs.readFileSync(file, 'utf-8');
    }
    catch {
        return '';
    }
}
function dedupeRoutes(routes) {
    const seen = new Set();
    const out = [];
    for (const r of routes) {
        const key = r.path.trim().toLowerCase();
        if (!key || seen.has(key))
            continue;
        seen.add(key);
        out.push(r);
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
}
function dedupeEndpoints(eps) {
    const seen = new Set();
    const out = [];
    for (const e of eps) {
        const key = `${e.method} ${e.path}`.toLowerCase();
        if (!e.path.trim() || seen.has(key))
            continue;
        seen.add(key);
        out.push(e);
    }
    return out.sort((a, b) => (a.path + a.method).localeCompare(b.path + b.method));
}
const AUTH_HINTS = [
    'requireauth', 'requiresauth', 'authenticate', 'isauthenticated',
    'login_required', 'jwt_required', '@useguards', 'authguard',
    'before_action :authenticate', 'ensure_authenticated', 'authorize',
];
function fileSuggestsAuth(content) {
    const lc = content.toLowerCase();
    return AUTH_HINTS.some((h) => lc.includes(h));
}
function detectStack(files) {
    const det = { frontend: null, backend: [], usesHashRouting: false };
    const pkgFile = files.find((f) => path.basename(f) === 'package.json');
    const pkg = pkgFile ? read(pkgFile) : '';
    const reqFiles = files.filter((f) => ['requirements.txt', 'pyproject.toml', 'Pipfile'].includes(path.basename(f)));
    const pyDeps = reqFiles.map(read).join('\n').toLowerCase();
    const gemfile = files.find((f) => path.basename(f) === 'Gemfile');
    const gem = gemfile ? read(gemfile).toLowerCase() : '';
    // Frontend
    if (/@angular\/core/.test(pkg))
        det.frontend = 'Angular';
    else if (/"react"\s*:/.test(pkg))
        det.frontend = 'React';
    else if (/"vue"\s*:/.test(pkg))
        det.frontend = 'Vue';
    // Hash routing?
    const allFrontHints = files
        .filter((f) => /\.(ts|js|tsx|jsx)$/.test(f))
        .slice(0, 4000);
    for (const f of allFrontHints) {
        const c = read(f);
        if (/useHash\s*:\s*true|HashLocationStrategy|createWebHashHistory|createHashRouter/.test(c)) {
            det.usesHashRouting = true;
            break;
        }
    }
    // Backend
    if (/@nestjs\/core/.test(pkg))
        det.backend.push('NestJS');
    if (/"express"\s*:/.test(pkg))
        det.backend.push('Express');
    if (/\bfastapi\b/.test(pyDeps))
        det.backend.push('FastAPI');
    if (/\bflask\b/.test(pyDeps))
        det.backend.push('Flask');
    if (/\bdjango\b/.test(pyDeps))
        det.backend.push('Django');
    if (/\brails\b/.test(gem))
        det.backend.push('Rails');
    // Fallback por arquivos caracteristicos, mesmo sem manifest.
    if (det.backend.length === 0) {
        if (files.some((f) => path.basename(f) === 'urls.py'))
            det.backend.push('Django');
        if (files.some((f) => f.endsWith(path.join('config', 'routes.rb'))))
            det.backend.push('Rails');
    }
    return det;
}
// ===============================================================
// Extratores de FRONTEND
// ===============================================================
function extractFrontendRoutes(files, det) {
    const routes = [];
    const prefix = det.usesHashRouting ? '#/' : '/';
    const candidates = files.filter((f) => /\.(ts|js|tsx|jsx)$/.test(f));
    for (const f of candidates) {
        const c = read(f);
        if (!c)
            continue;
        const isAngularRouteFile = /RouterModule\.(forRoot|forChild)\(/.test(c) || /:\s*Routes\s*=/.test(c) || /\.routes?\./.test(f);
        const isReactRouteFile = det.frontend === 'React' && /<Route\b|createBrowserRouter|createHashRouter/.test(c);
        const isVueRouteFile = det.frontend === 'Vue' &&
            /createRouter\(|const\s+routes\s*=|routes\s*:/.test(c) &&
            /path\s*:/.test(c);
        if (!isAngularRouteFile && !isReactRouteFile && !isVueRouteFile)
            continue;
        // path: '...'  (Angular/Vue e configs de objeto)
        const objRe = /path\s*:\s*['"`]([^'"`]*)['"`]([^}]*)/g;
        let m;
        while ((m = objRe.exec(c)) !== null) {
            const raw = m[1];
            const tail = m[2] || '';
            const requiresAuth = /canActivate|meta\s*:\s*{[^}]*requiresAuth\s*:\s*true|beforeEnter/.test(tail);
            routes.push(makeRoute(raw, prefix, requiresAuth));
        }
        // <Route path="..."> (React JSX)
        const jsxRe = /<Route\b[^>]*\bpath\s*=\s*['"`]([^'"`]+)['"`]/g;
        while ((m = jsxRe.exec(c)) !== null) {
            routes.push(makeRoute(m[1], prefix, false));
        }
    }
    return dedupeRoutes(routes);
}
function makeRoute(raw, prefix, requiresAuth) {
    let p = raw.trim();
    if (p === '' || p === '/')
        p = ''; // rota raiz
    // Normaliza para "<prefix><path>" sem duplicar barras.
    const cleaned = p.replace(/^\/+/, '');
    const full = prefix === '#/' ? `#/${cleaned}` : `/${cleaned}`;
    return {
        path: full.replace(/\/+$/, '') || (prefix === '#/' ? '#/' : '/'),
        requiresAuth: requiresAuth || undefined,
    };
}
// ===============================================================
// Extratores de BACKEND
// ===============================================================
function extractBackendEndpoints(files, det) {
    const eps = [];
    const has = (b) => det.backend.includes(b);
    for (const f of files) {
        const c = read(f);
        if (!c)
            continue;
        const auth = fileSuggestsAuth(c);
        if ((has('Express') || has('NestJS')) && /\.(ts|js)$/.test(f)) {
            eps.push(...extractExpress(c, auth));
            eps.push(...extractNest(c, auth));
        }
        if (has('Flask') && f.endsWith('.py'))
            eps.push(...extractFlask(c, auth));
        if (has('FastAPI') && f.endsWith('.py'))
            eps.push(...extractFastapi(c, auth));
        if (has('Django') && path.basename(f) === 'urls.py')
            eps.push(...extractDjango(c));
        if (has('Rails') && f.endsWith('routes.rb'))
            eps.push(...extractRails(c));
    }
    return dedupeEndpoints(eps);
}
function extractExpress(c, _fileAuth) {
    const out = [];
    // Captura tambem os argumentos ate o fim da chamada, para inferir auth
    // por-rota (middleware inline como requireAuth), nao por-arquivo.
    const re = /\b(?:app|router|route|api)\s*\.\s*(get|post|put|patch|delete|all)\s*\(\s*['"`]([^'"`]+)['"`]([^)]*)\)/gi;
    let m;
    while ((m = re.exec(c)) !== null) {
        const method = m[1].toUpperCase();
        if (method === 'ALL')
            continue;
        const args = m[3] || '';
        const authRequired = fileSuggestsAuth(args) || undefined;
        out.push({ path: m[2], method, authRequired });
    }
    return out;
}
function extractNest(c, auth) {
    const out = [];
    const ctrl = /@Controller\(\s*['"`]?([^'"`)]*)['"`]?\s*\)/.exec(c);
    const prefix = ctrl && ctrl[1] ? `/${ctrl[1].replace(/^\/+/, '')}` : '';
    const classAuth = auth || /@UseGuards/.test(c);
    const re = /@(Get|Post|Put|Patch|Delete)\(\s*['"`]?([^'"`)]*)['"`]?\s*\)/g;
    let m;
    while ((m = re.exec(c)) !== null) {
        const sub = m[2] ? `/${m[2].replace(/^\/+/, '')}` : '';
        const full = `${prefix}${sub}` || '/';
        out.push({ path: full, method: m[1].toUpperCase(), authRequired: classAuth || undefined });
    }
    return out;
}
function extractFlask(c, _fileAuth) {
    const out = [];
    const lines = c.split('\n');
    const re = /@[\w.]+\.route\(\s*['"]([^'"]+)['"]\s*(?:,\s*methods\s*=\s*\[([^\]]*)\])?/;
    lines.forEach((line, i) => {
        const m = re.exec(line);
        if (!m)
            return;
        const p = m[1];
        const methods = m[2]
            ? m[2].split(',').map((s) => s.replace(/['"\s]/g, '').toUpperCase()).filter(Boolean)
            : ['GET'];
        const authRequired = pythonRouteAuth(lines, i) || undefined;
        for (const method of methods)
            out.push({ path: p, method, authRequired });
    });
    return out;
}
function extractFastapi(c, _fileAuth) {
    const out = [];
    const prefixMatch = /APIRouter\([^)]*prefix\s*=\s*['"]([^'"]+)['"]/.exec(c);
    const prefix = prefixMatch ? prefixMatch[1] : '';
    const lines = c.split('\n');
    const re = /@(?:app|router)\.(get|post|put|patch|delete)\(\s*['"]([^'"]+)['"]/;
    lines.forEach((line, i) => {
        const m = re.exec(line);
        if (!m)
            return;
        const authRequired = pythonRouteAuth(lines, i) || undefined;
        out.push({ path: `${prefix}${m[2]}`, method: m[1].toUpperCase(), authRequired });
    });
    return out;
}
/**
 * Auth por-rota em Python: inspeciona o bloco de decorators contiguo
 * ao redor da linha da rota (linhas '@...' acima/abaixo ate o 'def')
 * em busca de @login_required, Depends(auth), etc.
 */
function pythonRouteAuth(lines, routeLine) {
    const window = [lines[routeLine]];
    // Decorators acima
    for (let i = routeLine - 1; i >= 0; i--) {
        const t = lines[i].trim();
        if (t.startsWith('@'))
            window.push(t);
        else
            break;
    }
    // Decorators abaixo, ate o def
    for (let i = routeLine + 1; i < lines.length; i++) {
        const t = lines[i].trim();
        window.push(t);
        if (t.startsWith('def ') || t.startsWith('async def '))
            break;
        if (!t.startsWith('@') && t !== '')
            break;
    }
    return fileSuggestsAuth(window.join('\n'));
}
function extractDjango(c) {
    const out = [];
    const re = /(?:re_)?path\(\s*r?['"]([^'"]*)['"]/g;
    let m;
    while ((m = re.exec(c)) !== null) {
        const p = '/' + m[1].replace(/^\^?\/?/, '').replace(/\$$/, '');
        out.push({ path: p, method: 'GET', notes: 'metodo nao inferido do urls.py — confirmar na view' });
    }
    return out;
}
function extractRails(c) {
    const out = [];
    // Rotas explicitas: get 'x', post 'y'
    const re = /\b(get|post|put|patch|delete)\s+['"]([^'"]+)['"]/gi;
    let m;
    while ((m = re.exec(c)) !== null) {
        out.push({ path: '/' + m[2].replace(/^\/+/, ''), method: m[1].toUpperCase() });
    }
    // resources :foo -> CRUD REST padrao
    const resRe = /resources?\s+:(\w+)/g;
    while ((m = resRe.exec(c)) !== null) {
        const r = m[1];
        out.push({ path: `/${r}`, method: 'GET' }, { path: `/${r}`, method: 'POST' }, { path: `/${r}/:id`, method: 'GET' }, { path: `/${r}/:id`, method: 'PATCH' }, { path: `/${r}/:id`, method: 'DELETE' });
    }
    return out;
}
// ===============================================================
// Main
// ===============================================================
function main() {
    const repo = process.argv[2] ?? process.env.TARGET_REPO ?? '';
    const outPath = process.argv[3] ?? process.env.TARGET_PROFILE_OUT ?? 'targets/generated-profile.json';
    const name = process.argv[4] ?? path.basename(repo || 'alvo');
    if (!repo) {
        console.error('Uso: node generate-target-profile.js <caminho-do-repo-alvo> [saida.json] [nome]\n' +
            '     (ou defina TARGET_REPO / TARGET_PROFILE_OUT)');
        process.exit(1);
    }
    if (!fs.existsSync(repo)) {
        console.error(`Caminho do repo nao existe: ${repo}`);
        process.exit(1);
    }
    console.log(`[gen] Varrendo ${repo} ...`);
    const files = walk(repo);
    console.log(`[gen] ${files.length} arquivo(s) considerados.`);
    const det = detectStack(files);
    console.log(`[gen] Frontend detectado : ${det.frontend ?? '(nao detectado)'}`);
    console.log(`[gen] Backend detectado  : ${det.backend.join(', ') || '(nao detectado)'}`);
    console.log(`[gen] Hash routing       : ${det.usesHashRouting ? 'sim' : 'nao/indefinido'}`);
    const routes = extractFrontendRoutes(files, det);
    const endpoints = extractBackendEndpoints(files, det);
    const notes = [
        'GERADO AUTOMATICAMENTE — revise antes de usar.',
        'authRequired e heuristico (baseado em middleware/decorators de auth no arquivo).',
        'Confirme params (query/body/path) e marque idor:true em recursos com id direto.',
    ];
    if (det.backend.length === 0) {
        notes.push('Backend nao detectado — nenhum endpoint extraido. Preencha manualmente ou informe a stack.');
    }
    if (det.frontend === 'Angular' && !det.usesHashRouting) {
        notes.push('Se a SPA usa hash routing (#/...), ajuste os paths das rotas.');
    }
    const profile = {
        name,
        framework: det.frontend ?? undefined,
        routes,
        endpoints,
        notes: notes.join(' '),
        _generatedBy: `generate-target-profile @ ${new Date().toISOString()}`,
    };
    const outDir = path.dirname(outPath);
    if (outDir && !fs.existsSync(outDir))
        fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(profile, null, 2), 'utf-8');
    console.log(`\n[gen] Perfil escrito em ${outPath}\n` +
        `      Rotas    : ${routes.length}\n` +
        `      Endpoints: ${endpoints.length}\n` +
        `\nRevise o arquivo (principalmente authRequired, params e idor), ` +
        `depois rode com TARGET_PROFILE=${outPath}.`);
}
main();
//# sourceMappingURL=generate-target-profile.js.map