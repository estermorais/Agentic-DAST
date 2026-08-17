#!/usr/bin/env python3
"""
compare-findings-vs-gt.py
-----------------------------------------------------------------
Compara os findings de UM relatorio do agente contra uma Matriz de
Ground Truth preenchida pelo red team para o alvo de producao.

Calcula:
  - TP, FP, FN
  - Precisao, Recall, F1
  - Cobertura acumulada (fracao do GT redescoberta)
  - Findings potencialmente NOVOS (nao estavam no GT — podem ser
    vulnerabilidades reais nao conhecidas OU falsos positivos)

Uso:
  python3 scripts/compare-findings-vs-gt.py <report.json> <ground-truth.json>

Onde:
  <report.json>       relatorio gerado pelo production-runner, em
                      reports/report-production-<timestamp>.json
  <ground-truth.json> arquivo ground-truth-target-filled.json, com base
                      no template em src/production-mode/

Saida vai para stdout em formato texto. Se quiser JSON estruturado
para agregacao posterior, use a flag --json.

Este script eh o mesmo classify.ts usado no TCC 2 do Juice Shop,
adaptado para consumir Ground Truth no formato de producao.
-----------------------------------------------------------------
"""
from __future__ import annotations
import argparse
import json
import re
import sys
import unicodedata
from pathlib import Path


def normalize(s: str) -> str:
    """Diacritic-insensitive lowercase, espelha classify.ts."""
    if not s:
        return ""
    nfd = unicodedata.normalize("NFD", s.lower())
    return "".join(c for c in nfd if unicodedata.category(c) != "Mn")


CONFIG_KEYWORDS = [
    "content security policy", "csp", "x-frame-options", "clickjacking",
    "x-content-type-options", "hsts", "strict-transport-security",
    "cors", "cross-origin", "cookie", "samesite", "httponly",
    "server header", "server version", "x-powered-by",
    "timestamp disclosure", "modernizr", "jquery", "angular",
    "lib version", "outdated", "cache-control",
]


def is_configurational(finding: dict) -> bool:
    text = normalize(f"{finding.get('title','')} {finding.get('description','')}")
    return any(kw in text for kw in CONFIG_KEYWORDS)


def infer_category(cat: str, title: str) -> str:
    canon = (cat or "").upper().replace(" ", "_").replace("-", "_")
    title_n = normalize(title)
    if canon in {"SQL_INJECTION", "SQLI"}: return "SQL_INJECTION"
    if "sql inject" in title_n or "sqli" in title_n: return "SQL_INJECTION"
    if canon == "JWT" or "jwt" in title_n or "json web token" in title_n: return "JWT"
    if canon == "XSS" or " xss" in title_n or "cross-site scripting" in title_n: return "XSS"
    if canon in {"BROKEN_ACCESS_CONTROL", "AUTHORIZATION"}: return "BROKEN_ACCESS_CONTROL"
    if canon in {"SENSITIVE_DATA_EXPOSURE", "INFORMATION_DISCLOSURE"}:
        return "SENSITIVE_DATA_EXPOSURE"
    if canon in {"BUSINESS_LOGIC", "BUSINESS_LOGIC_VULNERABILITY"}: return "BUSINESS_LOGIC"
    if "bypass" in title_n or "access control" in title_n: return "BROKEN_ACCESS_CONTROL"
    if "disclosure" in title_n or "exposed" in title_n: return "SENSITIVE_DATA_EXPOSURE"
    return "OTHER"


SPECIFIC_MIN = 12


def classify(findings: list[dict], gt: list[dict]) -> dict:
    matched_gt_ids: set[str] = set()
    tps: list[dict] = []
    fps: list[dict] = []
    config_findings: list[dict] = []

    for f in findings:
        if is_configurational(f):
            config_findings.append(f)
            continue

        inferred_cat = infer_category(f.get("category", ""), f.get("title", ""))
        text = normalize(
            f"{f.get('title','')} {f.get('description','')} {f.get('evidence','')}"
        )

        candidates = []
        for entry in gt:
            if entry["id"] in matched_gt_ids:
                continue
            kws = entry.get("detectionKeywords", [])
            matched_kws = [kw for kw in kws if normalize(kw) in text]
            if not matched_kws:
                continue
            has_specific = any(len(kw) >= SPECIFIC_MIN for kw in matched_kws)
            if entry["category"] != inferred_cat and not has_specific:
                continue
            hint = entry.get("endpointHint", "")
            if hint and not has_specific and normalize(hint) not in text:
                continue
            candidates.append(entry)

        if candidates:
            for c in candidates:
                matched_gt_ids.add(c["id"])
                tps.append({
                    "finding_title": f.get("title", "?"),
                    "matched_gt_id": c["id"],
                    "matched_gt_name": c.get("vulnerability_name", c.get("challengeName", "?")),
                    "gt_category": c["category"],
                    "gt_status": c.get("status", "unknown"),
                })
        else:
            fps.append({
                "title": f.get("title", "?"),
                "category": inferred_cat,
                "severity": f.get("severity", "?"),
                "description": (f.get("description") or "")[:150],
            })

    fns = [g for g in gt if g["id"] not in matched_gt_ids]
    return {
        "tp": tps,
        "fp": fps,
        "fn": fns,
        "config": config_findings,
    }


