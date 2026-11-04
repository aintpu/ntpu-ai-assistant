import os
import unittest

os.environ.setdefault("NTPU_SKIP_INDEX_BUILD", "1")
import agentic_v2_5_4high as core  # noqa: E402


class _Client:
    host = "10.0.0.1"  # Worker 轉發到容器時，每個使用者看起來都是這個位址


class _Req:
    def __init__(self, ip=None):
        self.client = _Client()
        self.headers = {"cf-connecting-ip": ip} if ip else {}


class RateLimitIpTests(unittest.TestCase):
    def setUp(self):
        core._request_times.clear()

    def test_uses_cloudflare_client_ip(self):
        self.assertEqual(core._client_ip(_Req("203.0.113.5")), "203.0.113.5")
        self.assertEqual(core._client_ip(_Req()), "10.0.0.1")

    def test_one_busy_user_does_not_block_others(self):
        for _ in range(core.RATE_LIMIT_MAX):
            self.assertFalse(core._is_rate_limited(_Req("203.0.113.5")))
        self.assertTrue(core._is_rate_limited(_Req("203.0.113.5")))
        self.assertFalse(core._is_rate_limited(_Req("198.51.100.7")))


if __name__ == "__main__":
    unittest.main()
