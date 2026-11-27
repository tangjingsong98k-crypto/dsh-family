#!/usr/bin/env python3
"""把汐汐的饮食库导成一份只读快照（在 AstrBot 容器里跑，标准输入送脚本）。

主电脑的 `tools/publish.mjs` 这样调它：

    docker exec -i -w /AstrBot/data/plugins/astrbot_plugin_diet_log astrbot python -

输出的 JSON 写到 `data/diet/diet.json`，家人电脑的 dsh-balance 插件只读它：

    {
      "version": 1,
      "exportedAt": "2026-11-26T10:00:00+08:00",
      "source": "astrbot_plugin_diet_log",
      "users": {
        "99132013": {
          "qq": "99132013",
          "target": 1800.0,
          "profile": {"goal": "lose", "weight_kg": 70},
          "days": {
            "2026-11-26": {
              "meals": [ {id, qq, day, meal_type, clock, kcal, protein, fat, carb,
                          raw_text, note, items: [...]} ]
            }
          }
        }
      }
    }

字段口径与 `scripts/panel_api.py` 的 day/month/year 完全一致（clock 是容器本地时间），
所以插件那边的快照分支不用改面板代码。

只读：sqlite 连接用 mode=ro，绝不写 diet.db。
"""

from __future__ import annotations

import json
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

DB_PATH = Path("/AstrBot/data/plugin_data/astrbot_plugin_diet_log/diet.db")
PLUGIN_DIR = Path("/AstrBot/data/plugins/astrbot_plugin_diet_log")

ITEM_FIELDS = ("id", "name", "grams", "kcal", "protein", "fat", "carb", "source", "basis", "food_code")
MEAL_FIELDS = ("id", "qq", "day", "meal_type", "kcal", "protein", "fat", "carb", "raw_text", "note")


def connect() -> sqlite3.Connection:
    """只读打开饮食库（WAL 库交给容器里的进程读，宿主不碰）。"""
    db = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    return db


def clock_of(ts: float, tz) -> str:
    """把时间戳变成 HH:MM；拿不到时区就按容器本地时间。"""
    try:
        return datetime.fromtimestamp(float(ts), tz).strftime("%H:%M")
    except Exception:
        return datetime.fromtimestamp(float(ts)).strftime("%H:%M")


def load_meta(db: sqlite3.Connection) -> tuple[dict, object]:
    """尽量借插件自己的资料/热量目标算法；借不到就退回 users 表。"""
    profiles: dict[str, dict] = {}
    target_fn = None
    tz = None
    try:
        sys.path.insert(0, str(PLUGIN_DIR))
        from core import nutrition as N  # type: ignore
        from core import users as U  # type: ignore
        from core.db import DietDB  # type: ignore

        store = DietDB(DB_PATH)
        tz = getattr(N, "TZ", None)
        target_fn = N.target_kcal
        for row in db.execute("SELECT qq FROM users UNION SELECT DISTINCT qq FROM meals"):
            qq = str(row["qq"])
            profile = U.load_profile(store, qq, {}) or {}
            profiles[qq] = {
                "goal": profile.get("goal") or "maintain",
                "weight_kg": profile.get("weight_kg") or 0,
                "target": float(target_fn(profile) or 0),
            }
    except Exception as exc:  # 插件升级换接口时不至于整份快照没了
        print(f"[diet-dump] fallback to raw users table: {exc}", file=sys.stderr)
        for row in db.execute("SELECT * FROM users"):
            qq = str(row["qq"])
            profiles[qq] = {
                "goal": row["goal"] or "maintain",
                "weight_kg": row["weight_kg"] or 0,
                "target": float(row["kcal_target"] or 0),
            }
    return profiles, tz


def build_snapshot() -> dict:
    """拼整份快照。"""
    db = connect()
    profiles, tz = load_meta(db)

    meals = [dict(row) for row in db.execute("SELECT * FROM meals ORDER BY day, ts, id")]
    items_by_meal: dict[int, list[dict]] = {}
    for row in db.execute("SELECT * FROM meal_items ORDER BY id"):
        item = dict(row)
        items_by_meal.setdefault(int(item["meal_id"]), []).append(
            {key: item.get(key) for key in ITEM_FIELDS}
        )

    users: dict[str, dict] = {}
    for meal in meals:
        qq = str(meal["qq"])
        day = str(meal["day"])
        meta = profiles.get(qq, {"goal": "maintain", "weight_kg": 0, "target": 0})
        user = users.setdefault(qq, {
            "qq": qq,
            "target": round(float(meta["target"] or 0), 1),
            "profile": {"goal": meta["goal"], "weight_kg": meta["weight_kg"]},
            "days": {},
        })
        payload = {key: meal.get(key) for key in MEAL_FIELDS}
        payload["clock"] = clock_of(meal["ts"], tz)
        payload["items"] = items_by_meal.get(int(meal["id"]), [])
        user["days"].setdefault(day, {"meals": []})["meals"].append(payload)

    # 没有记录但在 users 表里的人也给一条，面板显示空日历而不是报错。
    for qq, meta in profiles.items():
        users.setdefault(qq, {
            "qq": qq,
            "target": round(float(meta["target"] or 0), 1),
            "profile": {"goal": meta["goal"], "weight_kg": meta["weight_kg"]},
            "days": {},
        })

    return {
        "version": 1,
        "exportedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
        "source": "astrbot_plugin_diet_log",
        "users": users,
    }


def main() -> int:
    try:
        snapshot = build_snapshot()
    except Exception as exc:
        print(json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}, ensure_ascii=False))
        return 1
    print(json.dumps({"ok": True, "snapshot": snapshot}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
