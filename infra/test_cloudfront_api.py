"""Offline tests for the config-building parts of cloudfront_api.py (no AWS calls).

    python -m unittest discover infra -p "test_*.py"
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cloudfront_api as c  # noqa: E402

OUT = {"GatewayOriginDomain": "g.lambda-url.us-east-1.on.aws", "NewsroomOriginDomain": "n.lambda-url.us-east-1.on.aws",
       "TriggerOriginDomain": "t.lambda-url.us-east-1.on.aws", "OriginAccessControlId": "OAC1"}
HASH = "ab" * 32


class ConfigTest(unittest.TestCase):
    def test_auth_code_per_behavior(self):
        g = c.auth_code(c.AUTHS["gateway"], HASH)
        n = c.auth_code(c.AUTHS["newsroom"], HASH)
        self.assertIn("Edge check for /api/gateway/*.", g)
        self.assertIn("headers['x-gateway-key']", g)
        self.assertIn("headers['x-newsroom-key']", n)
        self.assertIn(f"var WANT = '{HASH}';", n)
        self.assertNotIn("@", g + n)
        self.assertIn("var DAY = '';", n)

    def test_day_key_baked_with_expiry_ms(self):
        n = c.auth_code(c.AUTHS["newsroom"], HASH, ("b" * 64, 1700000000))
        self.assertIn(f"var DAY = '{'b' * 64}';", n)
        self.assertIn("var DAY_UNTIL = 1700000000000;", n)
        self.assertNotIn("@", n)

    def test_parse_day(self):
        self.assertEqual(c.parse_day(f"{'B' * 64}:17"), ("b" * 64, 17))
        for bad in (None, "none", "b" * 64, "zz:1", f"{'b' * 64}:soon"):
            self.assertIsNone(c.parse_day(bad))

    def test_order_most_specific_first_and_default_last(self):
        paths = [a["path"] for a in c.ATTACHMENTS]
        self.assertEqual(paths, ["/api/gateway/*", "/api/newsroom/*", "/api/*"])

    def test_select_all(self):
        active, skipped = c.select_attachments(OUT, {"gateway": HASH, "newsroom": HASH})
        self.assertEqual(len(active), 3)
        self.assertEqual(skipped, [])

    def test_select_skips_newsroom_without_param_or_output(self):
        active, skipped = c.select_attachments(OUT, {"gateway": HASH, "newsroom": None})
        self.assertEqual([a["path"] for a in active], ["/api/gateway/*", "/api/*"])
        self.assertIn("/patelpb/newsroom/key-sha256", skipped[0])
        no_out = {k: v for k, v in OUT.items() if k != "NewsroomOriginDomain"}
        active, skipped = c.select_attachments(no_out, {"gateway": HASH, "newsroom": HASH})
        self.assertEqual(len(active), 2)
        self.assertIn("NewsroomOriginDomain", skipped[0])

    def test_desired(self):
        active, _ = c.select_attachments(OUT, {"gateway": HASH, "newsroom": HASH})
        o, b = c.desired(active, OUT, {"gateway": "arn:g", "newsroom": "arn:n"})
        self.assertEqual([x["Id"] for x in o], ["lambda-gateway", "lambda-newsroom", "lambda-rs-refresh-trigger"])
        self.assertEqual([x["DomainName"] for x in o], [OUT["GatewayOriginDomain"], OUT["NewsroomOriginDomain"],
                                                        OUT["TriggerOriginDomain"]])
        self.assertTrue(all(x["OriginAccessControlId"] == "OAC1" for x in o))
        fns = [x["FunctionAssociations"] for x in b]
        self.assertEqual(fns[0]["Items"][0]["FunctionARN"], "arn:g")
        self.assertEqual(fns[1]["Items"][0]["FunctionARN"], "arn:n")
        self.assertEqual(fns[2], {"Quantity": 0})
        self.assertEqual([x["TargetOriginId"] for x in b], [x["Id"] for x in o])

    def test_set_items(self):
        box = {"Quantity": 1, "Items": [1]}
        c.set_items(box, [])
        self.assertEqual(box, {"Quantity": 0})
        c.set_items(box, [1, 2])
        self.assertEqual(box, {"Quantity": 2, "Items": [1, 2]})

    def test_seeds(self):
        self.assertEqual(c.SEEDS["newsroom"]["live/newsroom/beat.json"],
                         {"v": 1, "beat": 0, "busy": False, "version": None})
        self.assertEqual(c.SEEDS["newsroom"]["live/newsroom/inbox/index.json"], {"v": 1, "seq": 0, "ids": []})


if __name__ == "__main__":
    unittest.main()
