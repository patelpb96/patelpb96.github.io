"""python -m unittest discover projects/model-tracker -p "test_*.py" -v"""
import json
import shutil
import tempfile
import unittest
from datetime import datetime
from pathlib import Path

import build_snapshot as bs
from scraper import aa_source as aa, triage


def rec(slug, name, creator, index, **kw):
    r = {"slug": slug, "name": name, "deprecated": False, "isReasoning": True, "isOpenWeights": False,
         "modelCreatorName": creator, "contextWindowTokens": 1_000_000, "intelligenceIndex": index,
         "omniscience": 30.0, "scores": {"terminalbench-4-0": 0.5, "hle-diamond": 0.25, "aa-briefcase": 1500.0},
         "intelligenceIndexCostPerTask": 2.5, "intelligenceIndexTimePerTask": 600.0, "price1mInputTokens": 2,
         "price1mOutputTokens": 6, "outputSpeed": 80.0, "timeToFirstAnswerToken": 12.0}
    r.update(kw)
    return r


def page(records):
    """An HTML page in the same shape as the real one: the data lives in self.__next_f.push([1,"..."]) chunks."""
    payload = '1:["$","div",null,{"rows":' + json.dumps(records, separators=(",", ":")) + "}]"   # compact, like the real one
    half = len(payload) // 2                                        # split mid-record: the parser must join chunks
    chunks = "".join(f"<script>self.__next_f.push([1,{json.dumps(c)}])</script>" for c in (payload[:half], payload[half:]))
    return f"<html><body><table><tr><td>x</td></tr></table>{chunks}</body></html>"


FILLER = [rec(f"filler-{i}", f"Filler {i} (High)", "Nobody", 5.0 + i * 0.1) for i in range(20)]
RECS = FILLER + [
    rec("grok-4-7", "Grok 4.7 (Xhigh)", "SpaceXAI", 35.48, contextWindowTokens=500_000),
    rec("grok-4-7-low", "Grok 4.7 (Low)", "SpaceXAI", 31.1),
    rec("kimi-k3-1-pro", "Kimi K3.1 Pro", "Kimi", 46.5),
    rec("qwen3-8-max-0902", "Qwen3.8 Max (0902)", "Alibaba", 33.7),
    rec("old-thing", "Old Thing (Max)", "Acme", 40.0, deprecated=True),
    rec("mistral-large-4", "Mistral Large 4 (High)", "Mistral", 26.1),
]


class AASourceTests(unittest.TestCase):
    def test_records_survive_chunking_and_escaping(self):
        got = aa.records(page(RECS))
        self.assertEqual(len(got), len(RECS))
        self.assertEqual(got[-6]["slug"], "grok-4-7")

    def test_layout_change_is_loud(self):
        with self.assertRaises(aa.SourceError):
            aa.records("<html>no flight data</html>")
        with self.assertRaises(aa.SourceError):
            aa.records(page(RECS[:5]))                       # too few records: refuse rather than publish a thin table

    def test_effort_is_split_but_versions_are_kept(self):
        self.assertEqual(aa.base_name("Grok 4.7 (Xhigh)"), ("Grok 4.7", "Xhigh"))
        self.assertEqual(aa.base_name("Claude Opus 5.5 (Max, Default Fallback)"), ("Claude Opus 5.5", "Max"))
        self.assertEqual(aa.base_name("Qwen3.8 Max (0902)"), ("Qwen3.8 Max (0902)", ""))

    def test_selection_keeps_best_variant_and_threshold(self):
        chosen = aa.select(aa.records(page(RECS)), 30, {"mistral/mistral-large-4"})
        ids = [c["model_id"] for c in chosen]
        self.assertEqual(ids, ["moonshot/kimi-k3-1-pro", "spacexai/grok-4-7", "alibaba/qwen3-8-max-0902", "mistral/mistral-large-4"])
        grok = next(c for c in chosen if c["model_id"] == "spacexai/grok-4-7")
        self.assertEqual((grok["effort"], grok["rec"]["intelligenceIndex"]), ("Xhigh", 35.48))   # Xhigh beat Low
        self.assertNotIn("acme/old-thing", ids)                                                     # deprecated

    def test_observations_convert_units(self):
        chosen = aa.select(aa.records(page(RECS)), 35, set())
        obs = aa.observations(chosen, "2026-11-07")
        by = {(r["model_id"], r["benchmark_id"]): r["value"] for r in obs["score_obs"]}
        g = "spacexai/grok-4-7"
        self.assertEqual(by[(g, "aa_intelligence_index")], "35.5")
        self.assertEqual(by[(g, "aa_time_per_task")], "10.0")              # 600 s -> 10 min
        self.assertEqual(by[(g, "aa_context_window")], "500.0")            # thousands of tokens
        self.assertEqual(by[(g, "aa_terminalbench_4")], "50.0")            # fraction -> %
        self.assertEqual(by[(g, "aa_briefcase_elo")], "1500.0")            # Elo stays as published
        price = next(p for p in obs["price_obs"] if p["model_id"] == g)
        self.assertEqual(price["blended_3to1_per_1m"], "3.0")              # (3*2 + 6) / 4
        self.assertTrue(all(r["origin"] == "scraped" and r["source_url"] == aa.URL for r in obs["score_obs"]))


class MergeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.seed = self.tmp / "seed"
        shutil.copytree(bs.DEFAULT_SEED, self.seed, ignore=shutil.ignore_patterns("aa"))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_refresh_is_append_only_and_hand_models_win(self):
        chosen = aa.select(aa.records(page(RECS)), 30, {"mistral/mistral-large-4"})
        first = aa.write(self.seed, aa.observations(chosen, "2026-11-07"), bs.TABLES)
        again = aa.write(self.seed, aa.observations(chosen, "2026-11-07"), bs.TABLES)
        later = aa.write(self.seed, aa.observations(chosen, "2026-11-08"), bs.TABLES)
        self.assertGreater(first["score_obs"], 0)
        self.assertEqual(again["score_obs"], 0)                            # same day: nothing new
        self.assertEqual(later["score_obs"], first["score_obs"])           # next day: a fresh row per metric (flat line = checked)
        snap, errs = bs.build(self.seed)
        self.assertEqual(errs, [])
        models = {m["model_id"]: m for m in snap["models"]}
        self.assertEqual(models["mistral/mistral-large-4"]["origin"], "manual")   # the hand row's attributes are kept
        self.assertIn("spacexai/grok-4-7", models)


class StaleTests(unittest.TestCase):
    NOW = datetime(2026, 11, 7, 19)

    def test_redated_old_stories_are_flagged(self):
        self.assertTrue(triage.stale_reasons("Switzerland launched Apertus in September 2025.", "https://x.com/a", self.NOW, 750))
        self.assertTrue(triage.stale_reasons("A new model.", "https://x.com/2024/03/new-model/", self.NOW, 750))

    def test_current_stories_pass(self):
        self.assertEqual(triage.stale_reasons("On November 7, 2026 Acme released Orbit-9, beating its 2025 model.",
                                              "https://x.com/2026/11/orbit/", self.NOW, 750), [])
        self.assertEqual(triage.stale_reasons("Acme released Orbit-9 today.", "https://x.com/a", self.NOW, 750), [])


if __name__ == "__main__":
    unittest.main()
