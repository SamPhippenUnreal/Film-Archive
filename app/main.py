"""Archive — entry point.

Starts the local server, opens a quiet native window (WebView2 via
pywebview). Falls back to the default browser if no webview is available.

    python -m app.main [--root PATH] [--port N] [--browser] [--no-window]
"""
import argparse
import hashlib
import json
import os
import socket
import sys
import threading

APP_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# per-photo metadata (titles, notes, dates, tags, stars, drawings, rotation,
# black-and-white) is written into this folder, created inside the linked
# archive folder — so it travels and syncs with the photographs, and never
# lives in the app's source
META_SUBDIR = "cache"

# The archive location is never baked into the source, so this project is safe
# to publish and works out of the box on macOS and Windows. On first launch no
# folder is linked — the "folder" button in the app links one, and the choice
# is remembered from then on. A folder can also be set without the button
# (first existing one wins):
#   1. a folder previously picked in the app (remembered per machine)
#   2. the  --root  command-line flag
#   3. the  ARCHIVE_ROOT  environment variable
# (archive.config.json may still override the local cache / metadata
# locations via "data" / "meta", for advanced setups.)


def _load_config():
    """Per-machine settings kept out of git. See
    archive.config.example.json for the shape."""
    try:
        with open(os.path.join(APP_DIR, "archive.config.json"),
                  encoding="utf-8") as f:
            cfg = json.load(f)
        return cfg if isinstance(cfg, dict) else {}
    except (OSError, ValueError):
        return {}


_CFG = _load_config()
DEFAULT_DATA = _CFG.get("data") or os.path.join(APP_DIR, "data")
DEFAULT_META = _CFG.get("meta")   # None -> <linked folder>/cache


def normalize_path(raw):
    """Turn whatever the user pastes — or the native folder picker returns —
    into one canonical folder path. Tolerates surrounding quotes, file:// URLs,
    ~, environment variables, trailing slashes, mixed / and \\ separators, and
    terminal-escaped spaces, on both macOS and Windows.

    The result is the folder's *canonical* identity (via os.path.realpath):
    the true on-disk casing, resolved symlinks, one spelling. So the same
    physical folder always maps to the same string no matter how it was
    reached — typed lower-case, pasted with forward slashes, chosen in the
    picker, or opened through a symlink. Everything keyed off the linked
    folder (its shared `cache` metadata folder and its local thumbnail/index
    cache) is therefore shared, never duplicated into separate folders."""
    if not raw:
        return ""
    s = str(raw).strip()
    if len(s) >= 2 and s[0] == s[-1] and s[0] in ("'", '"'):
        s = s[1:-1].strip()
    if s.lower().startswith("file://"):
        from urllib.parse import unquote, urlparse
        s = unquote(urlparse(s).path)
    if os.sep == "/":
        # macOS / Linux
        if "\\" in s and "/" not in s:
            s = s.replace("\\", "/")     # a Windows-style path, pasted here
        else:
            s = s.replace("\\ ", " ")    # spaces escaped by drag-and-drop
    s = os.path.expandvars(os.path.expanduser(s))
    try:
        # realpath implies normpath, and additionally resolves the real
        # on-disk case and any symlinks — the canonical identity. Falls back
        # to normpath if it ever raises (e.g. an odd path in strict mode).
        s = os.path.realpath(s)
    except Exception:
        try:
            s = os.path.normpath(s)
        except Exception:
            pass
    return s


def _state_path(cache_base):
    return os.path.join(cache_base, "state.json")


def _load_state(cache_base):
    try:
        with open(_state_path(cache_base), encoding="utf-8") as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def _save_state(cache_base, root, key="root"):
    # merge into any existing state so the photo archive and the projects
    # archive can remember their own linked folders side by side, each under
    # its own key, without overwriting the other
    try:
        state = _load_state(cache_base)
        state[key] = root
        os.makedirs(cache_base, exist_ok=True)
        tmp = _state_path(cache_base) + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(state, f)
        os.replace(tmp, _state_path(cache_base))
    except OSError:
        pass


