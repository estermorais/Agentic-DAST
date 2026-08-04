#!/usr/bin/env python3
"""
statistical-analysis.py
-----------------------------------------------------------------
Análise estatística formal da rodada oficial n=30, produzindo:

  1. Wilcoxon signed-rank (pareado por ciclo do round-robin)
  2. Mann-Whitney U (independente, robusto ao pareamento fraco)
  3. Bootstrap 95% CI para F1 medio de cada cenario (10k iteracoes)
  4. Cliff's delta (effect size nao-parametrico)
  5. Fisher exato: cobertura por categoria (C vs D) — atende RQ4

Saidas:
  reports/tcc-artifacts/estatistica.md — relatorio consolidado
  reports/tcc-artifacts/estatistica.tex — tabelas LaTeX prontas

Uso:
  python scripts/statistical-analysis.py
-----------------------------------------------------------------
"""
from __future__ import annotations
import json
import subprocess
from collections import defaultdict
from pathlib import Path

import numpy as np
from scipy import stats

ROOT = Path(__file__).resolve().parent.parent
REPORTS = ROOT / "reports"
OUT = REPORTS / "tcc-artifacts"


def load_f1_per_scenario() -> dict[str, list[float]]:
    """Extrai lista de F1 por cenario, ordenada pela ordem de execucao."""
    summary = json.loads((REPORTS / "_evaluation-summary.json").read_text(encoding="utf-8"))
    result = {}
    for agg in summary["aggregated"]:
        result[agg["scenario"]] = [m["f1"] for m in agg["individualMetrics"]]
    return result


def load_coverage_matrix() -> dict:
    """Chama coverage-analysis.js --json para obter matriz de deteccao por GT."""
    script = ROOT / "scripts" / "coverage-analysis.js"
    result = subprocess.run(
        ["node", str(script), "--json"],
        capture_output=True, text=True, cwd=ROOT, encoding="utf-8",
    )
    if result.returncode != 0:
        raise RuntimeError(f"coverage-analysis.js falhou: {result.stderr}")
    return json.loads(result.stdout)


def cliffs_delta(x: list[float], y: list[float]) -> tuple[float, str]:
    """Effect size nao-parametrico de Cliff.

    Retorna (delta, magnitude). Delta esta em [-1, 1]:
      |d| < 0.147   -> negligivel
      0.147-0.33    -> pequeno
      0.33-0.474    -> medio
      >= 0.474      -> grande
    Faixas de Vargha & Delaney (2000).
    """
    nx, ny = len(x), len(y)
    total = nx * ny
    greater = sum(1 for xi in x for yi in y if xi > yi)
    lesser = sum(1 for xi in x for yi in y if xi < yi)
    delta = (greater - lesser) / total
    ad = abs(delta)
    if ad < 0.147: mag = "negligivel"
    elif ad < 0.33: mag = "pequeno"
    elif ad < 0.474: mag = "medio"
    else: mag = "grande"
    return delta, mag


def bootstrap_ci(data: list[float], statistic=np.mean,
                 n_iter: int = 10000, ci: float = 0.95,
                 seed: int = 42) -> tuple[float, float, float]:
    """Bootstrap por reamostragem com reposicao. Retorna (est, lo, hi)."""
    rng = np.random.default_rng(seed)
    arr = np.array(data)
    n = len(arr)
    stats_boot = np.empty(n_iter)
    for i in range(n_iter):
        idx = rng.integers(0, n, size=n)
        stats_boot[i] = statistic(arr[idx])
    alpha = (1 - ci) / 2
    lo = float(np.quantile(stats_boot, alpha))
    hi = float(np.quantile(stats_boot, 1 - alpha))
    return float(statistic(arr)), lo, hi


def format_p(p: float) -> str:
    if p < 0.001: return "< 0{,}001"
    if p < 0.01:  return f"{p:.3f}".replace(".", "{,}")
    return f"{p:.3f}".replace(".", "{,}")


