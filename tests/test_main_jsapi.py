"""Platform-neutral contract tests for pywebview's native dialog bridge."""
import os
import sys
import types
import unittest
from unittest import mock

from PIL import Image

from app.main import JsApi


class _Window:
    def __init__(self, result):
        self.result = result
        self.calls = []

    def create_file_dialog(self, kind, **kwargs):
        self.calls.append((kind, kwargs))
        return self.result


class TestJsApiDialogs(unittest.TestCase):
    def webview(self, window):
        return types.SimpleNamespace(
            windows=[window],
            FileDialog=types.SimpleNamespace(OPEN="open", SAVE="save",
                                             FOLDER="folder"),
        )

    def test_pick_files_requests_multiple_native_paths(self):
        window = _Window([os.path.abspath("one.txt"), os.path.abspath("two.txt")])
        with mock.patch.dict(sys.modules, {"webview": self.webview(window)}):
            result = JsApi().pick_files()
        self.assertEqual(len(result), 2)
        self.assertEqual(window.calls[0][0], "open")
        self.assertTrue(window.calls[0][1]["allow_multiple"])
        self.assertTrue(all(os.path.isabs(path) for path in result))

    def test_save_dialog_adds_pdf_extension_and_handles_cancel(self):
        chosen = os.path.abspath("draft")
        window = _Window(chosen)
        with mock.patch.dict(sys.modules, {"webview": self.webview(window)}):
            result = JsApi().pick_save_file("My Draft", "pdf")
        self.assertEqual(result, os.path.realpath(chosen) + ".pdf")
        self.assertEqual(window.calls[0][0], "save")
        self.assertEqual(window.calls[0][1]["save_filename"], "My Draft.pdf")

        cancelled = _Window(None)
        with mock.patch.dict(sys.modules, {"webview": self.webview(cancelled)}):
            self.assertIsNone(JsApi().pick_save_file("draft", "pdf"))

    def test_visible_region_capture_returns_real_jpeg_pixels(self):
        pixels = Image.new("RGB", (30, 20), (12, 34, 56))
        with mock.patch.object(sys, "platform", "linux"), \
                mock.patch("PIL.ImageGrab.grab", return_value=pixels) as grab:
            result = JsApi().capture_visible_region({
                "left": 10, "top": 15, "width": 30, "height": 20,
            })

        self.assertTrue(result["ok"])
        self.assertTrue(result["data_url"].startswith(
            "data:image/jpeg;base64,"))
        self.assertEqual(grab.call_args.kwargs["bbox"], (10, 15, 40, 35))


if __name__ == "__main__":
    unittest.main()
