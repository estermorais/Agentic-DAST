#!/usr/bin/env python3
"""
generate-tcc-artifacts.py
-----------------------------------------------------------------
Gera artefatos consolidados para o TCC 2 a partir dos reports
oficiais (n=30 por cenario) e do CSV de log:

  reports/tcc-artifacts/
    tables.tex            Tabelas LaTeX prontas para \input{}
    violin-f1.pdf         Violin plot com swarm de F1 por cenario
    barchart-coverage.pdf Barras horizontais de cobertura acumulada
    heatmap-detection.pdf Heatmap frequencia de deteccao (GT x cenario)
    resumo.md             Documento consolidado em Markdown

Uso:
  python scripts/generate-tcc-artifacts.py
"""
from __future__ import annotations
import csv
import json
import statistics
import subprocess
from collections import defaultdict
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import seaborn as sns

ROOT = Path(__file__).resolve().parent.parent
REPORTS = ROOT / "reports"
GT_PATH = ROOT / "src" / "evaluation" / "ground-truth.json"
OUT = REPORTS / "tcc-artifacts"
OUT.mkdir(exist_ok=True)

# Paleta consistente por cenario (colorblind-friendly Okabe-Ito)
SCEN_COLORS = {
    "A": "#0072B2",  # azul
    "B": "#56B4E9",  # azul claro
    "C": "#009E73",  # verde (destaque - proposto)
    "D": "#D55E00",  # vermelho-laranja (baseline SOTA)
}
SCEN_LABELS = {
    "A": "Cenário A\n(ZAP puro)",
    "B": "Cenário B\n(ZAP + E2E)",
    "C": "Cenário C\n(Agentic DAST)",
    "D": "Cenário D\n(PentestGPT)",
}

# ==================================================================
# Carregamento de dados
# ==================================================================

def load_ground_truth() -> list[dict]:
    with GT_PATH.open(encoding="utf-8") as f:
        data = json.load(f)
    return data["entries"] if isinstance(data, dict) else data


def load_summary() -> dict:
    with (REPORTS / "_evaluation-summary.json").open(encoding="utf-8") as f:
        return json.load(f)


def run_coverage_json() -> dict:
    """Chama coverage-analysis.js --json para obter contagens estruturadas.

    Reusa a logica autoritativa de classify.ts (compilada em dist/) em
    vez de reimplementa-la em Python — evita drift entre as duas.
    """
    gt = load_ground_truth()
    script = ROOT / "scripts" / "coverage-analysis.js"
    result = subprocess.run(
        ["node", str(script), "--json"],
        capture_output=True, text=True, cwd=ROOT, encoding="utf-8",
    )
    if result.returncode != 0:
        raise RuntimeError(f"coverage-analysis.js falhou: {result.stderr}")

    data = json.loads(result.stdout)
    # Converte matched[scen] de dict para defaultdict(int) para compat
    matched = {s: defaultdict(int, info["matched"])
               for s, info in data["per_scenario"].items()}
    per_scen_n = {s: info["n_reports"]
                  for s, info in data["per_scenario"].items()}
    return {"matched": matched, "n": per_scen_n, "gt": gt}


# ==================================================================
# LaTeX
# ==================================================================

