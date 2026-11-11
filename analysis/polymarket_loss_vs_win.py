"""Compare next-day stake after losing days with next-day stake after winning days.

This pass reuses the frozen retail screen and the 159,666 loss-eligible wallets
from the first pass. It reads only in-sample 2024-2025 trade and PnL partitions.
It never reads 2026 trade partitions or the separate raw-trades dataset.
"""

from __future__ import annotations

import argparse
import json
import math
import statistics
from pathlib import Path

import polars as pl

from polymarket_loss_chasing import (
    BOOTSTRAP_REPS,
    CHASE_ABSOLUTE_USD,
    CHASE_RATIO,
    IN_SAMPLE_END,
    IN_SAMPLE_START,
    MIN_BASELINE_ACTIVE_DAYS,
    HOLDOUT_END,
    HOLDOUT_START,
    build_trade_aggregates,
    collect_streaming,
    retail_filter,
    save_json,
    bootstrap_ci,
)


LOSS_VS_WIN_TOLERANCE = 0.10


def finite_values(frame: pl.DataFrame, column: str) -> list[float]:
    return [
        float(value)
        for value in frame.get_column(column).drop_nulls().to_list()
        if math.isfinite(float(value))
    ]


def load_win_days(
    data_dir: Path,
    allowed_users: pl.DataFrame,
    output_path: Path,
) -> pl.DataFrame:
    if output_path.exists():
        return pl.read_parquet(output_path)

    pnl = pl.scan_parquet(
        str(data_dir / "pnl_change_daily/year=*/month=*/day=*/data.parquet"),
        hive_partitioning=False,
    ).select(["user_address", "day", "pnl_change"])
    win_query = (
        pnl.filter(
            (pl.col("day") >= pl.datetime(2024, 1, 2, time_zone="UTC"))
            & (pl.col("day") <= pl.datetime(2026, 1, 1, time_zone="UTC"))
            & (pl.col("pnl_change") > 0)
        )
        .with_columns(
            (pl.col("day").dt.date() - pl.duration(days=1)).alias("win_date")
        )
        .filter(
            (pl.col("win_date") >= pl.lit(IN_SAMPLE_START))
            & (pl.col("win_date") <= pl.lit(IN_SAMPLE_END))
        )
        .select(["user_address", "win_date", "pnl_change"])
        .join(allowed_users.lazy(), on="user_address", how="inner")
    )
    wins = collect_streaming(win_query.unique(["user_address", "win_date"]))
    output_path.parent.mkdir(parents=True, exist_ok=True)
    wins.write_parquet(output_path)
    return wins


def standardize_outcome_days(days: pl.DataFrame, outcome: str, date_column: str) -> pl.DataFrame:
    return days.select(
        [
            "user_address",
            pl.col(date_column).alias("outcome_date"),
            "pnl_change",
            pl.lit(outcome).alias("outcome"),
        ]
    ).with_columns(
        (pl.col("outcome_date") + pl.duration(days=1)).alias("post_date")
    )


