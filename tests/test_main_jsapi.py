"""Platform-neutral contract tests for pywebview's native dialog bridge."""
import os
import sys
import tempfile
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

    def test_project_file_open_uses_only_a_store_resolved_path(self):
        store = mock.Mock()
        store.resolve_file.return_value = None
        archive = types.SimpleNamespace(store=store)
        with mock.patch("app.main.subprocess.Popen") as launch:
            result = JsApi(archive).open_project_file("project", "file")
        self.assertFalse(result["ok"])
        launch.assert_not_called()
        store.resolve_file.assert_called_once_with("project", "file")

    def test_windows_project_file_open_delegates_to_the_os_association(self):
        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, "draft.txt")
            with open(path, "w", encoding="utf-8") as handle:
                handle.write("safe")
            archive = types.SimpleNamespace(
                store=types.SimpleNamespace(resolve_file=lambda *_: path))
            with mock.patch.object(sys, "platform", "win32"), \
                    mock.patch("app.main.os.startfile", create=True) as start:
                result = JsApi(archive).open_project_file("p", "f")
        self.assertTrue(result["ok"])
        start.assert_called_once_with(path)

    def test_macos_open_with_invokes_native_application_chooser(self):
        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, "draft.txt")
            with open(path, "w", encoding="utf-8") as handle:
                handle.write("safe")
            archive = types.SimpleNamespace(
                store=types.SimpleNamespace(resolve_file=lambda *_: path))
            with mock.patch.object(sys, "platform", "darwin"), \
                    mock.patch("app.main.subprocess.Popen") as launch:
                result = JsApi(archive).open_project_file("p", "f", True)
        self.assertTrue(result["ok"])
        self.assertEqual(launch.call_args.args[0][0], "osascript")
        self.assertEqual(launch.call_args.args[0][-1], path)


if __name__ == "__main__":
    unittest.main()