def gen_latex_tables(summary: dict, cov: dict) -> str:
    agg = summary["aggregated"]
    agg_by_scen = {a["scenario"]: a for a in agg}
    matched = cov["matched"]
    gt = cov["gt"]
    ngt = len(gt)

    # Helper de formatacao numerica em portugues brasileiro (virgula decimal)
    def n(x, digits=3):
        return f"{x:.{digits}f}".replace(".", ",")

    # Rodape padrao para todas as tabelas (NBR 6023:2018 exige fonte).
    LEGEND = r"\legend{Fonte: Elaborado pela autora (2026).}"

    def cov_pct(s):
        return len(matched[s]) * 100 / ngt

    latex = r"""% ============================================================
% Tabelas geradas automaticamente por generate-tcc-artifacts.py
% Nao editar manualmente — regenere com o script.
% ============================================================

% --- Tabela 1: Metricas agregadas por cenario -----------------
\begin{table}[htbp]
\centering
\caption{Métricas de desempenho por cenário experimental (n=30 execuções cada, Juice Shop v17.2.0)}
\label{tab:metricas-agregadas}
\begin{tabular}{lcccccc}
\toprule
\textbf{Cenário} & \textbf{n} & \textbf{Precisão} & \textbf{Recall} & \textbf{F1 (média)} & \textbf{F1 (desvio)} & \textbf{Cobertura} \\
\midrule
"""
    # Ordem A -> B -> D -> C: apresenta baselines antes, framework proposto
    # como climax da comparacao (orientacao do orientador)
    rows = [
        ("A (ZAP puro)", "A"),
        ("B (ZAP + E2E)", "B"),
        ("D (PentestGPT)", "D"),
        ("C (Agentic DAST)", "C"),
    ]
    for label, s in rows:
        a = agg_by_scen[s]
        prefix = r"\textbf{" if s == "C" else ""
        suffix = "}" if s == "C" else ""
        latex += (f"{prefix}{label}{suffix} & "
                  f"{prefix}{a['runs']}{suffix} & "
                  f"{prefix}{n(a['meanPrec'])}{suffix} & "
                  f"{prefix}{n(a['meanRecall'])}{suffix} & "
                  f"{prefix}{n(a['meanF1'])}{suffix} & "
                  f"{prefix}{n(a['stdevF1'])}{suffix} & "
                  f"{prefix}{len(matched[s])}/{ngt} ({cov_pct(s):.0f}\\%){suffix} \\\\\n")
    latex += r"\bottomrule" + "\n"
    latex += r"\end{tabular}" + "\n"
    latex += LEGEND + "\n"
    latex += r"\end{table}" + "\n\n"
    latex += r"""% --- Tabela 2: Cobertura por categoria (Cenario C) ------------
\begin{table}[htbp]
\centering
\caption{Cobertura por categoria OWASP no Cenário C (Agentic DAST proposto)}
\label{tab:cobertura-categoria-c}
\begin{tabular}{lcc}
\toprule
\textbf{Categoria} & \textbf{Detectadas / Total} & \textbf{\%} \\
\midrule
"""
    gt_by_cat = defaultdict(list)
    for e in gt:
        gt_by_cat[e["category"]].append(e["id"])

    cat_display = {
        "SQL_INJECTION": "SQL Injection",
        "JWT": "JSON Web Token",
        "SENSITIVE_DATA_EXPOSURE": "Sensitive Data Exposure",
        "XSS": "Cross-Site Scripting",
        "BROKEN_ACCESS_CONTROL": "Broken Access Control",
        "BUSINESS_LOGIC": "Business Logic",
    }
    c_ids = set(matched["C"].keys())
    for cat in ["SQL_INJECTION", "JWT", "SENSITIVE_DATA_EXPOSURE", "XSS",
                "BROKEN_ACCESS_CONTROL", "BUSINESS_LOGIC"]:
        ids = gt_by_cat.get(cat, [])
        hit = sum(1 for i in ids if i in c_ids)
        pct = hit * 100 // len(ids) if ids else 0
        latex += f"{cat_display[cat]} & {hit}/{len(ids)} & {pct}\\% \\\\\n"
    latex += r"\bottomrule" + "\n"
    latex += r"\end{tabular}" + "\n"
    latex += LEGEND + "\n"
    latex += r"\end{table}" + "\n\n"
    latex += r"""% --- Tabela 3: Comparativo C vs D (dominancia) ----------------
\begin{table}[htbp]
\centering
\caption{Análise comparativa entre o framework proposto (C) e o baseline estado-da-arte (D)}
\label{tab:comparativo-c-vs-d}
\begin{tabular}{lccc}
\toprule
\textbf{Métrica} & \textbf{Cenário C} & \textbf{Cenário D} & \textbf{Ganho relativo} \\
\midrule
"""
    c_agg = agg_by_scen["C"]
    d_agg = agg_by_scen["D"]
    def pct_gain(c, d): return (c - d) / d * 100 if d > 0 else float("inf")

    latex += f"F1 & {n(c_agg['meanF1'])} & {n(d_agg['meanF1'])} & +{pct_gain(c_agg['meanF1'], d_agg['meanF1']):.0f}\\% \\\\\n"
    latex += f"Precisão & {n(c_agg['meanPrec'])} & {n(d_agg['meanPrec'])} & +{pct_gain(c_agg['meanPrec'], d_agg['meanPrec']):.0f}\\% \\\\\n"
    latex += f"Recall & {n(c_agg['meanRecall'])} & {n(d_agg['meanRecall'])} & +{pct_gain(c_agg['meanRecall'], d_agg['meanRecall']):.0f}\\% \\\\\n"
    latex += f"Cobertura acumulada & {len(matched['C'])}/19 & {len(matched['D'])}/19 & +{len(matched['C'])-len(matched['D'])} vulns \\\\\n"
    latex += f"Desvio padrão de F1 & {n(c_agg['stdevF1'])} & {n(d_agg['stdevF1'])} & --{(d_agg['stdevF1']-c_agg['stdevF1'])/d_agg['stdevF1']*100:.0f}\\% \\\\\n"
    latex += r"\bottomrule" + "\n"
    latex += r"\end{tabular}" + "\n"
    latex += LEGEND + "\n"
    latex += r"\end{table}" + "\n\n"
    latex += r"""% --- Tabela 4: Dominancia estrita (C superset de D) -----------
\begin{table}[htbp]
\centering
\caption{Análise de dominância: vulnerabilidades detectadas exclusivamente por cada cenário}
\label{tab:dominancia}
\begin{tabular}{lcp{7cm}}
\toprule
\textbf{Grupo} & \textbf{\#} & \textbf{Vulnerabilidades (ID Ground Truth)} \\
\midrule
"""
    c_set = set(matched["C"].keys())
    d_set = set(matched["D"].keys())
    only_c = c_set - d_set
    only_d = d_set - c_set
    both   = c_set & d_set

    def fmt_ids(s):
        return ", ".join(sorted(s)) if s else "---"

    latex += f"Somente C detectou & {len(only_c)} & {fmt_ids(only_c)} \\\\\n"
    latex += f"Somente D detectou & {len(only_d)} & {fmt_ids(only_d)} \\\\\n"
    latex += f"Ambos detectaram & {len(both)} & {fmt_ids(both)} \\\\\n"
    latex += r"\bottomrule" + "\n"
    latex += r"\end{tabular}" + "\n"
    latex += LEGEND + "\n"
    latex += r"\end{table}" + "\n"
    return latex


