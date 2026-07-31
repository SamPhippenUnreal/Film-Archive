"""The 3D preview reader: OBJ and FBX geometry, packed for the in-app viewer.

Everything is written to a temporary directory; no linked folder is read.
The FBX fixtures are built here rather than committed as binaries, so the
node-record layout the reader relies on is stated explicitly in one place.
"""
import array
import math
import struct
import zlib
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from app import model3d


CUBE_OBJ = """\
# a unit cube
o cube
v -1 -1 -1
v  1 -1 -1
v  1  1 -1
v -1  1 -1
v -1 -1  1
v  1 -1  1
v  1  1  1
v -1  1  1
vn 0 0 1
f 1 2 3 4
f 5 8 7 6
f 1 5 6 2
f 2 6 7 3
f 3 7 8 4
f 4 8 5 1
"""


def unpack(buffer):
    """The header plus typed views over one packed mesh buffer."""
    magic, version, triangles = struct.unpack_from("<4sII", buffer, 0)
    bounds = struct.unpack_from("<6f", buffer, 12)
    flags = struct.unpack_from("<I", buffer, 36)[0]
    positions = array.array("f")
    positions.frombytes(buffer[model3d.MESH_HEADER:
                               model3d.MESH_HEADER + triangles * 36])
    normals = array.array("b")
    normals.frombytes(buffer[model3d.MESH_HEADER + triangles * 36:
                             model3d.MESH_HEADER + triangles * 45])
    uvs = array.array("f")
    if flags & model3d.MESH_FLAG_UV:
        after = model3d.MESH_HEADER + triangles * 45
        start = after + (-after) % 4
        uvs.frombytes(buffer[start:start + triangles * 24])
    return {"magic": magic, "version": version, "triangles": triangles,
            "bounds": bounds, "flags": flags, "positions": positions,
            "normals": normals, "uvs": uvs}


# --- FBX fixture writing ---------------------------------------------------

def _fbx_array(code, values, compress=False):
    fmt = {"d": "d", "i": "i"}[code]
    raw = array.array(fmt, values).tobytes()
    if compress:
        payload = zlib.compress(raw)
        return (code.encode() + struct.pack("<III", len(values), 1, len(payload))
                + payload)
    return code.encode() + struct.pack("<III", len(values), 0, len(raw)) + raw


def _fbx_string(value):
    encoded = value.encode("utf-8")
    return b"S" + struct.pack("<I", len(encoded)) + encoded


def _fbx_long(value):
    return b"L" + struct.pack("<q", value)


def _fbx_double(value):
    return b"D" + struct.pack("<d", value)


class Node:
    """One FBX node record.

    A record states the absolute file offset of its own end, so a node cannot
    be serialised until its position is known — hence the two-step shape: the
    size is computed on construction, the bytes on ``emit``.
    """

    def __init__(self, name, props=b"", children=(), count=0, wide=False):
        self.name = name.encode("utf-8")
        self.props = props
        self.children = list(children)
        self.count = count
        self.terminator = 25 if wide else 13
        self.wide = wide
        body = sum(child.size for child in self.children)
        if self.children:
            body += self.terminator
        self.size = self.terminator + len(self.name) + len(props) + body

    def emit(self, offset):
        head = self.terminator + len(self.name) + len(self.props)
        cursor = offset + head
        body = b""
        for child in self.children:
            body += child.emit(cursor)
            cursor += child.size
        if self.children:
            body += b"\0" * self.terminator
        header = struct.pack("<QQQ", offset + self.size, self.count,
                             len(self.props)) if self.wide else \
            struct.pack("<III", offset + self.size, self.count, len(self.props))
        return header + bytes([len(self.name)]) + self.name + self.props + body


