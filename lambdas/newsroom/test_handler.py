"""Offline tests for the newsroom relay (boto3 is stubbed; no AWS calls).

    python -m unittest discover lambdas/newsroom
"""
import base64
import hashlib
import io
import json
import os
import sys
import types
import unittest

TOKEN = "a" * 64
TOKEN_HASH = hashlib.sha256(TOKEN.encode()).hexdigest()
DAY = "d" * 64
DAY_HASH = hashlib.sha256(DAY.encode()).hexdigest()


class NoSuchKey(Exception):
    def __init__(self):
        self.response = {"Error": {"Code": "NoSuchKey"}}


class FakeS3:
    def __init__(self):
        self.objects: dict[str, dict] = {}

    def put_object(self, Bucket, Key, Body, ContentType, CacheControl):
        self.objects[Key] = {"Bucket": Bucket, "Body": Body, "ContentType": ContentType,
                             "CacheControl": CacheControl}

    def get_object(self, Bucket, Key):
        if Key not in self.objects:
            raise NoSuchKey()
        return {"Body": io.BytesIO(self.objects[Key]["Body"])}


class FakeSSM:
    def __init__(self):
        self.calls = 0
        self.temp = None  # value of the day-key parameter; None = ParameterNotFound
        self.open = None  # value of the open-key parameter; None = ParameterNotFound

    def get_parameter(self, Name):
        self.calls += 1
        if Name == "/test/temp":
            if self.temp is None:
                raise Exception("ParameterNotFound")
            return {"Parameter": {"Value": self.temp}}
        if Name == "/test/open":
            if self.open is None:
                raise Exception("ParameterNotFound")
            return {"Parameter": {"Value": self.open}}
        return {"Parameter": {"Value": TOKEN_HASH + "\n"}}


FAKE_S3, FAKE_SSM = FakeS3(), FakeSSM()
fake_boto3 = types.ModuleType("boto3")
fake_boto3.client = lambda name: FAKE_S3 if name == "s3" else FAKE_SSM
sys.modules["boto3"] = fake_boto3
os.environ.update(BUCKET="test-bucket", KEY_HASH_PARAM="/test/param", TEMP_HASH_PARAM="/test/temp",
                  OPEN_HASH_PARAM="/test/open")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import handler as h  # noqa: E402

h.print = lambda *a, **k: None  # silence the per-put log line
h.traceback.print_exc = lambda *a, **k: None

IV = base64.b64encode(b"\x01" * 12).decode()
CT = base64.b64encode(b"\x02" * 40).decode()
PFX = "live/newsroom/"


def envelope(name, seq=1, **over):
    doc = {"v": 1, "name": name, "seq": seq, "iv": IV, "ct": CT}
    doc.update(over)
    return doc


def event(body, method="POST", path="/api/newsroom/put", key=TOKEN, raw=None):
    headers = {"X-Newsroom-Key": key} if key is not None else {}
    return {"rawPath": path, "headers": headers, "requestContext": {"http": {"method": method}},
            "body": raw if raw is not None else json.dumps(body)}


def call(name, doc, **kw):
    return h.handler(event({"name": name, "doc": doc}, **kw), None)


