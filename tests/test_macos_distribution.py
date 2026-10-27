import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock

from scripts import macos_setup, uninstall_macos

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("archive_updater_test", ROOT / "update_and_launch.py")
updater = importlib.util.module_from_spec(spec)
spec.loader.exec_module(updater)


class MacSetupTests(unittest.TestCase):
    def test_rejects_wrong_python_version(self):
        with mock.patch.object(macos_setup.sys, "platform", "darwin"), mock.patch.object(macos_setup.sys, "version_info", (3, 12)):
            with self.assertRaisesRegex(RuntimeError, "Python 3.13"):
                macos_setup.validate_python()

    def test_rejects_rosetta_python_on_apple_silicon(self):
        with mock.patch.object(macos_setup.sys, "platform", "darwin"), mock.patch.object(macos_setup.sys, "version_info", (3, 13)), mock.patch.object(macos_setup.platform, "machine", return_value="x86_64"), mock.patch.object(macos_setup.subprocess, "run", return_value=mock.Mock(stdout="1")):
            with self.assertRaisesRegex(RuntimeError, "native Apple Silicon"):
                macos_setup.validate_python()

    def test_intel_and_native_apple_silicon_are_accepted(self):
        for hardware, machine in (("0", "x86_64"), ("1", "arm64")):
            with mock.patch.object(macos_setup.sys, "platform", "darwin"), mock.patch.object(macos_setup.sys, "version_info", (3, 13)), mock.patch.object(macos_setup.platform, "machine", return_value=machine), mock.patch.object(macos_setup.subprocess, "run", return_value=mock.Mock(stdout=hardware)):
                macos_setup.validate_python()

    def test_copied_windows_environment_is_preserved_and_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / ".venv" / "Scripts").mkdir(parents=True)
            marker = root / ".venv" / "Scripts" / "python.exe"
            marker.write_text("keep")
            with mock.patch.object(macos_setup, "ROOT", root), mock.patch.object(macos_setup, "validate_python"), mock.patch.object(macos_setup.subprocess, "run") as run:
                self.assertEqual(macos_setup.main(), 1)
                run.assert_not_called()
            self.assertEqual(marker.read_text(), "keep")


class MacUpdaterTests(unittest.TestCase):
    def test_mac_dependency_file_is_installed_before_launch_update(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "requirements-macos.txt").write_text("old")
            calls = []
            def install(command, **kwargs):
                calls.append(Path(command[-1]).read_text())
                return mock.Mock(returncode=0)
            with mock.patch.object(updater.sys, "platform", "darwin"), mock.patch.object(updater, "PROJECT_ROOT", root), mock.patch.object(updater, "git", return_value=(0, "flask==3.1.3", "")) as git, mock.patch.object(updater, "venv_python", return_value=Path("python")), mock.patch.object(updater.subprocess, "run", side_effect=install):
                self.assertTrue(updater.deps_ok_for_update("origin/codex/macos"))
                self.assertIn("requirements-macos.txt", git.call_args.args[0][1])
                self.assertEqual(calls, ["flask==3.1.3"])

    def test_dependency_failure_holds_back_update(self):
        with tempfile.TemporaryDirectory() as folder:
            with mock.patch.object(updater.sys, "platform", "darwin"), mock.patch.object(updater, "PROJECT_ROOT", Path(folder)), mock.patch.object(updater, "git", return_value=(0, "new", "")), mock.patch.object(updater, "venv_python", return_value=Path("python")), mock.patch.object(updater.subprocess, "run", return_value=mock.Mock(returncode=1, stderr="failed", stdout="")):
                self.assertFalse(updater.deps_ok_for_update("origin/codex/macos"))


