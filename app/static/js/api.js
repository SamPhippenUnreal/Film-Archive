/* thin API layer */
const API = {
  async status()        { return (await fetch('/api/status')).json(); },
  async setRoot(path) {
    return (await fetch('/api/root', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({path}),
    })).json();
  },
  async wall(filter) {
    const q = new URLSearchParams();
    if (filter && filter.tags && filter.tags.length)
      q.set('tag', filter.tags.join(','));
    if (filter && filter.stars)  q.set('stars', filter.stars);
    if (filter && filter.camera) q.set('camera', filter.camera);
    if (filter && filter.film)   q.set('film', filter.film);
    if (filter && filter.q)      q.set('q', filter.q);
    const qs = q.toString();
    return (await fetch('/api/wall' + (qs ? '?' + qs : ''))).json();
  },
  async saveFolderOffset(folder, dx, dy) {
    return (await fetch('/api/folder/offset', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({folder, dx, dy}),
    })).json();
  },
  async saveFolderMeta(folder, fields) {
    return (await fetch('/api/folder/meta', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({folder, ...fields}),
    })).json();
  },
  async rescan()        { return (await fetch('/api/rescan', {method:'POST'})).json(); },

  /* ——— projects: an independently-linked archive ——— */
  async projectStatus() { return (await fetch('/api/project/status')).json(); },
  async setProjectRoot(path) {
    return (await fetch('/api/project/root', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({path}),
    })).json();
  },
  async projects() {
    return (await fetch('/api/project/projects')).json();
  },
  async project(id) {
    return (await fetch('/api/project/projects/' + encodeURIComponent(id))).json();
  },
  projectFileUrl(projectId, fileId) {
    return '/project/file/' + encodeURIComponent(projectId) + '/' +
      encodeURIComponent(fileId);
  },
  projectPreviewUrl(projectId, fileId) {
    return '/project/preview/' + encodeURIComponent(projectId) + '/' +
      encodeURIComponent(fileId);
  },
  async setProjectCover(projectId, fileId) {
    return (await fetch(
      '/api/project/projects/' + encodeURIComponent(projectId) + '/cover', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({file_id: fileId}),
      })).json();
  },
  async saveProjectPositions(projectId, positions) {
    return (await fetch(
      '/api/project/projects/' + encodeURIComponent(projectId) + '/positions', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({positions}),
      })).json();
  },
  async saveProjectAnnotations(projectId, annotations) {
    return (await fetch(
      '/api/project/projects/' + encodeURIComponent(projectId) + '/annotations', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(annotations || {}),
      })).json();
  },
  async importProjectPictures(projectId, ids) {
    return (await fetch(
      '/api/project/projects/' + encodeURIComponent(projectId) + '/import/pictures', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ids: ids || []}),
      })).json();
  },
  async importProjectWriting(projectId, ids) {
    return (await fetch(
      '/api/project/projects/' + encodeURIComponent(projectId) + '/import/writing', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ids: ids || []}),
      })).json();
  },
  async tags()          { return (await fetch('/api/tags')).json(); },
  async photo(id)       { return (await fetch('/api/photo/' + id)).json(); },
  async saveMeta(id, fields) {
    return (await fetch(`/api/photo/${id}/meta`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(fields),
    })).json();
  },
  async saveAnnotations(id, data) {
    return (await fetch(`/api/photo/${id}/annotations`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(data),
    })).json();
  },

  /* ——— writing mode: a GUI over a linked folder of .docx documents ——— */
  async writingStatus() { return (await fetch('/api/writing/status')).json(); },
  async setWritingRoot(path) {
    return (await fetch('/api/writing/root', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({path}),
    })).json();
  },
  async documents()     { return (await fetch('/api/writing/documents')).json(); },
  async document(id)    {
    return (await fetch('/api/writing/documents/' + encodeURIComponent(id))).json();
  },
  async createDocument(fields) {
    return (await fetch('/api/writing/documents', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(fields || {}),
    })).json();
  },
  async saveDocument(id, fields) {
    return (await fetch('/api/writing/documents/' + encodeURIComponent(id), {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(fields),
    })).json();
  },
  saveDocumentBeacon(id, fields) {
    // a crash-safe last write on close: fire-and-forget so unload never blocks
    try {
      return navigator.sendBeacon(
        '/api/writing/documents/' + encodeURIComponent(id),
        new Blob([JSON.stringify(fields)], {type: 'application/json'}));
    } catch { return false; }
  },
  async duplicateDocument(id) {
    return (await fetch(
      `/api/writing/documents/${encodeURIComponent(id)}/duplicate`,
      {method: 'POST'})).json();
  },
  async deleteDocument(id) {
    return (await fetch(
      `/api/writing/documents/${encodeURIComponent(id)}/delete`,
      {method: 'POST'})).json();
  },
};

/* every tag quietly receives its own colour — derived from the name, so it
   is stable across sessions and identical everywhere in the app.
   kept pastel / earthy: muted saturation, soft lightness. */
function tagColor(name) {
  let h = 2166136261;
  const s = String(name).trim().toLowerCase();
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h = h >>> 0;
  const hue = h % 360;
  const sat = 26 + (h >>> 9) % 20;    // 26–45 %
  const lit = 58 + (h >>> 17) % 14;   // 58–71 %
  return `hsl(${hue} ${sat}% ${lit}%)`;
}