def build_fbx(version, geometries, models=(), connections=(), up_axis=None,
              compress=False, uv_layer=None):
    """Write a binary FBX holding the given meshes, models and connections.

    ``geometries``  — ``[(id, vertices, polygon_indices)]``
    ``models``      — ``[(id, name, {property: (x, y, z)})]``
    ``connections`` — ``[(child_id, parent_id)]``
    ``uv_layer``    — ``(mapping, reference, coordinates, indices)`` added to
                      every geometry, or ``None`` for a mesh with no unwrap
    """
    wide = version >= 7500

    def node(name, props=b"", children=(), count=0):
        return Node(name, props, children, count, wide)

    def integer_property(name, value):
        return node("P", _fbx_string(name) + _fbx_string("int") +
                    _fbx_string("Integer") + _fbx_string("") +
                    b"I" + struct.pack("<i", value), count=5)

    def uv_children():
        if uv_layer is None:
            return ()
        mapping, reference, coords, lookup = uv_layer
        kids = [node("MappingInformationType", _fbx_string(mapping), count=1),
                node("ReferenceInformationType", _fbx_string(reference), count=1),
                node("UV", _fbx_array("d", coords, compress), count=1)]
        if lookup is not None:
            kids.append(node("UVIndex", _fbx_array("i", lookup, compress),
                             count=1))
        return (node("LayerElementUV", b"I" + struct.pack("<i", 0),
                     tuple(kids), count=1),)

    objects = []
    for oid, vertices, indices in geometries:
        objects.append(node(
            "Geometry",
            _fbx_long(oid) + _fbx_string("Geometry::mesh") + _fbx_string("Mesh"),
            (node("Vertices", _fbx_array("d", vertices, compress), count=1),
             node("PolygonVertexIndex", _fbx_array("i", indices, compress),
                  count=1)) + uv_children(),
            count=3))
    for oid, name, properties in models:
        entries = [
            node("P", _fbx_string(key) + _fbx_string("Lcl Translation") +
                 _fbx_string("") + _fbx_string("A") +
                 b"".join(_fbx_double(v) for v in value), count=4 + len(value))
            for key, value in properties.items()]
        objects.append(node(
            "Model", _fbx_long(oid) + _fbx_string(name) + _fbx_string("Mesh"),
            (node("Properties70", b"", tuple(entries)),), count=3))

    roots = []
    if up_axis is not None:
        axis, sign = up_axis
        roots.append(node("GlobalSettings", b"", (
            node("Properties70", b"", (integer_property("UpAxis", axis),
                                       integer_property("UpAxisSign", sign))),)))
    roots.append(node("Objects", b"", tuple(objects)))
    if connections:
        roots.append(node("Connections", b"", tuple(
            node("C", _fbx_string("OO") + _fbx_long(child) + _fbx_long(parent),
                 count=3) for child, parent in connections)))

    out = b"Kaydara FBX Binary  \x00\x1a\x00" + struct.pack("<I", version)
    for root in roots:
        out += root.emit(len(out))
    return out + b"\0" * (25 if wide else 13)


# a quad on the XZ plane, wound as one polygon (the last index is negated)
QUAD_VERTICES = [0, 0, 0,  2, 0, 0,  2, 0, 2,  0, 0, 2]
QUAD_INDICES = [0, 1, 2, -4]


class ModelReaderBase(unittest.TestCase):
    def setUp(self):
        self._tmp = TemporaryDirectory(prefix="archive-model-test-")
        self.tmp = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

    def write(self, name, data):
        path = self.tmp / name
        if isinstance(data, str):
            path.write_text(data, encoding="utf-8")
        else:
            path.write_bytes(data)
        return str(path)


class TestSupportedExtensions(ModelReaderBase):
    def test_only_obj_and_fbx_claim_a_preview(self):
        self.assertTrue(model3d.supports(".obj"))
        self.assertTrue(model3d.supports(".FBX"))
        for other in (".glb", ".stl", ".hip", ".png", "", None):
            self.assertFalse(model3d.supports(other))

    def test_unsupported_extension_raises(self):
        path = self.write("scene.glb", b"not a model")
        with self.assertRaises(model3d.MeshError):
            model3d.read_mesh(path)