# ==================================================================
# Graficos
# ==================================================================

# Estilo grafico seguindo orientacao do orientador (baseado em Tufte):
# - fontes serif Times para casar com templates IEEE/ACM
# - grades sutis, sem molduras
# - saida em PDF vetorial
sns.set_theme(style="ticks")
plt.rcParams.update({
    "font.family": "serif",
    "font.serif": ["Times New Roman", "Times", "DejaVu Serif"],
    "font.size": 10,
    "axes.labelsize": 10,
    "xtick.labelsize": 9,
    "ytick.labelsize": 9,
    "legend.fontsize": 9,
    "axes.spines.top": False,
    "axes.spines.right": False,
    "figure.dpi": 120,
    "savefig.dpi": 300,
    "savefig.bbox": "tight",
    "savefig.format": "pdf",
})


def plot_violin_f1(summary: dict, out: Path):
    """Violin plot de F1 por cenario com swarm plot sobreposto.

    Substitui o boxplot anterior seguindo orientacao do orientador
    (documento 'Orientacao Resultados Agentic DAST.pdf'). O violin
    mostra a densidade da distribuicao alem dos quartis; o swarm
    mostra cada uma das 30 rodadas como ponto individual. Media
    marcada com losango branco. Salvo em PDF vetorial.
    """
    agg_by_scen = {a["scenario"]: a for a in summary["aggregated"]}
    scenarios = ["A", "B", "D", "C"]

    # DataFrame long-format para seaborn
    rows = []
    for s in scenarios:
        for m in agg_by_scen[s]["individualMetrics"]:
            rows.append({
                "Cenário": SCEN_LABELS[s].replace("\n", " "),
                "F1-score": m["f1"],
            })
    df = pd.DataFrame(rows)

    fig, ax = plt.subplots(figsize=(7, 4))

    palette = [SCEN_COLORS[s] for s in scenarios]
    order = [SCEN_LABELS[s].replace("\n", " ") for s in scenarios]

    sns.violinplot(
        data=df, x="Cenário", y="F1-score",
        order=order, hue="Cenário", palette=palette, hue_order=order,
        inner="quartile", linewidth=0.8, cut=0, ax=ax,
        alpha=0.55, legend=False,
    )
    sns.stripplot(
        data=df, x="Cenário", y="F1-score",
        order=order, color="black", alpha=0.5, size=3.0, jitter=0.15, ax=ax,
    )

    # Media por cenario (losango branco)
    for i, s in enumerate(scenarios):
        mean_f1 = agg_by_scen[s]["meanF1"]
        ax.scatter(i, mean_f1, marker="D", s=45,
                   facecolor="white", edgecolor="black", linewidth=0.9, zorder=5)
        ax.text(i, mean_f1 + 0.05, f"μ={mean_f1:.3f}",
                ha="center", fontsize=8, style="italic")

    ax.set_ylabel("F1-score")
    ax.set_xlabel("")
    ax.set_ylim(-0.05, 1.0)
    ax.grid(axis="y", linestyle="--", alpha=0.3)
    ax.set_axisbelow(True)
    sns.despine(ax=ax)
    fig.tight_layout()
    fig.savefig(out)
    plt.close(fig)


