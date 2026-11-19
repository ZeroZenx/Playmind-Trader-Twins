"""Convert Polymarket public trades into raw OBSERVATIONAL tables for `npm run intake`.

A converter, not a derivation: it screens and samples wallets, then copies the sampled
wallets' fills, one row per wallet side, into raw tables. Merging fills into orders, stakes,
realized results, and outcome times (settled_at from the market's close_time) are derived by
intake's derive stage from the mapping config this script writes (ADR-017). The
outcome-timing diagnostic is computed by intake readiness (ADR-018).

Reads the Jan-Mar 2026 trade partitions fetched by analysis/download_holdout.py
(.data/polymarket/trades/...) and markets.parquet (.data/polymarket-meta/), and writes, all
under data/polymarket/ (gitignored):

- raw/fills.csv                     one row per wallet side of a fill (the events table)
- raw/markets.csv                   market ID and close time for the markets those fills touch
- mapping.json                      intake config: settled_at derived from close_time
- mapping-no-settlement.json        the same without settled_at (the behavior-0.2.0 assumption)
- extract-summary.json              counts, screen cutoffs, and the sample

Then run:

    npm run intake -- run --config data/polymarket/mapping.json --label OBSERVATIONAL

Definitions (converter version polymarket-twin-extract-0.2.0):

- Retail screen (thresholds from analysis/polymarket_loss_chasing.py), computed on orders
  inside the window, where an order is a wallet's fills grouped by (trade_id, prediction_id,
  direction, role), as in version 0.1.0: at least 30 orders, at least 5 active days, maker
  share below 0.80, at most 50 orders per active day. The per-day order files cached under
  .data/polymarket-orders/ are used for the screen only.
- Sample: eligible wallets ordered by SHA-256(seed + address), taken until --wallets wallets
  or --max-orders orders. Deterministic for a given seed. Same seed and caps as 0.1.0.
- Fills: each day's trade file is filtered to the sampled wallets on its own, one file at a
  time, and appended to raw/fills.csv. There is no join across days. Each raw fill appears
  once for its taker and once for its maker; the maker's direction is the opposite of the
  taker's on the same token. fill_ref is the day and the fill's row position in that day's
  file plus the role, so every row has its own ID. token_won is blank when the market had not
  resolved by the dataset end.

The data is public on-chain activity (vgregoire/polymarket-users, CC-BY 4.0). Wallet
addresses are pseudonymous; intake replaces them with HMAC tokens. Outputs are OBSERVATIONAL.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

import polars as pl

EXTRACT_VERSION = "polymarket-twin-extract-0.2.0"
LABEL = "OBSERVATIONAL"
WINDOW_START = "2026-01-01"
WINDOW_END = "2026-03-29"
OBSERVATION_END = "2026-03-30T00:00:00Z"
EXPECTED_DAYS = 31 + 28 + 29

MIN_ORDERS = 30
MIN_ACTIVE_DAYS = 5
MAX_MAKER_SHARE = 0.80
MAX_ORDERS_PER_ACTIVE_DAY = 50.0

DEFAULT_SEED = 20261115
DEFAULT_WALLETS = 2000
DEFAULT_MAX_ORDERS = 700_000

FILLS_NAME = "fills.csv"
MARKETS_NAME = "markets.csv"
FILL_COLUMNS = ["fill_ref", "wallet", "filled_at", "entry_type", "tx_hash", "token_id", "role", "side", "price", "quantity", "token_won", "market_id", "category"]


def day_files(data_dir: Path) -> list[Path]:
    return sorted((data_dir / "trades" / "year=2026").glob("month=*/day=*/data.parquet"))


def day_name(path: Path) -> str:
    return f"2026-{path.parent.parent.name.split('=')[1]}-{path.parent.name.split('=')[1]}"


def clean_fills(path: Path) -> pl.LazyFrame:
    return pl.scan_parquet(str(path), hive_partitioning=False).with_row_index("position").filter(
        pl.col("price").is_finite() & (pl.col("price") > 0) & (pl.col("price") < 1)
        & pl.col("quantity").is_finite() & (pl.col("quantity") > 0)
    )


def orders_for_day(path: Path) -> pl.DataFrame:
    """For the screen only: one row per (wallet, trade_id, prediction_id, bought, role) for one day file."""

    fills = clean_fills(path).select("trade_id", "timestamp", "prediction_id", "maker_address", "taker_address", "taker_bought")
    taker = fills.select("trade_id", "timestamp", "prediction_id", pl.col("taker_address").alias("wallet"), pl.col("taker_bought").alias("bought"), pl.lit("taker").alias("role"))
    maker = fills.select("trade_id", "timestamp", "prediction_id", pl.col("maker_address").alias("wallet"), (~pl.col("taker_bought")).alias("bought"), pl.lit("maker").alias("role"))
    sides = pl.concat([taker, maker]).filter(pl.col("wallet").is_not_null() & pl.col("bought").is_not_null())
    return sides.group_by("wallet", "trade_id", "prediction_id", "bought", "role").agg(pl.col("timestamp").min()).collect()


def build_screen_cache(files: list[Path], cache_dir: Path) -> list[Path]:
    """Per-day order files for the screen. A cache written by version 0.1.0 has the columns the screen reads."""

    cache_dir.mkdir(parents=True, exist_ok=True)
    outputs = []
    for index, path in enumerate(files, start=1):
        target = cache_dir / f"orders-{day_name(path)}.parquet"
        if not target.exists():
            temporary = target.with_suffix(".tmp")
            orders_for_day(path).write_parquet(temporary)
            temporary.replace(target)
        outputs.append(target)
        print(f"screen cache {index}/{len(files)} {target.name}", flush=True)
    return outputs


def wallet_stats(order_files: list[Path]) -> pl.DataFrame:
    return (
        pl.scan_parquet([str(path) for path in order_files])
        .group_by("wallet")
        .agg(
            pl.len().alias("orders"),
            pl.col("timestamp").dt.date().n_unique().alias("active_days"),
            (pl.col("role") == "maker").mean().alias("maker_share"),
        )
        .with_columns((pl.col("orders") / pl.col("active_days")).alias("orders_per_active_day"))
        .collect(engine="streaming")
    )


def sample_wallets(eligible: pl.DataFrame, seed: int, wallets: int, max_orders: int) -> pl.DataFrame:
    keyed = eligible.with_columns(
        pl.col("wallet").map_elements(lambda value: hashlib.sha256(f"{seed}:{value}".encode()).hexdigest(), return_dtype=pl.String).alias("sample_key")
    ).sort("sample_key")
    keyed = keyed.with_columns(pl.col("orders").cum_sum().alias("cumulative_orders"))
    picked = keyed.filter((pl.int_range(pl.len()) < wallets) & (pl.col("cumulative_orders") <= max_orders))
    return picked.select("wallet", "orders")


def fills_for_day(path: Path, wallets: pl.DataFrame) -> pl.DataFrame:
    """The sampled wallets' fills in one day file, one row per wallet side. No other file is read."""

    day = day_name(path)
    fills = clean_fills(path).select(
        "position", "trade_id", "timestamp", "market_id", "prediction_id", "winner", "category",
        "price", "quantity", "maker_address", "taker_address", "taker_bought",
    )
    common = ["position", "trade_id", "timestamp", "market_id", "prediction_id", "winner", "category", "price", "quantity"]
    taker = fills.select(*common, pl.col("taker_address").alias("wallet"), pl.col("taker_bought").alias("bought"), pl.lit("taker").alias("role"))
    maker = fills.select(*common, pl.col("maker_address").alias("wallet"), (~pl.col("taker_bought")).alias("bought"), pl.lit("maker").alias("role"))
    sides = (
        pl.concat([taker, maker])
        .filter(pl.col("wallet").is_not_null() & pl.col("bought").is_not_null())
        .join(wallets.lazy().select("wallet"), on="wallet", how="semi")
    )
    return sides.select(
        (pl.lit(f"{day}:") + pl.col("position").cast(pl.String) + ":" + pl.col("role").str.slice(0, 1)).alias("fill_ref"),
        "wallet",
        pl.col("timestamp").dt.strftime("%Y-%m-%dT%H:%M:%S%.3fZ").alias("filled_at"),
        pl.lit("FILL").alias("entry_type"),
        pl.col("trade_id").alias("tx_hash"),
        pl.col("prediction_id").alias("token_id"),
        "role",
        pl.when(pl.col("bought")).then(pl.lit("buy")).otherwise(pl.lit("sell")).alias("side"),
        "price",
        "quantity",
        pl.when(pl.col("winner").is_null()).then(pl.lit("")).when(pl.col("winner")).then(pl.lit("true")).otherwise(pl.lit("false")).alias("token_won"),
        pl.col("market_id").cast(pl.String),
        pl.col("category").fill_null("Uncategorized"),
    ).sort("filled_at", "fill_ref").collect()