class Archive:
    """Holds the live store / scanner / metadata store for the currently
    linked folder, and can switch to a different folder at runtime."""

    def __init__(self, cache_base, meta_override=None, state_key="root"):
        from .store import Store
        from .metastore import MetaStore
        from .scanner import Scanner
        from .docstore import DocStore
        self._Store, self._MetaStore, self._Scanner = Store, MetaStore, Scanner
        self._DocStore = DocStore
        self.cache_base = cache_base
        self.meta_override = meta_override
        # which slot of the shared state file this archive remembers its folder
        # in ("root" for photos, "project_root" for projects) — so the two are
        # linked and switched independently
        self.state_key = state_key
        self._lock = threading.Lock()
        self.store = None
        self.scanner = None
        self.docstore = None
        self.root = None

    def status(self):
        if not self.scanner:
            return {"phase": "empty", "found": 0, "done": 0, "total": 0,
                    "errors": 0, "root": None, "linked": False}
        s = self.scanner.status()
        s["root"] = self.root
        s["linked"] = True
        return s

    def set_root(self, raw, persist=True):
        """Point the app at a folder. Returns (ok, error_message)."""
        root = normalize_path(raw)
        if not root or not os.path.isdir(root):
            return False, "that folder could not be found"
        with self._lock:
            if self.scanner:
                self.scanner.stop()          # end the old folder's watcher
            # Each linked folder gets its own local cache, keyed by the
            # folder's canonical path (see normalize_path). Because the key is
            # canonical, re-linking the same folder — however it is spelled, or
            # picked again from the native dialog — always resolves to the SAME
            # cache directory. exist_ok reuses it in place; it is never rebuilt
            # into a separate folder.
            cache = os.path.join(
                self.cache_base, "caches",
                hashlib.sha1(root.encode("utf-8")).hexdigest()[:16])
            os.makedirs(cache, exist_ok=True)
            # The shared metadata folder lives inside the linked folder, so it
            # is the same physical `cache/` for every app instance pointed
            # here. MetaStore references it if it already exists (notes, tags
            # and drawings are preserved) and only creates it on first use.
            meta_dir = self.meta_override or os.path.join(root, META_SUBDIR)
            # a genuinely local "backup" folder beside the app's own cache
            # (never in the cloud) durably holds every committed edit as a
            # write-ahead copy until the shared meta_dir confirms it
            metastore = self._MetaStore(
                meta_dir, local_dir=os.path.join(cache, "backup"))
            store = self._Store(os.path.join(cache, "archive.db"), metastore)
            scanner = self._Scanner(root, store, cache)
            # Writing Mode is a second, strictly separate cache domain: its
            # documents live in a `documents/` subtree of the same shared meta
            # folder (so they travel and sync with the photographs) and get
            # their own write-ahead backup journal, kept apart from the image
            # archive's so the two domains are never mixed.
            docstore = self._DocStore(
                os.path.join(meta_dir, "documents"),
                local_dir=os.path.join(cache, "writing_backup"))
            self.store, self.scanner, self.root = store, scanner, root
            self.docstore = docstore
            scanner.start()
            scanner.watch()
        if persist:
            _save_state(self.cache_base, root, self.state_key)
        return True, None


def _free_port(preferred=8471):
    for port in (preferred, 0):
        try:
            s = socket.socket()
            s.bind(("127.0.0.1", port))
            port = s.getsockname()[1]
            s.close()
            return port
        except OSError:
            continue
    return preferred


WINDOWS_APP_ID = "Archive.App"   # must match make_shortcut.ps1


def _set_windows_app_id():
    """Give the app its own taskbar identity. A pinned 'Archive' shortcut
    carries the same id, so the pinned icon and the running window share one
    taskbar button instead of appearing twice. Best-effort, Windows only."""
    try:
        import ctypes
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(
            WINDOWS_APP_ID)
    except Exception:
        pass


def _find_own_window():
    """HWND of THIS process's "Archive" top-level window, or None.
    Matching by pid as well as title so a second running instance (or any
    other window that happens to share the title) is never touched."""
    import ctypes
    from ctypes import wintypes
    u = ctypes.windll.user32
    pid = os.getpid()
    found = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def visit(hwnd, _):
        wpid = wintypes.DWORD()
        u.GetWindowThreadProcessId(hwnd, ctypes.byref(wpid))
        if wpid.value == pid:
            buf = ctypes.create_unicode_buffer(64)
            u.GetWindowTextW(hwnd, buf, 64)
            if buf.value == "Archive":
                found.append(hwnd)
                return False
        return True

    u.EnumWindows(visit, 0)
    return found[0] if found else None


