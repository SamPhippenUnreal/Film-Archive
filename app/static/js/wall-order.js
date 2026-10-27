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

  return {arrange};
})();
if (typeof module !== 'undefined') module.exports = WallOrder;