def mapping_config(settlement: bool, wallets: int) -> dict:
    contract = {"price": "price", "quantity": "quantity", "side": "side", "buy": ["buy"], "sell": ["sell"]}
    derive = {
        "orders": [{"method": "order-id", "key": ["tx_hash", "token_id", "role", "side"]}],
        "stake_amount": [{"method": "contract-resolution", **contract}],
        "realized_result": [{"method": "contract-resolution", **contract, "won": "token_won"}],
    }
    if settlement:
        derive["settled_at"] = [{"method": "market-settlement", "join": "market", "attribute": "close_time"}]
    name = "polymarket-2026q1" if settlement else "polymarket-2026q1-no-settlement"
    return {
        "name": name,
        "label": LABEL,
        "description": f"{LABEL} Polymarket public fills, {WINDOW_START} to {WINDOW_END}, {wallets} retail-screened wallets ({EXTRACT_VERSION}). "
        + ("settled_at from the market close time." if settlement else "No settled_at: outcomes assumed known before the next trade."),
        "venueId": "polymarket",
        "observationEnd": OBSERVATION_END,
        "tables": {
            "fills": {
                "role": "events",
                "input": f"raw/{FILLS_NAME}",
                "source": {"format": "csv", "commentPrefix": "#"},
                "trader": {"column": "wallet", "tokenPrefix": "pm_", "tokenHexLength": 16, "caseSensitive": False},
                "eventId": {"column": "fill_ref"},
                "timestamp": {"column": "filled_at", "timezone": "UTC", "format": "iso"},
                "eventType": {"column": "entry_type", "values": {"FILL": "trade"}, "caseSensitive": False},
                "fields": {
                    "side": {"column": "side"},
                    "market_id": {"column": "market_id"},
                    "market_type": {"column": "category"},
                    "price": {"column": "price"},
                    "quantity": {"column": "quantity"},
                },
                "attributes": {
                    "tx_hash": {"column": "tx_hash", "kind": "key"},
                    "token_id": {"column": "token_id", "kind": "key"},
                    "role": {"column": "role", "kind": "key"},
                    "side": {"column": "side", "kind": "key"},
                    "price": {"column": "price", "kind": "number"},
                    "quantity": {"column": "quantity", "kind": "number"},
                    "token_won": {"column": "token_won", "kind": "boolean"},
                    "market_key": {"column": "market_id", "kind": "key"},
                },
                "excludeRows": [],
                "dropExactDuplicates": False,
            },
            "markets": {
                "role": "lookup",
                "input": f"raw/{MARKETS_NAME}",
                "source": {"format": "csv", "commentPrefix": "#"},
                "key": "market_key",
                "timezone": "UTC",
                "attributes": {
                    "market_key": {"column": "market_id", "kind": "key"},
                    "close_time": {"column": "close_time", "kind": "timestamp"},
                },
            },
        },
        "joins": {"market": {"from": "fills.market_key", "to": "markets.market_key"}},
        "derive": derive,
    }


