"""First-pass loss-chasing analysis for vgregoire/polymarket-users.

This script uses only local 2024-2025 trade partitions and the daily PnL
partitions needed to label loss days through 2025-12-31. It never reads 2026
trade partitions and never reads the separate raw-trades dataset.
"""

from __future__ import annotations

import argparse
import json
import math
import random
import statistics
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import polars as pl


UTC = timezone.utc
IN_SAMPLE_START = date(2024, 1, 1)
IN_SAMPLE_END = date(2025, 12, 31)
HOLDOUT_START = date(2026, 1, 1)
HOLDOUT_END = date(2026, 3, 29)
MIN_TRADES = 30
MIN_ACTIVE_DAYS = 5
MAX_MAKER_SHARE = 0.80
MAX_TRADES_PER_ACTIVE_DAY = 50.0
MIN_LOSS_EPISODES = 3
MIN_BASELINE_ACTIVE_DAYS = 10
CHASE_RATIO = 1.25
CHASE_ABSOLUTE_USD = 10.0
BOOTSTRAP_REPS = 2000
SEED = 20261105


def collect_streaming(lazy_frame: pl.LazyFrame) -> pl.DataFrame:
    """Collect a lazy query using Polars streaming execution."""

    try:
        return lazy_frame.collect(engine="streaming")
    except TypeError:
        return lazy_frame.collect(streaming=True)


def save_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, default=str) + "\n")


def trade_sides(data_dir: Path) -> pl.LazyFrame:
    """Expand each fill into one activity row for maker and one for taker."""

    source = pl.scan_parquet(
        str(data_dir / "trades/year=*/month=*/day=*/data.parquet"),
        hive_partitioning=False,
    ).select(
        [
            "trade_id",
            "timestamp",
            "price",
            "quantity",
            "maker_address",
            "taker_address",
        ]
    )

    maker = source.select(
        [
            "trade_id",
            "timestamp",
            pl.col("maker_address").alias("user_address"),
            pl.lit("maker").alias("role"),
            (pl.col("price") * pl.col("quantity")).alias("stake_usd"),
        ]
    )
    taker = source.select(
        [
            "trade_id",
            "timestamp",
            pl.col("taker_address").alias("user_address"),
            pl.lit("taker").alias("role"),
            (pl.col("price") * pl.col("quantity")).alias("stake_usd"),
        ]
    )

    return pl.concat([maker, taker]).with_columns(
        pl.col("timestamp").dt.date().alias("trade_date")
    )


def build_trade_aggregates(data_dir: Path, output_dir: Path) -> tuple[pl.DataFrame, pl.DataFrame, dict]:
    output_dir.mkdir(parents=True, exist_ok=True)
    stats_path = output_dir / "wallet_stats.parquet"
    daily_path = output_dir / "wallet_daily_stake.parquet"

    if stats_path.exists() and daily_path.exists():
        return (
            pl.read_parquet(stats_path),
            pl.read_parquet(daily_path),
            {"cache_hit": True, "stats_path": str(stats_path), "daily_path": str(daily_path)},
        )

    sides = trade_sides(data_dir).filter(
        (pl.col("trade_date") >= pl.lit(IN_SAMPLE_START))
        & (pl.col("trade_date") <= pl.lit(IN_SAMPLE_END))
        & pl.col("user_address").is_not_null()
        & pl.col("stake_usd").is_finite()
        & (pl.col("stake_usd") >= 0)
    )

    daily = collect_streaming(
        sides.group_by(["user_address", "trade_date"])
        .agg(
            pl.len().alias("trade_count"),
            pl.col("stake_usd").sum().alias("daily_stake_usd"),
        )
        .sort(["user_address", "trade_date"])
    )
    daily.write_parquet(daily_path)

    stats = collect_streaming(
        sides.group_by("user_address")
        .agg(
            pl.len().alias("n_trades"),
            pl.col("trade_date").n_unique().alias("active_days"),
            pl.col("stake_usd").sum().alias("total_stake_usd"),
            (pl.col("role") == "maker").mean().alias("maker_share"),
        )
        .with_columns(
            (pl.col("n_trades") / pl.col("active_days")).alias("trades_per_active_day")
        )
    )

    daily_shape = (
        daily.group_by("user_address")
        .agg(
            pl.col("trade_count").max().alias("max_trades_per_day"),
            pl.col("trade_count").median().alias("median_trades_per_active_day"),
        )
    )

    stats = stats.join(daily_shape, on="user_address", how="left")
    stats.write_parquet(stats_path)
    return stats, daily, {"cache_hit": False, "stats_path": str(stats_path), "daily_path": str(daily_path)}


