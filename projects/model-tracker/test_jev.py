"""python -m unittest discover projects/model-tracker -p "test_*.py" -v"""
import unittest

from scraper import injection, jev, triage


def fake(answer):
    """A post() stand-in: records every payload and returns `answer` (or raises it if it is an exception)."""
    sent = []

    def post(key, payload):
        sent.append((key, payload))
        if isinstance(answer, Exception):
            raise answer
        return {"answers": {next(iter(payload["questions"])): answer}}
    post.sent = sent
    return post


class JevTests(unittest.TestCase):
    def test_no_key_means_no_judges(self):
        self.assertIsNone(jev.make_judges({}, {}))
        self.assertIsNone(jev.make_judges({"TYPESAFE_API_KEY": "  "}, {}))
        self.assertIsNotNone(jev.make_judges({"TYPESAFE_API_KEY": "k"}, {}))

    def test_triage_needs_confidence(self):
        j = jev.Judges("k", 5, fake({"choice": "release", "confidence": 0.95}))
        self.assertEqual(j.triage("x"), "release")
        j = jev.Judges("k", 5, fake({"choice": "release", "confidence": 0.5}))
        self.assertEqual(j.triage("x"), "unsure")

    def test_unknown_choice_or_garbage_stays_unsure(self):
        for bad in ({"choice": "maybe", "confidence": 0.99}, {"choice": "release"}, {"choice": "release", "confidence": True}, "text"):
            self.assertEqual(jev.Judges("k", 5, fake(bad)).triage("x"), "unsure")

    def test_failure_falls_back_and_is_counted(self):
        j = jev.Judges("k", 5, fake(jev.JevError("Timeout")))
        self.assertEqual(j.triage("x"), "unsure")
        self.assertEqual(j.injection("x"), 0.0)
        self.assertEqual(j.summary()["jev_failures"], 2)

    def test_call_cap_declines(self):
        post = fake({"choice": "release", "confidence": 0.99})
        j = jev.Judges("k", 2, post)
        self.assertEqual([j.triage("x") for _ in range(4)], ["release", "release", "unsure", "unsure"])
        self.assertEqual(len(post.sent), 2)
        self.assertEqual(j.summary(), {"jev_calls": 2, "jev_failures": 0, "jev_declined": 2})

    def test_injection_probability_is_bounded(self):
        self.assertEqual(jev.Judges("k", 5, fake({"noul": 0.9})).injection("x"), 0.9)
        self.assertEqual(jev.Judges("k", 5, fake({"noul": 7})).injection("x"), 0.0)
        self.assertEqual(jev.Judges("k", 5, fake({"noul": "high"})).injection("x"), 0.0)

    def test_only_the_head_of_the_text_is_sent(self):
        post = fake({"noul": 0.1})
        jev.Judges("k", 5, post).injection("a" * 50000)
        self.assertEqual(len(post.sent[0][1]["state"]), jev.JUDGE_CHARS)

    def test_plugs_into_triage_and_injection(self):
        text = "An analyst discusses the AI model market."
        self.assertEqual(triage.triage(text, 750)["verdict"], "unsure")
        j = jev.Judges("k", 5, fake({"choice": "not_release", "confidence": 0.9}))
        self.assertEqual(triage.triage(text, 750, j.triage)["verdict"], "not_release")
        hot = jev.Judges("k", 5, fake({"noul": 0.8}))
        self.assertTrue(injection.screen("a harmless sentence", hot.injection)["flagged"])


if __name__ == "__main__":
    unittest.main()
