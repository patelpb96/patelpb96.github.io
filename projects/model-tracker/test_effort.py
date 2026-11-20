"""python -m unittest discover projects/model-tracker -p "test_*.py" -v"""
import csv
import json
import shutil
import tempfile
import unittest
from pathlib import Path

import build_effort as be
import build_snapshot as bs
from scraper import aa_effort as ae


def rec(creator, name, index, cost=1.0, secs=600.0, **kw):
    r = {"slug": name.lower().replace(" ", "-"), "name": name, "deprecated": False, "modelCreatorName": creator,
         "intelligenceIndex": index, "intelligenceIndexCostPerTask": cost, "intelligenceIndexTimePerTask": secs,
         "omniscience": 40.0, "scores": {"terminalbench-4-0": 0.5, "aa-briefcase": 1500.0}}
    r.update(kw)
    return r


RECS = [
    rec("Anthropic", "Claude Opus 5.5 (Low, Default Fallback)", 34.75, 0.9755293, 300),
    rec("Anthropic", "Claude Opus 5.5 (Max, Default Fallback)", 59.1, 10.0364, 1542.9),
    rec("Anthropic", "Claude Mythos 5.6 (High)", 70.0, 30.0),                 # a family member nobody listed up front
    rec("Anthropic", "Claude Opus 4.8 (High)", 40.0),                          # before Claude 5
    rec("OpenAI", "GPT-6.2 Astra (Xhigh)", 61.56, 2.52),
    rec("OpenAI", "GPT-6 Luna (Low)", 9.67, 0.005115255),                     # a half-cent cost must not round to 0.01
    rec("OpenAI", "GPT-6 Luna (Non-reasoning)", 9.44, 0.0714),
    rec("OpenAI", "GPT-6 Sol (Daybreak Blue, max)", None),                     # special build, no Index
    rec("OpenAI", "Astra for Law 6.2 (Max)", 50.0),
    rec("OpenAI", "GPT-5.5 (Xhigh)", 50.0),                                   # before GPT-6
    rec("Google", "Gemini 4 Argon (High)", 50.4, 4.97),
    rec("Google", "Gemini 3.8 Flash", 30.8, 7.77),                             # no effort label at all
    rec("Google", "Gemini 3.5 Flash-Lite", 20.0),                              # older than 3.8
    rec("Google", "Gemini 3 Deep Think", 45.0),
    rec("Google", "Gemini 4 Hydrogen (Medium)", 41.2, 0.8, deprecated=True),   # AA marked it deprecated
    rec("Mistral", "GPT-6 Impostor (High)", 10.0),                             # wrong creator
]


class ClassifyTests(unittest.TestCase):
    def test_family_patterns_and_minimum_versions(self):
        c = ae.classify
        self.assertEqual(c("OpenAI", "GPT-6.2 Astra"), {"org": "OpenAI", "class": "Astra", "version": "6.2", "display_name": "GPT-6.2 Astra"})
        self.assertEqual(c("Anthropic", "Claude Fable 5.1")["version"], "5.1")
        self.assertEqual(c("Google", "Gemini 4 Neon")["class"], "Neon")
        self.assertEqual(c("Google", "Gemini 3.8 Flash")["version"], "3.8")
        for creator, name in [("OpenAI", "GPT-5.5"), ("OpenAI", "Astra for Law 6.2"), ("OpenAI", "GPT-6 Sol (Daybreak Blue, max)"),
                              ("Anthropic", "Claude Opus 4.8"), ("Google", "Gemini 3.5 Flash-Lite"), ("Google", "Gemini 3 Deep Think"),
                              ("Mistral", "GPT-6 Impostor"), ("Google", "Gemini 3.1 Pro Preview")]:
            self.assertIsNone(c(creator, name), name)

    def test_a_new_family_member_needs_no_code_change(self):
        self.assertEqual(ae.classify("Anthropic", "Claude Mythos 5.6")["class"], "Mythos")
        self.assertEqual(ae.classify("OpenAI", "GPT-6.3 Sol")["version"], "6.3")
        self.assertEqual(ae.classify("Google", "Gemini 4 Helium")["class"], "Helium")
        self.assertEqual(ae.classify("Google", "Gemini 10 Xenon")["version"], "10")          # 10 > 3.8 numerically, not as text

    def test_effort_keys_and_order(self):
        self.assertEqual([ae.effort_key(x) for x in ("Max", "Xhigh", "Non-reasoning", "Reasoning", "")], ["max", "xhigh", "none", "default", "default"])
        ranked = sorted(["max", "low", "none", "high", "xhigh", "medium", "default"], key=ae.effort_rank)
        self.assertEqual(ranked, ["none", "low", "medium", "high", "xhigh", "max", "default"])