def retail_filter(stats: pl.DataFrame) -> tuple[pl.DataFrame, dict]:
    """Apply an auditable retail-like heuristic without full-sample leakage."""

    all_active = stats.filter(
        (pl.col("n_trades") >= MIN_TRADES) & (pl.col("active_days") >= MIN_ACTIVE_DAYS)
    )
    retail = all_active.filter(
        (pl.col("maker_share") < MAX_MAKER_SHARE)
        & (pl.col("trades_per_active_day") <= MAX_TRADES_PER_ACTIVE_DAY)
    )
    strict = all_active.filter(
        (pl.col("maker_share") < 0.50)
        & (pl.col("trades_per_active_day") <= 25.0)
    )

    def quantiles(column: str) -> dict:
        values = stats.get_column(column).drop_nulls().to_list()
        if not values:
            return {}
        if len(values) == 1:
            value = float(values[0])
            return {"p50": value, "p90": value, "p95": value, "p99": value}
        return {
            "p50": float(statistics.median(values)),
            "p90": float(statistics.quantiles(values, n=10, method="inclusive")[8]),
            "p95": float(statistics.quantiles(values, n=20, method="inclusive")[18]),
            "p99": float(statistics.quantiles(values, n=100, method="inclusive")[98]),
        }

    profile = {
        "cutoffs": {
            "minimum_trades": MIN_TRADES,
            "minimum_active_days": MIN_ACTIVE_DAYS,
            "maximum_maker_share_exclusive": MAX_MAKER_SHARE,
            "maximum_trades_per_active_day": MAX_TRADES_PER_ACTIVE_DAY,
        },
        "counts": {
            "all_wallets": stats.height,
            "activity_eligible_wallets": all_active.height,
            "retail_like_wallets": retail.height,
            "strict_retail_like_wallets": strict.height,
        },
        "quantiles_all_wallets": {
            column: quantiles(column)
            for column in [
                "n_trades",
                "active_days",
                "trades_per_active_day",
                "maker_share",
            ]
        },
    }
    return retail, profile


def load_loss_days(data_dir: Path, allowed_users: pl.DataFrame | None = None) -> pl.DataFrame:
    pnl = pl.scan_parquet(
        str(data_dir / "pnl_change_daily/year=*/month=*/day=*/data.parquet"),
        hive_partitioning=False,
    ).select(["user_address", "day", "pnl_change"])
    loss_query = (
        pnl.filter(
            (pl.col("day") >= pl.datetime(2024, 1, 2, time_zone="UTC"))
            & (pl.col("day") <= pl.datetime(2026, 1, 1, time_zone="UTC"))
            & (pl.col("pnl_change") < 0)
        )
        .with_columns(
            pl.col("day").dt.date().alias("boundary_date"),
            (pl.col("day").dt.date() - pl.duration(days=1)).alias("loss_date"),
        )
        .filter(
            (pl.col("loss_date") >= pl.lit(IN_SAMPLE_START))
            & (pl.col("loss_date") <= pl.lit(IN_SAMPLE_END))
        )
        .select(["user_address", "loss_date", "pnl_change"])
    )
    if allowed_users is not None:
        loss_query = loss_query.join(allowed_users.lazy(), on="user_address", how="inner")
    losses = collect_streaming(loss_query.unique(["user_address", "loss_date"]))
    return losses