def _set_windows_relaunch(hwnd):
    """Stamp System.AppUserModel relaunch properties on the window.

    When the running window is pinned to the taskbar, Windows only knows the
    process executable — pythonw.exe — so the pin would get Python's icon and
    relaunch a bare interpreter. These properties tell the shell what a pin
    of this window means: the Archive name, the film icon, and a
    relaunch through the safe updater."""
    import ctypes
    from ctypes import wintypes

    class GUID(ctypes.Structure):
        _fields_ = [("d1", wintypes.DWORD), ("d2", wintypes.WORD),
                    ("d3", wintypes.WORD), ("d4", ctypes.c_ubyte * 8)]

    def guid(s):
        g = GUID()
        ctypes.oledll.ole32.CLSIDFromString(s, ctypes.byref(g))
        return g

    class PROPERTYKEY(ctypes.Structure):
        _fields_ = [("fmtid", GUID), ("pid", wintypes.DWORD)]

    class PROPVARIANT(ctypes.Structure):
        _fields_ = [("vt", wintypes.WORD), ("r1", wintypes.WORD),
                    ("r2", wintypes.WORD), ("r3", wintypes.WORD),
                    ("pwszVal", ctypes.c_wchar_p), ("pad", ctypes.c_void_p)]

    ctypes.windll.ole32.CoInitialize(None)
    store = ctypes.c_void_p()
    iid = guid("{886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99}")   # IPropertyStore
    hr = ctypes.windll.shell32.SHGetPropertyStoreForWindow(
        wintypes.HWND(hwnd), ctypes.byref(iid), ctypes.byref(store))
    if hr != 0 or not store:
        return

    # IPropertyStore vtable: 0 QueryInterface, 1 AddRef, 2 Release,
    # 3 GetCount, 4 GetAt, 5 GetValue, 6 SetValue, 7 Commit
    vtbl = ctypes.cast(
        ctypes.cast(store, ctypes.POINTER(ctypes.c_void_p)).contents,
        ctypes.POINTER(ctypes.c_void_p))
    set_value = ctypes.WINFUNCTYPE(
        ctypes.HRESULT, ctypes.c_void_p, ctypes.POINTER(PROPERTYKEY),
        ctypes.POINTER(PROPVARIANT))(vtbl[6])
    commit = ctypes.WINFUNCTYPE(ctypes.HRESULT, ctypes.c_void_p)(vtbl[7])
    release = ctypes.WINFUNCTYPE(ctypes.c_ulong, ctypes.c_void_p)(vtbl[2])

    fmtid = guid("{9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3}")  # AppUserModel
    pythonw = os.path.join(APP_DIR, ".venv", "Scripts", "pythonw.exe")
    updater = os.path.join(APP_DIR, "update_and_launch.py")
    ico = os.path.join(APP_DIR, "img", "Icon.ico")

    props = {5: WINDOWS_APP_ID,                # ID — matches the .lnk
             4: "Archive"}                     # RelaunchDisplayNameResource
    if os.path.exists(pythonw) and os.path.exists(updater):
        props[2] = f'"{pythonw}" "{updater}"'  # RelaunchCommand
    if os.path.exists(ico):
        props[3] = ico + ",0"                  # RelaunchIconResource

    VT_LPWSTR = 31
    for pid, val in sorted(props.items()):
        key = PROPERTYKEY(fmtid, pid)
        var = PROPVARIANT(VT_LPWSTR, 0, 0, 0, val, None)
        set_value(store, ctypes.byref(key), ctypes.byref(var))
    commit(store)
    release(store)


def _dress_windows_window():
    """Give the app window the Archive icon instead of Python's default,
    and make a taskbar pin of the running window keep that icon and relaunch
    through the updater. Best-effort, Windows only, and never fatal: the
    window still opens if any of this fails."""
    ico = os.path.join(APP_DIR, "img", "Icon.ico")

    def worker():
        try:
            import time
            import ctypes
            from ctypes import wintypes
            hwnd = None
            for _ in range(80):                 # wait up to ~8s for the window
                hwnd = _find_own_window()
                if hwnd:
                    break
                time.sleep(0.1)
            if not hwnd:
                return

            if os.path.exists(ico):
                u = ctypes.windll.user32
                u.LoadImageW.restype = wintypes.HANDLE
                u.LoadImageW.argtypes = [wintypes.HINSTANCE, wintypes.LPCWSTR,
                                         wintypes.UINT, ctypes.c_int,
                                         ctypes.c_int, wintypes.UINT]
                u.SendMessageW.argtypes = [wintypes.HWND, wintypes.UINT,
                                           ctypes.c_void_p, ctypes.c_void_p]
                IMAGE_ICON, WM_SETICON = 1, 0x0080
                LR_LOADFROMFILE, LR_DEFAULTSIZE = 0x0010, 0x0040
                ICON_SMALL, ICON_BIG = 0, 1
                big = u.LoadImageW(None, ico, IMAGE_ICON, 0, 0,
                                   LR_LOADFROMFILE | LR_DEFAULTSIZE)
                small = u.LoadImageW(None, ico, IMAGE_ICON, 16, 16,
                                     LR_LOADFROMFILE)
                if big:
                    u.SendMessageW(hwnd, WM_SETICON, ICON_BIG, big)
                if small:
                    u.SendMessageW(hwnd, WM_SETICON, ICON_SMALL, small)

            try:
                _set_windows_relaunch(hwnd)
            except Exception:
                pass
        except Exception:
            pass

    threading.Thread(target=worker, daemon=True).start()


