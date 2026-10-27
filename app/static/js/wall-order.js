/* Shared, pure geometry for the tag wall and its drag previews. */
const WallOrder = (() => {
  function arrange(cluster, ids) {
    const photos = cluster.photos;
    if (!photos.length) return cluster;
    const rank = new Map(ids.map((id, i) => [id, i]));
    const sorted = photos.slice().sort((a, b) =>
      (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity));
    // Reordering exchanges fixed slots; it never resizes a print or reshapes
    // the cluster. Shorter rows and all existing gaps stay exactly in place.
    const placed = sorted.map((photo, i) => ({...photo,
      x: photos[i].x, y: photos[i].y, w: photos[i].w, h: photos[i].h}));
    return {...cluster, photos: placed};
  }

  function rows(cluster, count) {
    const photos = cluster.photos;
    if (!photos.length) return cluster;
    count = Math.min(photos.length, Math.max(1, Math.min(5, Math.round(count))));
    const w = photos[0].w, h = photos[0].h, dx = w + 46, dy = h + 64;
    const base = Math.floor(photos.length / count), extra = photos.length % count;
    const columns = base + (extra > 0), width = columns * dx - 46, height = count * dy - 64;
    const cx = (Math.min(...photos.map(p => p.x)) + Math.max(...photos.map(p => p.x))) / 2;
    const cy = (Math.min(...photos.map(p => p.y)) + Math.max(...photos.map(p => p.y))) / 2;
    let i = 0; const placed = [];
    for (let row = 0; row < count; row++) {
      const n = base + (row < extra ? 1 : 0);
      for (let col = 0; col < n; col++) {
        placed.push({...photos[i++], x: cx - width / 2 + w / 2 + col * dx,
          y: cy - height / 2 + h / 2 + row * dy});
      }
    }
    return {...cluster, x: cx, y: cy - height / 2 - 34, photos: placed};
  }
  return {arrange, rows};
})();
if (typeof module !== 'undefined') module.exports = WallOrder;