def quantiles(frame: pl.DataFrame, column: str) -> dict:
    series = frame.get_column(column).drop_nulls()
    if series.is_empty():
        return {}
    return {f"p{int(q * 100)}": float(series.quantile(q, "linear")) for q in (0.5, 0.9, 0.99)}


def header(what: str) -> str:
    return (
        f"# {LABEL} public data ({EXTRACT_VERSION}): Polymarket {what}, {WINDOW_START} to {WINDOW_END} UTC, "
        f"from vgregoire/polymarket-users (CC-BY 4.0). Not customer data. Built by analysis/polymarket_twin_extract.py.\n"
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--data-dir", type=Path, default=Path(".data/polymarket"))
    parser.add_argument("--markets", type=Path, default=Path(".data/polymarket-meta/markets.parquet"))
    parser.add_argument("--cache-dir", type=Path, default=Path(".data/polymarket-orders"))
    parser.add_argument("--out", type=Path, default=Path("data/polymarket"))
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument("--wallets", type=int, default=DEFAULT_WALLETS)
    parser.add_argument("--max-orders", type=int, default=DEFAULT_MAX_ORDERS)
    parser.add_argument("--allow-partial", action="store_true", help="run on however many day files are present (for a smoke test)")
    args = parser.parse_args()

    files = day_files(args.data_dir)
    if len(files) != EXPECTED_DAYS and not args.allow_partial:
        raise SystemExit(f"found {len(files)} of {EXPECTED_DAYS} trade day files under {args.data_dir}; run analysis/download_holdout.py --kind trades, or pass --allow-partial")
    if not args.markets.exists():
        raise SystemExit(f"missing {args.markets}; download markets.parquet from the dataset first")

    stats = wallet_stats(build_screen_cache(files, args.cache_dir))
    eligible = stats.filter(
        (pl.col("orders") >= MIN_ORDERS)
        & (pl.col("active_days") >= MIN_ACTIVE_DAYS)
        & (pl.col("maker_share") < MAX_MAKER_SHARE)
        & (pl.col("orders_per_active_day") <= MAX_ORDERS_PER_ACTIVE_DAY)
    )
    picked = sample_wallets(eligible, args.seed, args.wallets, args.max_orders)
    print(f"wallets {stats.height}, eligible {eligible.height}, sampled {picked.height}", flush=True)

    raw = args.out / "raw"
    raw.mkdir(parents=True, exist_ok=True)
    fills_path = raw / FILLS_NAME
    rows = 0
    resolved = 0
    markets_seen: set[str] = set()
    by_role = {"taker": 0, "maker": 0}
    with fills_path.open("w", encoding="utf-8", newline="") as handle:
        handle.write(header("on-chain fills, one row per wallet side"))
        handle.write(",".join(FILL_COLUMNS) + "\n")
        for index, path in enumerate(files, start=1):
            day = fills_for_day(path, picked)
            if day.height:
                day.write_csv(handle, include_header=False)
            rows += day.height
            resolved += int((day["token_won"] != "").sum())
            markets_seen.update(value for value in day["market_id"].unique().to_list() if value is not None)
            for role, count in day.group_by("role").len().iter_rows():
                by_role[role] += count
            print(f"fills {index}/{len(files)} {day_name(path)}: {day.height} rows", flush=True)

    markets = (
        pl.read_parquet(args.markets, columns=["market_id", "close_time"])
        .with_columns(pl.col("market_id").cast(pl.String))
        .filter(pl.col("market_id").is_in(sorted(markets_seen)))
        .select("market_id", pl.col("close_time").dt.strftime("%Y-%m-%dT%H:%M:%S%.3fZ").alias("close_time"))
        .sort("market_id")
    )
    with (raw / MARKETS_NAME).open("w", encoding="utf-8", newline="") as handle:
        handle.write(header("market close times"))
        markets.write_csv(handle)

    for settlement, file_name in ((True, "mapping.json"), (False, "mapping-no-settlement.json")):
        (args.out / file_name).write_text(json.dumps(mapping_config(settlement, picked.height), indent=2) + "\n", encoding="utf-8")

    summary = {
        "label": LABEL,
        "extractVersion": EXTRACT_VERSION,
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": "vgregoire/polymarket-users trades + markets.parquet",
        "window": {"start": WINDOW_START, "end": WINDOW_END, "dayFiles": len(files), "expectedDayFiles": EXPECTED_DAYS, "partial": len(files) != EXPECTED_DAYS},
        "screen": {
            "minOrders": MIN_ORDERS, "minActiveDays": MIN_ACTIVE_DAYS,
            "maxMakerShareExclusive": MAX_MAKER_SHARE, "maxOrdersPerActiveDay": MAX_ORDERS_PER_ACTIVE_DAY,
            "wallets": stats.height, "eligibleWallets": eligible.height,
            "quantilesAllWallets": {column: quantiles(stats, column) for column in ("orders", "active_days", "orders_per_active_day", "maker_share")},
        },
        "sample": {"seed": args.seed, "walletCap": args.wallets, "orderCap": args.max_orders, "wallets": picked.height, "screenOrders": int(picked["orders"].sum())},
        "fills": {"rows": rows, "resolvedRows": resolved, "byRole": by_role, "markets": len(markets_seen), "marketsWithCloseTime": int(markets["close_time"].is_not_null().sum())},
        "note": "Orders, stakes, results, and outcome times are derived by intake from mapping.json; the outcome-timing share is in intake readiness.",
    }
    (args.out / "extract-summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: summary[key] for key in ("window", "sample", "fills")}, indent=2))


if __name__ == "__main__":
    main()