class TestObj(ModelReaderBase):
    def test_cube_packs_twelve_triangles_with_exact_bounds(self):
        mesh = unpack(model3d.read_mesh(self.write("cube.obj", CUBE_OBJ)))
        self.assertEqual(mesh["magic"], model3d.MESH_MAGIC)
        self.assertEqual(mesh["version"], model3d.MESH_VERSION)
        self.assertEqual(mesh["triangles"], 12)      # six quads, fanned
        self.assertEqual(mesh["bounds"], (-1, -1, -1, 1, 1, 1))
        self.assertEqual(len(mesh["positions"]), 12 * 9)
        self.assertEqual(len(mesh["normals"]), 12 * 9)

    def test_buffer_length_is_a_multiple_of_four(self):
        buffer = model3d.read_mesh(self.write("cube.obj", CUBE_OBJ))
        self.assertEqual(len(buffer) % 4, 0)
        self.assertGreaterEqual(
            len(buffer), model3d.MESH_HEADER + 12 * 36 + 12 * 9)

    def test_face_normals_are_unit_length_and_axis_aligned(self):
        mesh = unpack(model3d.read_mesh(self.write("cube.obj", CUBE_OBJ)))
        seen = set()
        for i in range(0, len(mesh["normals"]), 3):
            n = tuple(mesh["normals"][i:i + 3])
            length = math.sqrt(sum(v * v for v in n)) / 127.0
            self.assertAlmostEqual(length, 1.0, delta=0.02)
            seen.add(tuple(round(v / 127.0) for v in n))
        # a cube shows all six axis directions and nothing else
        self.assertEqual(len(seen), 6)

    def test_negative_indices_count_back_from_the_vertices_seen(self):
        source = ("v 0 0 0\nv 1 0 0\nv 0 1 0\n"
                  "f -3 -2 -1\n")
        mesh = unpack(model3d.read_mesh(self.write("neg.obj", source)))
        self.assertEqual(mesh["triangles"], 1)
        self.assertEqual(list(mesh["positions"])[:9],
                         [0, 0, 0, 1, 0, 0, 0, 1, 0])

    def test_face_slots_ignore_texture_and_normal_indices(self):
        source = ("v 0 0 0\nv 1 0 0\nv 0 1 0\nvt 0 0\nvn 0 0 1\n"
                  "f 1/1/1 2/1/1 3/1/1\n")
        mesh = unpack(model3d.read_mesh(self.write("slots.obj", source)))
        self.assertEqual(mesh["triangles"], 1)

    def test_degenerate_faces_are_dropped_rather_than_drawn(self):
        source = ("v 0 0 0\nv 1 0 0\nv 0 1 0\n"
                  "f 1 1 1\n"          # zero area
                  "f 1 2 9\n"          # index past the vertices
                  "f 1 2 3\n")
        mesh = unpack(model3d.read_mesh(self.write("bad.obj", source)))
        self.assertEqual(mesh["triangles"], 1)

    def test_a_file_with_no_faces_raises(self):
        with self.assertRaises(model3d.MeshError):
            model3d.read_mesh(self.write("empty.obj", "v 0 0 0\nv 1 0 0\n"))


