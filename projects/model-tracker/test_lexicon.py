"""python -m unittest test_lexicon -v   (from projects/model-tracker)"""
import copy
import csv
import json
import re
import shutil
import tempfile
import unittest
from datetime import datetime
from pathlib import Path

from scraper import exa_client, fetch, gate, injection, lexicon, run, triage

ROOT = Path(__file__).resolve().parent
LEX = lexicon.load_lexicon()
COMPS = lexicon.load_compositions()
PHRASES = gate.load_phrases(lexicon.PARAMS / "phrases.csv")
PARAMS = run.load_params()
NOW = datetime(2026, 11, 6, 2, 0, 0)
CJK = re.compile(r"[㐀-鿿]")


def zh_of(term_id):
    return next(r["zh"] for r in LEX if r["term_id"] == term_id)


class ShippedLexiconTests(unittest.TestCase):
    def test_every_term_is_approved_and_unchanged(self):
        for r in LEX:
            self.assertTrue(lexicon.term_ok(r), r["term_id"])
            self.assertEqual(gate.sha(r["zh"]), r["zh_sha256"], r["term_id"])

    def test_phrases_are_exactly_what_the_lexicon_composes(self):
        built = {p["param_id"]: p for p in lexicon.build_phrase_rows(LEX, COMPS)}
        shipped = {p["param_id"]: p for p in PHRASES if p["lang"] == "zh"}
        self.assertEqual(set(built), set(shipped))
        for pid, b in built.items():
            self.assertEqual((shipped[pid]["phrase"], shipped[pid]["gloss_en"], shipped[pid]["phrase_sha256"]),
                             (b["phrase"], b["gloss_en"], b["phrase_sha256"]), pid)

    def test_each_concept_has_an_english_and_a_chinese_phrase_except_the_listed_pending_ones(self):
        # search_params/zh_pending.csv names English-only concepts whose Chinese phrase still needs a DeepSeek draft and
        # an Argon review. The list is exact: a concept can neither be English-only unlisted, nor stay listed once it has zh.
        by = {}
        for p in PHRASES:
            by.setdefault(p["concept_id"], set()).add(p["lang"])
        with open(lexicon.PARAMS / "zh_pending.csv", newline="", encoding="utf-8") as f:
            pending = {r["concept_id"] for r in csv.DictReader(f)}
        english_only = {c for c, langs in by.items() if langs == {"en"}}
        self.assertEqual(english_only, pending)
        self.assertTrue(all(langs == {"en", "zh"} for c, langs in by.items() if c not in pending), by)

    def test_scraper_code_holds_no_chinese_literals(self):
        for path in (ROOT / "scraper").glob("*.py"):
            self.assertIsNone(CJK.search(path.read_text(encoding="utf-8")), path.name)

    def test_review_records_exist_and_the_first_was_not_a_pass(self):
        r1 = json.loads((lexicon.PARAMS / "argon_reviews" / "review-01.json").read_text(encoding="utf-8"))
        r2 = json.loads((lexicon.PARAMS / "argon_reviews" / "review-02.json").read_text(encoding="utf-8"))
        self.assertEqual(r1["decision"]["verdict"], "drift")
        self.assertEqual((r2["decision"]["verdict"], r2["decision"]["action"], r2["problems"]), ("ok", "continue", []))
        # Approval only covers what a PASSING review saw. review-02 was Argon; review-03 (2026-11-07) was Opus, by
        # Preet's choice. Every review names its reviewer, and a failed review (review-01) approves nothing.
        seen = set()
        for path in sorted((lexicon.PARAMS / "argon_reviews").glob("review-*.json")):
            rv = json.loads(path.read_text(encoding="utf-8"))
            self.assertTrue(rv.get("reviewer"), path.name)
            if (rv["decision"]["verdict"], rv["decision"]["action"], rv["problems"]) == ("ok", "continue", []):
                seen |= set(rv["reviewed_hashes"])
        for r in LEX:
            if not r["zh"].isascii():
                self.assertIn(r["zh_sha256"], seen, r["term_id"])
        for p in PHRASES:
            if p["lang"] == "zh":
                self.assertIn(p["phrase_sha256"], seen, p["param_id"])


