import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
FRONTEND = ROOT / "front_end" / "sports-ai-chat"


class FrontendSystemContractTests(unittest.TestCase):
    def test_about_brand_links_return_to_home(self):
        html = (FRONTEND / "public" / "about.html").read_text(encoding="utf-8")
        self.assertEqual(
            html.count('<a class="brand" href="https://aia.ntpu.ai/">'),
            2,
        )

    def test_about_page_describes_actual_cloudflare_deployment(self):
        html = (FRONTEND / "public" / "about.html").read_text(encoding="utf-8")
        self.assertIn("Cloudflare Workers · Containers · Durable Objects", html)
        self.assertNotIn("GCP Cloud Run · Secret Manager", html)
        self.assertIn("id=\"system-faq-list\"", html)
        self.assertIn("fetch('/system_content.json')", html)

    def test_build_syncs_the_single_system_content_source(self):
        package = json.loads((FRONTEND / "package.json").read_text(encoding="utf-8"))
        workflow = (ROOT / ".github" / "workflows" / "deploy.yml").read_text(encoding="utf-8")
        self.assertIn("sync-system-content.mjs", package["scripts"]["sync:system-content"])
        self.assertIn("sync:system-content", package["scripts"]["prebuild"])
        self.assertIn("npm run build", workflow)
        self.assertIn("out/system_content.json", workflow)
        self.assertTrue((ROOT / "system_content.json").is_file())

    def test_chat_ui_has_system_quick_question_and_source_label(self):
        page = (FRONTEND / "app" / "page.js").read_text(encoding="utf-8")
        self.assertIn('"你可以回答哪些問題？"', page)
        self.assertIn('"What can this system answer?"', page)
        self.assertIn('source.type === "system"', page)
        self.assertIn('systemSources: "系統說明"', page)

    def test_chat_ui_persists_visible_messages_with_session_state(self):
        page = (FRONTEND / "app" / "page.js").read_text(encoding="utf-8")
        self.assertIn("CONVERSATION_MESSAGES_STORAGE_PREFIX", page)
        self.assertIn("sanitizeStoredMessages(messages)", page)
        self.assertIn("setMessages(storedMessages)", page)
        self.assertIn("storedMessages === null", page)
        self.assertIn("setSessionId(createConversationId())", page)
        self.assertIn("if (!sessionReady", page)


if __name__ == "__main__":
    unittest.main()