class HandlerTest(unittest.TestCase):
    def setUp(self):
        FAKE_S3.objects.clear()
        h._hash = None

    def stored(self, name):
        return json.loads(FAKE_S3.objects[PFX + name]["Body"])

    # ------------------------------------------------------------------ auth
    def test_auth_ok_writes_with_headers(self):
        r = call("out/index.json", envelope("out/index.json"))
        self.assertEqual(r["statusCode"], 200)
        self.assertEqual(json.loads(r["body"]), {"status": "ok"})
        self.assertEqual(r["headers"]["Cache-Control"], "no-store")
        obj = FAKE_S3.objects[PFX + "out/index.json"]
        self.assertEqual(obj["CacheControl"], "public, max-age=1")
        self.assertIn("application/json", obj["ContentType"])
        self.assertEqual(obj["Bucket"], "test-bucket")

    def test_auth_missing_and_wrong(self):
        env = envelope("out/index.json")
        self.assertEqual(call("out/index.json", env, key=None)["statusCode"], 401)
        self.assertEqual(call("out/index.json", env, key="")["statusCode"], 401)
        self.assertEqual(call("out/index.json", env, key="b" * 64)["statusCode"], 401)
        self.assertFalse(FAKE_S3.objects)

    def test_hash_cached(self):
        FAKE_SSM.calls = 0
        call("beat.json", {"v": 1, "beat": 1})
        call("beat.json", {"v": 1, "beat": 2})
        self.assertEqual(FAKE_SSM.calls, 1)

    # ------------------------------------------------------------ name rules
    def test_good_names(self):
        for name in ("out/index.json", "inbox/r-abcd1234.json", "out/r-abcd1234/status.json",
                     "out/r-" + "z9" * 16 + "/plane.json", "out/r-abcd1234/edition.json"):
            self.assertEqual(call(name, envelope(name))["statusCode"], 200, name)

    def test_bad_names(self):
        for name in ("../beat.json", "inbox/../beat.json", "config.json", "inbox/index.json",
                     "inbox/r-abc.json", "inbox/r-ABCD1234.json", "out/r-abcd1234/other.json",
                     "out/r-abcd1234/edition.json\n", "beat.json\n", "/beat.json", "out/../../x.json",
                     "out/r-abcd1234/../r-abcd5678/status.json", "inbox/r-abcd1234.json/", "",
                     "out/r-" + "a" * 33 + "/status.json", None, 5):
            r = call(name, envelope(str(name)))
            self.assertEqual(r["statusCode"], 400, repr(name))
        self.assertFalse(FAKE_S3.objects)

    # -------------------------------------------------------------- envelope
    def test_envelope_name_mismatch(self):
        r = call("out/index.json", envelope("out/r-abcd1234/status.json"))
        self.assertEqual(r["statusCode"], 400)
        self.assertFalse(FAKE_S3.objects)

    def test_envelope_shape(self):
        n = "out/index.json"
        bad = [
            envelope(n, v=2), envelope(n, seq="1"), envelope(n, seq=True), envelope(n, seq=-1),
            envelope(n, seq=1.5), envelope(n, iv="short"), envelope(n, iv=base64.b64encode(b"x" * 16).decode()),
            envelope(n, ct=""), envelope(n, ct="abc"), envelope(n, ct="!!!!" * 8), envelope(n, ct=5),
            envelope(n, extra=1),
            {"v": 1, "name": n, "seq": 1, "iv": IV}, "string", None, [],
        ]
        for doc in bad:
            self.assertEqual(call(n, doc)["statusCode"], 400, repr(doc)[:60])

    # ------------------------------------------------------------------ beat
    def test_beat_valid(self):
        for doc in ({"v": 1, "beat": 123}, {"v": 1, "beat": 123, "busy": True, "version": "0.1.0"},
                    {"v": 1, "beat": 123, "busy": False, "version": None}):
            self.assertEqual(call("beat.json", doc)["statusCode"], 200)
            self.assertEqual(self.stored("beat.json"), doc)

    def test_beat_invalid(self):
        for doc in ({}, {"v": 1}, {"v": 2, "beat": 1}, {"v": 1, "beat": "1"}, {"v": 1, "beat": 1, "x": 1},
                    {"v": 1, "beat": 1, "busy": "yes"}, {"v": 1, "beat": 1, "version": 3},
                    {"v": 1, "beat": 1, "version": "v" * 2000}, [1], "x", None,
                    envelope("beat.json")):
            self.assertEqual(call("beat.json", doc)["statusCode"], 400, repr(doc)[:60])

    # ----------------------------------------------------------- inbox index
    def test_inbox_creates_index(self):
        n = "inbox/r-abcd1234.json"
        self.assertEqual(call(n, envelope(n))["statusCode"], 200)
        self.assertEqual(self.stored("inbox/index.json"), {"v": 1, "seq": 1, "ids": ["r-abcd1234"]})
        self.assertIn(PFX + n, FAKE_S3.objects)

    def test_inbox_dedup_and_seq(self):
        a, b = "inbox/r-aaaaaaaa.json", "inbox/r-bbbbbbbb.json"
        call(a, envelope(a))
        call(b, envelope(b))
        call(a, envelope(a, seq=2))
        self.assertEqual(self.stored("inbox/index.json"),
                         {"v": 1, "seq": 3, "ids": ["r-aaaaaaaa", "r-bbbbbbbb"]})

    def test_inbox_cap_50_keeps_newest(self):
        for i in range(55):
            n = f"inbox/r-id{i:06d}.json"
            call(n, envelope(n))
        idx = self.stored("inbox/index.json")
        self.assertEqual(len(idx["ids"]), 50)
        self.assertEqual(idx["ids"][0], "r-id000005")
        self.assertEqual(idx["ids"][-1], "r-id000054")
        self.assertEqual(idx["seq"], 55)

    def test_inbox_corrupt_index_resets(self):
        FAKE_S3.objects[PFX + "inbox/index.json"] = {"Body": b"not json"}
        n = "inbox/r-abcd1234.json"
        call(n, envelope(n))
        self.assertEqual(self.stored("inbox/index.json"), {"v": 1, "seq": 1, "ids": ["r-abcd1234"]})

    def test_non_inbox_leaves_index_alone(self):
        call("out/index.json", envelope("out/index.json"))
        self.assertNotIn(PFX + "inbox/index.json", FAKE_S3.objects)

    # ------------------------------------------------------ transport errors
    def test_413(self):
        big = json.dumps({"name": "out/index.json", "doc": envelope("out/index.json", ct="A" * (901 * 1024))})
        self.assertEqual(h.handler(event(None, raw=big), None)["statusCode"], 413)

    def test_413_base64_body(self):
        ev = event(None, raw=base64.b64encode(b"x" * (901 * 1024)).decode())
        ev["isBase64Encoded"] = True
        self.assertEqual(h.handler(ev, None)["statusCode"], 413)

    def test_base64_body_ok(self):
        n = "out/index.json"
        raw = json.dumps({"name": n, "doc": envelope(n)})
        ev = event(None, raw=base64.b64encode(raw.encode()).decode())
        ev["isBase64Encoded"] = True
        self.assertEqual(h.handler(ev, None)["statusCode"], 200)

    def test_405(self):
        for m in ("GET", "PUT", "DELETE", ""):
            r = h.handler(event({}, method=m), None)
            self.assertEqual(r["statusCode"], 405)
            self.assertEqual(r["headers"]["Allow"], "POST")

    def test_unknown_route(self):
        self.assertEqual(h.handler(event({}, path="/api/newsroom/other"), None)["statusCode"], 400)
        self.assertEqual(h.handler(event({}, path="/api/gateway/put"), None)["statusCode"], 400)

    def test_trailing_slash_route_ok(self):
        n = "out/index.json"
        self.assertEqual(h.handler(event({"name": n, "doc": envelope(n)}, path="/api/newsroom/put/"),
                                   None)["statusCode"], 200)

    def test_bad_json(self):
        for raw in ("{nope", "", "[1]", '"s"'):
            self.assertEqual(h.handler(event(None, raw=raw), None)["statusCode"], 400, raw)

    def test_missing_doc(self):
        self.assertEqual(h.handler(event({"name": "beat.json"}), None)["statusCode"], 400)

    def test_never_403_404(self):
        codes = {call("../x", {}, key=k)["statusCode"] for k in (None, TOKEN)}
        self.assertTrue(codes.isdisjoint({403, 404}))

    def test_s3_failure_is_500(self):
        orig = FAKE_S3.put_object
        FAKE_S3.put_object = lambda **kw: (_ for _ in ()).throw(RuntimeError("boom"))
        try:
            self.assertEqual(call("beat.json", {"v": 1, "beat": 1})["statusCode"], 500)
        finally:
            FAKE_S3.put_object = orig