class TestFbxBinary(ModelReaderBase):
    def test_reads_a_32_bit_header_file(self):
        data = build_fbx(7400, [(100, QUAD_VERTICES, QUAD_INDICES)])
        mesh = unpack(model3d.read_mesh(self.write("quad.fbx", data)))
        self.assertEqual(mesh["triangles"], 2)       # one quad, fanned
        self.assertEqual(mesh["bounds"], (0, 0, 0, 2, 0, 2))

    def test_reads_a_64_bit_7500_header_file(self):
        data = build_fbx(7500, [(100, QUAD_VERTICES, QUAD_INDICES)])
        mesh = unpack(model3d.read_mesh(self.write("wide.fbx", data)))
        self.assertEqual(mesh["triangles"], 2)
        self.assertEqual(mesh["bounds"], (0, 0, 0, 2, 0, 2))

    def test_reads_zlib_compressed_arrays(self):
        plain = build_fbx(7400, [(100, QUAD_VERTICES, QUAD_INDICES)])
        packed = build_fbx(7400, [(100, QUAD_VERTICES, QUAD_INDICES)],
                           compress=True)
        self.assertNotEqual(plain, packed)
        mesh = unpack(model3d.read_mesh(self.write("zip.fbx", packed)))
        self.assertEqual(mesh["triangles"], 2)
        self.assertEqual(mesh["bounds"], (0, 0, 0, 2, 0, 2))

    def test_a_models_translation_places_its_mesh(self):
        data = build_fbx(
            7400,
            [(100, QUAD_VERTICES, QUAD_INDICES)],
            models=[(200, "Model::pPlane1", {"Lcl Translation": (10, 5, -3)})],
            connections=[(100, 200)])
        mesh = unpack(model3d.read_mesh(self.write("moved.fbx", data)))
        self.assertEqual(mesh["bounds"], (10, 5, -3, 12, 5, -1))

    def test_untranslated_meshes_keep_their_own_coordinates(self):
        data = build_fbx(7400, [(100, QUAD_VERTICES, QUAD_INDICES)],
                         models=[(200, "Model::pPlane1", {})],
                         connections=[(100, 200)])
        mesh = unpack(model3d.read_mesh(self.write("still.fbx", data)))
        self.assertEqual(mesh["bounds"], (0, 0, 0, 2, 0, 2))

    def test_a_z_up_file_is_turned_to_the_viewers_y_up(self):
        # a quad lying in the XY plane of a Z-up file should end up lying in
        # the XZ plane once the viewer's convention is applied
        vertices = [0, 0, 0,  2, 0, 0,  2, 2, 0,  0, 2, 0]
        data = build_fbx(7400, [(100, vertices, QUAD_INDICES)],
                         up_axis=(2, 1))
        mesh = unpack(model3d.read_mesh(self.write("zup.fbx", data)))
        self.assertEqual(mesh["bounds"], (0, 0, -2, 2, 0, 0))

    def test_a_y_up_file_is_left_alone(self):
        data = build_fbx(7400, [(100, QUAD_VERTICES, QUAD_INDICES)],
                         up_axis=(1, 1))
        mesh = unpack(model3d.read_mesh(self.write("yup.fbx", data)))
        self.assertEqual(mesh["bounds"], (0, 0, 0, 2, 0, 2))

    def test_several_meshes_are_gathered_into_one_buffer(self):
        second = [10, 0, 0,  12, 0, 0,  12, 0, 2,  10, 0, 2]
        data = build_fbx(7400, [(100, QUAD_VERTICES, QUAD_INDICES),
                                (101, second, QUAD_INDICES)])
        mesh = unpack(model3d.read_mesh(self.write("two.fbx", data)))
        self.assertEqual(mesh["triangles"], 4)
        self.assertEqual(mesh["bounds"], (0, 0, 0, 12, 0, 2))

    def test_a_file_with_no_geometry_raises(self):
        data = build_fbx(7400, [])
        with self.assertRaises(model3d.MeshError):
            model3d.read_mesh(self.write("bare.fbx", data))

    def test_a_truncated_file_raises_rather_than_crashing(self):
        data = build_fbx(7400, [(100, QUAD_VERTICES, QUAD_INDICES)])
        with self.assertRaises(model3d.MeshError):
            model3d.read_mesh(self.write("cut.fbx", data[:60]))

    def test_rubbish_named_fbx_raises(self):
        with self.assertRaises(model3d.MeshError):
            model3d.read_mesh(self.write("junk.fbx", b"\x00\x01\x02" * 40))