def plot_barchart_coverage(cov: dict, out: Path):
    """Barras horizontais empilhadas: cobertura acumulada por cenario e categoria."""
    matched = cov["matched"]
    gt = cov["gt"]
    scenarios = ["A", "B", "D", "C"]
    labels = [SCEN_LABELS[s].replace("\n", " ") for s in scenarios]

    # Total absoluto e proporcional
    cats = ["SQL_INJECTION", "JWT", "SENSITIVE_DATA_EXPOSURE", "XSS",
            "BROKEN_ACCESS_CONTROL", "BUSINESS_LOGIC"]
    cat_short = {
        "SQL_INJECTION": "SQLi", "JWT": "JWT",
        "SENSITIVE_DATA_EXPOSURE": "SDE", "XSS": "XSS",
        "BROKEN_ACCESS_CONTROL": "BAC", "BUSINESS_LOGIC": "BLV",
    }
    cat_total = defaultdict(int)
    for e in gt:
        cat_total[e["category"]] += 1

    # cat_hit[scen][cat]
    cat_hit = {s: defaultdict(int) for s in scenarios}
    for s in scenarios:
        for gid in matched[s]:
            entry = next(e for e in gt if e["id"] == gid)
            cat_hit[s][entry["category"]] += 1

    cat_colors = {
        "SQL_INJECTION": "#0072B2",
        "JWT": "#E69F00",
        "SENSITIVE_DATA_EXPOSURE": "#009E73",
        "XSS": "#CC79A7",
        "BROKEN_ACCESS_CONTROL": "#56B4E9",
        "BUSINESS_LOGIC": "#D55E00",
    }

    fig, ax = plt.subplots(figsize=(10, 5))
    y = np.arange(len(scenarios))
    left = np.zeros(len(scenarios))
    for cat in cats:
        vals = [cat_hit[s][cat] for s in scenarios]
        ax.barh(y, vals, left=left, height=0.6,
                color=cat_colors[cat], label=f"{cat_short[cat]} (max {cat_total[cat]})",
                edgecolor="white", linewidth=0.8)
        # Rotulos nos segmentos
        for i, v in enumerate(vals):
            if v > 0:
                ax.text(left[i] + v/2, y[i], str(v), ha="center", va="center",
                        color="white", fontsize=9, fontweight="bold")
        left += vals

    # Totais no fim
    for i, s in enumerate(scenarios):
        total = int(left[i])
        pct = total * 100 // len(gt)
        ax.text(total + 0.3, y[i], f"{total}/{len(gt)} ({pct}%)",
                va="center", fontsize=10, fontweight="bold")

    ax.set_yticks(y)
    ax.set_yticklabels(labels)
    ax.invert_yaxis()
    ax.set_xlabel("Vulnerabilidades detectadas (união de 30 execuções)", fontsize=11)
    ax.set_title("Cobertura acumulada por cenário e categoria OWASP\n"
                 f"Ground Truth: {len(gt)} vulnerabilidades",
                 fontsize=12, pad=15)
    ax.set_xlim(0, len(gt) + 4)
    ax.legend(loc="lower right", fontsize=9, framealpha=0.95, ncol=2)
    ax.grid(axis="x", alpha=0.3)
    ax.set_axisbelow(True)
    plt.tight_layout()
    plt.savefig(out)
    plt.close()