class MacUninstallTests(unittest.TestCase):
    def fixture(self, folder):
        root = Path(folder) / "Film-Archive"
        (root / "app").mkdir(parents=True)
        (root / "app" / "main.py").write_text("")
        (root / "setup.sh").write_text("")
        (root / "requirements-macos.txt").write_text("")
        (root / ".git").mkdir()
        return root

    def git(self, root, dirty=""):
        def output(command, **kwargs):
            if command[1] == "rev-parse": return str(root)
            if command[1] == "remote": return "https://github.com/SamPhippenUnreal/Film-Archive.git"
            return dirty
        return output

    def test_external_photo_archive_is_allowed(self):
        with tempfile.TemporaryDirectory() as folder:
            root = self.fixture(folder)
            (root / "archive.config.json").write_text(json.dumps({"root": str(Path(folder) / "Photos")}))
            with mock.patch.object(uninstall_macos.subprocess, "check_output", side_effect=self.git(root)):
                self.assertEqual(uninstall_macos.validate_installation(root), root.resolve())

    def test_nested_or_ancestor_photo_folder_blocks_removal(self):
        with tempfile.TemporaryDirectory() as folder:
            root = self.fixture(folder)
            for photos in (root / "Photos", root, root.parent):
                (root / "archive.config.json").write_text(json.dumps({"root": str(photos)}))
                with mock.patch.object(uninstall_macos.subprocess, "check_output", side_effect=self.git(root)):
                    with self.assertRaisesRegex(RuntimeError, "overlaps"):
                        uninstall_macos.validate_installation(root)

    def test_dirty_checkout_and_unreadable_settings_are_not_removed(self):
        with tempfile.TemporaryDirectory() as folder:
            root = self.fixture(folder)
            with mock.patch.object(uninstall_macos.subprocess, "check_output", side_effect=self.git(root, " M app/main.py")):
                with self.assertRaisesRegex(RuntimeError, "local source changes"):
                    uninstall_macos.validate_installation(root)
            (root / "archive.config.json").write_text("invalid json")
            with mock.patch.object(uninstall_macos.subprocess, "check_output", side_effect=self.git(root)):
                with self.assertRaisesRegex(RuntimeError, "Cannot safely read"):
                    uninstall_macos.validate_installation(root)

    def test_pending_or_conflicted_backup_blocks_removal(self):
        with tempfile.TemporaryDirectory() as folder:
            root = self.fixture(folder)
            journal = root / "data" / "caches" / "one" / "backup" / "journal" / "photo.json"
            journal.parent.mkdir(parents=True)
            for state in ("pending", "conflict"):
                journal.write_text(json.dumps({"state": state}))
                with mock.patch.object(uninstall_macos.subprocess, "check_output", side_effect=self.git(root)):
                    with self.assertRaisesRegex(RuntimeError, "Unresolved annotation backups"):
                        uninstall_macos.validate_installation(root)
            journal.write_text(json.dumps({"state": "verified"}))
            with mock.patch.object(uninstall_macos.subprocess, "check_output", side_effect=self.git(root)):
                self.assertEqual(uninstall_macos.validate_installation(root), root.resolve())

    def test_running_app_blocks_removal(self):
        with tempfile.TemporaryDirectory() as folder:
            root = self.fixture(folder)
            original = self.git(root)
            def output(command, **kwargs):
                if command[0] == "ps": return str(root.resolve()) + "/.venv/bin/python -m app.main"
                return original(command, **kwargs)
            with mock.patch.object(uninstall_macos.sys, "platform", "darwin"), mock.patch.object(uninstall_macos.subprocess, "check_output", side_effect=output):
                with self.assertRaisesRegex(RuntimeError, "still running"):
                    uninstall_macos.validate_installation(root)

    def test_cancel_never_calls_delete(self):
        with mock.patch.object(uninstall_macos.sys, "platform", "darwin"), mock.patch.object(uninstall_macos, "validate_installation", return_value=Path("/safe/clone")), mock.patch("builtins.input", return_value="cancel"), mock.patch.object(uninstall_macos.shutil, "rmtree") as remove:
            self.assertEqual(uninstall_macos.main(), 0)
            remove.assert_not_called()

    def test_confirmed_uninstall_revalidates_exact_target_before_removal(self):
        root = Path("/safe/clone")
        with mock.patch.object(uninstall_macos.sys, "platform", "darwin"), mock.patch.object(uninstall_macos, "validate_installation", return_value=root) as validate, mock.patch("builtins.input", return_value="UNINSTALL"), mock.patch.object(uninstall_macos.os, "chdir") as chdir, mock.patch.object(uninstall_macos.shutil, "rmtree") as remove:
            self.assertEqual(uninstall_macos.main(), 0)
            self.assertEqual(validate.call_count, 2)
            chdir.assert_called_once_with(root.parent)
            remove.assert_called_once_with(root)
