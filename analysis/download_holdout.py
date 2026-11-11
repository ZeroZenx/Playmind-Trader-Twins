"""Download only the requested Jan-Mar 2026 holdout partitions.

This script targets the main vgregoire/polymarket-users dataset. It never
targets the separate 163GB raw-trades repository.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import urllib.request
from pathlib import Path


DATASET_URL = "https://huggingface.co/datasets/vgregoire/polymarket-users/resolve/main"
DATA_DIR = Path(".data/polymarket")
HOLDOUT_DATES = [f"2026-{month:02d}-{day:02d}" for month, last_day in ((1, 31), (2, 28), (3, 29)) for day in range(1, last_day + 1)]
PNL_DATES = [f"2026-{month:02d}-{day:02d}" for month, last_day in ((1, 31), (2, 28), (3, 30)) for day in range(1, last_day + 1)]


def partition_path(kind: str, day: str) -> str:
    year, month, date = day.split("-")
    return f"{kind}/year={year}/month={month}/day={date}/data.parquet"


def download(relative_path: str) -> tuple[str, int]:
    target = DATA_DIR / relative_path
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists() and target.stat().st_size > 0:
        return relative_path, target.stat().st_size
    url = f"{DATASET_URL}/{relative_path}?download=true"
    temporary = target.with_suffix(".download")
    try:
        urllib.request.urlretrieve(url, temporary)
        temporary.replace(target)
    finally:
        if temporary.exists():
            temporary.unlink()
    return relative_path, target.stat().st_size


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--kind", choices=["trades", "pnl", "both"], default="both")
    parser.add_argument("--workers", type=int, default=4)
    args = parser.parse_args()
    paths: list[str] = []
    if args.kind in {"trades", "both"}:
        paths.extend(partition_path("trades", day) for day in HOLDOUT_DATES)
    if args.kind in {"pnl", "both"}:
        paths.extend(partition_path("pnl_change_daily", day) for day in PNL_DATES)
    total = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as executor:
        for index, (relative_path, size) in enumerate(executor.map(download, paths), start=1):
            total += size
            print(f"[{index}/{len(paths)}] {relative_path} {size / 1024 / 1024:.1f} MiB", flush=True)
    print(f"Downloaded or reused {len(paths)} partitions totaling {total / 1024 / 1024 / 1024:.2f} GiB")


if __name__ == "__main__":
    main()