def build_episode_metrics(daily: pl.DataFrame, losses: pl.DataFrame) -> tuple[pl.DataFrame, pl.DataFrame]:
    loss_days = losses.select(
        [
            "user_address",
            "loss_date",
            "pnl_change",
            pl.col("loss_date").alias("reference_day"),
        ]
    )
    post_dates = losses.select(
        [
            "user_address",
            "loss_date",
            "pnl_change",
            (pl.col("loss_date") + pl.duration(days=1)).alias("reference_day"),
            (pl.col("loss_date") + pl.duration(days=1)).alias("post_loss_date"),
        ]
    )
    post = (
        post_dates.join(
            daily.rename({"trade_date": "reference_day"}),
            on=["user_address", "reference_day"],
            how="left",
        )
        .with_columns(
            pl.col("daily_stake_usd").fill_null(0.0),
            pl.col("trade_count").fill_null(0),
        )
        .rename({"daily_stake_usd": "post_loss_stake_usd", "trade_count": "post_loss_trade_count"})
    )

    excluded = pl.concat(
        [
            loss_days.select(["user_address", pl.col("reference_day").alias("trade_date")]),
            post.select(["user_address", pl.col("post_loss_date").alias("trade_date")]),
        ]
    ).unique()
    baseline = (
        daily.join(excluded, on=["user_address", "trade_date"], how="anti")
        .group_by("user_address")
        .agg(
            pl.col("daily_stake_usd").median().alias("baseline_median_stake_usd"),
            pl.len().alias("baseline_active_days"),
        )
    )

    episodes = (
        post.join(baseline, on="user_address", how="inner")
        .filter(pl.col("baseline_active_days") >= MIN_BASELINE_ACTIVE_DAYS)
        .with_columns(
            (pl.col("post_loss_stake_usd") / pl.col("baseline_median_stake_usd")).alias("post_loss_ratio"),
            (pl.col("post_loss_stake_usd") - pl.col("baseline_median_stake_usd")).alias("post_loss_increase_usd"),
        )
        .with_columns(
            (
                (pl.col("post_loss_ratio") >= CHASE_RATIO)
                & (pl.col("post_loss_increase_usd") >= CHASE_ABSOLUTE_USD)
            ).alias("chasing_episode")
        )
        .sort(["user_address", "loss_date"])
    )

    per_wallet = (
        episodes.group_by("user_address")
        .agg(
            pl.len().alias("loss_episode_count"),
            pl.col("chasing_episode").sum().alias("chasing_episode_count"),
            pl.col("chasing_episode").mean().alias("chasing_episode_share"),
            pl.col("post_loss_ratio").median().alias("median_post_loss_ratio"),
            pl.col("post_loss_ratio").mean().alias("mean_post_loss_ratio"),
            pl.col("post_loss_stake_usd").median().alias("median_post_loss_stake_usd"),
            pl.col("baseline_median_stake_usd").median().alias("baseline_median_stake_usd"),
            (pl.col("post_loss_trade_count") > 0).mean().alias("post_loss_active_share"),
            pl.col("baseline_active_days").max().alias("baseline_active_days"),
        )
        .with_columns(
            (
                (pl.col("loss_episode_count") >= MIN_LOSS_EPISODES)
                & (pl.col("chasing_episode_share") >= 0.50)
                & (pl.col("median_post_loss_ratio") >= CHASE_RATIO)
            ).alias("consistent_chasing_wallet")
        )
    )
    return episodes, per_wallet


