"""Finding a colour map to lay over a 3D preview, and nothing more.

The Project canvas's 3D look shows **one image at a time, straight, as colour**.
A normal or roughness map chosen in that view is displayed as the picture it is
— none of them are interpreted as the thing they are named after.  All this
module decides is which file, if any, to reach for the first time a model is
opened, so that a well-organised folder shows something recognisable without the
user having to go looking.

The vocabularies below are drawn from the conventions the common exporters and
libraries actually write: Substance Painter and Designer, Quixel/Megascans,
Blender, Maya (``sourceimages``), 3ds Max (``bitmaps``), Arnold (``tx``), and
the Unreal/Unity import naming guides.  When nothing matches, nothing is chosen
and the model stays bare — a wrong guess is worse than no guess.
"""

import os
import re


# Folders that conventionally sit beside a model and hold its maps.
TEXTURE_FOLDER_NAMES = frozenset({
    "tex", "texs", "texture", "textures", "texturing", "textureset",
    "texturesets", "map", "maps", "material", "materials", "mat", "mats",
    "image", "images", "img", "imgs", "bitmap", "bitmaps",
    "sourceimages", "source_images", "sourceimage", "tx", "surfacing",
})

IMAGE_EXTENSIONS = frozenset({
    ".jpg", ".jpeg", ".png", ".tif", ".tiff", ".tga", ".bmp", ".webp",
    ".gif", ".exr", ".psd",
})

# Unambiguous words for the *other* maps.  A filename containing one of these
# is never auto-chosen, however colour-ish the rest of its name reads —
# "emissive_color" and "normal_basecolor_mask" are not base colour.
OTHER_MAP_WORDS = (
    "normal", "roughness", "metallic", "metalness", "specular", "glossiness",
    "displacement", "emissive", "emission", "occlusion", "opacity",
    "curvature", "thickness", "subsurface", "clearcoat", "translucency",
    "anisotropy", "transparency", "reflection", "refraction", "cavity",
    "height", "bump", "scatter",
)
# Short forms, matched only as whole words so "north" and "identity" are safe.
OTHER_MAP_TOKENS = frozenset({
    "nrm", "nor", "norm", "nml", "n", "rough", "rgh", "r", "metal", "mtl",
    "met", "m", "spec", "s", "gloss", "gls", "ao", "occ", "disp", "dsp",
    "bmp", "hgt", "opac", "alpha", "a", "emit", "ems", "sss", "curv", "cav",
    "mask", "msk", "orm", "arm", "rma", "id", "pos", "position", "trans",
})

# Base-colour vocabularies, strongest first.  The long ones are matched
# anywhere in the name; the short ones only as whole words.
BASE_COLOUR_WORDS = (
    "basecolor", "basecolour", "base_color", "base_colour",
    "diffusecolor", "diffusecolour", "albedo", "diffuse", "basemap",
)
BASE_COLOUR_TOKENS = frozenset({"diff", "dif", "color", "colour", "base"})
BASE_COLOUR_SHORT = frozenset({"c", "d", "bc", "col", "alb", "rgb", "basecol"})

# Maps that describe where an object is *not*, rather than what colour it is.
# The viewer uses one of these, when the folder holds it, as a cut-out.
ALPHA_MAP_WORDS = ("opacity", "transparency", "transparent", "alpha")
ALPHA_MAP_TOKENS = frozenset({"opac", "alpha", "a", "mask", "msk", "cutout",
                              "trans", "transp", "op"})

_SPLIT = re.compile(r"[^a-z0-9]+")
_CAMEL = re.compile(r"(?<=[a-z0-9])(?=[A-Z])")


def is_image(filename):
    return os.path.splitext(str(filename))[1].lower() in IMAGE_EXTENSIONS


def is_texture_folder(name):
    """Is this the sort of folder that holds a model's maps?"""
    plain = _SPLIT.sub("", str(name or "").lower())
    return plain in TEXTURE_FOLDER_NAMES


