"""Read-only source decoding and bounded, replace-in-place display previews."""
import hashlib
import os
import re
import threading
import time
from PIL import Image, ImageOps

# Serialize large source decodes, including thumbnail indexing.
DECODE_LOCK = threading.RLock()
LEVELS = (512, 1024, 2048, 4096)
DISK_BUDGET = 512 * 1024 * 1024


class PreviewCache:
    def __init__(self, directory, budget=DISK_BUDGET, extra_dirs=()):
        self.directory = directory
        self.budget = budget
        self.directories = (directory, *extra_dirs)
        os.makedirs(directory, exist_ok=True)
        with DECODE_LOCK:
            self._prune()

    def _prune(self, keep=None):
        # Only disposable previews, never originals, metadata or backups.
        entries = []
        for directory in self.directories:
            for entry in os.scandir(directory):
                if entry.is_file(follow_symlinks=False) and entry.name.endswith('.jpg'):
                    stat = entry.stat()
                    entries.append((stat.st_mtime_ns, entry.path, stat.st_size))
        total = sum(e[2] for e in entries)
        for _, path, size in sorted(entries):
            if total <= self.budget:
                break
            if path != keep:
                try:
                    os.unlink(path)
                    total -= size
                except OSError:
                    pass

    def path(self, source, pid, edge=None):
        if edge is not None and edge not in LEVELS:
            raise ValueError('unsupported preview level')
        if not re.fullmatch(r'[A-Za-z0-9_-]+', pid):
            raise ValueError('invalid photo ID')
        slot = str(edge) if edge else 'full'
        cached = os.path.join(self.directory, f'{pid}.lod-{slot}.jpg')
        with DECODE_LOCK:
            stat = os.stat(source)
            signature = hashlib.sha256(f'v1:{stat.st_mtime_ns}:{stat.st_size}'.encode()).hexdigest().encode()
            try:
                with Image.open(cached) as existing:
                    valid = existing.info.get('comment') == signature
                if valid:
                    if time.time() - os.path.getmtime(cached) > 60:
                        os.utime(cached, None)
                    return cached
            except (OSError, ValueError):
                pass
            tmp = cached + '.tmp'
            try:
                with Image.open(source) as original:
                    image = ImageOps.exif_transpose(original)
                    try:
                        if edge:
                            image.thumbnail((edge, edge), Image.Resampling.LANCZOS, reducing_gap=3)
                        if image.mode not in ('RGB', 'L'):
                            converted = image.convert('RGB')
                            image.close()
                            image = converted
                        image.save(tmp, 'JPEG', quality=95 if edge else 98,
                                   subsampling=0, comment=signature)
                    finally:
                        image.close()
                os.replace(tmp, cached)
                self._prune(keep=cached)
                return cached
            finally:
                if os.path.exists(tmp):
                    os.unlink(tmp)