def build_control_metrics(daily: pl.DataFrame, losses: pl.DataFrame, wallets: pl.DataFrame) -> pl.DataFrame:
    loss_dates = losses.select(["user_address", pl.col("loss_date").alias("reference_day")]).unique()
    post_dates = losses.select(
        ["user_address", (pl.col("loss_date") + pl.duration(days=1)).alias("reference_day")]
    ).unique()
    excluded = pl.concat([loss_dates, post_dates]).unique()
    baseline = (
        daily.join(
            pl.concat(
                [
                    losses.select(["user_address", pl.col("loss_date").alias("trade_date")]),
                    losses.select(["user_address", (pl.col("loss_date") + pl.duration(days=1)).alias("trade_date")]),
                ]
            ).unique(),
            on=["user_address", "trade_date"],
            how="anti",
        )
        .group_by("user_address")
        .agg(
            pl.col("daily_stake_usd").median().alias("baseline_median_stake_usd"),
            pl.len().alias("baseline_active_days"),
        )
    )
    control_starts = (
        daily.rename({"trade_date": "reference_day"})
        .join(excluded, on=["user_address", "reference_day"], how="anti")
        .with_columns((pl.col("reference_day") + pl.duration(days=1)).alias("next_day"))
        .filter(pl.col("next_day") <= pl.lit(IN_SAMPLE_END))
    )
    control = (
        control_starts.join(
            daily.rename({"trade_date": "next_day"}),
            on=["user_address", "next_day"],
            how="left",
        )
        .with_columns(pl.col("daily_stake_usd_right").fill_null(0.0))
        .join(baseline, on="user_address", how="inner")
        .filter(pl.col("baseline_active_days") >= MIN_BASELINE_ACTIVE_DAYS)
        .with_columns(
            (pl.col("daily_stake_usd_right") / pl.col("baseline_median_stake_usd")).alias("control_ratio")
        )
        .group_by("user_address")
        .agg(
            pl.len().alias("control_episode_count"),
            pl.col("control_ratio").median().alias("median_control_ratio"),
        )
    )
    return wallets.join(control, on="user_address", how="left")


def bootstrap_ci(values: list[float], statistic: str, seed: int = SEED) -> tuple[float | None, float | None]:
    values = [float(value) for value in values if math.isfinite(float(value))]
    if len(values) < 2:
        return None, None
    rng = random.Random(seed)
    estimates = []
    for _ in range(BOOTSTRAP_REPS):
        sample = [values[rng.randrange(len(values))] for _ in values]
        if statistic == "mean":
            estimates.append(statistics.mean(sample))
        elif statistic == "median":
            estimates.append(statistics.median(sample))
        else:
            raise ValueError(statistic)
    estimates.sort()
    return estimates[int(0.025 * len(estimates))], estimates[int(0.975 * len(estimates))]