class ValidationTests(unittest.TestCase):
    def test_check_zh_rejects_unsafe_text(self):
        for bad in ("", "x" * 25, "see http://a.b", "a\nb", "a/b", "<b>", '"q"', " ab", "a;rm"):
            with self.assertRaises(lexicon.LexiconError):
                lexicon.check_zh(bad)
        lexicon.check_zh(zh_of("model") + "AI")

    def test_edited_term_stops_being_usable(self):
        r = dict(next(r for r in LEX if r["term_id"] == "model"))
        r["zh"] += "x"
        self.assertFalse(lexicon.term_ok(r))
        r = dict(next(r for r in LEX if r["term_id"] == "model"))
        r["argon_verdict"] = ""
        self.assertFalse(lexicon.term_ok(r))

    def test_compose_spaces_only_between_ascii_neighbours(self):
        phrase, gloss = lexicon.compose(["gpt", "claude", "ai", "model"], LEX)
        self.assertEqual(phrase, "GPT Claude AI" + zh_of("model"))
        self.assertEqual(gloss, "GPT Claude AI model")

    def test_compose_refuses_unknown_or_non_search_terms(self):
        for ids in (["nope"], ["v_release"], ["i_ignore"]):
            with self.assertRaises(lexicon.LexiconError):
                lexicon.compose(ids, LEX)

    def test_ingest_validates_deepseek_reply_strictly(self):
        blank = [dict(r, zh="", zh_sha256="", status="draft", argon_verdict="") if not r["zh"].isascii() else dict(r) for r in LEX]
        todo = [r["term_id"] for r in blank if not r["zh"]]
        good = {"lexicon": {t: "x1" for t in todo},
                "compositions": {pid: ["new", "model"] for pid in lexicon.PARAM_FOR.values()}}
        rows, _ = lexicon.ingest(copy.deepcopy(good), blank)
        self.assertTrue(all(r["status"] == "draft" for r in rows if r["term_id"] in todo))
        cases = []
        extra = copy.deepcopy(good); extra["note"] = "hi"; cases.append(extra)
        missing = copy.deepcopy(good); del missing["lexicon"][todo[0]]; cases.append(missing)
        url = copy.deepcopy(good); url["lexicon"][todo[0]] = "see http://x.y"; cases.append(url)
        trg = copy.deepcopy(good); trg["compositions"]["zh-api-01"] = ["new", "v_release"]; cases.append(trg)
        short = copy.deepcopy(good); short["compositions"]["zh-api-01"] = ["new"]; cases.append(short)
        wrong = copy.deepcopy(good); wrong["compositions"]["zh-other"] = ["new", "model"]; cases.append(wrong)
        for bad in cases:
            with self.assertRaises(lexicon.LexiconError):
                lexicon.ingest(bad, blank)

    def test_apply_review_approves_only_what_was_seen_and_only_on_a_pass(self):
        rows = [dict(r, status="draft", argon_verdict="") if not r["zh"].isascii() else dict(r) for r in LEX]
        phrases = [dict(p, status="draft", argon_verdict="") if p["lang"] == "zh" else dict(p) for p in PHRASES]
        seen = [gate.sha(zh_of("new")), phrases[-1]["phrase_sha256"]]
        ok = {"decision": {"verdict": "ok", "action": "continue"}, "problems": [], "reviewed_hashes": seen}
        counts = lexicon.apply_review(ok, rows, phrases)
        self.assertEqual(counts["phrases"], 1)
        self.assertGreaterEqual(counts["terms"], 1)
        self.assertEqual(next(r for r in rows if r["term_id"] == "model")["status"], "draft")   # not shown to Argon
        for bad in ({"decision": {"verdict": "drift", "action": "retarget"}, "problems": [], "reviewed_hashes": seen},
                    {"decision": {"verdict": "ok", "action": "continue"}, "problems": ["evidence does not quote the digest"], "reviewed_hashes": seen},
                    {"decision": {"verdict": "ok", "action": "stop"}, "problems": [], "reviewed_hashes": seen}):
            with self.assertRaises(lexicon.LexiconError):
                lexicon.apply_review(bad, rows, phrases)


class VocabularyTests(unittest.TestCase):
    def test_chinese_release_hit_is_recognised_with_approved_vocabulary(self):
        text = f"Orbit-9{zh_of('v_release')}{zh_of('n_bigmodel')} benchmark results"
        self.assertEqual(triage.triage(text, 750)["verdict"], "not_release")            # no lexicon: no Chinese knowledge
        self.assertEqual(triage.triage(text, 750, zh=PARAMS["zh_triage"])["verdict"], "release")

    def test_chinese_injection_phrases_are_flagged(self):
        page = f"Great model. {zh_of('i_ignore')}. Thanks."
        self.assertEqual(injection.prescreen(page), [])
        self.assertEqual(injection.prescreen(page, PARAMS["zh_injection"]), ["zh-i_ignore"])

    def test_unapproved_terms_do_not_reach_triage_or_injection(self):
        rows = [dict(r, status="draft") if r["term_id"] in {"v_release", "i_ignore"} else r for r in LEX]
        verbs, _ = lexicon.triage_regexes(rows)
        self.assertNotIn(zh_of("v_release") + "|", (verbs.pattern if verbs else "") + "|")
        self.assertEqual([n for n, _ in lexicon.injection_patterns(rows)].count("zh-i_ignore"), 0)


class ChineseRunTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_chinese_phrase_runs_through_the_same_pipeline(self):
        zh = next(p for p in PHRASES if p["param_id"] == "zh-release-01")
        docs = {zh["phrase"]: {"costDollars": {"total": 0.007}, "results": [
            {"url": "https://news.example.cn/a", "publishedDate": "2026-11-06T01:00:00.000Z",
             "text": f"Orbit-9{zh_of('v_release')}{zh_of('n_bigmodel')}"},
            {"url": "https://news.example.cn/b", "publishedDate": "2026-11-06T00:00:00.000Z",
             "text": f"{zh_of('model')} news. {zh_of('i_ignore')}, then {zh_of('i_sendkey')}"}]}}
        exa = exa_client.FixtureExa(docs)
        res = run.run("2026-11-06T02", NOW, self.tmp, PARAMS, [], exa, fetch.FixturePages({}))
        self.assertIn(zh["phrase"], [b["query"] for b in exa.calls])
        verdicts = {h["url"][-1]: h["verdict"] for h in res["hits"]}
        self.assertEqual(verdicts, {"a": "release", "b": "quarantined"})

    def test_an_edited_chinese_phrase_is_stopped_by_the_gate(self):
        rows = copy.deepcopy(PHRASES)
        zh = next(r for r in rows if r["param_id"] == "zh-bench-01")
        zh["phrase"] += zh_of("new")
        exa = exa_client.FixtureExa({})
        res = run.run("2026-11-06T02", NOW, self.tmp, {**PARAMS, "phrases": rows}, [], exa, fetch.FixturePages({}))
        self.assertEqual(len(exa.calls), len(PARAMS["phrases"]) - 1)
        self.assertTrue(any("hash does not match" in m for m in res["error_messages"]))


if __name__ == "__main__":
    unittest.main()