class TestFbxAscii(ModelReaderBase):
    SOURCE = """\
; FBX 6.1.0 project file
Objects:  {
    Model: "Model::plane", "Mesh" {
        Vertices: *12 {
            a: 0,0,0,2,0,0,2,0,2,0,0,2
        }
        PolygonVertexIndex: *4 {
            a: 0,1,2,-4
        }
    }
}
"""

    def test_reads_the_ascii_flavour(self):
        mesh = unpack(model3d.read_mesh(self.write("ascii.fbx", self.SOURCE)))
        self.assertEqual(mesh["triangles"], 2)
        self.assertEqual(mesh["bounds"], (0, 0, 0, 2, 0, 2))

    def test_ascii_without_geometry_raises(self):
        with self.assertRaises(model3d.MeshError):
            model3d.read_mesh(self.write("none.fbx", "Objects: { }\n"))


class TestTextureCoordinates(ModelReaderBase):
    """The one thing a colour map needs: somewhere on the mesh to land."""

    def test_an_obj_without_vt_is_flagged_as_having_none(self):
        mesh = unpack(model3d.read_mesh(self.write("bare.obj", CUBE_OBJ)))
        self.assertEqual(mesh["flags"], 0)
        self.assertEqual(len(mesh["uvs"]), 0)

    def test_obj_texture_coordinates_follow_the_second_face_slot(self):
        source = ("v 0 0 0\nv 1 0 0\nv 0 1 0\n"
                  "vt 0.25 0.75\nvt 1 0\nvt 0 1\n"
                  "f 1/1 2/2 3/3\n")
        mesh = unpack(model3d.read_mesh(self.write("uv.obj", source)))
        self.assertEqual(mesh["flags"], model3d.MESH_FLAG_UV)
        self.assertEqual([round(v, 4) for v in mesh["uvs"]],
                         [0.25, 0.75, 1.0, 0.0, 0.0, 1.0])

    def test_a_polygon_fan_carries_its_coordinates_with_it(self):
        source = ("v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\n"
                  "vt 0 0\nvt 1 0\nvt 1 1\nvt 0 1\n"
                  "f 1/1 2/2 3/3 4/4\n")
        mesh = unpack(model3d.read_mesh(self.write("quad.obj", source)))
        self.assertEqual(mesh["triangles"], 2)
        # the fan is 1,2,3 then 1,3,4 — and the coordinates come along
        self.assertEqual([round(v, 4) for v in mesh["uvs"]],
                         [0, 0, 1, 0, 1, 1,  0, 0, 1, 1, 0, 1])

    def test_negative_and_absent_slots_are_tolerated(self):
        source = ("v 0 0 0\nv 1 0 0\nv 0 1 0\nv 2 2 0\n"
                  "vt 0.5 0.5\nvt 1 1\nvt 0 0\n"
                  "f 1/-3 2/-2 3/-1\n"      # counting back from the vt seen
                  "f 1//1 2//1 4//1\n")     # no texture slot at all
        mesh = unpack(model3d.read_mesh(self.write("mixed.obj", source)))
        self.assertEqual(mesh["triangles"], 2)
        self.assertEqual([round(v, 4) for v in mesh["uvs"][:6]],
                         [0.5, 0.5, 1.0, 1.0, 0.0, 0.0])
        # the face with no coordinates falls back to the corner of the square
        self.assertEqual(list(mesh["uvs"][6:]), [0, 0, 0, 0, 0, 0])

    def test_fbx_by_polygon_vertex_index_to_direct(self):
        # the combination Maya and Blender write, and the one the sample file
        # in the repository's own project folder uses
        data = build_fbx(7400, [(100, QUAD_VERTICES, QUAD_INDICES)],
                         uv_layer=("ByPolygonVertex", "IndexToDirect",
                                   [0, 0, 1, 0, 1, 1, 0, 1], [0, 1, 2, 3]))
        mesh = unpack(model3d.read_mesh(self.write("uv.fbx", data)))
        self.assertEqual(mesh["flags"], model3d.MESH_FLAG_UV)
        self.assertEqual([round(v, 4) for v in mesh["uvs"]],
                         [0, 0, 1, 0, 1, 1,  0, 0, 1, 1, 0, 1])

    def test_fbx_by_polygon_vertex_direct(self):
        data = build_fbx(7400, [(100, QUAD_VERTICES, QUAD_INDICES)],
                         uv_layer=("ByPolygonVertex", "Direct",
                                   [0, 0, 1, 0, 1, 1, 0, 1], None))
        mesh = unpack(model3d.read_mesh(self.write("direct.fbx", data)))
        self.assertEqual([round(v, 4) for v in mesh["uvs"]],
                         [0, 0, 1, 0, 1, 1,  0, 0, 1, 1, 0, 1])

    def test_fbx_by_control_point_addresses_the_vertex_not_the_corner(self):
        data = build_fbx(7400, [(100, QUAD_VERTICES, QUAD_INDICES)],
                         uv_layer=("ByVertice", "Direct",
                                   [0, 0, 1, 0, 1, 1, 0, 1], None))
        mesh = unpack(model3d.read_mesh(self.write("cp.fbx", data)))
        self.assertEqual([round(v, 4) for v in mesh["uvs"]],
                         [0, 0, 1, 0, 1, 1,  0, 0, 1, 1, 0, 1])

    def test_a_mapping_the_reader_does_not_know_yields_no_unwrap(self):
        for mapping in ("ByPolygon", "ByEdge", "Something"):
            data = build_fbx(7400, [(100, QUAD_VERTICES, QUAD_INDICES)],
                             uv_layer=(mapping, "Direct", [0, 0, 1, 1], None))
            mesh = unpack(model3d.read_mesh(self.write("odd.fbx", data)))
            self.assertEqual(mesh["flags"], 0, mapping)

    def test_index_to_direct_without_its_index_array_yields_no_unwrap(self):
        data = build_fbx(7400, [(100, QUAD_VERTICES, QUAD_INDICES)],
                         uv_layer=("ByPolygonVertex", "IndexToDirect",
                                   [0, 0, 1, 1], None))
        mesh = unpack(model3d.read_mesh(self.write("noidx.fbx", data)))
        self.assertEqual(mesh["flags"], 0)

    def test_one_unwrapped_mesh_among_several_keeps_the_others_in_step(self):
        second = [10, 0, 0,  12, 0, 0,  12, 0, 2,  10, 0, 2]
        data = build_fbx(7400, [(100, QUAD_VERTICES, QUAD_INDICES),
                                (101, second, QUAD_INDICES)],
                         uv_layer=("ByPolygonVertex", "Direct",
                                   [0, 0, 1, 0, 1, 1, 0, 1], None))
        mesh = unpack(model3d.read_mesh(self.write("two.fbx", data)))
        self.assertEqual(mesh["triangles"], 4)
        self.assertEqual(len(mesh["uvs"]), 4 * 6)
        # the second mesh's coordinates address its own run, not the first's
        self.assertEqual([round(v, 4) for v in mesh["uvs"][12:]],
                         [0, 0, 1, 0, 1, 1,  0, 0, 1, 1, 0, 1])

    def test_the_buffer_stays_four_byte_aligned_with_coordinates(self):
        source = ("v 0 0 0\nv 1 0 0\nv 0 1 0\nvt 0 0\nvt 1 0\nvt 0 1\n"
                  "f 1/1 2/2 3/3\n")
        buffer = model3d.read_mesh(self.write("align.obj", source))
        after = model3d.MESH_HEADER + 1 * 36 + 1 * 9
        self.assertEqual((after + (-after) % 4) % 4, 0)
        self.assertEqual(len(buffer) % 4, 0)


class TestLimits(ModelReaderBase):
    def test_an_over_large_model_is_refused_rather_than_streamed(self):
        original = model3d.MAX_TRIANGLES
        model3d.MAX_TRIANGLES = 4
        self.addCleanup(setattr, model3d, "MAX_TRIANGLES", original)
        source = ["v 0 0 0", "v 1 0 0", "v 0 1 0"]
        source += ["f 1 2 3"] * 12
        with self.assertRaises(model3d.MeshError):
            model3d.read_mesh(self.write("big.obj", "\n".join(source) + "\n"))


if __name__ == "__main__":
    unittest.main()