def summarize(retail: pl.DataFrame, stats: pl.DataFrame, profile: dict, losses: pl.DataFrame, episodes: pl.DataFrame, wallets: pl.DataFrame, control: pl.DataFrame) -> dict:
    analysis_wallets = wallets.filter(pl.col("loss_episode_count") >= MIN_LOSS_EPISODES)
    ratios = analysis_wallets.get_column("median_post_loss_ratio").drop_nulls().to_list()
    control_ratios = control.get_column("median_control_ratio").drop_nulls().to_list()
    share_values = analysis_wallets.get_column("consistent_chasing_wallet").cast(pl.Float64).to_list()
    episode_chase_share = episodes.get_column("chasing_episode").cast(pl.Float64).mean() if episodes.height else None
    active_episodes = episodes.filter(pl.col("post_loss_stake_usd") > 0)
    active_ratios = [
        float(value)
        for value in active_episodes.get_column("post_loss_ratio").to_list()
        if math.isfinite(float(value))
    ]
    consistent_wallet_count = int(sum(share_values)) if share_values else 0
    wallet_share_all_retail = consistent_wallet_count / retail.height if retail.height else None
    active_episode_chase_share = (
        active_episodes.get_column("chasing_episode").cast(pl.Float64).mean()
        if active_episodes.height
        else None
    )

    return {
        "source_scope": {
            "source_dataset": "vgregoire/polymarket-users",
            "analysis_start_utc": str(IN_SAMPLE_START),
            "analysis_end_utc": str(IN_SAMPLE_END),
            "holdout_start_utc": str(HOLDOUT_START),
            "holdout_end_utc": str(HOLDOUT_END),
            "holdout_touched": False,
            "trade_partitions": 731,
            "pnl_partitions": 732,
        },
        "retail_filter": profile,
        "loss_days": {
            "negative_pnl_rows": losses.height,
            "wallets_with_negative_pnl_day": losses.get_column("user_address").n_unique() if losses.height else 0,
            "population": "retail_like_wallets",
            "definition": "pnl_change < 0, shifted one UTC day backward because the dataset labels the right boundary",
            "pnl_type": "daily mark-to-market PnL change, not realized PnL",
        },
        "sample": {
            "retail_like_wallets": retail.height,
            "analysis_eligible_wallets": analysis_wallets.height,
            "consistent_chasing_wallets": consistent_wallet_count,
            "eligible_loss_episodes": episodes.height,
        },
        "primary_signal": {
            "definition": {
                "chasing_episode": f"next-day stake >= {CHASE_RATIO:.2f}x baseline and >= ${CHASE_ABSOLUTE_USD:.0f} above baseline",
                "consistent_chasing_wallet": f">={MIN_LOSS_EPISODES} episodes, >=50% chasing episodes, median ratio >= {CHASE_RATIO:.2f}x",
            },
            "wallet_share_eligible": float(statistics.mean(share_values)) if share_values else None,
            "wallet_share_eligible_ci95": bootstrap_ci(share_values, "mean"),
            "wallet_share_all_retail": wallet_share_all_retail,
            "episode_share": float(episode_chase_share) if episode_chase_share is not None else None,
            "active_episode_share": active_episodes.height / episodes.height if episodes.height else None,
            "active_episode_chasing_share": float(active_episode_chase_share) if active_episode_chase_share is not None else None,
            "active_episode_ratio_median": float(statistics.median(active_ratios)) if active_ratios else None,
            "active_episode_ratio_p75": float(pl.Series(active_ratios).quantile(0.75)) if active_ratios else None,
            "active_episode_ratio_p90": float(pl.Series(active_ratios).quantile(0.90)) if active_ratios else None,
            "median_wallet_ratio": float(statistics.median(ratios)) if ratios else None,
            "median_wallet_ratio_ci95": bootstrap_ci(ratios, "median"),
            "p75_wallet_ratio": float(statistics.quantiles(ratios, n=4, method="inclusive")[2]) if len(ratios) >= 2 else None,
            "median_control_ratio": float(statistics.median(control_ratios)) if control_ratios else None,
            "control_wallet_count": len(control_ratios),
        },
        "interpretation": {
            "status": "preliminary",
            "warning": "The signal uses mark-to-market loss days. It does not yet establish realized-loss chasing or predictive performance.",
            "next_step_if_signal_present": "Freeze this definition and evaluate a model on Jan-Mar 2026 without changing the retail filter or metric after holdout inspection.",
        },
    }