class DayKeyTest(unittest.TestCase):
    def setUp(self):
        FAKE_S3.objects.clear()
        h._temp = None

    def tearDown(self):
        FAKE_SSM.temp = None
        h._temp = None

    def put_beat(self, key):
        return call("beat.json", {"v": 1, "beat": 1, "busy": False, "version": "x"}, key=key)["statusCode"]

    def test_no_day_key(self):
        self.assertEqual(self.put_beat(DAY), 401)
        self.assertEqual(self.put_beat(TOKEN), 200)

    def test_unexpired_day_key_works_alongside_master(self):
        import time
        FAKE_SSM.temp = f"{DAY_HASH}:{time.time() + 3600:.0f}"
        self.assertEqual(self.put_beat(DAY), 200)
        self.assertEqual(self.put_beat(TOKEN), 200)

    def test_expired_day_key_rejected(self):
        import time
        FAKE_SSM.temp = f"{DAY_HASH}:{time.time() - 1:.0f}"
        self.assertEqual(self.put_beat(DAY), 401)
        self.assertEqual(self.put_beat(TOKEN), 200)

    def test_none_and_garbage(self):
        for v in ("none", "zz:abc", DAY_HASH):
            FAKE_SSM.temp, h._temp = v, None
            self.assertEqual(self.put_beat(DAY), 401, v)