class LadderTests(unittest.TestCase):
    def setUp(self):
        self.rows = ae.ladders(RECS, "2026-11-19")
        self.by = {(r["model_id"], r["effort"]): r for r in self.rows}

    def test_only_the_tracked_families_with_an_index_survive(self):
        self.assertEqual(sorted({r["model_id"] for r in self.rows}), [
            "anthropic/claude-mythos-5-6", "anthropic/claude-opus-5-5", "google/gemini-3-8-flash", "google/gemini-4-argon",
            "openai/gpt-6-2-astra", "openai/gpt-6-luna"])

    def test_every_effort_of_a_model_is_kept_in_ladder_order(self):
        opus = [r["effort"] for r in self.rows if r["model_id"] == "anthropic/claude-opus-5-5"]
        self.assertEqual(opus, ["low", "max"])
        luna = [r["effort"] for r in self.rows if r["model_id"] == "openai/gpt-6-luna"]
        self.assertEqual(luna, ["none", "low"])
        self.assertIn(("google/gemini-3-8-flash", "default"), self.by)               # unlabelled = one default setting

    def test_numbers_keep_their_precision_and_units(self):
        luna = self.by[("openai/gpt-6-luna", "low")]
        self.assertEqual(luna["aa_cost_per_task"], "0.005115")
        opus = self.by[("anthropic/claude-opus-5-5", "max")]
        self.assertEqual((opus["aa_intelligence_index"], opus["aa_cost_per_task"], opus["aa_time_per_task"]), ("59.1", "10.04", "25.7"))
        self.assertEqual((opus["aa_terminalbench_4"], opus["aa_briefcase_elo"]), ("50.0", "1500.0"))   # fractions become %, Elo stays

    def test_duplicate_rows_keep_the_higher_index(self):
        dup = ae.ladders([rec("OpenAI", "GPT-6 Luna (Low)", 5.0), rec("OpenAI", "GPT-6 Luna (Low)", 9.0)], "2026-11-19")
        self.assertEqual([r["aa_intelligence_index"] for r in dup], ["9.0"])


class SeedTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        shutil.copy(bs.DEFAULT_SEED / "benchmarks.csv", self.tmp / "benchmarks.csv")

    def test_write_is_append_only_and_a_same_day_rerun_adds_nothing(self):
        self.assertEqual(ae.refresh(RECS, "2026-11-19", self.tmp), {"rows": 8, "models": 6, "added": 8})
        self.assertEqual(ae.refresh(RECS, "2026-11-19", self.tmp)["added"], 0)
        self.assertEqual(ae.refresh(RECS, "2026-11-20", self.tmp)["added"], 8)       # a new day appends
        self.assertEqual(len(ae.read(self.tmp)), 16)

    def test_a_wrong_header_is_refused(self):
        (self.tmp / "effort").mkdir()
        (self.tmp / "effort" / "effort_obs.csv").write_text("a,b\n1,2\n", encoding="utf-8")
        with self.assertRaises(ValueError):
            ae.read(self.tmp)

    def test_backfill_adds_only_models_without_a_ladder(self):
        (self.tmp / "aa").mkdir()
        with open(self.tmp / "aa" / "models.csv", "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(bs.TABLES["models"])
            for mid, org, name in [("openai/gpt-6-astra", "OpenAI", "GPT-6 Astra"), ("openai/gpt-6-luna", "OpenAI", "GPT-6 Luna"),
                                   ("openai/gpt-5-5", "OpenAI", "GPT-5.5")]:
                w.writerow([mid, org, org, name, name, "proprietary", "false", "", "scraped"])
        with open(self.tmp / "aa" / "score_obs.csv", "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=bs.TABLES["score_obs"], lineterminator="\n")
            w.writeheader()
            for mid in ("openai/gpt-6-astra", "openai/gpt-6-luna", "openai/gpt-5-5"):
                for day, idx in (("2026-11-07", "50"), ("2026-11-16", "56.9")):
                    for bid, v in (("aa_intelligence_index", idx), ("aa_cost_per_task", "6.24")):
                        w.writerow({"obs_id": f"{day}-{mid}-{bid}", "model_id": mid, "benchmark_id": bid, "value": v, "status": "observed",
                                    "observed_at": day, "effort": "Max"})
        ae.refresh([rec("OpenAI", "GPT-6 Luna (Low)", 9.67)], "2026-11-19", self.tmp)       # Luna already has a live ladder
        out = ae.backfill(self.tmp)
        self.assertEqual(out["models"], ["openai/gpt-6-astra"])                              # not Luna (live), not GPT-5.5 (not tracked)
        row = next(r for r in ae.read(self.tmp) if r["model_id"] == "openai/gpt-6-astra")
        self.assertEqual((row["observed_at"], row["effort"], row["aa_intelligence_index"], row["aa_cost_per_task"]), ("2026-11-16", "max", "56.9", "6.24"))
        self.assertEqual(ae.backfill(self.tmp)["added"], 0)                                  # idempotent


class BuildTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        shutil.copy(bs.DEFAULT_SEED / "benchmarks.csv", self.tmp / "benchmarks.csv")
        ae.refresh(RECS, "2026-11-18", self.tmp)
        ae.refresh([r for r in RECS if "Argon" not in r["name"]], "2026-11-19", self.tmp)   # Argon vanishes from AA on the 19th

    def test_live_and_retired_models(self):
        data = be.build(self.tmp, None)
        by = {m["model_id"]: m for m in data["models"]}
        self.assertEqual(data["as_of"], "2026-11-19")
        self.assertTrue(by["anthropic/claude-opus-5-5"]["live"])
        self.assertFalse(by["google/gemini-4-argon"]["live"])
        self.assertEqual(by["google/gemini-4-argon"]["last_seen"], "2026-11-18")
        self.assertEqual(data["counts"], {"models": 6, "live": 5, "settings": 8})

    def test_a_ladder_is_read_from_one_day_only(self):
        # On the 19th AA lists only Opus (Max); the Low row from the 18th must not be mixed into a ladder read as of the 19th.
        ae.refresh([rec("Anthropic", "Claude Opus 5.5 (Max, Default Fallback)", 60.0)], "2026-11-20", self.tmp)
        opus = next(m for m in be.build(self.tmp, None)["models"] if m["model_id"] == "anthropic/claude-opus-5-5")
        self.assertEqual([p["effort"] for p in opus["points"]], ["max"])
        self.assertEqual(opus["points"][0]["values"]["aa_intelligence_index"], 60.0)

    def test_output_is_deterministic_and_only_lists_metrics_with_data(self):
        a, b = self.tmp / "a.json", self.tmp / "b.json"
        be.build(self.tmp, a)
        be.build(self.tmp, b)
        self.assertEqual(a.read_bytes(), b.read_bytes())
        ids = [m["id"] for m in json.loads(a.read_text(encoding="utf-8"))["metrics"]]
        self.assertIn("aa_intelligence_index", ids)
        self.assertNotIn("aa_scicode", ids)                    # the synthetic records carry no SciCode score

    def test_bad_rows_are_refused(self):
        path = self.tmp / "effort" / "effort_obs.csv"
        with path.open(newline="", encoding="utf-8") as fh:
            rows = list(csv.DictReader(fh))
        rows[0]["aa_intelligence_index"] = "not-a-number"
        with open(path, "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=ae.COLUMNS, lineterminator="\n")
            w.writeheader()
            w.writerows(rows)
        with self.assertRaises(ValueError):
            be.build(self.tmp, None)


class CommittedDataTests(unittest.TestCase):
    """The page reads public/projects/models/data/effort.json; it must be exactly what the seed builds."""

    def test_the_committed_file_matches_a_fresh_build(self):
        fresh = be.build(bs.DEFAULT_SEED, None)
        committed = json.loads(be.DEFAULT_OUT.read_text(encoding="utf-8"))
        self.assertEqual(committed, fresh, "effort.json is stale: run python build_effort.py")

    def test_every_tracked_family_is_in_the_committed_seed(self):
        orgs = {m["org"] for m in be.build(bs.DEFAULT_SEED, None)["models"]}
        self.assertEqual(orgs, {"OpenAI", "Anthropic", "Google"})


if __name__ == "__main__":
    unittest.main()
