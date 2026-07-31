"""Rudimentary triangle geometry for the Project canvas 3D preview.

The Archive previews 3D material with the lightest thing that can honestly be
called a 3D view: flat-shaded triangles under one fixed light rig — no
materials, no textures, no third-party code on either side of the wire.

Everything the preview needs is read here with the standard library alone
(``struct``, ``array``, ``zlib``) and handed to the page as one compact binary
buffer, so the frontend renderer stays a few dozen lines of plain WebGL with no
loader library, no index-buffer extension and no shader variants.

Supported material: Wavefront ``.obj``, and Autodesk ``.fbx`` in both the
binary flavour (FBX 6.x and 7.x, including the 64-bit 7500 header) and the
older ASCII one.  Anything else raises :class:`MeshError` and the canvas keeps
its existing double-click-to-open behaviour.
"""

import array
import math
import os
import struct
import sys
import zlib

# The buffer the page receives: a 40-byte header, then flat-shaded triangle
# soup — positions as float32, face normals as signed bytes.  Deliberately not
# indexed: flat shading needs a normal per face anyway, and drawArrays keeps
# the renderer free of the uint-index extension.
MESH_MAGIC = b"A3DM"
MESH_VERSION = 1
MESH_HEADER = 40

# A preview, not a viewport: past this the buffer costs more than the glance is
# worth, and the file is better opened in its own application.
MAX_TRIANGLES = 1_200_000

SUPPORTED_EXTENSIONS = (".obj", ".fbx")


class MeshError(Exception):
    """Raised when a file holds no geometry this reader can present."""


def supports(extension):
    return str(extension or "").lower() in SUPPORTED_EXTENSIONS


# ---------------------------------------------------------------------------
# packing
# ---------------------------------------------------------------------------

def _pack(vertices, triangles):
    """Flatten indexed geometry into the wire buffer described above.

    ``vertices`` is a flat sequence of x, y, z; ``triangles`` a flat sequence of
    vertex indices in threes.  Degenerate faces (zero area, or indices outside
    the vertex array) are dropped rather than drawn as slivers.
    """
    positions = array.array("f")
    normals = array.array("b")
    limit = len(vertices) - 2
    min_x = min_y = min_z = math.inf
    max_x = max_y = max_z = -math.inf
    kept = 0
    for i in range(0, len(triangles) - 2, 3):
        ia, ib, ic = triangles[i] * 3, triangles[i + 1] * 3, triangles[i + 2] * 3
        if ia < 0 or ib < 0 or ic < 0 or ia > limit or ib > limit or ic > limit:
            continue
        ax, ay, az = vertices[ia], vertices[ia + 1], vertices[ia + 2]
        bx, by, bz = vertices[ib], vertices[ib + 1], vertices[ib + 2]
        cx, cy, cz = vertices[ic], vertices[ic + 1], vertices[ic + 2]
        ux, uy, uz = bx - ax, by - ay, bz - az
        vx, vy, vz = cx - ax, cy - ay, cz - az
        nx = uy * vz - uz * vy
        ny = uz * vx - ux * vz
        nz = ux * vy - uy * vx
        length = math.sqrt(nx * nx + ny * ny + nz * nz)
        if length <= 0.0:
            continue
        nx = int(nx / length * 127.0)
        ny = int(ny / length * 127.0)
        nz = int(nz / length * 127.0)
        positions.extend((ax, ay, az, bx, by, bz, cx, cy, cz))
        normals.extend((nx, ny, nz, nx, ny, nz, nx, ny, nz))
        lo_x, hi_x = (ax, bx) if ax < bx else (bx, ax)
        lo_y, hi_y = (ay, by) if ay < by else (by, ay)
        lo_z, hi_z = (az, bz) if az < bz else (bz, az)
        if cx < lo_x: lo_x = cx
        elif cx > hi_x: hi_x = cx
        if cy < lo_y: lo_y = cy
        elif cy > hi_y: hi_y = cy
        if cz < lo_z: lo_z = cz
        elif cz > hi_z: hi_z = cz
        if lo_x < min_x: min_x = lo_x
        if lo_y < min_y: min_y = lo_y
        if lo_z < min_z: min_z = lo_z
        if hi_x > max_x: max_x = hi_x
        if hi_y > max_y: max_y = hi_y
        if hi_z > max_z: max_z = hi_z
        kept += 1
        if kept > MAX_TRIANGLES:
            raise MeshError("that model is too large to preview")
    if not kept:
        raise MeshError("no geometry could be read from that file")
    if sys.byteorder == "big":
        positions.byteswap()
    header = struct.pack(
        "<4sII6fI", MESH_MAGIC, MESH_VERSION, kept,
        min_x, min_y, min_z, max_x, max_y, max_z, 0)
    body = positions.tobytes() + normals.tobytes()
    # keep the whole buffer a multiple of four bytes, so the page can read the
    # float section as a Float32Array view without copying
    pad = (-len(body)) % 4
    return header + body + b"\0" * pad