def build_loss_win_episodes(
    daily: pl.DataFrame,
    losses: pl.DataFrame,
    wins: pl.DataFrame,
    eligible_users: pl.DataFrame,
    baseline: pl.DataFrame,
) -> tuple[pl.DataFrame, pl.DataFrame]:
    events = pl.concat(
        [
            standardize_outcome_days(losses, "loss", "loss_date"),
            standardize_outcome_days(wins, "win", "win_date"),
        ],
        how="vertical_relaxed",
    ).join(eligible_users, on="user_address", how="inner")

    post = (
        events.join(
            daily.rename({"trade_date": "post_date"}),
            on=["user_address", "post_date"],
            how="left",
        )
        .with_columns(
            pl.col("daily_stake_usd").fill_null(0.0),
            pl.col("trade_count").fill_null(0),
        )
        .rename(
            {
                "daily_stake_usd": "post_stake_usd",
                "trade_count": "post_trade_count",
            }
        )
    )

    episodes = (
        post.join(baseline, on="user_address", how="inner")
        .filter(pl.col("baseline_active_days") >= MIN_BASELINE_ACTIVE_DAYS)
        .with_columns(
            (pl.col("post_stake_usd") / pl.col("baseline_median_stake_usd")).alias(
                "post_ratio"
            ),
            (pl.col("post_stake_usd") - pl.col("baseline_median_stake_usd")).alias(
                "post_increase_usd"
            ),
        )
        .sort(["user_address", "outcome_date", "outcome"])
    )

    def outcome_summary(outcome: str, prefix: str) -> pl.DataFrame:
        return (
            episodes.filter(pl.col("outcome") == outcome)
            .group_by("user_address")
            .agg(
                pl.len().alias(f"{prefix}_episode_count"),
                pl.col("post_stake_usd").mean().alias(f"{prefix}_mean_post_stake_usd"),
                pl.col("post_stake_usd").median().alias(f"{prefix}_median_post_stake_usd"),
                pl.col("post_ratio").mean().alias(f"{prefix}_mean_post_ratio"),
                pl.col("post_ratio").median().alias(f"{prefix}_median_post_ratio"),
                (pl.col("post_trade_count") > 0).mean().alias(f"{prefix}_active_rate"),
            )
        )

    loss_summary = outcome_summary("loss", "loss")
    win_summary = outcome_summary("win", "win")
    comparison = (
        eligible_users.join(
            baseline.select(
                ["user_address", "baseline_median_stake_usd", "baseline_active_days"]
            ),
            on="user_address",
            how="left",
        )
        .join(loss_summary, on="user_address", how="left")
        .join(win_summary, on="user_address", how="left")
        .with_columns(
            (
                pl.col("loss_mean_post_ratio") - pl.col("win_mean_post_ratio")
            ).alias("loss_minus_win_mean_ratio"),
            (
                pl.col("loss_mean_post_stake_usd")
                - pl.col("win_mean_post_stake_usd")
            ).alias("loss_minus_win_mean_stake_usd"),
        )
        .with_columns(
            pl.when(
                pl.col("win_episode_count").is_null()
                | (pl.col("win_episode_count") == 0)
            )
            .then(pl.lit("no_observed_win"))
            .when(
                (pl.col("loss_active_rate") == 0)
                & (pl.col("win_active_rate") > 0)
            )
            .then(pl.lit("stop"))
            .when(
                pl.col("loss_mean_post_ratio")
                <= pl.col("win_mean_post_ratio") * (1 - LOSS_VS_WIN_TOLERANCE)
            )
            .then(pl.lit("shrink"))
            .when(
                pl.col("loss_mean_post_ratio")
                >= pl.col("win_mean_post_ratio") * (1 + LOSS_VS_WIN_TOLERANCE)
            )
            .then(pl.lit("chase"))
            .otherwise(pl.lit("leave"))
            .alias("behavior_category")
        )
    )
    return episodes, comparison


