#!/usr/bin/env python3
"""
fix-silent-failures.py
-----------------------------------------------------------------
Reprocessa o CSV de log de runs (_run-log.csv) marcando como
'failed' os runs que foram gravados como 'ok' mas que, pelas
metricas de duracao e findings, sao claramente falhas silenciosas.

Motivacao: o Cenario D, quando o Claude Code CLI bate rate limit
do plano Pro, retorna cedo com um summary.json que produz 0
findings em ~8 segundos. O extractor original (run_pentestgpt.py)
tratava isso como 'sucesso com 0 findings' e o runner marcava 'ok'.
Efeito: 13 dos 30 runs do D eram na verdade rate-limit failures
inflando artificialmente n=30 do D com dados invalidos.

Regras de reclassificacao:
  - Cenario D com duration_s < 20 E findings == 0 -> failed
  - Cenario A/B/C nunca se enquadram (nao ha caso analogo hoje)

Efeitos colaterais:
  - Reescreve _run-log.csv (backup em _run-log.csv.bak-<timestamp>)
  - Move os report JSONs dos runs reclassificados para reports/_archive/
    (assim o evaluate.ts nao os inclui na proxima agregacao).
-----------------------------------------------------------------
"""
from __future__ import annotations

import csv
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

REPORTS_DIR = Path(__file__).resolve().parent.parent / "reports"
CSV_PATH = REPORTS_DIR / "_run-log.csv"
ARCHIVE_DIR = REPORTS_DIR / "_archive"


def is_silent_failure(row: dict) -> bool:
    """Detecta rate limit disfarcado de sucesso no Cenario D.

    Runs bem sucedidos do D duram 130-520s e produzem 3-8 findings.
    Runs com rate limit do Claude Pro se enquadram em uma dessas duas
    assinaturas:
      1. Aborta cedo total: dur < 20s E findings == 0 (fail explicito
         do agente sem produzir summary util).
      2. Aborta cedo parcial: dur < 90s E findings <= 1 (rate limit no
         meio do primeiro attempt, agente registra um finding trivial
         mas nao chega a explorar). Foi o caso do run 4 na rodada
         oficial: dur=51.6s findings=1.
    """
    if row["scenario"] != "D":
        return False
    try:
        dur = float(row["duration_s"])
        findings = int(row["findings"])
    except (ValueError, KeyError):
        return False
    # Assinatura 1: aborta imediato
    if dur < 20 and findings == 0:
        return True
    # Assinatura 2: aborta apos primeiro attempt (~60-90s), 0 ou 1 finding
    if dur < 90 and findings <= 1:
        return True
    return False


def main() -> int:
    if not CSV_PATH.exists():
        print(f"CSV nao encontrado: {CSV_PATH}", file=sys.stderr)
        return 1

    # Backup
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup = CSV_PATH.with_suffix(f".csv.bak-{stamp}")
    shutil.copy2(CSV_PATH, backup)
    print(f"[fix] backup do CSV em: {backup.name}")

    ARCHIVE_DIR.mkdir(exist_ok=True)

    # Le, reclassifica, arquiva reports falhados
    with CSV_PATH.open(encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        rows = list(reader)
        fieldnames = reader.fieldnames

    reclassified = 0
    archived_reports: list[str] = []

    for row in rows:
        if row["status"] == "ok" and is_silent_failure(row):
            row["status"] = "failed"
            reclassified += 1
            # Arquiva o report vazio para nao poluir o evaluate
            report_name = row.get("report_file", "").strip()
            if report_name:
                src = REPORTS_DIR / report_name
                if src.exists():
                    dst = ARCHIVE_DIR / report_name
                    shutil.move(str(src), str(dst))
                    archived_reports.append(report_name)

    # Reescreve o CSV
    with CSV_PATH.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)

    print(f"[fix] runs reclassificados de ok -> failed: {reclassified}")
    print(f"[fix] reports movidos para _archive/: {len(archived_reports)}")
    if archived_reports:
        for name in archived_reports:
            print(f"       - {name}")

    # Sumario final
    counts: dict[tuple[str, str], int] = {}
    for r in rows:
        key = (r["scenario"], r["status"])
        counts[key] = counts.get(key, 0) + 1
    print("\n[fix] contagem final (scenario, status):")
    for (scen, stat), n in sorted(counts.items()):
        print(f"       {scen} {stat}: {n}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