# ---------------------------------------------------------------------------
# Wavefront OBJ
# ---------------------------------------------------------------------------

def _read_obj(path):
    vertices = array.array("d")
    triangles = array.array("i")
    with open(path, "rb") as handle:
        for raw in handle:
            if not raw:
                continue
            head = raw[:2]
            if head == b"v ":
                parts = raw.split()
                if len(parts) >= 4:
                    try:
                        vertices.extend((float(parts[1]), float(parts[2]),
                                         float(parts[3])))
                    except ValueError:
                        pass
            elif head == b"f " or head == b"f\t":
                parts = raw.split()
                count = len(vertices) // 3
                face = []
                for token in parts[1:]:
                    slot = token.split(b"/", 1)[0]
                    if not slot:
                        continue
                    try:
                        index = int(slot)
                    except ValueError:
                        continue
                    # OBJ indices are 1-based; negative ones count back from
                    # the vertices seen so far
                    face.append(index - 1 if index > 0 else count + index)
                # a polygon is previewed as a fan, which is exact for the
                # convex faces every exporter emits
                for k in range(1, len(face) - 1):
                    triangles.extend((face[0], face[k], face[k + 1]))
    if not len(triangles):
        raise MeshError("that .obj file holds no faces")
    return vertices, triangles


# ---------------------------------------------------------------------------
# Autodesk FBX — binary
# ---------------------------------------------------------------------------

_FBX_MAGIC = b"Kaydara FBX Binary  \x00"
_ARRAY_FORMATS = {"f": "f", "d": "d", "l": "q", "i": "i", "b": "b"}
_MAX_DEPTH = 24


class _Node:
    __slots__ = ("name", "props", "children")

    def __init__(self, name, props, children):
        self.name = name
        self.props = props
        self.children = children

    def first(self, name):
        for child in self.children:
            if child.name == name:
                return child
        return None

    def every(self, name):
        return [child for child in self.children if child.name == name]


def _fbx_property(data, pos):
    code = data[pos:pos + 1]
    pos += 1
    if code == b"Y":
        return struct.unpack_from("<h", data, pos)[0], pos + 2
    if code == b"C":
        return data[pos] != 0, pos + 1
    if code == b"I":
        return struct.unpack_from("<i", data, pos)[0], pos + 4
    if code == b"F":
        return struct.unpack_from("<f", data, pos)[0], pos + 4
    if code == b"D":
        return struct.unpack_from("<d", data, pos)[0], pos + 8
    if code == b"L":
        return struct.unpack_from("<q", data, pos)[0], pos + 8
    if code in (b"S", b"R"):
        length = struct.unpack_from("<I", data, pos)[0]
        pos += 4
        chunk = data[pos:pos + length]
        pos += length
        return (chunk.decode("utf-8", "replace") if code == b"S" else chunk), pos
    letter = code.decode("ascii", "replace")
    fmt = _ARRAY_FORMATS.get(letter)
    if fmt is None:
        raise MeshError("that .fbx file uses an unknown property type")
    length, encoding, stored = struct.unpack_from("<III", data, pos)
    pos += 12
    raw = data[pos:pos + stored]
    pos += stored
    if encoding == 1:
        raw = zlib.decompress(raw)
    values = array.array(fmt)
    values.frombytes(raw[:length * values.itemsize])
    if sys.byteorder == "big":
        values.byteswap()
    return values, pos