def summarize_comparison(
    comparison: pl.DataFrame,
    episodes: pl.DataFrame,
    prior_summary: dict,
) -> dict:
    paired = comparison.filter(
        pl.col("loss_episode_count").is_not_null()
        & pl.col("win_episode_count").is_not_null()
    )
    deltas = finite_values(paired, "loss_minus_win_mean_ratio")
    stake_deltas = finite_values(paired, "loss_minus_win_mean_stake_usd")
    loss_ratios = finite_values(paired, "loss_mean_post_ratio")
    win_ratios = finite_values(paired, "win_mean_post_ratio")
    category_counts = {
        row["behavior_category"]: int(row["len"])
        for row in comparison.group_by("behavior_category").len().to_dicts()
    }
    total = comparison.height
    categories = {
        category: {
            "wallets": count,
            "share_all_eligible": count / total if total else None,
        }
        for category, count in sorted(category_counts.items())
    }
    return {
        "source_scope": prior_summary["source_scope"],
        "population": {
            "eligible_wallets_from_first_pass": total,
            "paired_loss_and_win_wallets": paired.height,
            "wallets_without_observed_win_day": category_counts.get("no_observed_win", 0),
        },
        "metric": {
            "loss_next_day_stake": "wallet mean of next-day stake across observed loss days",
            "win_next_day_stake": "wallet mean of next-day stake across observed win days",
            "normalized_ratio": "next-day stake divided by the same wallet's common baseline median stake",
            "baseline": "the first-pass median active-day stake after excluding loss days and their next days",
            "category_tolerance": f"loss versus win mean ratio must differ by more than {LOSS_VS_WIN_TOLERANCE:.0%}",
        },
        "all_wallet_average": {
            "mean_wallet_loss_ratio": statistics.mean(loss_ratios) if loss_ratios else None,
            "mean_wallet_win_ratio": statistics.mean(win_ratios) if win_ratios else None,
            "mean_wallet_loss_minus_win_ratio": statistics.mean(deltas) if deltas else None,
            "mean_wallet_loss_minus_win_ratio_ci95": bootstrap_ci(deltas, "mean"),
            "mean_wallet_loss_minus_win_stake_usd": statistics.mean(stake_deltas)
            if stake_deltas
            else None,
            "mean_wallet_loss_minus_win_stake_usd_ci95": bootstrap_ci(stake_deltas, "mean"),
            "median_wallet_loss_ratio": statistics.median(loss_ratios) if loss_ratios else None,
            "median_wallet_win_ratio": statistics.median(win_ratios) if win_ratios else None,
            "median_wallet_loss_minus_win_ratio": statistics.median(deltas) if deltas else None,
            "median_wallet_loss_minus_win_stake_usd": statistics.median(stake_deltas)
            if stake_deltas
            else None,
            "mean_wallet_loss_stake_usd": statistics.mean(
                finite_values(paired, "loss_mean_post_stake_usd")
            )
            if paired.height
            else None,
            "mean_wallet_win_stake_usd": statistics.mean(
                finite_values(paired, "win_mean_post_stake_usd")
            )
            if paired.height
            else None,
        },
        "behavior_categories": categories,
        "prior_first_pass": {
            "consistent_chasing_wallets": prior_summary["sample"]["consistent_chasing_wallets"],
            "consistent_chasing_definition": prior_summary["primary_signal"]["definition"][
                "consistent_chasing_wallet"
            ],
        },
        "quality": {
            "episode_rows": episodes.height,
            "holdout_touched": False,
            "note": "No observed win day is kept distinct from zero stake; missing comparison evidence is not converted to zero.",
        },
    }


