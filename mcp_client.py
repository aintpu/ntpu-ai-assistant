"""呼叫 NTPU AIA MCP（mcp/，aia.mcp.ntpu.ai）的最小 client。

只用 MCP 的唯讀工具；任何錯誤都丟出 McpUnavailable，由呼叫端退回本機資料，
學生不會因為 MCP 出問題而拿不到答案。
"""
import json
import os
from typing import Any, Dict, Optional

import requests

DEFAULT_MCP_URL = "https://aia.mcp.ntpu.ai/mcp"
TIMEOUT_SECONDS = 8

# AIA 的處室代碼 → MCP 的處室代碼（只列 MCP 有公告的處室）。
# 校長室、副校長室在 MCP 只有介紹頁、沒有公告，不在這裡。
DEPT_TO_MCP_UNIT = {
    "ope": "ope",
    "ge": "cge",
    "lc": "lc",
    "oaa": "oaa",
    "osa": "osa",
    "hr": "op",
    "oga": "oga",
    "ord": "ord",
    "oa": "oa",
    "lib": "library",
    "cic": "cic",
    "oia": "oia",
    "eec": "eec",
    "alu": "alumni",
    "sus": "sustainable",
    "edusp": "edusp",
    "os": "os",
}


# AIA 的處室代碼 → MCP 的（法規 unit, 常見問答 unit）。只列「本機索引用到的法規／FAQ 檔案
# MCP 全部都有」的處室，避免切過去少資料：
# - 體育室、通識（cge_content.md）、語言中心（lc_content.md）有 MCP 沒收的檔案，不在這裡。
# - 校長室要固定帶入「現任校長」並跨副校長室檢索（OFFICE_SEARCH_GROUPS），維持本機。
DEPT_TO_MCP_RECORD_UNITS = {
    "oaa": ("oaa", None),
    "osa": ("osa", None),
    "hr": ("op", "op"),
    "oga": ("oga", "oga"),
    "ord": ("ord", "ord"),
    "oa": ("oa", "oa"),
    "lib": ("library", "library"),
    "cic": ("cic", "cic"),
    "oia": ("oia", "oia"),
    "eec": ("eec", "eec"),
    "alu": ("alumni", "alumni"),
    "sus": (None, "sustainable"),
    "edusp": ("edusp", "edusp"),
    "os": ("os", "os"),
    "vpa": (None, "vice-president-academic"),
    "vpad": (None, "vice-president-administration"),
    "vpf": (None, "vice-president-financial"),
}


# AIA 的處室代碼 → MCP 官網內容頁（search_pages）的 unit。只列 MCP 有登記頁面來源的單位；
# 傳入沒有頁面的 unit（例如 lc）會讓工具回錯誤，所以不能直接沿用公告的對應表。
DEPT_TO_MCP_PAGE_UNIT = {
    "ope": "ope",
    "ge": "cge",
    "oaa": "oaa",
    "osa": "osa",
    "hr": "op",
    "oga": "oga",
    "ord": "ord",
    "oa": "oa",
    "lib": "library",
    "cic": "cic",
    "oia": "oia",
    "eec": "eec",
    "alu": "alumni",
    "sus": "sustainable",
    "edusp": "edusp",
    "os": "os",
    "pres": "president",
    "vpa": "vice-president-academic",
    "vpad": "vice-president-administration",
    "vpf": "vice-president-financial",
}


class McpUnavailable(Exception):
    """MCP 關閉、連不上、逾時或回傳錯誤。"""


def mcp_url() -> str:
    return os.environ.get("MCP_URL", DEFAULT_MCP_URL).strip() or DEFAULT_MCP_URL


def announcements_enabled() -> bool:
    """預設開啟；設 MCP_ANNOUNCEMENTS=0 可立即改回只用本機資料。"""
    return os.environ.get("MCP_ANNOUNCEMENTS", "1").strip().lower() not in ("0", "false", "off")


def records_enabled() -> bool:
    """法規、常見問答改查 MCP。預設關閉；評估通過後設 MCP_REGULATIONS=1 才開啟。"""
    return os.environ.get("MCP_REGULATIONS", "0").strip().lower() in ("1", "true", "on")


def call_tool(name: str, arguments: Dict[str, Any], *, session: Optional[requests.Session] = None) -> Dict[str, Any]:
    """呼叫一個 MCP 工具，回傳 structuredContent。"""
    body = {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": arguments}}
    http = session or requests
    try:
        resp = http.post(
            mcp_url(),
            data=json.dumps(body),
            headers={"Content-Type": "application/json", "Accept": "application/json, text/event-stream"},
            timeout=TIMEOUT_SECONDS,
        )
    except requests.RequestException as exc:
        raise McpUnavailable(f"request failed: {type(exc).__name__}") from exc
    if resp.status_code != 200:
        raise McpUnavailable(f"HTTP {resp.status_code}")
    try:
        payload = resp.json()
    except ValueError as exc:
        raise McpUnavailable("response is not JSON") from exc
    result = payload.get("result") if isinstance(payload, dict) else None
    if not isinstance(result, dict) or result.get("isError") or not isinstance(result.get("structuredContent"), dict):
        raise McpUnavailable("tool returned an error")
    return result["structuredContent"]


def sync_time(freshness: Any) -> Optional[str]:
    """這批資料最後一次完整同步的時間（ISO）。有多個處室時取最早的，避免把舊資料說成新的。"""
    times = [f.get("lastSuccessAt") for f in (freshness or []) if isinstance(f, dict) and f.get("lastSuccessAt")]
    return min(times) if times else None
