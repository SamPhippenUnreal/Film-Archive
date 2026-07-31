"""Choosing a colour map without asking the user.

The vocabularies live in app/texturescan.py; these tests pin the behaviour that
matters — that a real export folder yields its base colour, that the other maps
are never mistaken for one, and that an unrecognisable folder yields nothing at
all rather than a guess.
"""
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from app import texturescan


class TestFolderNames(unittest.TestCase):
    def test_the_conventional_folders_are_recognised(self):
        for name in ("tex", "texture", "textures", "Textures", "TEXTURES",
                     "maps", "map", "materials", "mat", "images", "img",
                     "sourceimages", "source images", "source_images",
                     "bitmaps", "tx", "texture-sets"):
            self.assertTrue(texturescan.is_texture_folder(name), name)

    def test_unrelated_folders_are_left_alone(self):
        for name in ("renders", "scenes", "cache", "trash", "abc", "geo",
                     "project canvas", "", None):
            self.assertFalse(texturescan.is_texture_folder(name), name)


class TestBaseColourNames(unittest.TestCase):
    def test_the_common_base_colour_spellings_all_read(self):
        for name in ("wheat_BaseColor.png", "wheat_basecolour.tif",
                     "rock_albedo.jpg", "T_Wood_Diffuse.tga",
                     "cloth_diffuse.exr", "brick_base_color.png",
                     "metal_BaseMap.png"):
            self.assertEqual(texturescan.base_colour_rank(name), 3, name)

    def test_shorter_conventions_rank_below_the_explicit_ones(self):
        for name in ("wood_diff.png", "wood_color.png", "wood_colour.png",
                     "T_Rock_Base.png"):
            self.assertEqual(texturescan.base_colour_rank(name), 2, name)
        for name in ("wood_c.png", "wood_D.tga", "T_Rock_BC.png",
                     "marble_col.png", "sand_alb.jpg"):
            self.assertEqual(texturescan.base_colour_rank(name), 1, name)

    def test_the_other_maps_are_never_taken_for_colour(self):
        for name in ("wheat_Normal.png", "wheat_Roughness.png", "rock_AO.png",
                     "rock_n.png", "rock_r.png", "metal_ORM.png",
                     "cloth_height.exr", "cloth_bump.png", "skin_sss.png",
                     "glass_opacity.png", "lamp_emissive_color.png",
                     "lamp_emission.png", "part_id.png", "part_mask.png",
                     "wood_displacement.tif", "wood_metalness.png"):
            self.assertIsNone(texturescan.base_colour_rank(name), name)

    def test_a_colour_word_inside_a_longer_word_is_not_a_false_positive(self):
        # "lighthouse" must not read as "height"
        self.assertEqual(texturescan.base_colour_rank("lighthouse_diffuse.png"), 3)

    def test_only_images_are_considered(self):
        self.assertIsNone(texturescan.base_colour_rank("readme_diffuse.txt"))
        self.assertIsNone(texturescan.base_colour_rank("scene_albedo.fbx"))
        self.assertEqual(texturescan.base_colour_rank("scene_albedo.exr"), 3)

    def test_choice_prefers_the_strongest_and_is_deterministic(self):
        folder = ["wheat_AO.png", "wheat_c.png", "wheat_BaseColor.png",
                  "wheat_Normal.png", "wheat_diffuse.png"]
        # the explicit spellings outrank the one-letter convention, and the
        # tie between them breaks the same way every time
        self.assertEqual(texturescan.choose_base_colour(folder),
                         "wheat_diffuse.png")
        self.assertEqual(texturescan.choose_base_colour(reversed(folder)),
                         "wheat_diffuse.png")

    def test_a_folder_of_other_maps_yields_nothing(self):
        self.assertIsNone(texturescan.choose_base_colour(
            ["a_Normal.png", "a_Roughness.png", "a_ORM.png", "notes.txt"]))
        self.assertIsNone(texturescan.choose_base_colour([]))


class TestFolderWalk(unittest.TestCase):
    def setUp(self):
        self._tmp = TemporaryDirectory(prefix="archive-texscan-test-")
        self.root = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

    def touch(self, *parts):
        path = self.root.joinpath(*parts)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"x")
        return path

    def test_named_subfolders_come_before_the_models_own_folder(self):
        self.touch("textures", "wood_basecolor.png")
        self.touch("beside_the_model.png")
        folders = texturescan.candidate_folders(str(self.root))
        self.assertEqual(Path(folders[0]).name, "textures")
        self.assertEqual(Path(folders[-1]).resolve(), self.root.resolve())

    def test_one_level_inside_a_named_folder_is_searched_too(self):
        self.touch("textures", "wheat", "wheat_basecolor.png")
        folders = [Path(f).name for f in
                   texturescan.candidate_folders(str(self.root))]
        self.assertIn("wheat", folders)

    def test_unrelated_subfolders_are_not_walked(self):
        self.touch("renders", "frame_0001.png")
        folders = [Path(f).name for f in
                   texturescan.candidate_folders(str(self.root))]
        self.assertNotIn("renders", folders)

    def test_a_missing_folder_yields_nothing_rather_than_raising(self):
        self.assertEqual(
            texturescan.candidate_folders(str(self.root / "gone")), [])

    def test_images_in_lists_only_images_directly_inside(self):
        self.touch("textures", "b_basecolor.png")
        self.touch("textures", "a_normal.PNG")
        self.touch("textures", "notes.txt")
        self.touch("textures", "nested", "deep_basecolor.png")
        names = texturescan.images_in(str(self.root / "textures"))
        self.assertEqual(names, ["a_normal.PNG", "b_basecolor.png"])


if __name__ == "__main__":
    unittest.main()