def _fbx_node(data, pos, wide, depth):
    """Read one node record, or ``(None, pos)`` for the null terminator."""
    if wide:
        end, count, prop_len = struct.unpack_from("<QQQ", data, pos)
        pos += 24
    else:
        end, count, prop_len = struct.unpack_from("<III", data, pos)
        pos += 12
    name_len = data[pos]
    pos += 1
    if end == 0 and count == 0 and prop_len == 0 and name_len == 0:
        return None, pos
    name = data[pos:pos + name_len].decode("utf-8", "replace")
    pos += name_len
    prop_end = pos + prop_len
    props = []
    if depth < _MAX_DEPTH:
        for _ in range(count):
            value, pos = _fbx_property(data, pos)
            props.append(value)
    pos = prop_end
    children = []
    while pos + 13 <= end:
        child, pos = _fbx_node(data, pos, wide, depth + 1)
        if child is None:
            break
        children.append(child)
    return _Node(name, props, children), max(pos, end)


def _fbx_parse(data):
    version = struct.unpack_from("<I", data, 23)[0]
    wide = version >= 7500
    pos = 27
    roots = []
    limit = len(data)
    while pos + (25 if wide else 13) <= limit:
        node, pos = _fbx_node(data, pos, wide, 0)
        if node is None:
            break
        roots.append(node)
    return _Node("", [], roots)


# --- transforms ------------------------------------------------------------

def _identity():
    return [1.0, 0.0, 0.0, 0.0,
            0.0, 1.0, 0.0, 0.0,
            0.0, 0.0, 1.0, 0.0]


def _multiply(a, b):
    """Compose two 3x4 affine matrices (row-major, translation last column)."""
    out = [0.0] * 12
    for row in range(3):
        ar = row * 4
        for col in range(3):
            out[ar + col] = (a[ar] * b[col] + a[ar + 1] * b[4 + col] +
                             a[ar + 2] * b[8 + col])
        out[ar + 3] = (a[ar] * b[3] + a[ar + 1] * b[7] +
                       a[ar + 2] * b[11] + a[ar + 3])
    return out


def _translation(x, y, z):
    m = _identity()
    m[3], m[7], m[11] = x, y, z
    return m


def _scaling(x, y, z):
    m = _identity()
    m[0], m[5], m[10] = x, y, z
    return m


def _rotation(degrees, order=0):
    rx, ry, rz = (math.radians(v) for v in degrees)
    cx, sx = math.cos(rx), math.sin(rx)
    cy, sy = math.cos(ry), math.sin(ry)
    cz, sz = math.cos(rz), math.sin(rz)
    mx = [1.0, 0.0, 0.0, 0.0, 0.0, cx, -sx, 0.0, 0.0, sx, cx, 0.0]
    my = [cy, 0.0, sy, 0.0, 0.0, 1.0, 0.0, 0.0, -sy, 0.0, cy, 0.0]
    mz = [cz, -sz, 0.0, 0.0, sz, cz, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0]
    # FBX rotation orders; XYZ (0) is the default every exporter writes unless
    # the artist changed it, and means "apply X first" — i.e. R = Rz·Ry·Rx.
    sequences = {
        0: (mz, my, mx), 1: (my, mz, mx), 2: (my, mx, mz),
        3: (mx, my, mz), 4: (mx, mz, my), 5: (mz, mx, my),
    }
    first, second, third = sequences.get(order, sequences[0])
    return _multiply(_multiply(first, second), third)