def main():
    f1 = load_f1_per_scenario()
    cov = load_coverage_matrix()
    entries = json.loads((ROOT / "src" / "evaluation" / "ground-truth.json").read_text(encoding="utf-8"))["entries"]

    md = ["# Análise Estatística — Rodada Oficial n=30\n"]
    tex = ["% Tabelas estatisticas geradas por statistical-analysis.py\n"]

    # =============================================================
    # 1. Bootstrap CI para F1 medio de cada cenario
    # =============================================================
    md.append("## 1. Intervalos de confiança bootstrap (95%) para F1 médio\n")
    md.append("Reamostragem com reposição, 10.000 iterações, seed = 42.\n")
    md.append("| Cenário | n | F1 médio | IC 95% | Amplitude |")
    md.append("|---|---|---|---|---|")

    tex.append(r"\begin{table}[htbp]\centering")
    tex.append(r"\caption{Intervalos de confiança bootstrap (95\%, 10.000 iterações) para o F1-\emph{score} médio}")
    tex.append(r"\label{tab:bootstrap-ci}")
    tex.append(r"\begin{tabular}{lccc}")
    tex.append(r"\toprule")
    tex.append(r"\textbf{Cenário} & \textbf{$n$} & \textbf{F1 médio} & \textbf{IC 95\%} \\")
    tex.append(r"\midrule")

    for scen in ("A", "B", "C", "D"):
        mean, lo, hi = bootstrap_ci(f1[scen])
        amp = hi - lo
        md.append(f"| {scen} | {len(f1[scen])} | {mean:.3f} | [{lo:.3f}; {hi:.3f}] | {amp:.3f} |")
        tex.append(f"{scen} & {len(f1[scen])} & {mean:.3f} & [{lo:.3f}; {hi:.3f}] \\\\".replace(".", "{,}"))
    tex.append(r"\bottomrule\end{tabular}\end{table}")
    md.append("")

    # =============================================================
    # 2. Teste de Wilcoxon signed-rank (C vs D pareado por ciclo)
    # =============================================================
    md.append("## 2. Teste de Wilcoxon signed-rank (C vs D)\n")
    md.append("Pareamento por índice de rodada, justificado pelo round-robin: a i-ésima "
              "rodada do Cenário C foi executada no mesmo ciclo temporal da i-ésima rodada "
              "do Cenário D. Hipótese nula: distribuição das diferenças F1(C)_i − F1(D)_i "
              "é simétrica em torno de zero.\n")
    n_pairs = min(len(f1["C"]), len(f1["D"]))
    c_arr = np.array(f1["C"][:n_pairs])
    d_arr = np.array(f1["D"][:n_pairs])
    stat_w, p_w = stats.wilcoxon(c_arr, d_arr, alternative="greater")
    diff = c_arr - d_arr
    md.append(f"- Pares analisados: **{n_pairs}**")
    md.append(f"- Diferença média (C − D): **{diff.mean():.3f}** (desvio {diff.std():.3f})")
    md.append(f"- Estatística W: **{stat_w:.1f}**")
    md.append(f"- p-valor (unicaudal, C > D): **{p_w:.2e}**")
    md.append(f"- Rejeita H0 ao nível α=0,05? **{'SIM' if p_w < 0.05 else 'NÃO'}**\n")

    # =============================================================
    # 3. Mann-Whitney U (amostras independentes, robusto)
    # =============================================================
    md.append("## 3. Teste de Mann-Whitney U (C vs D)\n")
    md.append("Trata as amostras como independentes, sem exigir pareamento. Usado como "
              "checagem de robustez do teste anterior.\n")
    stat_u, p_u = stats.mannwhitneyu(f1["C"], f1["D"], alternative="greater")
    md.append(f"- Estatística U: **{stat_u:.1f}**")
    md.append(f"- p-valor (unicaudal, C > D): **{p_u:.2e}**")
    md.append(f"- Rejeita H0 ao nível α=0,05? **{'SIM' if p_u < 0.05 else 'NÃO'}**\n")

    # =============================================================
    # 4. Cliff's delta (effect size)
    # =============================================================
    md.append("## 4. Cliff's delta (tamanho do efeito)\n")
    md.append("Métrica não-paramétrica que quantifica a magnitude da dominância "
              "estocástica. Faixas de Vargha e Delaney (2000): |d| < 0,147 negligível; "
              "0,147–0,33 pequeno; 0,33–0,474 médio; ≥ 0,474 grande.\n")
    delta_cd, mag_cd = cliffs_delta(f1["C"], f1["D"])
    delta_ca, mag_ca = cliffs_delta(f1["C"], f1["A"])
    md.append(f"- **C vs D:** δ = **{delta_cd:.3f}** (magnitude: **{mag_cd}**)")
    md.append(f"- **C vs A:** δ = **{delta_ca:.3f}** (magnitude: **{mag_ca}**)")
    md.append(f"- Interpretação: {'quase toda' if abs(delta_cd) > 0.9 else 'grande parte' if abs(delta_cd) > 0.5 else 'parte'} "
              f"das rodadas do Cenário C excede o valor observado no Cenário D.\n")

    tex.append(r"\begin{table}[htbp]\centering")
    tex.append(r"\caption{Testes de hipótese e effect size para o F1-\emph{score}}")
    tex.append(r"\label{tab:testes-hipotese}")
    tex.append(r"\begin{tabular}{lcccc}")
    tex.append(r"\toprule")
    tex.append(r"\textbf{Comparação} & \textbf{Teste} & \textbf{Estatística} & \textbf{$p$-valor} & \textbf{Cliff's $\delta$} \\")
    tex.append(r"\midrule")
    tex.append(f"C vs D (pareado)    & Wilcoxon      & W = {stat_w:.1f} & ${format_p(p_w)}$ & {delta_cd:.3f} ({mag_cd}) \\\\".replace(".", "{,}", 5))
    tex.append(f"C vs D (independ.)  & Mann-Whitney  & U = {stat_u:.1f} & ${format_p(p_u)}$ & --- \\\\".replace(".", "{,}", 3))
    tex.append(r"\bottomrule\end{tabular}\end{table}")

    # =============================================================
    # 5. Fisher exato: cobertura por categoria (C vs D) — atende RQ4
    # =============================================================
    md.append("## 5. Teste de Fisher exato: distribuição de detecções por categoria (RQ4)\n")
    md.append("Compara, para cada categoria OWASP, se a proporção de vulnerabilidades "
              "detectadas pelo Cenário C difere significativamente da proporção detectada "
              "pelo Cenário D. Fisher exato é apropriado devido ao tamanho pequeno das "
              "contagens por categoria (2 a 4 GTs por célula).\n")
    md.append("| Categoria | C detectou | D detectou | Total | p-valor (Fisher) |")
    md.append("|---|---|---|---|---|")

    tex.append(r"\begin{table}[htbp]\centering")
    tex.append(r"\caption{Fisher exato bilateral por categoria OWASP (Cenário C \emph{versus} Cenário D)}")
    tex.append(r"\label{tab:fisher-categorias}")
    tex.append(r"\begin{tabular}{lccc}")
    tex.append(r"\toprule")
    tex.append(r"\textbf{Categoria} & \textbf{C (det./total)} & \textbf{D (det./total)} & \textbf{$p$-valor} \\")
    tex.append(r"\midrule")

    gt_by_cat = defaultdict(list)
    for e in entries:
        gt_by_cat[e["category"]].append(e["id"])
    c_matched = set(cov["per_scenario"]["C"]["matched"].keys())
    d_matched = set(cov["per_scenario"]["D"]["matched"].keys())

    cat_display = {
        "SQL_INJECTION": "SQL Injection",
        "JWT": "JSON Web Token",
        "SENSITIVE_DATA_EXPOSURE": "Sensitive Data Exposure",
        "XSS": "Cross-Site Scripting",
        "BROKEN_ACCESS_CONTROL": "Broken Access Control",
        "BUSINESS_LOGIC": "Business Logic",
    }
    for cat in ["SQL_INJECTION", "JWT", "SENSITIVE_DATA_EXPOSURE", "XSS",
                "BROKEN_ACCESS_CONTROL", "BUSINESS_LOGIC"]:
        ids = gt_by_cat[cat]
        c_hit = sum(1 for i in ids if i in c_matched)
        d_hit = sum(1 for i in ids if i in d_matched)
        # Tabela de contingencia 2x2: [detectada, nao detectada] x [C, D]
        table = [[c_hit, len(ids) - c_hit], [d_hit, len(ids) - d_hit]]
        _, p_fisher = stats.fisher_exact(table)
        md.append(f"| {cat_display[cat]} | {c_hit}/{len(ids)} | {d_hit}/{len(ids)} | {p_fisher:.3f} |")
        tex.append(f"{cat_display[cat]} & {c_hit}/{len(ids)} & {d_hit}/{len(ids)} & ${format_p(p_fisher)}$ \\\\")
    tex.append(r"\bottomrule\end{tabular}\end{table}")

    # =============================================================
    # 6. Comparativo global (qui-quadrado)
    # =============================================================
    md.append("\n## 6. Comparativo global de cobertura (qui-quadrado)\n")
    total_gt = len(entries)
    c_hit_total = len(c_matched)
    d_hit_total = len(d_matched)
    table = [[c_hit_total, total_gt - c_hit_total],
             [d_hit_total, total_gt - d_hit_total]]
    chi2, p_chi2, dof, _ = stats.chi2_contingency(table)
    md.append(f"- Tabela de contingência 2×2: C = {c_hit_total}/{total_gt}, D = {d_hit_total}/{total_gt}")
    md.append(f"- χ² = **{chi2:.3f}** (gl = {dof})")
    md.append(f"- p-valor bilateral: **{p_chi2:.3f}**")
    md.append(f"- Rejeita H0 (proporções iguais)? **{'SIM' if p_chi2 < 0.05 else 'NÃO'}** ao nível α=0,05\n")

    # Salva
    OUT.mkdir(exist_ok=True)
    (OUT / "estatistica.md").write_text("\n".join(md), encoding="utf-8")
    (OUT / "estatistica.tex").write_text("\n".join(tex), encoding="utf-8")

    # Imprime resumo no terminal
    print("=" * 60)
    print("RESUMO ESTATISTICO")
    print("=" * 60)
    for scen in ("A", "B", "C", "D"):
        mean, lo, hi = bootstrap_ci(f1[scen])
        print(f"  {scen}: F1 = {mean:.3f} IC95% [{lo:.3f}; {hi:.3f}]")
    print()
    print(f"  Wilcoxon signed-rank C > D: W={stat_w:.1f}, p={p_w:.2e}")
    print(f"  Mann-Whitney U C > D:       U={stat_u:.1f}, p={p_u:.2e}")
    print(f"  Cliff's delta C vs D:       {delta_cd:.3f} ({mag_cd})")
    print(f"  Chi2 cobertura C vs D:      chi2={chi2:.3f}, p={p_chi2:.3f}")
    print()
    print(f"[gen] estatistica.md e estatistica.tex em {OUT}/")


if __name__ == "__main__":
    main()
