"""Offline tests for the search proxy (boto3 and the Exa HTTP call are stubbed; no network).

    python -m unittest discover lambdas/search
"""
import hashlib
import io
import json
import os
import sys
import types
import unittest
import urllib.error

PW = "p" * 64
DEV = "d" * 64
H = lambda s: hashlib.sha256(s.encode()).hexdigest()  # noqa: E731


class ParameterNotFound(Exception):
    pass


class FakeSSM:
    def __init__(self):
        self.values = {}

    def reset(self):
        self.values = {"/t/key": H(PW) + "\n", "/t/device": H(DEV), "/t/exa": "exa-secret"}

    def get_parameter(self, Name, WithDecryption=False):
        if Name not in self.values:
            raise ParameterNotFound(Name)
        return {"Parameter": {"Value": self.values[Name]}}

    def put_parameter(self, Name, Value, Type, Overwrite):
        self.values[Name] = Value


FAKE_SSM = FakeSSM()
fake_boto3 = types.ModuleType("boto3")
fake_boto3.client = lambda name: FAKE_SSM
sys.modules["boto3"] = fake_boto3
os.environ.update(KEY_HASH_PARAM="/t/key", DEVICE_HASH_PARAM="/t/device", EXA_KEY_PARAM="/t/exa",
                  SPEND_PARAM="/t/spend", DAILY_CAP_USD="1")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import handler as h  # noqa: E402


class FakeResp(io.BytesIO):
    status = 200

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class SearchTest(unittest.TestCase):
    def setUp(self):
        FAKE_SSM.reset()
        h._cache.clear()
        self.sent = []
        self.reply = (200, {"results": [], "costDollars": {"total": 0.25}})

        def urlopen(req, timeout):
            self.sent.append(req)
            code, doc = self.reply
            if code != 200:
                raise urllib.error.HTTPError(req.full_url, code, "x", {}, io.BytesIO(json.dumps(doc).encode()))
            return FakeResp(json.dumps(doc).encode())

        h.urllib.request.urlopen = urlopen

    def call(self, action, body=None, key=PW, method="POST"):
        ev = {"rawPath": "/api/search/" + action, "requestContext": {"http": {"method": method}},
              "headers": {"X-Search-Key": key} if key else {}, "body": json.dumps(body or {})}
        r = h.handler(ev, None)
        return r["statusCode"], json.loads(r["body"])

    def test_auth_roles(self):
        self.assertEqual(self.call("whoami")[1]["role"], "password")
        self.assertEqual(self.call("whoami", key=DEV)[1]["role"], "device")
        self.assertEqual(self.call("whoami", key="nope")[0], 401)
        self.assertEqual(self.call("whoami", key=None)[0], 401)

    def test_routes_and_methods(self):
        self.assertEqual(self.call("other")[0], 400)
        self.assertEqual(self.call("search", method="GET")[0], 405)

    def test_search_forwards_key_and_user_identifier(self):
        code, doc = self.call("search", {"request": {"query": "q", "type": "auto", "numResults": 5}})
        self.assertEqual(code, 200)
        req = self.sent[0]
        self.assertEqual(req.full_url, "https://api.exa.ai/search")
        self.assertEqual(req.get_header("X-api-key"), "exa-secret")
        sent = json.loads(req.data)
        self.assertEqual(sent["userIdentifier"], "patelpb-password")
        self.assertNotIn("Exa-beta", req.headers)

    def test_password_limits(self):
        self.assertEqual(self.call("search", {"request": {"query": "q", "numResults": 26}})[0], 400)
        self.assertEqual(self.call("search", {"request": {"query": "q", "numResults": 100}}, key=DEV)[0], 200)
        self.assertEqual(self.call("search", {"request": {"query": "q", "stream": True}})[0], 400)
        self.assertEqual(self.call("search", {"request": {"query": " "}})[0], 400)

    def test_daily_cap_applies_to_password_only(self):
        self.reply = (200, {"results": [], "costDollars": {"total": 0.6}})
        self.assertEqual(self.call("search", {"request": {"query": "a"}})[0], 200)
        self.assertEqual(self.call("search", {"request": {"query": "b"}})[0], 200)  # 1.2 spent now
        code, doc = self.call("search", {"request": {"query": "c"}})
        self.assertEqual(code, 429)
        self.assertEqual(self.call("search", {"request": {"query": "d"}}, key=DEV)[0], 200)
        self.assertAlmostEqual(self.call("whoami")[1]["spent_today"], 1.2)

    def test_agent_password_caps_and_reserves_budget(self):
        self.reply = (200, {"id": "agent_run_1", "status": "queued"})
        self.assertEqual(self.call("agent", {"request": {"query": "q", "effort": "ultra"}})[0], 400)
        self.assertEqual(self.call("agent", {"request": {"query": "q", "budget": {"maxCostDollars": 5}}})[0], 400)
        code, _ = self.call("agent", {"request": {"query": "q"}})
        self.assertEqual(code, 200)
        sent = json.loads(self.sent[-1].data)
        self.assertEqual(sent["budget"], {"maxCostDollars": 2.0})
        self.assertEqual(self.call("whoami")[1]["spent_today"], 2.0)
        code, _ = self.call("agent", {"request": {"query": "q", "effort": "ultra"}}, key=DEV)
        self.assertEqual(code, 200)
        self.assertNotIn("budget", json.loads(self.sent[-1].data))

    def test_run_poll(self):
        self.reply = (200, {"id": "agent_run_1", "status": "completed"})
        code, doc = self.call("run", {"id": "agent_run_1"})
        self.assertEqual((code, doc["exa"]["status"]), (200, "completed"))
        self.assertTrue(self.sent[-1].full_url.endswith("/agent/runs/agent_run_1"))
        self.assertEqual(self.call("run", {"id": "../x y"})[0], 400)

    def test_beta_header_for_dynamic_highlights(self):
        self.call("search", {"request": {"query": "q", "contents": {"highlights": {"verbosity": "high"}}}})
        self.assertEqual(self.sent[0].get_header("Exa-beta"), h.HIGHLIGHTS_BETA)

    def test_exa_errors_never_403_404(self):
        self.reply = (403, {"error": "blocked", "tag": "TEAM_BLOCKED"})
        self.assertEqual(self.call("search", {"request": {"query": "q"}}, key=DEV)[0], 502)
        self.reply = (400, {"error": "bad schema"})
        code, doc = self.call("search", {"request": {"query": "q"}}, key=DEV)
        self.assertEqual((code, doc["error"]), (400, "bad schema"))

    def test_missing_exa_key(self):
        del FAKE_SSM.values["/t/exa"]
        self.assertEqual(self.call("search", {"request": {"query": "q"}}, key=DEV)[0], 503)
        self.assertFalse(self.call("whoami", key=DEV)[1]["exa_ready"])

    def test_missing_password_param_still_allows_device(self):
        del FAKE_SSM.values["/t/key"]
        self.assertEqual(self.call("whoami", key=PW)[0], 401)
        self.assertEqual(self.call("whoami", key=DEV)[0], 200)


if __name__ == "__main__":
    unittest.main()