def _properties70(node):
    """The named property values of an FBX object, as ``{name: [values…]}``."""
    values = {}
    holder = node.first("Properties70") or node.first("Properties60")
    if holder is None:
        return values
    for prop in holder.every("P") + holder.every("Property"):
        if not prop.props:
            continue
        numbers = [p for p in prop.props[1:]
                   if isinstance(p, (int, float)) and not isinstance(p, bool)]
        values[str(prop.props[0])] = numbers
    return values


def _vector(values, name, default):
    got = values.get(name)
    if not got or len(got) < 3:
        return default
    return (float(got[-3]), float(got[-2]), float(got[-1]))


def _local_matrix(props):
    """The standard FBX local transform, pivots and all.

    ``T · Roff · Rp · Rpre · R · Rpost⁻¹ · Rp⁻¹ · Soff · Sp · S · Sp⁻¹``
    """
    order = 0
    if props.get("RotationOrder"):
        try:
            order = int(props["RotationOrder"][-1])
        except (TypeError, ValueError):
            order = 0
    t = _vector(props, "Lcl Translation", (0.0, 0.0, 0.0))
    r = _vector(props, "Lcl Rotation", (0.0, 0.0, 0.0))
    s = _vector(props, "Lcl Scaling", (1.0, 1.0, 1.0))
    roff = _vector(props, "RotationOffset", (0.0, 0.0, 0.0))
    rp = _vector(props, "RotationPivot", (0.0, 0.0, 0.0))
    pre = _vector(props, "PreRotation", (0.0, 0.0, 0.0))
    post = _vector(props, "PostRotation", (0.0, 0.0, 0.0))
    soff = _vector(props, "ScalingOffset", (0.0, 0.0, 0.0))
    sp = _vector(props, "ScalingPivot", (0.0, 0.0, 0.0))
    rotation = _multiply(_multiply(_rotation(pre), _rotation(r, order)),
                         _transpose_rotation(_rotation(post)))
    m = _translation(*t)
    m = _multiply(m, _translation(*roff))
    m = _multiply(m, _translation(*rp))
    m = _multiply(m, rotation)
    m = _multiply(m, _translation(-rp[0], -rp[1], -rp[2]))
    m = _multiply(m, _translation(*soff))
    m = _multiply(m, _translation(*sp))
    m = _multiply(m, _scaling(*s))
    m = _multiply(m, _translation(-sp[0], -sp[1], -sp[2]))
    return m


def _transpose_rotation(m):
    """The inverse of a pure rotation — its transpose, translation dropped."""
    return [m[0], m[4], m[8], 0.0,
            m[1], m[5], m[9], 0.0,
            m[2], m[6], m[10], 0.0]


def _geometric_matrix(props):
    """The geometric offset: applied to the mesh, never inherited by children."""
    t = _vector(props, "GeometricTranslation", (0.0, 0.0, 0.0))
    r = _vector(props, "GeometricRotation", (0.0, 0.0, 0.0))
    s = _vector(props, "GeometricScaling", (1.0, 1.0, 1.0))
    return _multiply(_multiply(_translation(*t), _rotation(r)), _scaling(*s))