def compute_metrics(result: dict, gt_total: int) -> dict:
    tp = len(result["tp"])
    fp = len(result["fp"])
    fn = len(result["fn"])
    precision = tp / (tp + fp) if (tp + fp) > 0 else 0.0
    recall = tp / (tp + fn) if (tp + fn) > 0 else 0.0
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) > 0 else 0.0
    coverage = tp / gt_total if gt_total > 0 else 0.0
    return {
        "tp_count": tp,
        "fp_count": fp,
        "fn_count": fn,
        "config_count": len(result["config"]),
        "precision": round(precision, 3),
        "recall": round(recall, 3),
        "f1": round(f1, 3),
        "coverage": round(coverage, 3),
    }


def print_report(result: dict, metrics: dict, meta: dict) -> None:
    line = "=" * 72
    print(line)
    print("COMPARACAO: findings do agente vs. Ground Truth do alvo")
    print(line)
    if meta:
        print(f"Alvo (tipo)          : {meta.get('target_type', '?')}")
        print(f"Stack                : {meta.get('target_stack', '?')}")
        print(f"GT fonte             : {meta.get('gt_source', '?')}")
        print(f"GT congelado em      : {meta.get('gt_frozen_at', '?')}")
    print()
    print("METRICAS")
    print("-" * 72)
    print(f"  True Positives      : {metrics['tp_count']}")
    print(f"  False Positives     : {metrics['fp_count']}")
    print(f"  False Negatives     : {metrics['fn_count']}")
    print(f"  Alertas config      : {metrics['config_count']} (segregados, nao contam)")
    print(f"  Precision           : {metrics['precision']:.3f}")
    print(f"  Recall              : {metrics['recall']:.3f}")
    print(f"  F1-score            : {metrics['f1']:.3f}")
    print(f"  Cobertura acumulada : {metrics['coverage']:.3f}  ({metrics['tp_count']}/{metrics['tp_count']+metrics['fn_count']})")
    print()

    if result["tp"]:
        print(f"TRUE POSITIVES ({len(result['tp'])})  — vulnerabilidades do GT redescobertas:")
        print("-" * 72)
        for tp in result["tp"]:
            print(f"  [{tp['matched_gt_id']}] {tp['matched_gt_name']}")
            print(f"     encontrado via  : {tp['finding_title'][:80]}")
            print(f"     categoria GT    : {tp['gt_category']} (status: {tp['gt_status']})")
        print()

    if result["fn"]:
        print(f"FALSE NEGATIVES ({len(result['fn'])})  — vulnerabilidades do GT que o agente NAO detectou:")
        print("-" * 72)
        for fn in result["fn"]:
            print(f"  [{fn['id']}] {fn.get('vulnerability_name', fn.get('challengeName', '?'))}")
            print(f"     categoria        : {fn['category']}")
            print(f"     endpoint         : {fn.get('endpoint', '?')}")
        print()

    if result["fp"]:
        print(f"POTENCIAIS NOVOS ({len(result['fp'])})  — findings do agente que nao casaram com GT:")
        print("-" * 72)
        print("  Podem ser: (a) vulnerabilidades reais nao conhecidas antes,")
        print("             (b) falsos positivos do agente,")
        print("             (c) padroes que o classificador nao reconheceu.")
        print("  Recomenda-se revisar manualmente cada um.")
        print()
        for fp in result["fp"]:
            print(f"  [{fp['severity']}] {fp['title'][:80]}")
            print(f"     categoria inferida: {fp['category']}")
            print(f"     descricao         : {fp['description']}")
        print()

    print(line)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("report", type=Path, help="reports/report-production-*.json")
    ap.add_argument("ground_truth", type=Path, help="ground-truth-target-filled.json")
    ap.add_argument("--json", action="store_true", help="saida em JSON estruturado")
    args = ap.parse_args()

    if not args.report.exists():
        print(f"[erro] report nao encontrado: {args.report}", file=sys.stderr)
        return 1
    if not args.ground_truth.exists():
        print(f"[erro] ground truth nao encontrado: {args.ground_truth}", file=sys.stderr)
        return 1

    report_data = json.loads(args.report.read_text(encoding="utf-8"))
    gt_data = json.loads(args.ground_truth.read_text(encoding="utf-8"))

    findings = report_data.get("findings", [])
    gt_entries = gt_data.get("entries", [])
    meta = gt_data.get("_meta", {})

    if not gt_entries:
        print("[erro] ground truth vazio ou sem chave 'entries'", file=sys.stderr)
        return 1

    result = classify(findings, gt_entries)
    metrics = compute_metrics(result, len(gt_entries))

    if args.json:
        out = {
            "meta": meta,
            "metrics": metrics,
            "tp": result["tp"],
            "fp": result["fp"],
            "fn": [
                {"id": fn["id"], "name": fn.get("vulnerability_name", "?"), "category": fn["category"]}
                for fn in result["fn"]
            ],
        }
        print(json.dumps(out, indent=2, ensure_ascii=False))
    else:
        print_report(result, metrics, meta)

    return 0


if __name__ == "__main__":
    sys.exit(main())