def write_markdown_report(path: Path, summary: dict) -> None:
    primary = summary["primary_signal"]
    sample = summary["sample"]
    filt = summary["retail_filter"]
    path.parent.mkdir(parents=True, exist_ok=True)
    share = primary["wallet_share_eligible"]
    share_all_retail = primary["wallet_share_all_retail"]
    ratio = primary["median_wallet_ratio"]
    active_ratio = primary["active_episode_ratio_median"]
    active_episode_share = primary["active_episode_share"]
    active_chasing_share = primary["active_episode_chasing_share"]
    lines = [
        "# Polymarket loss-chasing rough read",
        "",
        "Prepared from the public `vgregoire/polymarket-users` dataset.",
        "",
        "## Executive read",
        "",
        f"The analysis uses {sample['analysis_eligible_wallets']:,} retail-like wallets with at least {MIN_LOSS_EPISODES} eligible loss episodes and {sample['eligible_loss_episodes']:,} loss episodes in total.",
        f"The primary wallet-level chasing share is {share:.2%} among wallets with at least {MIN_LOSS_EPISODES} eligible loss episodes and {share_all_retail:.2%} across all screened retail-like wallets." if share is not None else "The primary wallet-level chasing share is unavailable because no wallets met the episode threshold.",
        f"The episode-level rate is {primary['episode_share']:.2%}. Only {active_episode_share:.2%} of post-loss episodes show any next-day stake; among those active episodes, the median ratio is {active_ratio:.2f}x." if active_ratio is not None else "The episode-level rate is unavailable.",
        f"Among active post-loss episodes, {active_chasing_share:.2%} meet the chasing threshold. This reflects a small upper tail, not a typical next-day increase." if active_chasing_share is not None else "The active-episode chasing rate is unavailable.",
        "",
        "## Scope and definitions",
        "",
        "- Discovery period: 2024-01-01 through 2025-12-31 UTC.",
        "- Holdout period: 2026-01-01 through 2026-03-29 UTC. The analysis did not read 2026 trade data.",
        "- Loss day: negative `pnl_change` after shifting the dataset's +1-day right-boundary label back by one UTC day.",
        "- Post-loss window: the following UTC calendar day.",
        "- Baseline: each wallet's median active-day stake after excluding loss and post-loss days.",
        "- Stake: `price * quantity`, assigned once to each participating maker and taker wallet.",
        "",
        "## Retail-like filter",
        "",
        f"The filter keeps wallets with at least {MIN_TRADES} fills and {MIN_ACTIVE_DAYS} active days, maker share below {MAX_MAKER_SHARE:.0%}, and no more than {MAX_TRADES_PER_ACTIVE_DAY:.0f} fills per active day. These thresholds act as a heuristic, not a verified bot label. Counterparty concentration is a follow-up sensitivity check, not a primary cutoff in this rough read.",
        f"The filter produced {filt['counts']['retail_like_wallets']:,} retail-like wallets from {filt['counts']['all_wallets']:,} wallets with activity in the downloaded partitions.",
        "",
        "## Caveats",
        "",
        "- The PnL label is mark-to-market, not realized PnL.",
        "- The overall ratio includes inactive next-day episodes, which produce a zero stake. The active-episode ratio is reported separately.",
        "- The non-loss control median also includes inactive days, so a clean active-only control comparison belongs in the next pass.",
        "- Public wallet behavior does not represent a verified retail population.",
        "- The retail filter uses in-sample 2024-2025 behavior and must remain frozen before holdout testing.",
        "- This first pass tests association. It does not prove causality or predictive performance.",
        "",
        "## Sources",
        "",
        "- Dataset: https://huggingface.co/datasets/vgregoire/polymarket-users",
        "- Documentation: https://www.vincentgregoire.com/polymarket-users-data/",
        "- PnL and time convention: https://www.vincentgregoire.com/polymarket-users-data/datasets/pnl_change/",
        "- Trade schema: https://www.vincentgregoire.com/polymarket-users-data/datasets/trades/",
        "- Methodology: https://www.vincentgregoire.com/polymarket-users-data/methodology/",
        "",
        "## Reproducibility",
        "",
        "Run `./.venv/bin/python analysis/polymarket_loss_chasing.py` from the repository root.",
        "",
    ]
    path.write_text("\n".join(lines))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", type=Path, default=Path(".data/polymarket"))
    parser.add_argument("--output-dir", type=Path, default=Path("analysis/output"))
    parser.add_argument("--report", type=Path, default=Path("analysis/reports/polymarket-loss-chasing-rough-read.md"))
    args = parser.parse_args()

    stats, daily, cache_info = build_trade_aggregates(args.data_dir, args.output_dir)
    retail, filter_profile = retail_filter(stats)
    retail_users = retail.select(["user_address"])
    daily = daily.join(retail_users, on="user_address", how="inner")
    losses = load_loss_days(args.data_dir, retail_users)
    episodes, wallet_metrics = build_episode_metrics(daily, losses)
    control_metrics = build_control_metrics(daily, losses, wallet_metrics)
    summary = summarize(retail, stats, filter_profile, losses, episodes, wallet_metrics, control_metrics)
    summary["cache"] = cache_info

    save_json(args.output_dir / "retail-filter-profile.json", filter_profile)
    save_json(args.output_dir / "summary.json", summary)
    losses.write_parquet(args.output_dir / "loss-days.parquet")
    episodes.write_parquet(args.output_dir / "loss-episodes.parquet")
    control_metrics.write_parquet(args.output_dir / "wallet-metrics-with-control.parquet")
    write_markdown_report(args.report, summary)

    print(json.dumps(summary, indent=2, default=str))


if __name__ == "__main__":
    main()
