from pathlib import Path
import unittest


class SmokeLayoutTests(unittest.TestCase):
    def test_package_and_extension_layout_exist(self):
        self.assertTrue(Path("native_host/cc_batch/__init__.py").exists())
        self.assertTrue(Path("extension/manifest.json").exists())
