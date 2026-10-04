import tempfile
import unittest
from pathlib import Path

try:
    import openpyxl  # noqa: F401
    from scripts.import_office_faqs import latest_workbook
    _IMPORT_ERROR = ""
except ModuleNotFoundError as exc:
    _IMPORT_ERROR = str(exc)


@unittest.skipIf(_IMPORT_ERROR, f"dependencies unavailable: {_IMPORT_ERROR}")
class LatestWorkbookTests(unittest.TestCase):
    def _dir(self, *names):
        d = Path(tempfile.mkdtemp())
        for n in names:
            (d / n).write_bytes(b"")
        return d

    def test_picks_the_newest_date(self):
        d = self._dir("NTPU_LIB_FAQ_20261002-圖書館.xlsx", "NTPU_LIB_FAQ_20261115-圖書館.xlsx")
        self.assertEqual(latest_workbook(d, "lib").name, "NTPU_LIB_FAQ_20261115-圖書館.xlsx")

    def test_does_not_confuse_offices_with_shared_prefixes(self):
        d = self._dir("NTPU_VPA_FAQ_20261002-學術副校長室.xlsx", "NTPU_VPAD_FAQ_20261201-行政副校長室.xlsx")
        self.assertEqual(latest_workbook(d, "vpa").name, "NTPU_VPA_FAQ_20261002-學術副校長室.xlsx")

    def test_rejects_missing_or_ambiguous_workbooks(self):
        with self.assertRaises(ValueError):
            latest_workbook(self._dir(), "lib")
        d = self._dir("NTPU_LIB_FAQ_20261115-圖書館.xlsx", "NTPU_LIB_FAQ_20261115-圖書館(1).xlsx")
        with self.assertRaises(ValueError):
            latest_workbook(d, "lib")


if __name__ == "__main__":
    unittest.main()
