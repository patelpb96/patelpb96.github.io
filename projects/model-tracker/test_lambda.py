"""python -m unittest discover projects/model-tracker -p "test_*.py" -v"""
import io
import json
import unittest
from datetime import datetime
from pathlib import Path

from scraper import exa_client, fetch, lambda_handler as lh, run
from test_aa_source import RECS, page

FX = json.loads((Path(__file__).parent / "scraper" / "fixtures" / "dry_run.json").read_text(encoding="utf-8"))
NOW = datetime(2026, 11, 6, 2, 0, 0)
ENV = {"STATE_BUCKET": "state-b", "SITE_BUCKET": "site-b", "MODELS_KEY": "projects/models/data/latest.json",
       "EXA_KEY_PARAM": "/p/exa", "TYPESAFE_KEY_PARAM": "/p/typesafe"}


class Err(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.response = {"Error": {"Code": code}}


class ParameterNotFound(Exception):
    pass


class FakeS3:
    def __init__(self):
        self.objects = {}

    def get_object(self, Bucket, Key):
        if (Bucket, Key) not in self.objects:
            raise Err("NoSuchKey")
        return {"Body": io.BytesIO(self.objects[(Bucket, Key)])}

    def put_object(self, Bucket, Key, Body, IfNoneMatch=None):
        if IfNoneMatch == "*" and (Bucket, Key) in self.objects:
            raise Err("PreconditionFailed")
        self.objects[(Bucket, Key)] = Body

    def list_objects_v2(self, Bucket, Prefix, ContinuationToken=None):
        return {"Contents": [{"Key": k} for b, k in sorted(self.objects) if b == Bucket and k.startswith(Prefix)], "IsTruncated": False}

    def keys(self, bucket="state-b"):
        return {k for b, k in self.objects if b == bucket}


class FakeSSM:
    def __init__(self, values):
        self.values, self.asked = values, []

    def get_parameter(self, Name, WithDecryption):
        self.asked.append((Name, WithDecryption))
        if Name not in self.values:
            raise ParameterNotFound(Name)
        return {"Parameter": {"Value": self.values[Name]}}


class LambdaTests(unittest.TestCase):
    def setUp(self):
        self.s3 = FakeS3()
        self.s3.objects[("site-b", ENV["MODELS_KEY"])] = json.dumps({"models": FX["models"]}).encode()
        self.ssm = FakeSSM({"/p/exa": "exa-test-key"})
        self.aa_html = page(RECS)

    def go(self, now=NOW, ssm=None):
        exa = exa_client.FixtureExa(FX["exa"])
        out = lh.run_once(now, self.s3, ssm or self.ssm, ENV, exa=exa, pages=fetch.FixturePages(FX["pages"]), aa_html=self.aa_html)
        return out, exa

    def test_first_run_writes_ledgers_raw_lock_and_spend(self):
        out, exa = self.go()
        self.assertEqual(out["status"], "ok")
        self.assertEqual(len(exa.calls), len(run.load_params()["phrases"]))
        keys = self.s3.keys()
        for k in ("state/hits.csv", "state/runs.csv", "state/candidates.csv", "state/locks/2026-11-06T02.lock", "state/spend/2026-11-06.json"):
            self.assertIn(k, keys)
        self.assertTrue(any(k.startswith("state/raw/2026/11/06/") for k in keys))
        self.assertEqual(self.s3.keys("site-b"), {ENV["MODELS_KEY"]})       # the public site bucket is only read, never written

    def test_same_slot_never_runs_twice_and_next_run_dedupes(self):
        self.go()
        again, exa = self.go()
        self.assertEqual(again["status"], "refused")
        self.assertEqual(exa.calls, [])
        later, _ = self.go(datetime(2026, 11, 6, 6))
        self.assertEqual((later["status"], later["new_hits"]), ("ok", 0))       # hits.csv came back from S3, so all are duplicates
        self.assertGreater(later["duplicates"], 0)

    def test_s3_lock_wins_even_if_local_state_missed_it(self):
        self.s3.objects[("state-b", "state/locks/2026-11-06T02.lock")] = b""
        self.s3.list_objects_v2 = lambda **kw: {"Contents": [], "IsTruncated": False}        # a racing invocation not yet listed
        out, exa = self.go()
        self.assertEqual(out["status"], "refused")
        self.assertIn("S3 lock", out["reason"])
        self.assertEqual(exa.calls, [])

    def test_kill_switch_object_stops_everything(self):
        self.s3.objects[("state-b", "state/KILL")] = b""
        out, exa = self.go()
        self.assertEqual(out["status"], "refused")
        self.assertIn("kill switch", out["reason"])
        self.assertEqual(exa.calls, [])

    def test_spend_carries_across_runs(self):
        self.go()
        first = json.loads(self.s3.objects[("state-b", "state/spend/2026-11-06.json")])["usd"]
        self.go(datetime(2026, 11, 6, 6))
        self.assertGreaterEqual(json.loads(self.s3.objects[("state-b", "state/spend/2026-11-06.json")])["usd"], first)

    def test_typesafe_key_is_optional_and_exa_is_decrypted(self):
        out, _ = self.go()
        self.assertEqual(out["jev"], "off")
        self.assertIn(("/p/typesafe", True), self.ssm.asked)

    def test_missing_exa_key_fails_without_echoing_anything(self):
        with self.assertRaises(RuntimeError) as cm:
            lh.run_once(NOW, self.s3, FakeSSM({}), ENV, pages=fetch.FixturePages({}))
        self.assertIn("/p/exa", str(cm.exception))
        self.assertNotIn("state/locks/2026-11-06T02.lock", self.s3.keys())   # failed before taking the slot

    def test_reference_snapshot_is_saved_privately(self):
        out, _ = self.go()
        self.assertEqual(out["aa"]["status"], "ok")
        body = json.loads(self.s3.objects[("state-b", "state/" + out["aa"]["key"])])
        self.assertIn("spacexai/grok-4-7", {m["model_id"] for m in body["models"]})

    def test_reference_failure_never_fails_the_run(self):
        self.aa_html = "<html>layout changed</html>"
        out, _ = self.go()
        self.assertEqual((out["status"], out["aa"]["status"]), ("ok", "error"))
        self.assertIn("state/hits.csv", self.s3.keys())

    def test_result_has_no_page_text_or_keys(self):
        out, _ = self.go()
        blob = json.dumps(out, default=str)
        self.assertNotIn("exa-test-key", blob)
        self.assertNotIn("hits", out)


if __name__ == "__main__":
    unittest.main()
