"""Frozen 2024-2025 training and Jan-Mar 2026 loss-chasing holdout test.

The target keeps the first-pass definition: next-day stake is at least 1.25x
the wallet's frozen 2024-2025 baseline and at least $10 above that baseline.
Features use information available before each loss episode. The prior chase
rate includes only earlier episodes for the same wallet.
"""

from __future__ import annotations

import argparse
import json
import math
import statistics
from datetime import date, timedelta
from pathlib import Path

import numpy as np
import polars as pl
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import average_precision_score, brier_score_loss, roc_auc_score


IN_SAMPLE_START = date(2024, 1, 1)
IN_SAMPLE_END = date(2025, 12, 31)
HOLDOUT_START = date(2026, 1, 1)
HOLDOUT_END = date(2026, 3, 29)
HOLDOUT_PNL_END = date(2026, 3, 30)
MIN_TRADES = 30
MIN_ACTIVE_DAYS = 5
MAX_MAKER_SHARE = 0.80
MAX_TRADES_PER_ACTIVE_DAY = 50.0
CHASE_RATIO = 1.25
CHASE_ABSOLUTE_USD = 10.0
SEED = 20261111
FEATURES = [
    "prior_loss_count",
    "prior_chase_rate",
    "prior_active_rate",
    "days_since_prior_loss",
    "log_baseline_stake",
    "log_loss_magnitude",
]


def collect(lazy_frame: pl.LazyFrame) -> pl.DataFrame:
    try:
        return lazy_frame.collect(engine="streaming")
    except TypeError:
        return lazy_frame.collect(streaming=True)


def read_retail(output_dir: Path) -> pl.DataFrame:
    stats = pl.read_parquet(output_dir / "wallet_stats.parquet")
    retail = stats.filter(
        (pl.col("n_trades") >= MIN_TRADES)
        & (pl.col("active_days") >= MIN_ACTIVE_DAYS)
        & (pl.col("maker_share") < MAX_MAKER_SHARE)
        & (pl.col("trades_per_active_day") <= MAX_TRADES_PER_ACTIVE_DAY)
    ).select("user_address")
    baselines = pl.read_parquet(output_dir / "wallet-metrics-with-control.parquet").select(
        ["user_address", "baseline_median_stake_usd"]
    )
    return retail.join(baselines, on="user_address", how="inner").filter(
        pl.col("baseline_median_stake_usd") > 0
    )


def read_in_sample_episodes(output_dir: Path, retail: pl.DataFrame) -> pl.DataFrame:
    return (
        pl.read_parquet(output_dir / "loss-episodes.parquet")
        .select(["user_address", "loss_date", "pnl_change", "post_loss_stake_usd", "post_loss_trade_count", "baseline_median_stake_usd", "chasing_episode"])
        .join(retail, on=["user_address", "baseline_median_stake_usd"], how="inner")
        .with_columns(pl.lit("train").alias("period"))
    )


def read_holdout_losses(data_dir: Path, retail: pl.DataFrame) -> pl.DataFrame:
    pnl = pl.scan_parquet(
        str(data_dir / "pnl_change_daily/year=2026/month=*/day=*/data.parquet"),
        hive_partitioning=False,
    ).select(["user_address", "day", "pnl_change"])
    losses = collect(
        pnl.filter(
            (pl.col("day").dt.date() >= pl.lit(HOLDOUT_START + timedelta(days=1)))
            & (pl.col("day").dt.date() <= pl.lit(HOLDOUT_PNL_END))
            & (pl.col("pnl_change") < 0)
        )
        .with_columns((pl.col("day").dt.date() - pl.duration(days=1)).alias("loss_date"))
        .filter((pl.col("loss_date") >= pl.lit(HOLDOUT_START)) & (pl.col("loss_date") <= pl.lit(HOLDOUT_END)))
        .select(["user_address", "loss_date", "pnl_change"])
        .unique(["user_address", "loss_date"])
    )
    return losses.join(retail, on="user_address", how="inner").with_columns(pl.lit("holdout").alias("period"))


def read_holdout_daily(data_dir: Path, retail: pl.DataFrame) -> pl.DataFrame:
    source = pl.scan_parquet(
        str(data_dir / "trades/year=2026/month=*/day=*/data.parquet"),
        hive_partitioning=False,
    ).select(["trade_id", "timestamp", "price", "quantity", "maker_address", "taker_address"])
    stake = (pl.col("price") * pl.col("quantity")).alias("stake_usd")
    maker = source.select(["trade_id", "timestamp", pl.col("maker_address").alias("user_address"), stake])
    taker = source.select(["trade_id", "timestamp", pl.col("taker_address").alias("user_address"), stake])
    return collect(
        pl.concat([maker, taker])
        .filter(pl.col("user_address").is_not_null() & pl.col("user_address").is_in(retail.get_column("user_address").implode()))
        .with_columns(pl.col("timestamp").dt.date().alias("trade_date"))
        .group_by(["user_address", "trade_date"])
        .agg([pl.len().alias("trade_count"), pl.col("stake_usd").sum().alias("daily_stake_usd")])
    )


