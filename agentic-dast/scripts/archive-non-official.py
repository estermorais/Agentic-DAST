#!/usr/bin/env python3
"""
archive-non-official.py
-----------------------------------------------------------------
Move para reports/_archive/ todos os JSONs em reports/ que NAO
estao referenciados no CSV oficial (_run-log.csv) com status='ok'.

Motivacao: o diretorio reports/ acumulou JSONs de fases de
setup/debug e de runs que falharam por rate limit / falta de
credito. Para o TCC queremos comparar exatamente n=30 por cenario,
usando apenas as execucoes oficiais bem sucedidas.

Efeitos:
  - Move JSONs 'extras' (nao no CSV OU no CSV com status != 'ok')
    para reports/_archive/
  - Nao mexe em _run-log.csv nem em nenhum outro arquivo
  - Idempotente: rodar duas vezes nao muda nada
-----------------------------------------------------------------
"""
from __future__ import annotations
import csv
import shutil
from pathlib import Path

REPORTS = Path(__file__).resolve().parent.parent / "reports"
CSV_PATH = REPORTS / "_run-log.csv"
ARCHIVE = REPORTS / "_archive"


def main() -> int:
    ARCHIVE.mkdir(exist_ok=True)

    # 1. Le CSV: coleta apenas report_file de runs com status='ok'
    official_ok = set()
    with CSV_PATH.open(encoding="utf-8") as f:
        for row in csv.DictReader(f):
            if row["status"] == "ok":
                name = row.get("report_file", "").strip()
                if name:
                    official_ok.add(name)

    print(f"[archive] runs oficiais (status=ok) no CSV: {len(official_ok)}")

    # 2. Lista JSONs no diretorio reports/ (ignora subpastas e _prefixed)
    all_jsons = [p for p in REPORTS.iterdir()
                 if p.is_file() and p.suffix == ".json"
                 and not p.name.startswith("_")]

    print(f"[archive] JSONs no diretorio: {len(all_jsons)}")

    # 3. Move os que nao estao na lista oficial
    moved = 0
    per_scen = {"A": 0, "B": 0, "C": 0, "D": 0, "?": 0}
    for path in all_jsons:
        if path.name not in official_ok:
            dst = ARCHIVE / path.name
            shutil.move(str(path), str(dst))
            moved += 1
            # Detecta cenario pelo prefixo
            if path.name.startswith("scenario-a"): per_scen["A"] += 1
            elif path.name.startswith("scenario-b"): per_scen["B"] += 1
            elif path.name.startswith("report-"): per_scen["C"] += 1
            elif path.name.startswith("scenario-d"): per_scen["D"] += 1
            else: per_scen["?"] += 1

    print(f"[archive] movidos para _archive/: {moved}")
    for scen, n in per_scen.items():
        if n > 0:
            print(f"       cenario {scen}: {n}")

    # 4. Verifica estado final
    remaining = [p for p in REPORTS.iterdir()
                 if p.is_file() and p.suffix == ".json"
                 and not p.name.startswith("_")]
    print(f"\n[archive] estado final:")
    counts = {"A": 0, "B": 0, "C": 0, "D": 0, "?": 0}
    for p in remaining:
        if p.name.startswith("scenario-a"): counts["A"] += 1
        elif p.name.startswith("scenario-b"): counts["B"] += 1
        elif p.name.startswith("report-"): counts["C"] += 1
        elif p.name.startswith("scenario-d"): counts["D"] += 1
        else: counts["?"] += 1
    for scen, n in counts.items():
        if n > 0:
            print(f"       {scen}: {n} reports")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