def write_report(path: Path, summary: dict) -> None:
    avg = summary["all_wallet_average"]
    population = summary["population"]
    categories = summary["behavior_categories"]
    path.parent.mkdir(parents=True, exist_ok=True)
    category_lines = [
        f"- {category}: {values['wallets']:,} wallets ({values['share_all_eligible']:.2%})"
        for category, values in categories.items()
    ]
    lines = [
        "# Polymarket loss versus win follow-up",
        "",
        "This follow-up uses the 159,666 wallets eligible for the first loss-chasing pass.",
        "",
        "## Result",
        "",
        f"Paired wallets with observed loss and win days: {population['paired_loss_and_win_wallets']:,} of {population['eligible_wallets_from_first_pass']:,}.",
        f"Mean wallet-normalized next-day stake after losses: {avg['mean_wallet_loss_ratio']:.3f}x baseline.",
        f"Mean wallet-normalized next-day stake after wins: {avg['mean_wallet_win_ratio']:.3f}x baseline.",
        f"Mean within-wallet loss-minus-win difference: {avg['mean_wallet_loss_minus_win_ratio']:.3f}x, with a bootstrap 95% interval of {avg['mean_wallet_loss_minus_win_ratio_ci95'][0]:.3f}x to {avg['mean_wallet_loss_minus_win_ratio_ci95'][1]:.3f}x.",
        f"Mean raw next-day stake after losses: ${avg['mean_wallet_loss_stake_usd']:.2f}; after wins: ${avg['mean_wallet_win_stake_usd']:.2f}; difference: ${avg['mean_wallet_loss_minus_win_stake_usd']:.2f}, with a bootstrap 95% interval of ${avg['mean_wallet_loss_minus_win_stake_usd_ci95'][0]:.2f} to ${avg['mean_wallet_loss_minus_win_stake_usd_ci95'][1]:.2f}.",
        f"Median wallet-normalized ratios are {avg['median_wallet_loss_ratio']:.3f}x after losses and {avg['median_wallet_win_ratio']:.3f}x after wins. The mean normalized ratios are outlier-sensitive.",
        "The typical wallet and raw-dollar average both point to a small post-loss reduction; the positive normalized mean comes from extreme wallet-level ratios.",
        "",
        "## What wallets do after losses",
        "",
        *category_lines,
        "",
        "Categories use a 10% tolerance around the wallet's own mean normalized stake. Stop means zero next-day activity after every observed loss day and positive next-day activity after at least one observed win day. No observed win day stays separate from zero stake.",
        "",
        "## First-pass 1,050 wallets",
        "",
        "The 1,050-wallet extract uses the original repeated-chasing definition: at least three eligible loss episodes, at least 50% chasing episodes, and median post-loss ratio at least 1.25x.",
        "",
        "## Sources and limits",
        "",
        "- Dataset: https://huggingface.co/datasets/vgregoire/polymarket-users",
        "- Documentation: https://www.vincentgregoire.com/polymarket-users-data/",
        "- PnL label convention: https://www.vincentgregoire.com/polymarket-users-data/datasets/pnl_change/",
        "- Trade schema: https://www.vincentgregoire.com/polymarket-users-data/datasets/trades/",
        "- PnL methodology: https://www.vincentgregoire.com/polymarket-users-data/methodology/",
        "",
        "The PnL measure is mark-to-market, not realized PnL. The 2026 trade holdout stayed untouched. The retail screen remains a heuristic and does not include a full counterparty-concentration filter.",
        "",
    ]
    path.write_text("\n".join(lines))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", type=Path, default=Path(".data/polymarket"))
    parser.add_argument("--output-dir", type=Path, default=Path("analysis/output"))
    args = parser.parse_args()

    stats, daily, cache_info = build_trade_aggregates(args.data_dir, args.output_dir)
    retail, _ = retail_filter(stats)
    prior_wallets = pl.read_parquet(
        args.output_dir / "wallet-metrics-with-control.parquet"
    ).filter(pl.col("loss_episode_count") >= 3)
    eligible_users = prior_wallets.select(["user_address"])
    baseline = prior_wallets.select(
        ["user_address", "baseline_median_stake_usd", "baseline_active_days"]
    )
    prior_summary = json.loads((args.output_dir / "summary.json").read_text())
    daily = daily.join(eligible_users, on="user_address", how="inner")
    losses = pl.read_parquet(args.output_dir / "loss-days.parquet").join(
        eligible_users, on="user_address", how="inner"
    )
    wins = load_win_days(
        args.data_dir,
        retail.select(["user_address"]),
        args.output_dir / "win-days.parquet",
    ).join(eligible_users, on="user_address", how="inner")
    episodes, comparison = build_loss_win_episodes(
        daily, losses, wins, eligible_users, baseline
    )
    summary = summarize_comparison(comparison, episodes, prior_summary)
    summary["cache"] = cache_info

    episodes.write_parquet(args.output_dir / "loss-win-episodes.parquet")
    comparison.write_parquet(args.output_dir / "loss-win-wallet-comparison.parquet")
    prior_wallet_metrics = pl.read_parquet(
        args.output_dir / "wallet-metrics-with-control.parquet"
    )
    comparison_columns = [
        "user_address",
        "win_episode_count",
        "win_mean_post_stake_usd",
        "win_median_post_stake_usd",
        "win_mean_post_ratio",
        "win_median_post_ratio",
        "win_active_rate",
        "loss_minus_win_mean_ratio",
        "loss_minus_win_mean_stake_usd",
        "behavior_category",
    ]
    consistent_extract = (
        prior_wallet_metrics.filter(pl.col("consistent_chasing_wallet"))
        .select(
            [
                "user_address",
                "loss_episode_count",
                "chasing_episode_count",
                "chasing_episode_share",
                "median_post_loss_ratio",
                "mean_post_loss_ratio",
                "median_post_loss_stake_usd",
                "baseline_median_stake_usd",
                "post_loss_active_share",
                "consistent_chasing_wallet",
                "median_control_ratio",
            ]
        )
        .join(comparison.select(comparison_columns), on="user_address", how="left")
        .sort("user_address")
    )
    consistent_extract.write_csv(args.output_dir / "consistent-chasing-wallets.csv")
    save_json(args.output_dir / "loss-vs-win-summary.json", summary)
    write_report(
        Path("analysis/reports/polymarket-loss-vs-win-follow-up.md"), summary
    )
    print(json.dumps(summary, indent=2, default=str))


if __name__ == "__main__":
    main()