def _up_axis_matrix(root):
    """Bring the file's own up-axis to the viewer's Y-up convention."""
    settings = root.first("GlobalSettings")
    if settings is None:
        return None
    props = _properties70(settings)
    axis = props.get("UpAxis")
    sign = props.get("UpAxisSign")
    try:
        axis = int(axis[-1]) if axis else 1
    except (TypeError, ValueError):
        axis = 1
    try:
        sign = int(sign[-1]) if sign else 1
    except (TypeError, ValueError):
        sign = 1
    sign = -1.0 if sign < 0 else 1.0
    if axis == 2:                       # Z-up (3ds Max, most CAD exports)
        return [1.0, 0.0, 0.0, 0.0,
                0.0, 0.0, sign, 0.0,
                0.0, -sign, 0.0, 0.0]
    if axis == 0:                       # X-up, vanishingly rare but cheap
        return [0.0, sign, 0.0, 0.0,
                -sign, 0.0, 0.0, 0.0,
                0.0, 0.0, 1.0, 0.0]
    if sign < 0:
        return _scaling(1.0, -1.0, 1.0)
    return None


def _mesh_nodes(node, found, depth=0):
    """Every node carrying both a vertex array and a polygon index array.

    Written as a plain walk rather than a lookup of ``Objects/Geometry`` so the
    FBX 6.x layout — where the same two arrays hang off ``Model`` — is read by
    the same code.
    """
    if node.first("Vertices") is not None and \
            node.first("PolygonVertexIndex") is not None:
        found.append(node)
        return
    if depth > _MAX_DEPTH:
        return
    for child in node.children:
        _mesh_nodes(child, found, depth + 1)


def _fbx_object_id(node):
    for prop in node.props:
        if isinstance(prop, int) and not isinstance(prop, bool):
            return prop
    return None


def _fbx_world_transforms(root):
    """World matrices for every ``Model``, resolved through ``Connections``."""
    objects = root.first("Objects")
    connections = root.first("Connections")
    if objects is None:
        return {}, {}, {}
    models = {}
    for model in objects.every("Model"):
        oid = _fbx_object_id(model)
        if oid is not None:
            models[oid] = model
    geometry_owner = {}
    parent_of = {}
    if connections is not None:
        for link in connections.every("C") + connections.every("Connect"):
            props = link.props
            if len(props) < 3 or props[0] != "OO":
                continue
            child, parent = props[1], props[2]
            if parent in models:
                if child in models:
                    parent_of[child] = parent
                else:
                    geometry_owner.setdefault(child, parent)
    world = {}

    def resolve(oid, guard=0):
        if oid in world:
            return world[oid]
        model = models.get(oid)
        if model is None or guard > _MAX_DEPTH:
            return _identity()
        world[oid] = _identity()          # break any cycle in a broken file
        local = _local_matrix(_properties70(model))
        parent = parent_of.get(oid)
        matrix = local if parent is None else _multiply(resolve(parent, guard + 1), local)
        world[oid] = matrix
        return matrix

    for oid in list(models):
        resolve(oid)
    return world, geometry_owner, models


def _fbx_geometry(node):
    """Triangulate one mesh node's vertex + polygon-index arrays."""
    positions = node.first("Vertices").props
    indices = node.first("PolygonVertexIndex").props
    positions = next((p for p in positions if isinstance(p, array.array)), None)
    indices = next((p for p in indices if isinstance(p, array.array)), None)
    if positions is None or indices is None:
        return None, None
    triangles = array.array("i")
    face = []
    for raw in indices:
        if raw < 0:
            face.append(-raw - 1)         # the last corner is stored negated
            for k in range(1, len(face) - 1):
                triangles.extend((face[0], face[k], face[k + 1]))
            face = []
        else:
            face.append(raw)
    return positions, triangles