def plot_heatmap_detection(cov: dict, out: Path):
    """Heatmap: linhas=vulns, colunas=cenarios, cor=frequencia de deteccao (%)."""
    matched = cov["matched"]
    n = cov["n"]
    gt = cov["gt"]
    scenarios = ["A", "B", "D", "C"]

    # Ordena GTs por categoria + id
    gt_sorted = sorted(gt, key=lambda e: (e["category"], e["id"]))
    matrix = np.zeros((len(gt_sorted), len(scenarios)))
    for i, e in enumerate(gt_sorted):
        for j, s in enumerate(scenarios):
            count = matched[s].get(e["id"], 0)
            matrix[i, j] = count / n[s] * 100 if n[s] > 0 else 0

    fig, ax = plt.subplots(figsize=(7, 8))
    im = ax.imshow(matrix, aspect="auto", cmap="YlGn", vmin=0, vmax=100)

    ax.set_xticks(np.arange(len(scenarios)))
    ax.set_xticklabels([f"Cen. {s}" for s in scenarios], fontsize=11)
    ax.set_yticks(np.arange(len(gt_sorted)))
    ax.set_yticklabels([f"{e['id']} {e['challengeName'][:32]}" for e in gt_sorted],
                       fontsize=9)

    # Valor em cada celula
    for i in range(len(gt_sorted)):
        for j in range(len(scenarios)):
            v = matrix[i, j]
            color = "white" if v > 55 else "black"
            label = f"{v:.0f}" if v > 0 else "-"
            ax.text(j, i, label, ha="center", va="center",
                    color=color, fontsize=8, fontweight="bold" if v > 0 else "normal")

    # Linhas separadoras entre categorias
    prev_cat = None
    for i, e in enumerate(gt_sorted):
        if prev_cat and e["category"] != prev_cat:
            ax.axhline(i - 0.5, color="black", linewidth=0.8, alpha=0.4)
        prev_cat = e["category"]

    cbar = plt.colorbar(im, ax=ax, shrink=0.7, pad=0.02)
    cbar.set_label("Frequência de detecção (%)")
    ax.set_title("Frequência de detecção por vulnerabilidade\n"
                 "(percentual de 30 execuções em que cada GT foi detectado)",
                 fontsize=10, pad=15)
    plt.tight_layout()
    plt.savefig(out)
    plt.close()


def plot_f1_por_categoria_ci(summary: dict, cov: dict, out: Path):
    """F1 por categoria com barras de erro (bootstrap 95% CI).

    Atende orientacao do orientador: 'em graficos de barra, adicionar
    barras de erro (95% CI) para provar que os resultados sao
    estatisticamente superiores e estaveis'. Bootstrap com 10k
    reamostragens sobre as 30 rodadas de cada cenario/categoria.
    """
    from collections import defaultdict as _dd

    agg_by_scen = {a["scenario"]: a for a in summary["aggregated"]}
    scenarios = ["A", "B", "D", "C"]
    gt = cov["gt"]

    # Descobre categorias e conta GTs totais por categoria
    cats = ["SQL_INJECTION", "JWT", "SENSITIVE_DATA_EXPOSURE", "XSS",
            "BROKEN_ACCESS_CONTROL", "BUSINESS_LOGIC"]
    cat_short = {"SQL_INJECTION": "SQLi", "JWT": "JWT",
                 "SENSITIVE_DATA_EXPOSURE": "SDE", "XSS": "XSS",
                 "BROKEN_ACCESS_CONTROL": "BAC", "BUSINESS_LOGIC": "BLV"}

    # Para bootstrap CI: precisamos F1 POR CATEGORIA POR RODADA, e o
    # summary agregado nao tem isso desagregado. Uso perCategory dos
    # relatorios individuais.
    per_reports = summary.get("perReport", [])
    f1_por_cat = _dd(lambda: _dd(list))  # scen -> cat -> [f1 por rodada]
    for r in per_reports:
        s = r.get("scenario")
        if s not in scenarios: continue
        for c in r.get("perCategory", []):
            cat = c.get("category")
            if cat not in cats: continue
            f1_por_cat[s][cat].append(c.get("f1", 0.0))

    def bootstrap_mean_ci(data, n_iter=10000, ci=0.95, seed=42):
        if not data: return (0.0, 0.0, 0.0)
        arr = np.array(data)
        rng = np.random.default_rng(seed)
        n = len(arr)
        boots = np.empty(n_iter)
        for i in range(n_iter):
            boots[i] = arr[rng.integers(0, n, size=n)].mean()
        alpha = (1 - ci) / 2
        return float(arr.mean()), float(np.quantile(boots, alpha)), float(np.quantile(boots, 1 - alpha))

    fig, ax = plt.subplots(figsize=(9, 4.5))
    x = np.arange(len(cats))
    n_scen = len(scenarios)
    width = 0.20

    for i, s in enumerate(scenarios):
        means, lo_err, hi_err = [], [], []
        for cat in cats:
            m, lo, hi = bootstrap_mean_ci(f1_por_cat[s].get(cat, []))
            means.append(m)
            lo_err.append(m - lo)
            hi_err.append(hi - m)
        offset = (i - (n_scen - 1) / 2) * width
        ax.bar(x + offset, means, width, yerr=[lo_err, hi_err], capsize=3,
               color=SCEN_COLORS[s], alpha=0.85,
               label=SCEN_LABELS[s].replace("\n", " "),
               error_kw={"linewidth": 0.7, "ecolor": "black"})

    ax.set_xticks(x)
    ax.set_xticklabels([cat_short[c] for c in cats])
    ax.set_ylabel("F1-score (média com IC 95\\%)")
    ax.set_ylim(0, 1.0)
    ax.grid(axis="y", linestyle="--", alpha=0.3)
    ax.set_axisbelow(True)
    ax.legend(loc="upper right", frameon=True, framealpha=0.95)
    sns.despine(ax=ax)
    fig.tight_layout()
    fig.savefig(out)
    plt.close(fig)