class JsApi:
    """Bridge exposed to the page as ``window.pywebview.api``.

    Its one job is ``pick_folder``: open the operating system's native
    folder-chooser so the "folder" button can browse to a folder instead of
    asking the user to type or paste a path. pywebview's folder dialog is
    native on both macOS and Windows, so one code path serves both. When the
    app runs in a plain browser (``--browser``) this bridge is absent and the
    frontend falls back to the paste-a-path bar."""

    def pick_folder(self):
        """Show a native folder picker; return the chosen path, or None if
        the dialog is unavailable or the user cancels."""
        try:
            import webview
            win = webview.windows[0] if webview.windows else None
            if win is None:
                return None
            # FileDialog.FOLDER (== the old FOLDER_DIALOG); one folder only.
            result = win.create_file_dialog(webview.FileDialog.FOLDER)
        except Exception:
            return None
        if not result:
            return None
        # create_file_dialog returns a sequence of paths; a folder dialog
        # yields exactly one.
        if isinstance(result, (list, tuple)):
            return result[0] if result else None
        return result


def main():
    ap = argparse.ArgumentParser(prog="archive")
    ap.add_argument("--root", default=None,
                    help="link this folder of photographs on launch")
    ap.add_argument("--data", default=DEFAULT_DATA,
                    help="local cache (thumbnails, index). Default: app folder")
    ap.add_argument("--meta", default=DEFAULT_META,
                    help="shared metadata folder (notes, tags, drawings…). "
                         "Default: <root>/" + META_SUBDIR)
    ap.add_argument("--port", type=int, default=0)
    ap.add_argument("--browser", action="store_true",
                    help="open in the default browser instead of a window")
    ap.add_argument("--no-window", action="store_true",
                    help="run the local server only")
    args = ap.parse_args()

    from .server import create_app

    archive = Archive(args.data, meta_override=args.meta)
    # the projects archive is a second, strictly independent link, remembered
    # under its own key in the shared state file
    project_archive = Archive(args.data, meta_override=args.meta,
                              state_key="project_root")

    state = _load_state(args.data)

    # link a folder if one is remembered (or explicitly given); otherwise
    # start unlinked and let the "folder" button choose one
    for cand in (state.get("root"), args.root,
                 os.environ.get("ARCHIVE_ROOT")):
        if cand and os.path.isdir(normalize_path(cand)):
            archive.set_root(cand, persist=False)
            break

    # restore the projects folder independently, if one was linked before
    proj_cand = state.get("project_root")
    if proj_cand and os.path.isdir(normalize_path(proj_cand)):
        project_archive.set_root(proj_cand, persist=False)

    app = create_app(archive, project_archive)
    port = args.port or _free_port()
    url = f"http://127.0.0.1:{port}"

    def serve():
        # quiet: no request logging in the terminal
        import logging
        logging.getLogger("werkzeug").setLevel(logging.ERROR)
        app.run(host="127.0.0.1", port=port, threaded=True,
                use_reloader=False)

    if args.no_window:
        print(f"archive  ·  {url}")
        serve()
        return

    server_thread = threading.Thread(target=serve, daemon=True)
    server_thread.start()

    if not args.browser:
        try:
            import webview
            win_kwargs = dict(
                width=1480, height=920, min_size=(900, 600),
                background_color="#FAFAF7",
            )
            if sys.platform == "darwin":
                win_kwargs["fullscreen"] = True   # launch fullscreen on macOS
            else:
                win_kwargs["maximized"] = True     # fill the screen elsewhere
            if sys.platform == "win32":
                _set_windows_app_id()        # taskbar identity, before the window
            webview.create_window("Archive", url, js_api=JsApi(),
                                  **win_kwargs)
            if sys.platform == "win32":
                _dress_windows_window()      # icon + pinnable taskbar button
            webview.start()
            return
        except Exception as e:
            print(f"window unavailable ({e}); opening browser instead")

    import webbrowser
    print(f"archive  ·  {url}")
    webbrowser.open(url)
    try:
        server_thread.join()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
