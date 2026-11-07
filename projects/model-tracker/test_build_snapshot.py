"""python -m unittest discover projects/model-tracker -p "test_*.py" -v"""
import json
import shutil
import tempfile
import unittest
from pathlib import Path

import build_snapshot as bs


class SnapshotTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.seed = self.tmp / "seed"
        shutil.copytree(bs.DEFAULT_SEED, self.seed)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def edit(self, name, old, new):
        path = self.seed / name
        text = path.read_text(encoding="utf-8")
        self.assertIn(old, text)
        path.write_text(text.replace(old, new, 1), encoding="utf-8")

    def test_seed_is_valid_and_deterministic(self):
        a, errs = bs.build(self.seed)
        b, _ = bs.build(self.seed)
        self.assertEqual(errs, [])
        self.assertEqual(json.dumps(a), json.dumps(b))
        self.assertGreaterEqual(len(a["models"]), 13)                       # the 13 hand models, plus seed/aa
        self.assertEqual(len({m["model_id"] for m in a["models"]}), len(a["models"]))
        # The page colours companies from a 16-colour palette per theme; a 17th company would reuse a colour.
        self.assertLessEqual(len({m["org"] for m in a["models"]}), 16)

    def test_unknown_model_is_rejected(self):
        self.edit("score_obs.csv", "s001,google/gemini-4-carbon", "s001,google/nope")
        _, errs = bs.build(self.seed)
        self.assertTrue(any("unknown model_id" in e for e in errs))

    def test_not_observed_must_have_blank_value(self):
        self.edit("score_obs.csv", "60.0,observed", "60.0,not_observed")
        _, errs = bs.build(self.seed)
        self.assertTrue(any("not_observed must have a blank value" in e for e in errs))

    def test_observed_needs_a_value(self):
        self.edit("score_obs.csv", "s002,anthropic/claude-opus-5-5,aa_intelligence_index,59.1", "s002,anthropic/claude-opus-5-5,aa_intelligence_index,")
        _, errs = bs.build(self.seed)
        self.assertTrue(any("observed but no value" in e for e in errs))

    def test_history_start_is_enforced(self):
        self.edit("speed_obs.csv", "t001,anthropic/claude-sonnet-5-5,unspecified,136,2026-11-06", "t001,anthropic/claude-sonnet-5-5,unspecified,136,2024-12-31")
        _, errs = bs.build(self.seed)
        self.assertTrue(any("before history_start" in e for e in errs))

    def test_duplicate_obs_id_is_rejected(self):
        self.edit("price_obs.csv", "p002,", "p001,")
        _, errs = bs.build(self.seed)
        self.assertTrue(any("duplicate obs_id" in e for e in errs))

    def test_http_source_is_rejected(self):
        self.edit("speed_obs.csv", "https://temperature2.com/models/", "http://temperature2.com/models/")
        _, errs = bs.build(self.seed)
        self.assertTrue(any("source_url must be https" in e for e in errs))


if __name__ == "__main__":
    unittest.main()