OPEN = "e" * 64
OPEN_HASH = hashlib.sha256(OPEN.encode()).hexdigest()


class OpenKeyTest(unittest.TestCase):
    def setUp(self):
        import time
        FAKE_S3.objects.clear()
        h._open = None
        self.exp = int(time.time() + 3600)
        FAKE_SSM.open = f"{OPEN_HASH}:{self.exp}:3"

    def tearDown(self):
        FAKE_SSM.open = None
        h._open = None

    def stored(self, name):
        return json.loads(FAKE_S3.objects[PFX + name]["Body"])

    def send(self, rid, key=OPEN):
        name = f"open/inbox/{rid}.json"
        return call(name, envelope(name), key=key)["statusCode"]

    def test_open_key_only_sends_requests(self):
        for name in ("out/index.json", "open/out/index.json", "open/out/r-abcd1234/edition.json",
                     "inbox/r-abcd1234.json", "out/r-abcd1234/status.json"):
            self.assertEqual(call(name, envelope(name), key=OPEN)["statusCode"], 401, name)
        self.assertEqual(call("beat.json", {"v": 1, "beat": 1}, key=OPEN)["statusCode"], 401)
        self.assertFalse(FAKE_S3.objects)

    def test_open_request_goes_to_open_index(self):
        self.assertEqual(self.send("r-abcd1234"), 200)
        idx = self.stored("open/inbox/index.json")
        self.assertEqual((idx["ids"], idx["period"], idx["seq"]), (["r-abcd1234"], self.exp, 1))
        self.assertNotIn(PFX + "inbox/index.json", FAKE_S3.objects)

    def test_limit_per_period(self):
        for i in range(3):
            self.assertEqual(self.send(f"r-abcd000{i}"), 200)
        self.assertEqual(self.send("r-abcd0009"), 429)
        self.assertNotIn(PFX + "open/inbox/r-abcd0009.json", FAKE_S3.objects)
        # A new open period (new expiry) starts with a fresh allowance.
        FAKE_SSM.open, h._open = f"{OPEN_HASH}:{self.exp + 60}:3", None
        self.assertEqual(self.send("r-abcd0009"), 200)
        self.assertEqual(self.stored("open/inbox/index.json")["ids"], ["r-abcd0009"])

    def test_no_overwrite(self):
        self.assertEqual(self.send("r-abcd1234"), 200)
        self.assertEqual(self.send("r-abcd1234"), 409)

    def test_master_still_writes_open_outputs(self):
        for name in ("open/out/index.json", "open/out/r-abcd1234/status.json"):
            self.assertEqual(call(name, envelope(name))["statusCode"], 200, name)

    def test_expired_closed_or_garbage(self):
        import time
        for v in (f"{OPEN_HASH}:{time.time() - 1:.0f}:3", "none", f"{OPEN_HASH}:{self.exp}", f"{OPEN_HASH}:{self.exp}:0"):
            FAKE_SSM.open, h._open = v, None
            self.assertEqual(self.send("r-abcd1234"), 401, v)
        FAKE_SSM.open, h._open = None, None
        self.assertEqual(self.send("r-abcd1234"), 401)

    def test_open_body_cap(self):
        name = "open/inbox/r-abcd1234.json"
        big = envelope(name, ct=base64.b64encode(b"\x02" * 9000).decode())
        self.assertEqual(call(name, big, key=OPEN)["statusCode"], 413)
        self.assertEqual(call(name, big)["statusCode"], 413)   # requests are capped for every key

    def test_request_ct_cap(self):
        at_cap = "A" * h.MAX_REQUEST_CT
        over = "A" * (h.MAX_REQUEST_CT + 4)
        for name, key in (("open/inbox/r-abcd1234.json", OPEN), ("inbox/r-abcd5678.json", TOKEN)):
            self.assertEqual(call(name, envelope(name, ct=over), key=key)["statusCode"], 413, name)
            self.assertNotIn(PFX + name, FAKE_S3.objects)
            self.assertEqual(call(name, envelope(name, ct=at_cap), key=key)["statusCode"], 200, name)
        # outputs aren't requests; the master key still writes big editions
        big = envelope("out/r-abcd1234/edition.json", ct="A" * (h.MAX_REQUEST_CT * 10))
        self.assertEqual(call("out/r-abcd1234/edition.json", big)["statusCode"], 200)


if __name__ == "__main__":
    unittest.main()