# ==================================================================
# Markdown resumo
# ==================================================================

def gen_markdown_summary(summary: dict, cov: dict) -> str:
    agg = {a["scenario"]: a for a in summary["aggregated"]}
    matched = cov["matched"]
    gt = cov["gt"]
    ngt = len(gt)

    only_c = set(matched["C"]) - set(matched["D"])
    only_d = set(matched["D"]) - set(matched["C"])
    both = set(matched["C"]) & set(matched["D"])
    never = set(e["id"] for e in gt) - set(matched["C"]) - set(matched["D"])

    def id_to_name(gid):
        return next(e["challengeName"] for e in gt if e["id"] == gid)

    md = f"""# Resumo Consolidado — Rodada Oficial TCC 2

**Data de geração:** 2026-08-03
**Autora:** Ester Morais Neves
**Orientador:** Mateus Tymburibá
**Universidade:** CEFET-MG — Engenharia de Computação
**Alvo experimental:** OWASP Juice Shop v17.2.0
**Ground Truth:** {ngt} vulnerabilidades em 6 categorias OWASP
**Design experimental:** n=30 execuções por cenário, round-robin entre A/B/C/D

---

## 1. Métricas agregadas por cenário

| Cenário | n | Precisão | Recall | F1 (μ ± σ) | Cobertura |
|---|---|---|---|---|---|
| A (ZAP puro) | {agg['A']['runs']} | {agg['A']['meanPrec']:.3f} | {agg['A']['meanRecall']:.3f} | {agg['A']['meanF1']:.3f} ± {agg['A']['stdevF1']:.3f} | {len(matched['A'])}/{ngt} ({len(matched['A'])*100//ngt}%) |
| B (ZAP + E2E) | {agg['B']['runs']} | {agg['B']['meanPrec']:.3f} | {agg['B']['meanRecall']:.3f} | {agg['B']['meanF1']:.3f} ± {agg['B']['stdevF1']:.3f} | {len(matched['B'])}/{ngt} ({len(matched['B'])*100//ngt}%) |
| **C (Agentic DAST)** | **{agg['C']['runs']}** | **{agg['C']['meanPrec']:.3f}** | **{agg['C']['meanRecall']:.3f}** | **{agg['C']['meanF1']:.3f} ± {agg['C']['stdevF1']:.3f}** | **{len(matched['C'])}/{ngt} ({len(matched['C'])*100//ngt}%)** |
| D (PentestGPT) | {agg['D']['runs']} | {agg['D']['meanPrec']:.3f} | {agg['D']['meanRecall']:.3f} | {agg['D']['meanF1']:.3f} ± {agg['D']['stdevF1']:.3f} | {len(matched['D'])}/{ngt} ({len(matched['D'])*100//ngt}%) |

---

## 2. Principais achados

### 2.1 Framework proposto supera baseline estado-da-arte

- **F1 do Cenário C é {agg['C']['meanF1']/agg['D']['meanF1']:.2f}× o F1 do Cenário D** ({agg['C']['meanF1']:.3f} vs {agg['D']['meanF1']:.3f})
- **Recall {agg['C']['meanRecall']/agg['D']['meanRecall']:.2f}× superior** ({agg['C']['meanRecall']:.3f} vs {agg['D']['meanRecall']:.3f})
- **Cobertura absoluta {len(matched['C'])-len(matched['D'])} vulnerabilidades a mais** ({len(matched['C'])}/{ngt} vs {len(matched['D'])}/{ngt})

### 2.2 Alta reprodutibilidade do framework proposto

- **Desvio padrão de F1 no Cenário C: σ = {agg['C']['stdevF1']:.3f}**
- **Desvio padrão de F1 no Cenário D: σ = {agg['D']['stdevF1']:.3f}** ({agg['D']['stdevF1']/agg['C']['stdevF1']:.1f}× maior)
- **9 dos 16 GTs detectados pelo C aparecem em 100% dos 30 runs** — comportamento determinístico apesar da natureza estocástica do LLM

### 2.3 Dominância estrita de C sobre D

- **Somente C detectou ({len(only_c)}):** {", ".join(sorted(only_c)) if only_c else "---"}
- **Somente D detectou ({len(only_d)}):** {", ".join(sorted(only_d)) if only_d else "---"}
- **Ambos detectaram ({len(both)}):** {", ".join(sorted(both))}

O framework proposto detectou **todo** o conjunto encontrado pelo baseline mais {len(only_c)} vulnerabilidades adicionais — dominância no sentido matemático estrito.

### 2.4 Scanner tradicional (ZAP) é ineficaz nesta classe de aplicação

- Cenários A e B (ZAP puro e ZAP + E2E) obtiveram **F1 = 0.000** e **0% de cobertura funcional**
- Todos os findings de ZAP foram alertas configuracionais (CSP, cabeçalhos HTTP, timestamps) — segregados pela função `isConfigurationalAlert()` e não contabilizados como TP
- Confirma a hipótese motivadora do TCC: **DAST tradicional não penetra SPAs com autenticação e lógica de negócio complexa**

---

## 3. Cobertura por categoria — Cenário C (proposto)

| Categoria OWASP | Detectadas | Percentual |
|---|---|---|
| SQL Injection | 3/3 | **100%** |
| JSON Web Token (JWT) | 2/2 | **100%** |
| Sensitive Data Exposure | 4/4 | **100%** |
| Cross-Site Scripting (XSS) | 3/3 | **100%** |
| Broken Access Control | 3/4 | 75% |
| Business Logic | 1/3 | 33% |
| **Total** | **{len(matched['C'])}/{ngt}** | **{len(matched['C'])*100//ngt}%** |

---

## 4. Vulnerabilidades nunca detectadas ({len(never)})

"""
    for gid in sorted(never):
        e = next(x for x in gt if x["id"] == gid)
        md += f"- **{gid} — {e['challengeName']}** ({e['category']})\n"

    md += f"""
### Análise das não-detecções

Todas as {len(never)} vulnerabilidades não detectadas por nenhum cenário compartilham uma característica: **exigem manipulação de estado muito específica** que nenhum agente conseguiu inferir a partir da superfície da aplicação:

- **GT-BLV-01 Negative Order**: requer adicionar produto com quantidade negativa ao carrinho e completar checkout — ação nunca sugerida por browsers legítimos.
- **GT-BLV-03 Forged Coupon**: exige engenharia reversa do algoritmo de cupons (base64 + timestamp + rating) sem qualquer pista na aplicação.
- **GT-BAC-04 Change Other Users**: requer PATCH em `/api/Users/:id` de outro usuário — o LLM tentou GET mas não PATCH.

Este resultado é **consistente com a literatura de LLM-based pentesting** (Deng et al. 2024, Fang et al. 2024), que reporta dificuldades análogas em vulnerabilidades de lógica de negócio que exigem exploração criativa fora do padrão comum. **Documentar como Ameaça à Validade** na Seção Discussão do TCC.

---

## 5. Frequência de detecção — Cenário C (top 10)

"""
    n_c = cov["n"]["C"]
    sorted_matches = sorted(matched["C"].items(), key=lambda x: -x[1])[:10]
    md += "| Rank | ID | Vulnerabilidade | Freq / 30 runs | % |\n|---|---|---|---|---|\n"
    for rank, (gid, count) in enumerate(sorted_matches, 1):
        name = id_to_name(gid)
        pct = count * 100 // n_c
        md += f"| {rank} | {gid} | {name} | {count}/{n_c} | {pct}% |\n"

    md += """
---

## 6. Metodologia — execução experimental

- **Amostragem:** 30 execuções independentes por cenário, intercaladas em modo round-robin (A→B→C→D→A→…) para minimizar efeitos temporais e de estado.
- **Ambiente:** Docker Compose com OWASP Juice Shop v17.2.0 e OWASP ZAP 2.15 em rede isolada `dast-net`.
- **Reset entre runs:** `docker compose restart juice-shop zap` antes de cada execução, para garantir estado limpo.
- **Modelo LLM (Cenário C):** Claude Haiku 4.5 via OpenRouter, com prompt caching Anthropic-style ativado.
- **Modelo LLM (Cenário D):** Claude Sonnet via Claude Code CLI (Claude Pro plan).
- **Iterações máximas ReAct (Cenário C):** 40.
- **Circuit breaker HTTP:** encerramento gracioso após 3 falhas consecutivas de conexão ao alvo.
- **Classificação de findings:** função `classify()` em `src/evaluation/classify.ts`, com matching multi-categoria por palavras-chave específicas (≥12 caracteres) e `endpointHint` permissivo.
- **Alertas configuracionais** (CSP, cabeçalhos HTTP, versões de biblioteca) foram segregados por `isConfigurationalAlert()` e não contabilizados em TP/FP.

---

## 7. Limitações e Ameaças à Validade

1. **Vulnerabilidades de lógica de negócio de alta especificidade** não foram detectadas por nenhum agente (BLV-01, BLV-03, BAC-04). Isto reflete limitação intrínseca dos LLMs em explorar cenários sem pistas na superfície da aplicação.
2. **Rate limit do Claude Pro** durante execução do Cenário D exigiu re-execuções — todas as tentativas mal-sucedidas foram reclassificadas como `failed` pelo script `fix-silent-failures.py` e excluídas da amostra final.
3. **Custo de token elevado** limitou o número de iterações ReAct a 40 no Cenário C — configuração superior poderia expandir cobertura mas está fora do escopo.
4. **Aplicação-alvo única** (Juice Shop): resultados podem não generalizar diretamente para SPAs com arquiteturas ou padrões distintos.
5. **Classificador determinístico baseado em palavras-chave**: apesar de refinado (multi-match cross-category), pode ainda produzir falsos negativos por rotulagem imprecisa do LLM.

---

## 8. Arquivos gerados por este script

- `tables.tex` — Tabelas 1 a 4 em LaTeX (prontas para `\\input{}`)
- `boxplot-f1.png` — Box plot da distribuição de F1 por cenário
- `barchart-coverage.png` — Cobertura acumulada por cenário e categoria
- `heatmap-detection.png` — Frequência de detecção por vulnerabilidade

Fontes de dados:
- `reports/_evaluation-summary.json`
- `reports/report-*.json`, `scenario-*.json` (120 reports oficiais)
- `src/evaluation/ground-truth.json`
"""
    return md


