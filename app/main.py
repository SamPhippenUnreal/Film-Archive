"""Film Archive — entry point.

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
#   3. the  FILM_ARCHIVE_ROOT  environment variable
# (film_archive.config.json may still override the local cache / metadata
# locations via "data" / "meta", for advanced setups.)


def _load_config():
    """Per-machine settings kept out of git. See
    film_archive.config.example.json for the shape."""
    try:
        with open(os.path.join(APP_DIR, "film_archive.config.json"),
                  encoding="utf-8") as f:
            cfg = json.load(f)
        return cfg if isinstance(cfg, dict) else {}
    except (OSError, ValueError):
        return {}


_CFG = _load_config()
DEFAULT_DATA = _CFG.get("data") or os.path.join(APP_DIR, "data")
DEFAULT_META = _CFG.get("meta")   # None -> <linked folder>/cache


def normalize_path(raw):
    """Turn whatever the user pastes into a real folder path. Tolerates
    surrounding quotes, file:// URLs, ~, environment variables, trailing
    slashes, mixed / and \\ separators, and terminal-escaped spaces — on
    both macOS and Windows."""
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


def _save_state(cache_base, root):
    try:
        os.makedirs(cache_base, exist_ok=True)
        tmp = _state_path(cache_base) + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"root": root}, f)
        os.replace(tmp, _state_path(cache_base))
    except OSError:
        pass


class Archive:
    """Holds the live store / scanner / metadata store for the currently
    linked folder, and can switch to a different folder at runtime."""

    def __init__(self, cache_base, meta_override=None):
        from .store import Store
        from .metastore import MetaStore
        from .scanner import Scanner
        self._Store, self._MetaStore, self._Scanner = Store, MetaStore, Scanner
        self.cache_base = cache_base
        self.meta_override = meta_override
        self._lock = threading.Lock()
        self.store = None
        self.scanner = None
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
            # each linked folder gets its own local cache, so switching never
            # mixes one archive's thumbnails/index with another's
            cache = os.path.join(
                self.cache_base, "caches",
                hashlib.sha1(root.encode("utf-8")).hexdigest()[:16])
            os.makedirs(cache, exist_ok=True)
            meta_dir = self.meta_override or os.path.join(root, META_SUBDIR)
            metastore = self._MetaStore(meta_dir)
            store = self._Store(os.path.join(cache, "archive.db"), metastore)
            scanner = self._Scanner(root, store, cache)
            self.store, self.scanner, self.root = store, scanner, root
            scanner.start()
            scanner.watch()
        if persist:
            _save_state(self.cache_base, root)
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


def main():
    ap = argparse.ArgumentParser(prog="film_archive")
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

    # link a folder if one is remembered (or explicitly given); otherwise
    # start unlinked and let the "folder" button choose one
    for cand in (_load_state(args.data).get("root"), args.root,
                 os.environ.get("FILM_ARCHIVE_ROOT")):
        if cand and os.path.isdir(normalize_path(cand)):
            archive.set_root(cand, persist=False)
            break

    app = create_app(archive)
    port = args.port or _free_port()
    url = f"http://127.0.0.1:{port}"

    def serve():
        # quiet: no request logging in the terminal
        import logging
        logging.getLogger("werkzeug").setLevel(logging.ERROR)
        app.run(host="127.0.0.1", port=port, threaded=True,
                use_reloader=False)

    if args.no_window:
        print(f"film archive  ·  {url}")
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
            webview.create_window("Film Archive", url, **win_kwargs)
            webview.start()
            return
        except Exception as e:
            print(f"window unavailable ({e}); opening browser instead")

    import webbrowser
    print(f"film archive  ·  {url}")
    webbrowser.open(url)
    try:
        server_thread.join()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