def add_holdout_labels(losses: pl.DataFrame, daily: pl.DataFrame) -> pl.DataFrame:
    post = losses.select(
        ["user_address", "loss_date", "pnl_change", "baseline_median_stake_usd", "period", (pl.col("loss_date") + pl.duration(days=1)).alias("trade_date")]
    ).join(daily, on=["user_address", "trade_date"], how="left")
    return post.with_columns(
        pl.col("daily_stake_usd").fill_null(0).alias("post_loss_stake_usd"),
        pl.col("trade_count").fill_null(0).alias("post_loss_trade_count"),
    ).with_columns(
        (pl.col("post_loss_stake_usd") / pl.col("baseline_median_stake_usd")).alias("post_loss_ratio"),
        (pl.col("post_loss_stake_usd") - pl.col("baseline_median_stake_usd")).alias("post_loss_increase_usd"),
    ).with_columns(
        (
            (pl.col("post_loss_ratio") >= CHASE_RATIO)
            & (pl.col("post_loss_increase_usd") >= CHASE_ABSOLUTE_USD)
        ).alias("chasing_episode"),
    ).select(
        ["user_address", "loss_date", "pnl_change", "post_loss_stake_usd", "post_loss_trade_count", "baseline_median_stake_usd", "chasing_episode", "period"]
    )


def add_history_features(episodes: pl.DataFrame) -> pl.DataFrame:
    episodes = episodes.sort(["user_address", "loss_date"])
    return episodes.with_columns(
        (pl.col("loss_date").cum_count().over("user_address") - 1).alias("prior_loss_count"),
        (pl.col("chasing_episode").cast(pl.Int64).cum_sum().over("user_address") - pl.col("chasing_episode").cast(pl.Int64)).alias("prior_chase_count"),
        ((pl.col("post_loss_trade_count") > 0).cast(pl.Int64).cum_sum().over("user_address") - (pl.col("post_loss_trade_count") > 0).cast(pl.Int64)).alias("prior_active_count"),
        pl.col("loss_date").diff().over("user_address").dt.total_days().fill_null(999).alias("days_since_prior_loss"),
    ).with_columns(
        pl.when(pl.col("prior_loss_count") > 0).then(pl.col("prior_chase_count") / pl.col("prior_loss_count")).otherwise(0.0).alias("prior_chase_rate"),
        pl.when(pl.col("prior_loss_count") > 0).then(pl.col("prior_active_count") / pl.col("prior_loss_count")).otherwise(0.0).alias("prior_active_rate"),
        pl.col("baseline_median_stake_usd").log1p().alias("log_baseline_stake"),
        pl.col("pnl_change").abs().log1p().alias("log_loss_magnitude"),
    )


def finite_array(frame: pl.DataFrame, columns: list[str]) -> np.ndarray:
    values = frame.select(columns).to_numpy().astype(float)
    values[~np.isfinite(values)] = 0.0
    return values