# ==================================================================
# Main
# ==================================================================

def main():
    print("[gen] carregando dados...")
    summary = load_summary()
    cov = run_coverage_json()

    print("[gen] tabelas LaTeX...")
    latex = gen_latex_tables(summary, cov)
    (OUT / "tables.tex").write_text(latex, encoding="utf-8")
    print(f"       -> {OUT / 'tables.tex'}")

    print("[gen] boxplot F1 por cenario...")
    plot_violin_f1(summary, OUT / "violin-f1.pdf")
    print(f"       -> {OUT / 'violin-f1.pdf'}")

    print("[gen] barras cobertura por cenario e categoria...")
    plot_barchart_coverage(cov, OUT / "barchart-coverage.pdf")
    print(f"       -> {OUT / 'barchart-coverage.pdf'}")

    print("[gen] heatmap frequencia de deteccao...")
    plot_heatmap_detection(cov, OUT / "heatmap-detection.pdf")
    print(f"       -> {OUT / 'heatmap-detection.pdf'}")

    print("[gen] F1 por categoria com barras de erro CI 95%...")
    plot_f1_por_categoria_ci(summary, cov, OUT / "f1-por-categoria-ci.pdf")
    print(f"       -> {OUT / 'f1-por-categoria-ci.pdf'}")

    # NOTA: resumo.md NAO e mais regerado automaticamente. A versao
    # atual em disco foi humanizada manualmente para uso em anexos e
    # documentacao para o orientador. Se precisar de uma versao
    # sintetica atualizada com metricas do CSV, gere manualmente.
    print("[gen] resumo.md preservado (regeneracao desabilitada).")

    print("\n[gen] pronto. artefatos em:", OUT)


if __name__ == "__main__":
    main()