def _read_fbx_binary(data):
    root = _fbx_parse(data)
    meshes = []
    _mesh_nodes(root, meshes)
    if not meshes:
        raise MeshError("that .fbx file holds no mesh geometry")
    world, owner, models = _fbx_world_transforms(root)
    axis = _up_axis_matrix(root)
    vertices = array.array("d")
    triangles = array.array("i")
    for mesh in meshes:
        local, faces = _fbx_geometry(mesh)
        if not local or not faces:
            continue
        oid = _fbx_object_id(mesh)
        # 7.x: the mesh hangs off a Model through Connections. 6.x: the Model
        # *is* the mesh, so its own id already carries the transform.
        model_id = owner.get(oid, oid if oid in models else None)
        matrix = world.get(model_id) if model_id is not None else None
        if matrix is not None and model_id in models:
            matrix = _multiply(
                matrix, _geometric_matrix(_properties70(models[model_id])))
        if axis is not None:
            matrix = axis if matrix is None else _multiply(axis, matrix)
        offset = len(vertices) // 3
        if matrix is None:
            vertices.extend(local)
        else:
            m = matrix
            for i in range(0, len(local) - 2, 3):
                x, y, z = local[i], local[i + 1], local[i + 2]
                vertices.extend((
                    m[0] * x + m[1] * y + m[2] * z + m[3],
                    m[4] * x + m[5] * y + m[6] * z + m[7],
                    m[8] * x + m[9] * y + m[10] * z + m[11]))
        if offset:
            triangles.extend(array.array("i", (i + offset for i in faces)))
        else:
            triangles.extend(faces)
    if not len(triangles):
        raise MeshError("that .fbx file holds no mesh geometry")
    return vertices, triangles


# --- Autodesk FBX — the older ASCII flavour --------------------------------

def _ascii_array(text, start):
    """Read one ``a: 1,2,3`` payload following an ``*N {`` array header."""
    open_brace = text.find("{", start)
    if open_brace < 0:
        return None, start
    close_brace = text.find("}", open_brace)
    if close_brace < 0:
        close_brace = len(text)
    body = text[open_brace + 1:close_brace]
    marker = body.find("a:")
    if marker >= 0:
        body = body[marker + 2:]
    return body, close_brace


def _read_fbx_ascii(text):
    vertices = array.array("d")
    triangles = array.array("i")
    pos = 0
    while True:
        v_at = text.find("Vertices:", pos)
        if v_at < 0:
            break
        body, pos = _ascii_array(text, v_at + 9)
        if body is None:
            break
        i_at = text.find("PolygonVertexIndex:", pos)
        if i_at < 0:
            break
        index_body, pos = _ascii_array(text, i_at + 19)
        if index_body is None:
            break
        offset = len(vertices) // 3
        try:
            vertices.extend(float(v) for v in body.replace("\n", " ").split(",") if v.strip())
        except ValueError:
            raise MeshError("that .fbx file could not be read")
        face = []
        for token in index_body.replace("\n", " ").split(","):
            token = token.strip()
            if not token:
                continue
            try:
                raw = int(token)
            except ValueError:
                continue
            if raw < 0:
                face.append(offset + (-raw - 1))
                for k in range(1, len(face) - 1):
                    triangles.extend((face[0], face[k], face[k + 1]))
                face = []
            else:
                face.append(offset + raw)
    if not len(triangles):
        raise MeshError("that .fbx file holds no mesh geometry")
    return vertices, triangles


def _read_fbx(path):
    with open(path, "rb") as handle:
        data = handle.read()
    if data[:len(_FBX_MAGIC)] == _FBX_MAGIC:
        if len(data) < 27:
            raise MeshError("that .fbx file is truncated")
        return _read_fbx_binary(data)
    return _read_fbx_ascii(data.decode("utf-8", "replace"))


# ---------------------------------------------------------------------------
# entry point
# ---------------------------------------------------------------------------

def read_mesh(path):
    """Return the wire buffer for one 3D file, or raise :class:`MeshError`."""
    extension = os.path.splitext(path)[1].lower()
    try:
        if extension == ".obj":
            vertices, triangles = _read_obj(path)
        elif extension == ".fbx":
            vertices, triangles = _read_fbx(path)
        else:
            raise MeshError("that file type has no preview")
    except MeshError:
        raise
    except (OSError, ValueError, struct.error, zlib.error, IndexError,
            MemoryError, RecursionError):
        raise MeshError("that model could not be read")
    return _pack(vertices, triangles)