def _tokens(stem):
    """The words of a filename, splitting punctuation *and* camel case."""
    return [t for t in _SPLIT.split(_CAMEL.sub(" ", stem).lower()) if t]


def base_colour_rank(filename):
    """How strongly a filename reads as a base-colour map, or ``None``.

    Higher is better.  ``None`` means "do not choose this on the user's
    behalf" — which is also what an unrecognised name gets.
    """
    if not is_image(filename):
        return None
    stem = os.path.splitext(os.path.basename(str(filename)))[0]
    flat = _SPLIT.sub("", _CAMEL.sub(" ", stem).lower())
    words = _tokens(stem)
    # A spelled-out map name settles it: "emissive_color" is not base colour.
    if any(word in flat for word in OTHER_MAP_WORDS):
        return None
    # …but a spelled-out *colour* name outranks a bare short form, because the
    # short forms are as often the material's name as the map's:
    # "metal_BaseMap" is the base colour of a metal, not a metalness map.
    if any(word in flat for word in BASE_COLOUR_WORDS):
        return 3
    if any(word in OTHER_MAP_TOKENS for word in words):
        return None
    if any(word in BASE_COLOUR_TOKENS for word in words):
        return 2
    if any(word in BASE_COLOUR_SHORT for word in words):
        return 1
    return None


def choose_base_colour(filenames):
    """The best base-colour candidate among ``filenames``, or ``None``.

    Ties break on the shorter name and then alphabetically, so the same folder
    always yields the same choice.
    """
    best = None
    for name in filenames:
        rank = base_colour_rank(name)
        if rank is None:
            continue
        key = (-rank, len(name), name.lower())
        if best is None or key < best[0]:
            best = (key, name)
    return best[1] if best else None


def alpha_map_rank(filename):
    """How strongly a filename reads as an opacity map, or ``None``."""
    if not is_image(filename):
        return None
    stem = os.path.splitext(os.path.basename(str(filename)))[0]
    flat = _SPLIT.sub("", _CAMEL.sub(" ", stem).lower())
    if any(word in flat for word in ALPHA_MAP_WORDS):
        return 2
    if any(word in ALPHA_MAP_TOKENS for word in _tokens(stem)):
        return 1
    return None


def choose_alpha_map(filenames):
    """The best opacity map among ``filenames``, or ``None``.

    Ties break exactly as the colour choice does, so a folder always yields the
    same pair.
    """
    best = None
    for name in filenames:
        rank = alpha_map_rank(name)
        if rank is None:
            continue
        key = (-rank, len(name), name.lower())
        if best is None or key < best[0]:
            best = (key, name)
    return best[1] if best else None


def candidate_folders(model_dir, depth=2):
    """Folders to search for a model's maps, most likely first.

    The conventionally-named subfolders beside the model come first, then their
    own subfolders (Substance and Quixel often nest one set per material), and
    the model's own folder is tried last — maps are frequently exported
    straight beside the mesh.
    """
    found, seen = [], set()

    def add(path):
        real = os.path.realpath(path)
        if real not in seen and os.path.isdir(real):
            seen.add(real)
            found.append(real)

    def scan(folder, level):
        try:
            entries = sorted(os.scandir(folder), key=lambda e: e.name.lower())
        except OSError:
            return
        for entry in entries:
            try:
                if not entry.is_dir():
                    continue
            except OSError:
                continue
            if level == 0 and not is_texture_folder(entry.name):
                continue
            add(entry.path)
            if level + 1 < depth:
                scan(entry.path, level + 1)

    if os.path.isdir(model_dir):
        scan(model_dir, 0)
        add(model_dir)
    return found


def images_in(folder):
    """The image files sitting directly in one folder, in display order."""
    try:
        entries = os.scandir(folder)
    except OSError:
        return []
    names = []
    for entry in entries:
        try:
            if entry.is_file() and is_image(entry.name):
                names.append(entry.name)
        except OSError:
            continue
    return sorted(names, key=lambda n: n.lower())