def metrics(y_true: np.ndarray, score: np.ndarray) -> dict:
    positives = int(y_true.sum())
    negatives = int(len(y_true) - positives)
    if positives == 0 or negatives == 0:
        return {"rows": int(len(y_true)), "positive_rate": float(y_true.mean()), "auroc": None, "average_precision": None, "brier": None}
    return {
        "rows": int(len(y_true)),
        "positives": positives,
        "negative": negatives,
        "positive_rate": float(y_true.mean()),
        "auroc": float(roc_auc_score(y_true, score)),
        "average_precision": float(average_precision_score(y_true, score)),
        "brier": float(brier_score_loss(y_true, score)),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", type=Path, default=Path(".data/polymarket"))
    parser.add_argument("--output-dir", type=Path, default=Path("analysis/output"))
    parser.add_argument("--report", type=Path, default=Path("analysis/reports/polymarket-holdout-model.md"))
    args = parser.parse_args()
    retail = read_retail(args.output_dir)
    train = read_in_sample_episodes(args.output_dir, retail)
    holdout_losses = read_holdout_losses(args.data_dir, retail)
    holdout_daily = read_holdout_daily(args.data_dir, retail)
    holdout = add_holdout_labels(holdout_losses, holdout_daily)
    episodes = add_history_features(pl.concat([train, holdout], how="vertical"))
    train_features = episodes.filter(pl.col("period") == "train")
    test_features = episodes.filter(pl.col("period") == "holdout")
    train_sample = train_features.sample(n=min(500_000, train_features.height), seed=SEED)
    x_train = finite_array(train_sample, FEATURES)
    x_test = finite_array(test_features, FEATURES)
    means = x_train.mean(axis=0)
    scales = x_train.std(axis=0)
    scales[scales == 0] = 1.0
    x_train = (x_train - means) / scales
    x_test = (x_test - means) / scales
    y_train = train_sample.get_column("chasing_episode").cast(pl.Int8).to_numpy()
    y_test = test_features.get_column("chasing_episode").cast(pl.Int8).to_numpy()
    model = LogisticRegression(max_iter=200, solver="lbfgs", random_state=SEED)
    model.fit(x_train, y_train)
    test_score = model.predict_proba(x_test)[:, 1]
    prior_score = test_features.get_column("prior_chase_rate").to_numpy().astype(float)
    train_score = model.predict_proba(x_train)[:, 1]
    summary = {
        "definition": {
            "training_window_utc": [str(IN_SAMPLE_START), str(IN_SAMPLE_END)],
            "holdout_window_utc": [str(HOLDOUT_START), str(HOLDOUT_END)],
            "holdout_pnl_boundary_through": str(HOLDOUT_PNL_END),
            "retail_filter": {"minimum_trades": MIN_TRADES, "minimum_active_days": MIN_ACTIVE_DAYS, "maker_share_below": MAX_MAKER_SHARE, "trades_per_active_day_at_most": MAX_TRADES_PER_ACTIVE_DAY},
            "target": f"next-day stake >= {CHASE_RATIO:.2f}x frozen 2024-2025 baseline and >= ${CHASE_ABSOLUTE_USD:.0f} above baseline",
            "features": FEATURES,
            "feature_rule": "Features use only earlier loss episodes for the same wallet. Holdout history updates after each observed episode.",
        },
        "population": {"retail_wallets_with_frozen_baseline": retail.height, "train_episodes": train_features.height, "train_sample": train_sample.height, "holdout_episodes": test_features.height},
        "train_metrics": metrics(y_train, train_score),
        "holdout_metrics": metrics(y_test, test_score),
        "holdout_prior_chase_rate_baseline": metrics(y_test, prior_score),
        "model": {"type": "standardized logistic regression", "seed": SEED, "intercept": float(model.intercept_[0]), "coefficients": dict(zip(FEATURES, model.coef_[0].astype(float))), "means": dict(zip(FEATURES, means.astype(float))), "scales": dict(zip(FEATURES, scales.astype(float)))},
        "limitations": [
            "The target is a behavioral proxy based on mark-to-market PnL and public wallet activity, not a clinical or causal label.",
            "The retail screen is heuristic and does not fully remove coordinated wallets or counterparty concentration.",
            "The holdout only evaluates wallets with a frozen in-sample baseline and observed holdout loss episodes.",
            "The model predicts next-day threshold crossing. It does not predict financial loss, intent, or a need for intervention.",
        ],
    }
    args.output_dir.mkdir(parents=True, exist_ok=True)
    (args.output_dir / "polymarket-holdout-model-summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    predictions = test_features.select(["user_address", "loss_date", "pnl_change", "post_loss_stake_usd", "baseline_median_stake_usd", "chasing_episode", *FEATURES]).with_columns(pl.Series("predicted_probability", test_score))
    predictions.write_parquet(args.output_dir / "polymarket-holdout-episode-predictions.parquet")
    holdout_metrics = summary["holdout_metrics"]
    prior_metrics = summary["holdout_prior_chase_rate_baseline"]
    report = f"""# Polymarket loss-chasing holdout model

This evaluation trains on {IN_SAMPLE_START} through {IN_SAMPLE_END} and scores {HOLDOUT_START} through {HOLDOUT_END}. The Jan-Mar 2026 trade partitions remain outside training.

## Result

- Retail-like wallets with a frozen in-sample baseline: {retail.height:,}
- Training episodes: {train_features.height:,}, sampled for fitting: {train_sample.height:,}
- Holdout loss episodes: {test_features.height:,}
- Holdout positive rate: {holdout_metrics['positive_rate']:.2%}
- Logistic model AUROC: {holdout_metrics['auroc']:.3f}
- Logistic model average precision: {holdout_metrics['average_precision']:.3f}
- Prior-chase-rate baseline AUROC: {prior_metrics['auroc']:.3f}
- Prior-chase-rate baseline average precision: {prior_metrics['average_precision']:.3f}

The baseline provides a persistence check. The model only earns a predictive claim if its holdout metrics improve on the prior-chase-rate baseline and beat the holdout prevalence by a meaningful margin.

## Frozen definition

The target marks a loss episode when next-day stake reaches at least {CHASE_RATIO:.2f}x the wallet's 2024-2025 median active-day baseline and exceeds baseline by at least ${CHASE_ABSOLUTE_USD:.0f}. The retail screen stays fixed at 30 fills, 5 active days, maker share below 80%, and no more than 50 fills per active day.

Features use only earlier episodes for the same wallet. The holdout score updates wallet history after each observed episode, matching an online scoring workflow.

## Files

- `analysis/polymarket_holdout_model.py`
- `analysis/output/polymarket-holdout-model-summary.json`
- `analysis/output/polymarket-holdout-episode-predictions.parquet`

## Limits

- Mark-to-market PnL does not equal realized PnL.
- Public wallet behavior does not reveal intent.
- The model predicts a next-day stake pattern. It does not diagnose a person or authorize an intervention.
- The screen excludes wallets without a frozen in-sample baseline, so results do not describe every 2026 wallet.
"""
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(report)
    print(json.dumps({"holdout": summary["holdout_metrics"], "prior_baseline": summary["holdout_prior_chase_rate_baseline"], "report": str(args.report)}, indent=2))


if __name__ == "__main__":
    main()
