"""python -m unittest discover projects/model-tracker -p "test_*.py" -v"""
import csv
import json
import shutil
import tempfile
import unittest
from datetime import datetime
from pathlib import Path

import build_snapshot as bs
from scraper import ledger, review

NOW = datetime(2026, 11, 8, 12, 0, 0)


class ReviewTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.seed, self.data, self.out = self.tmp / "seed", self.tmp / "data", self.tmp / "out" / "latest.json"
        shutil.copytree(bs.DEFAULT_SEED, self.seed)
        self.data.mkdir()
        ledger.append_csv(self.data / "hits.csv", ledger.HIT_COLUMNS, [{
            "hit_id": "run-x:aaa", "run_id": "run-x", "param_id": "p1", "url_hash": "aaa", "url": "https://news.example.com/a?utm_source=feed",
            "domain": "news.example.com", "published_at": "2026-11-08T03:00:00.000Z", "verdict": "release", "reasons": "", "injection_flag": False,
            "injection_reasons": "", "fetch_status": "ok", "first_seen_at": "2026-11-08T04:00:00Z"}])
        self.models = [m["model_id"] for m in bs.build(self.seed)[0]["models"]]
        self.add_candidate(self.models[0], "aa_coding_index", "71.5")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def add_candidate(self, model, bench, value):
        ledger.append_csv(self.data / "candidates.csv", ledger.CANDIDATE_COLUMNS, [{
            "run_id": "run-x", "hit_id": "run-x:aaa", "benchmark_id": bench, "value": value, "model_id": model,
            "status": "resolved" if model else "needs_agent", "snippet": "... 71.5% ...", "url": "https://news.example.com/a?utm_source=feed"}])

    def only(self):
        (c,) = review.pending(self.data)
        return c["cand_id"]

    def test_accept_appends_validates_and_regenerates(self):
        cid = self.only()
        obs = review.accept(cid, self.data, self.seed, NOW, provenance="third_party", effort="High", out=self.out)
        self.assertRegex(obs, r"^s\d{3}$")
        with open(self.seed / "score_obs.csv", encoding="utf-8") as f:
            rows = list(csv.DictReader(f))
        new = rows[-1]
        self.assertEqual((new["obs_id"], new["origin"], new["source_url"], new["reported_date"]),
                         (obs, "scraped", "https://news.example.com/a", "2026-11-08"))      # tracking query stripped, date from the hit
        self.assertIn(obs, {s["obs_id"] for s in json.loads(self.out.read_text(encoding="utf-8"))["scores"]})
        self.assertEqual(review.pending(self.data), [])
        self.assertEqual(review.decisions(self.data)[cid]["decision"], "accepted")

    def test_invalid_row_is_rolled_back(self):
        cid = self.only()
        before = (self.seed / "score_obs.csv").read_text(encoding="utf-8")
        with self.assertRaises(review.ReviewError):
            review.accept(cid, self.data, self.seed, NOW, provenance="third_party", model="nobody/none", out=self.out)
        self.assertEqual((self.seed / "score_obs.csv").read_text(encoding="utf-8"), before)
        self.assertEqual(len(review.pending(self.data)), 1)              # still pending, nothing logged
        self.assertFalse(self.out.exists())

    def test_bad_provenance_is_rolled_back(self):
        before = (self.seed / "score_obs.csv").read_text(encoding="utf-8")
        with self.assertRaises(review.ReviewError):
            review.accept(self.only(), self.data, self.seed, NOW, provenance="trust_me", out=self.out)
        self.assertEqual((self.seed / "score_obs.csv").read_text(encoding="utf-8"), before)

    def test_benchmark_outside_the_seed_is_refused(self):
        (self.data / "candidates.csv").unlink()
        self.add_candidate(self.models[0], "not_a_benchmark", "83.2")
        with self.assertRaises(review.ReviewError) as cm:
            review.accept(self.only(), self.data, self.seed, NOW, provenance="third_party", out=self.out)
        self.assertIn("unknown benchmark_id", str(cm.exception))

    def test_a_defined_but_unscored_benchmark_is_accepted_and_appears(self):
        # GPQA Diamond is defined in the seed with no scores (the page hides it); the first accepted score makes it live.
        (self.data / "candidates.csv").unlink()
        self.add_candidate(self.models[0], "gpqa_diamond", "83.2")
        self.assertNotIn("gpqa_diamond", {s["benchmark_id"] for s in bs.build(self.seed)[0]["scores"]})
        review.accept(self.only(), self.data, self.seed, NOW, provenance="third_party", out=self.out)
        self.assertIn("gpqa_diamond", {s["benchmark_id"] for s in json.loads(self.out.read_text(encoding="utf-8"))["scores"]})

    def test_candidate_without_a_model_needs_one(self):
        (self.data / "candidates.csv").unlink()
        self.add_candidate("", "aa_coding_index", "50")
        cid = self.only()
        with self.assertRaises(review.ReviewError):
            review.accept(cid, self.data, self.seed, NOW, provenance="third_party", out=self.out)
        review.accept(cid, self.data, self.seed, NOW, provenance="third_party", model=self.models[0], out=self.out)

    def test_reject_logs_and_hides(self):
        cid = self.only()
        review.reject(cid, self.data, NOW, "rumour")
        self.assertEqual(review.pending(self.data), [])
        self.assertEqual(review.decisions(self.data)[cid]["note"], "rumour")
        with self.assertRaises(review.ReviewError):                    # a decided candidate cannot be decided again
            review.reject(cid, self.data, NOW)

    def test_same_number_from_same_page_is_not_added_twice(self):
        review.accept(self.only(), self.data, self.seed, NOW, provenance="third_party", out=self.out)
        shutil.copy(self.data / "decisions.csv", self.tmp / "d.csv")
        (self.data / "decisions.csv").unlink()                           # pretend the log was lost: the seed itself must refuse
        with self.assertRaises(review.ReviewError):
            review.accept(self.only(), self.data, self.seed, NOW, provenance="third_party", out=self.out)

    def test_short_id_prefix_and_unknown(self):
        cid = self.only()
        with self.assertRaises(review.ReviewError):
            review.reject("zzzzzzzz", self.data, NOW)
        review.reject(cid[:4], self.data, NOW)


if __name__ == "__main__":
    unittest.main()
