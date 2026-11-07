// Layout only: panel resizing, map tabs, canvas zoom/pan.

const $ = (sel) => document.querySelector(sel);

function dragHandle(handle, onMove) {
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('dragging');
    const move = (ev) => onMove(ev, e);
    const up = () => {
      handle.classList.remove('dragging');
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  });
}

function initSplitters() {
  document.querySelectorAll('.splitter-v').forEach((handle) => {
    const panel = document.getElementById(handle.dataset.resize);
    const dir = handle.dataset.side === 'left' ? 1 : -1;
    let startW = 0;
    handle.addEventListener('pointerdown', () => { startW = panel.offsetWidth; });
    dragHandle(handle, (ev, start) => {
      panel.style.width = `${startW + dir * (ev.clientX - start.clientX)}px`;
    });
  });

  // Vertical split between the two sections of a side panel
  document.querySelectorAll('.splitter-h').forEach((handle) => {
    const top = handle.previousElementSibling;
    let startH = 0;
    handle.addEventListener('pointerdown', () => { startH = top.offsetHeight; });
    dragHandle(handle, (ev, start) => {
      top.style.flex = `0 0 ${Math.max(60, startH + ev.clientY - start.clientY)}px`;
    });
  });
}

// Each map keeps its own view transform
const maps = [];

// Global snapping, shared by placing and moving everything
const snap = { grid: false, anchor: false };

function renderSnapButtons() {
  $('#grid-snap').setAttribute('aria-pressed', String(snap.grid));
  $('#anchor-snap').setAttribute('aria-pressed', String(snap.anchor));
}
let activeMap = null;
let mapCounter = 0;

const svg = $('#canvas');
const viewport = $('#viewport');
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 10;

function applyView() {
  const { x, y, zoom } = activeMap.view;
  viewport.setAttribute('transform', `translate(${x} ${y}) scale(${zoom})`);
  $('#zoom-level').textContent = `${Math.round(zoom * 100)}%`;
}

function renderTabs() {
  const tabs = $('#tabs');
  tabs.replaceChildren();
  maps.forEach((map) => {
    const tab = document.createElement('div');
    tab.className = 'tab' + (map === activeMap ? ' active' : '');
    tab.setAttribute('role', 'tab');
    const label = document.createElement('span');
    label.textContent = map.name;
    const close = document.createElement('button');
    close.className = 'close';
    close.textContent = '\u00d7';
    close.title = 'Close';
    close.addEventListener('click', (e) => { e.stopPropagation(); closeMap(map); });
    tab.append(label, close);
    tab.addEventListener('click', () => selectMap(map));
    tab.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openMenu(e.clientX, e.clientY, [
        ['Save', () => saveMap(map)],
        ['Rename', () => startRename(tab, label, map, (name) => !maps.some((other) => other !== map && other.name.toLowerCase() === name.toLowerCase()))],
      ]);
    });
    tabs.append(tab);
  });
}

function newMap() {
  const rect = svg.getBoundingClientRect();
  const map = {
    name: `Untitled ${++mapCounter}`,
    view: { x: rect.width / 2, y: rect.height / 2, zoom: 1 },
    layers: [defaultLayer('Background')],
    objects: [],
    selectedObject: null,
    selectedObjects: [],
  };
  maps.push(map);
  map.selection = [map.layers[0]];
  map.anchor = map.layers[0];
  selectMap(map);
}

function selectMap(map) {
  pathStartPoint = null;
  hideGhost();
  activeMap = map;
  renderTabs();
  applyView();
  renderLayers();
  renderProperties();
}

function saveMap(map = activeMap) {
  if (!map) return;
  const items = Object.fromEntries(allItemStates.map(({ kind, items: entries }) => [
    `${kind}s`, entries.map((item) => structuredClone(item)),
  ]));
  const data = {
    version: 1,
    map: {
      name: map.name,
      view: { ...map.view },
      layers: map.layers.map((layer) => structuredClone(layer)),
      items,
      objects: map.objects.map((object) => ({
        id: object.id,
        type: object.type,
        itemIndex: allItemStates.find((state) => state.kind === object.type)?.items.indexOf(object[object.type]) ?? -1,
        layerIndex: map.layers.indexOf(object.layer),
        ...(object.type === 'path'
          ? { start: { ...object.start }, end: { ...object.end } }
          : object.type === 'icon'
            ? { x: object.x, y: object.y }
            : { x: object.x, y: object.y, slotTexts: { ...object.slotTexts } }),
      })),
    },
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const filename = map.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'map';
  link.href = url;
  link.download = `${filename}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function loadMapData(data) {
  const mapData = data?.map;
  const itemKeys = { marker: 'markers', path: 'paths', icon: 'icons', image: 'images' };
  const objectTypes = ['marker', 'path', 'icon'];
  const invalid = () => { throw new Error('Unsupported or invalid map file.'); };
  if (data?.version !== 1 || !mapData || typeof mapData.name !== 'string') invalid();
  if (!mapData.view || !['x', 'y', 'zoom'].every((key) => Number.isFinite(mapData.view[key])) || mapData.view.zoom <= 0) invalid();
  if (!Array.isArray(mapData.layers) || !mapData.layers.length || mapData.layers.some((layer) => !layer || typeof layer.name !== 'string' || !layer.grid)) invalid();
  if (!mapData.items || Object.values(itemKeys).some((key) => !Array.isArray(mapData.items[key]))) invalid();
  if (Object.values(itemKeys).some((key) => mapData.items[key].some((item) => !item || typeof item.name !== 'string'))) invalid();
  if (!Array.isArray(mapData.objects) || mapData.objects.some((object) => {
    if (!object || !objectTypes.includes(object.type) || !Number.isInteger(object.itemIndex) ||
      object.itemIndex < 0 || object.itemIndex >= mapData.items[itemKeys[object.type]].length ||
      !Number.isInteger(object.layerIndex) || object.layerIndex < 0 || object.layerIndex >= mapData.layers.length) return true;
    if (object.type === 'path') return !['start', 'end'].every((point) => object[point] && Number.isFinite(object[point].x) && Number.isFinite(object[point].y));
    return !Number.isFinite(object.x) || !Number.isFinite(object.y);
  })) invalid();

  const itemRefs = {};
  allItemStates.forEach((state) => {
    const imported = mapData.items[itemKeys[state.kind]];
    itemRefs[state.kind] = imported.map((item) => {
      if (state.kind === 'path') {
        item.orthogonal ??= false;
        item.merge ??= true;
      }
      const serialized = JSON.stringify(item);
      const existing = state.items.find((entry) => JSON.stringify(entry) === serialized);
      if (existing) return existing;
      const copy = structuredClone(item);
      state.items.push(copy);
      return copy;
    });
    itemBrowsers.forEach((browser) => browser.refresh(state.kind));
  });

  const layers = mapData.layers.map((layer) => structuredClone(layer));
  let name = mapData.name;
  let suffix = 2;
  while (maps.some((existing) => existing.name === name)) name = `${mapData.name} (${suffix++})`;
  const map = {
    name,
    view: { ...mapData.view },
    layers,
    objects: mapData.objects.map((object) => object.type === 'path' ? ({
      id: ++objectCounter,
      type: 'path',
      path: itemRefs.path[object.itemIndex],
      layer: layers[object.layerIndex],
      start: { ...object.start },
      end: { ...object.end },
    }) : object.type === 'icon' ? ({
      id: ++objectCounter,
      type: 'icon',
      icon: itemRefs.icon[object.itemIndex],
      layer: layers[object.layerIndex],
      x: object.x,
      y: object.y,
    }) : ({
      id: ++objectCounter,
      type: 'marker',
      marker: itemRefs.marker[object.itemIndex],
      layer: layers[object.layerIndex],
      x: object.x,
      y: object.y,
      slotTexts: { ...(object.slotTexts || {}) },
    })),
    selectedObject: null,
    selectedObjects: [],
  };
  map.selection = [layers[0]];
  map.anchor = layers[0];
  maps.push(map);
  const untitledNumber = /^Untitled (\d+)$/.exec(mapData.name);
  if (untitledNumber) mapCounter = Math.max(mapCounter, Number(untitledNumber[1]));
  selectMap(map);
}

// Layers: first in the list is drawn on top
const layerList = $('#layer-list');
const popover = $('#color-popover');
let popoverLayer = null;

function svgEl(name, attrs, ...children) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', name);
  Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
  el.append(...children);
  return el;
}

function gridPattern(id, grid) {
  const s = grid.size;
  const c = s / 2;
  const line = { stroke: grid.color, 'stroke-opacity': grid.alpha, fill: 'none' };
  let shape;
  if (grid.style === 'dots') {
    shape = svgEl('circle', { cx: c, cy: c, r: 1.5, fill: grid.color, 'fill-opacity': grid.alpha });
  } else if (grid.style === 'crosshair') {
    shape = svgEl('path', { ...line, d: `M ${c - 4} ${c} H ${c + 4} M ${c} ${c - 4} V ${c + 4}` });
  } else {
    const dash = grid.style === 'dashed' ? { 'stroke-dasharray': '6 4' } : {};
    shape = svgEl('path', { ...line, ...dash, d: `M ${s} 0 H 0 V ${s}` });
  }
  return svgEl('pattern', { id, width: s, height: s, patternUnits: 'userSpaceOnUse' }, shape);
}

function renderFills() {
  drawLayerFills($('#layer-fills'), activeMap.layers, 'grid', layerObjects);
  renderAnchorGuides();
}

// Set while a multi-selection is being dragged: the pressed object's kind, and the objects moving with it
let groupDrag = null;

function renderAnchorGuides() {
  const guides = $('#anchor-guides');
  guides.replaceChildren();
  const selectedObject = activeMap?.selectedObject;
  const marker = selectedObject ? (selectedObject.type === 'marker' ? selectedObject.marker : null) : activeMarker();
  const path = selectedObject ? (selectedObject.type === 'path' ? selectedObject.path : null) : activePath();
  const icon = selectedObject ? (selectedObject.type === 'icon' ? selectedObject.icon : null) : activeIcon();
  const kind = groupDrag ? groupDrag.kind : marker ? 'marker' : path ? 'path' : icon ? 'icon' : null;
  const anchorSnap = snap.anchor;
  if (!kind || !anchorSnap) return;
  activeMap.objects.filter((object) => object.type === 'marker' && object.layer.visible && !groupDrag?.exclude.includes(object)).forEach((object) => {
    anchorList(object.marker).filter((anchor) => anchor.accepts.includes(kind)).forEach((anchor) => {
      const x = object.x + (anchor.x - 0.5) * object.marker.width;
      const y = object.y + (anchor.y - 0.5) * object.marker.height;
      guides.append(svgEl('circle', {
        cx: x,
        cy: y,
        r: 5 / activeMap.view.zoom,
        fill: '#ff2d95',
        stroke: '#ffffff',
        'stroke-width': 1.5 / activeMap.view.zoom,
        'vector-effect': 'non-scaling-stroke',
      }));
    });
  });
}

let objectCounter = 0;

// A placed marker references its template item, so template edits show up on re-render
function layerObjects(layer) {
  const g = svgEl('g', {});
  const selected = activeMap.selectedObject;
  const group = activeMap.selectedObjects.length > 1 ? activeMap.selectedObjects : [];
  const objects = activeMap.objects.filter((o) => o.layer === layer);
  const merged = objects.filter((o) => o.type === 'path' && o.path.merge);
  objects.forEach((o) => {
    if (merged.includes(o)) {
      // All merged paths on the layer render together, at the first one's position
      if (o === merged[0]) g.append(mergedPathsGroup(merged));
      return;
    }
    const node = o.type === 'path'
      ? svgEl('g', { 'data-obj': o.id }, pathGroup(o.path, o.start, o.end))
      : o.type === 'icon'
        ? svgEl('g', { transform: `translate(${o.x} ${o.y})`, 'data-obj': o.id }, iconShape(o.icon))
        : svgEl('g', { transform: `translate(${o.x} ${o.y})`, 'data-obj': o.id }, markerGroup(o.marker, `obj${o.id}`, o.slotTexts));
    if (o === selected && o.type === 'path') {
      node.append(pathSelectionHighlight(o.path, o.start, o.end));
      node.append(pathEndpointHandle(o, 'start'), pathEndpointHandle(o, 'end'));
    }
    if (o === selected && o.type === 'marker') node.append(selectionBox(o.marker));
    if (o === selected && o.type === 'icon') node.append(selectionBox(o.icon));
    if (group.includes(o)) {
      if (o.type === 'path') node.append(pathSelectionHighlight(o.path, o.start, o.end));
      else node.append(selectionBox(o.type === 'icon' ? o.icon : o.marker));
    }
    g.append(node);
  });
  // A selected merged path gets its highlight and handles on top of everything
  if (merged.includes(selected)) {
    g.append(svgEl('g', { 'data-obj': selected.id },
      pathSelectionHighlight(selected.path, selected.start, selected.end),
      pathEndpointHandle(selected, 'start'),
      pathEndpointHandle(selected, 'end')));
  }
  // Merged paths in a multi-selection get a highlight on top as well
  merged.filter((o) => group.includes(o)).forEach((o) => {
    g.append(svgEl('g', { 'data-obj': o.id }, pathSelectionHighlight(o.path, o.start, o.end)));
  });
  return g;
}

function selectionBox(m) {
  const w = m.width + m.thickness + 6;
  const h = m.height + m.thickness + 6;
  return svgEl('rect', {
    x: -w / 2,
    y: -h / 2,
    width: w,
    height: h,
    rx: 3,
    fill: 'none',
    stroke: '#4a9eff',
    'stroke-width': 2,
    'stroke-dasharray': '4 3',
    'vector-effect': 'non-scaling-stroke',
    'pointer-events': 'none',
  });
}

function pathSelectionHighlight(path, start, end) {
  return pathGroup({
    ...path,
    fill: 'none',
    fillAlpha: 0,
    outline: '#4a9eff',
    outlineAlpha: 1,
    outlineStyle: 'solid',
    thickness: 2 / activeMap.view.zoom,
  }, start, end);
}

function pathEndpointHandle(object, endpoint) {
  const point = object[endpoint];
  return svgEl('circle', {
    cx: point.x,
    cy: point.y,
    r: 6 / activeMap.view.zoom,
    fill: endpoint === 'start' ? '#4a9eff' : '#ff9f43',
    stroke: '#ffffff',
    'stroke-width': 1.5,
    'vector-effect': 'non-scaling-stroke',
    'data-path-endpoint': endpoint,
    cursor: 'crosshair',
  });
}

// selectedObjects is the full selection; selectedObject is set only when exactly one object is selected
function setObjectSelection(objects) {
  activeMap.selectedObjects = objects;
  activeMap.selectedObject = objects.length === 1 ? objects[0] : null;
  renderFills();
  renderProperties();
}

function clearObjectSelection() {
  if (!activeMap.selectedObjects.length) return;
  setObjectSelection([]);
}

function renderProperties() {
  renderSnapButtons();
  const object = activeMap?.selectedObject;
  const marker = object?.type === 'marker' ? object.marker : object ? null : activeMarker();
  const path = object?.type === 'path' ? object.path : object ? null : activePath();
  const icon = object?.type === 'icon' ? object.icon : object ? null : activeIcon();
  const item = marker || path || icon;
  const empty = $('#properties .empty');
  const panel = $('#marker-properties');
  empty.hidden = !!item;
  const count = activeMap?.selectedObjects.length || 0;
  empty.textContent = count > 1 ? `${count} objects selected.` : 'Nothing selected.';
  panel.hidden = !item;
  if (!item) return;
  $('#selected-item-name').textContent = item.name;
  $('#selected-marker-text-section').hidden = !marker;
  $('#selected-marker-coordinate-grid').hidden = !marker && !icon;
  $('#selected-path-position').hidden = !path || (!object && !pathStartPoint);
  $('#selected-path-empty').hidden = !path || !!object || !!pathStartPoint;
  const slots = $('#selected-marker-slots');
  slots.replaceChildren();
  (marker?.slots || []).filter((slot) => !slot.default).forEach((slot) => {
    const row = document.createElement('div');
    row.className = 'property-slot';
    const label = document.createElement('label');
    const input = document.createElement('input');
    label.textContent = slot.name;
    input.type = 'text';
    input.value = (object?.slotTexts?.[slot.name] ?? marker.placementSlotTexts?.[slot.name] ?? slot.text) || slot.name;
    input.setAttribute('aria-label', slot.name);
    input.addEventListener('input', () => {
      if (object) {
        object.slotTexts ||= {};
        object.slotTexts[slot.name] = input.value;
        renderFills();
      } else {
        marker.placementSlotTexts ||= {};
        marker.placementSlotTexts[slot.name] = input.value;
        ghostItem = null;
        drawGhostAt(ghostPointerPosition);
      }
    });
    row.append(label, input);
    slots.append(row);
  });
  updateSelectedCoordinates();
}

function updateSelectedCoordinates() {
  const object = activeMap?.selectedObject;
  if (object?.type === 'marker' || object?.type === 'icon') {
    $('#selected-marker-x').value = object.x.toFixed(2);
    $('#selected-marker-y').value = object.y.toFixed(2);
  } else if (!object && (activeMarker() || activeIcon())) {
    $('#selected-marker-x').value = ghostPosition.x.toFixed(2);
    $('#selected-marker-y').value = ghostPosition.y.toFixed(2);
  }
  const pathObject = object?.type === 'path' ? object : null;
  const pathStart = pathObject?.start || (!object && activePath() ? pathStartPoint : null);
  const pathEnd = pathObject?.end || (!object && activePath() && pathStartPoint ? ghostPointerPosition : null);
  if (pathStart) {
    $('#selected-path-start-x').value = pathStart.x.toFixed(2);
    $('#selected-path-start-y').value = pathStart.y.toFixed(2);
  }
  if (pathEnd) {
    $('#selected-path-end-x').value = pathEnd.x.toFixed(2);
    $('#selected-path-end-y').value = pathEnd.y.toFixed(2);
  }
  if (pathStart && pathEnd) $('#selected-path-length').value = Math.hypot(pathEnd.x - pathStart.x, pathEnd.y - pathStart.y).toFixed(2);
}

// Draws layers bottom-up into g; prefix keeps pattern ids unique per canvas
function drawLayerFills(g, layers, prefix, objectsFor, showGrid = true) {
  g.replaceChildren();
  const defs = svgEl('defs', {});
  g.append(defs);
  [...layers].reverse().forEach((l, i) => {
    if (!l.visible) return;
    const box = { x: -5000, y: -5000, width: 10000, height: 10000 };
    g.append(svgEl('rect', { ...box, fill: l.color, 'fill-opacity': l.alpha }));
    if (showGrid && l.grid.style !== 'none') {
      defs.append(gridPattern(`${prefix}-${i}`, l.grid));
      g.append(svgEl('rect', { ...box, fill: `url(#${prefix}-${i})` }));
    }
    if (objectsFor) g.append(objectsFor(l));
  });
}

function renderLayers() {
  layerList.replaceChildren();
  const q = $('#layer-search').value.trim().toLowerCase();
  activeMap.layers.forEach((l) => {
    if (q && !l.name.toLowerCase().includes(q)) return;
    const li = document.createElement('li');
    li.className = 'layer-row';
    const vis = document.createElement('input');
    vis.type = 'checkbox';
    vis.title = 'Visible';
    vis.checked = l.visible;
    vis.addEventListener('change', () => { l.visible = vis.checked; renderFills(); });
    const lock = document.createElement('input');
    lock.type = 'checkbox';
    lock.title = 'Locked';
    lock.checked = l.locked;
    lock.addEventListener('change', () => { l.locked = lock.checked; });
    const sw = document.createElement('button');
    sw.className = 'swatch';
    sw.title = 'Color';
    sw.style.setProperty('--c', hexToRgba(l.color, l.alpha));
    sw.addEventListener('click', (e) => { e.stopPropagation(); openColorPicker(l, sw); });
    const name = document.createElement('span');
    name.className = 'entry-name';
    name.textContent = l.name;
    name.addEventListener('dblclick', () => startRename(li, name, l));
    li.append(vis, lock, sw, name);
    if (activeMap.selection.includes(l)) li.classList.add('selected');
    li.layerRef = l;
    li.draggable = true;
    li.addEventListener('click', (e) => clickLayer(l, e));
    li.addEventListener('dragstart', (e) => {
      dragLayer = l;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', l.name);
      const ghost = document.createElement('div');
      ghost.className = 'drag-ghost';
      const chip = document.createElement('span');
      chip.className = 'swatch';
      chip.style.setProperty('--c', hexToRgba(l.color, l.alpha));
      ghost.append(chip, l.name);
      document.body.append(ghost);
      e.dataTransfer.setDragImage(ghost, 12, 12);
      setTimeout(() => ghost.remove());
    });
    li.addEventListener('dragend', () => { dragLayer = null; clearDropMarks(); });
    li.addEventListener('dragover', (e) => {
      if (!dragLayer || dragLayer === l) return;
      e.preventDefault();
      const r = li.getBoundingClientRect();
      const after = e.clientY > r.top + r.height / 2;
      clearDropMarks();
      li.classList.add(after ? 'drop-after' : 'drop-before');
    });
    li.addEventListener('drop', (e) => {
      if (!dragLayer || dragLayer === l) return;
      e.preventDefault();
      const after = li.classList.contains('drop-after');
      const layers = activeMap.layers;
      layers.splice(layers.indexOf(dragLayer), 1);
      layers.splice(layers.indexOf(l) + (after ? 1 : 0), 0, dragLayer);
      dragLayer = null;
      renderLayers();
    });
    layerList.append(li);
  });
  renderFills();
}

let dragLayer = null;

function defaultLayer(name) {
  return { name, visible: true, locked: false, color: '#2b2b2b', alpha: 1, grid: { style: 'solid', color: '#ffffff', alpha: 0.3, size: 50 } };
}

// Selection only toggles classes so a following dblclick still hits the same row
function setSelection(layers, anchor) {
  activeMap.selection = layers;
  if (anchor) activeMap.anchor = anchor;
  layerList.querySelectorAll('li').forEach((el) => el.classList.toggle('selected', layers.includes(el.layerRef)));
}

function clickLayer(l, e) {
  const sel = activeMap.selection;
  if (e.ctrlKey || e.metaKey) {
    if (!sel.includes(l)) setSelection([...sel, l], l);
    else if (sel.length > 1) setSelection(sel.filter((x) => x !== l), l);
  } else if (e.shiftKey) {
    const ls = activeMap.layers;
    const a = ls.indexOf(activeMap.anchor);
    const b = ls.indexOf(l);
    setSelection(ls.slice(Math.min(a, b), Math.max(a, b) + 1));
  } else {
    setSelection([l], l);
  }
}

function insertLayerAbove(ref, layer) {
  const ls = activeMap.layers;
  ls.splice(Math.max(0, ls.indexOf(ref)), 0, layer);
  renderLayers();
}

function nameTaken(name) {
  return activeMap.layers.some((l) => l.name === name);
}

function newLayerName() {
  let n = activeMap.layers.length + 1;
  while (nameTaken(`Layer ${n}`)) n++;
  return `Layer ${n}`;
}

function copyName(base) {
  const first = `${base} copy`;
  if (!nameTaken(first)) return first;
  let n = 1;
  while (nameTaken(`${first} #${n}`)) n++;
  return `${first} #${n}`;
}

function newLayer(ref) {
  openLayerDialog(defaultLayer(newLayerName()), (layer) => {
    insertLayerAbove(ref, layer);
    setSelection([layer], layer);
  });
}

function duplicateLayers(targets) {
  const copies = targets.map((src) => {
    const copy = structuredClone(src);
    copy.name = copyName(src.name);
    insertLayerAbove(src, copy);
    return copy;
  });
  setSelection(copies, copies[0]);
}

function deleteLayers(targets) {
  const ls = activeMap.layers;
  const first = Math.min(...targets.map((t) => ls.indexOf(t)));
  activeMap.layers = ls.filter((l) => !targets.includes(l));
  activeMap.objects = activeMap.objects.filter((o) => !targets.includes(o.layer));
  activeMap.selectedObjects = activeMap.selectedObjects.filter((o) => activeMap.objects.includes(o));
  activeMap.selectedObject = activeMap.selectedObjects.length === 1 ? activeMap.selectedObjects[0] : null;
  if (!activeMap.layers.length) activeMap.layers.push(defaultLayer('Background'));
  let sel = activeMap.selection.filter((l) => activeMap.layers.includes(l));
  if (!sel.length) sel = [activeMap.layers[Math.min(first, activeMap.layers.length - 1)]];
  activeMap.selection = sel;
  activeMap.anchor = sel[0];
  renderLayers();
  renderProperties();
}

// Right-clicking a row outside the selection selects it; inside keeps the multi-selection
function layerContextMenu(e) {
  e.preventDefault();
  const row = e.target.closest('li');
  if (row && !activeMap.selection.includes(row.layerRef)) setSelection([row.layerRef], row.layerRef);
  const targets = [...activeMap.selection];
  targets.sort((a, b) => activeMap.layers.indexOf(a) - activeMap.layers.indexOf(b));
  const s = targets.length > 1 ? 's' : '';
  openMenu(e.clientX, e.clientY, [
    ['Edit Layer', () => openLayerDialog(targets[0], (draft) => {
      Object.assign(targets[0], draft);
      renderLayers();
    }), targets.length > 1],
    ['New Layer', () => newLayer(targets[0])],
    [`Duplicate Layer${s}`, () => duplicateLayers(targets)],
    [`Delete Layer${s}`, () => deleteLayers(targets)],
  ]);
}

function clearDropMarks() {
  layerList.querySelectorAll('.drop-before, .drop-after').forEach((el) => el.classList.remove('drop-before', 'drop-after'));
}

function startRename(li, span, layer, isValid = () => true) {
  li.draggable = false;
  span.contentEditable = 'plaintext-only';
  span.focus();
  getSelection().selectAllChildren(span);
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    const text = span.textContent.trim();
    if (commit && text && isValid(text)) layer.name = text;
    span.contentEditable = 'false';
    span.textContent = layer.name;
    li.draggable = true;
  };
  span.addEventListener('blur', () => finish(true));
  span.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') finish(false);
  });
}

function hexToRgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

let popoverChange = renderLayers;

// The popover moves into the open dialog, since a modal dialog blocks everything outside it
function openColorPicker(layer, anchor, onChange = renderLayers) {
  popoverLayer = layer;
  popoverChange = onChange;
  popoverLoad(layer);
  (anchor.closest('dialog') || $('#layers')).append(popover);
  popover.hidden = false;
  const r = anchor.getBoundingClientRect();
  popover.style.left = `${Math.max(8, Math.min(r.left, innerWidth - popover.offsetWidth - 8))}px`;
  popover.style.top = `${Math.min(r.bottom + 4, innerHeight - popover.offsetHeight - 8)}px`;
}

let dialogLayer = null;
let dialogAccept = null;
let popoverLoad;
let dialogLoad;

// Edits a draft copy; onAccept receives it only if the user accepts
function openLayerDialog(layer, onAccept) {
  dialogLayer = structuredClone(layer);
  dialogAccept = onAccept;
  dialogLoad(dialogLayer);
  const dialog = $('#layer-dialog');
  dialog.returnValue = '';
  dialog.showModal();
}

// Keeps slider and number box pairs in sync (clamped to the slider range), then calls onInput
function bindPairs(root, onInput) {
  root.addEventListener('input', (e) => {
    const k = e.target.dataset.f;
    if (!k) return;
    const isNum = k.endsWith('-num');
    const pairKey = isNum ? k.slice(0, -4) : `${k}-num`;
    const pair = root.querySelector(`[data-f="${pairKey}"]`);
    if (pair) {
      if (e.target.value === '') return;
      pair.value = e.target.value;
      if (isNum) pair.value = Math.min(Number(pair.max), Math.max(Number(pair.min), Number(e.target.value)));
    }
    onInput(e);
  });
}

// Wires a container of layer fields to a layer; returns a function that loads a layer into it
function createLayerForm(root, getLayer, onChange) {
  const f = (k) => root.querySelector(`[data-f="${k}"]`);
  const setField = (k, v) => {
    f(k).value = v;
    const n = f(`${k}-num`);
    if (n) n.value = v;
  };
  const load = (l) => {
    if (f('name')) {
      f('name').value = l.name;
      f('visible').checked = l.visible;
      f('locked').checked = l.locked;
    }
    setField('layer-color', l.color);
    setField('layer-alpha', Math.round(l.alpha * 100));
    setField('grid-style', l.grid.style);
    setField('grid-color', l.grid.color);
    setField('grid-alpha', Math.round(l.grid.alpha * 100));
    setField('grid-size', l.grid.size);
  };
  const apply = () => {
    const l = getLayer();
    if (f('name')) {
      const n = f('name').value.trim();
      if (n) l.name = n;
      l.visible = f('visible').checked;
      l.locked = f('locked').checked;
    }
    l.color = f('layer-color').value;
    l.alpha = Number(f('layer-alpha').value) / 100;
    l.grid.style = f('grid-style').value;
    l.grid.color = f('grid-color').value;
    l.grid.alpha = Number(f('grid-alpha').value) / 100;
    l.grid.size = Number(f('grid-size').value);
    onChange();
  };
  bindPairs(root, apply);
  return load;
}

function initLayers() {
  const fields = () => $('#layer-fields').content.cloneNode(true);
  popover.append(fields());
  const form = $('#layer-dialog form');
  form.insertBefore(fields(), form.querySelector('.actions'));
  popoverLoad = createLayerForm(popover, () => popoverLayer, () => popoverChange());
  dialogLoad = createLayerForm(form, () => dialogLayer, () => {});
  $('#layer-dialog').addEventListener('close', (e) => {
    if (e.target.returnValue === 'accept') dialogAccept(dialogLayer);
  });
  $('#layers').addEventListener('contextmenu', (e) => {
    if (e.target.closest('.layer-header, #color-popover, dialog')) return;
    layerContextMenu(e);
  });
  $('#layer-search').addEventListener('input', renderLayers);
  document.addEventListener('pointerdown', (e) => { if (!popover.contains(e.target)) popover.hidden = true; });
}
initLayers();

function closeMap(map) {
  const i = maps.indexOf(map);
  maps.splice(i, 1);
  if (!maps.length) return newMap();
  if (map === activeMap) selectMap(maps[Math.min(i, maps.length - 1)]);
  else renderTabs();
}

function zoomView(v, factor, cx, cy) {
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.zoom * factor));
  const k = zoom / v.zoom;
  v.x = cx - (cx - v.x) * k;
  v.y = cy - (cy - v.y) * k;
  v.zoom = zoom;
}

function zoomAt(factor, cx, cy) {
  zoomView(activeMap.view, factor, cx, cy);
  applyView();
}

// Wheel zoom and drag pan on an svg; apply() redraws after the view object changes
function enablePanZoom(el, getView, apply, enabled = () => true) {
  el.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (!enabled(e)) return;
    const r = el.getBoundingClientRect();
    zoomView(getView(), Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
    apply();
  }, { passive: false });

  // Stops the browser's middle-click autoscroll from taking over the pan
  el.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });

  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 1) return;
    if (!enabled(e)) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    el.classList.add('panning');
    let lastX = e.clientX;
    let lastY = e.clientY;
    const move = (ev) => {
      const v = getView();
      v.x += ev.clientX - lastX;
      v.y += ev.clientY - lastY;
      lastX = ev.clientX;
      lastY = ev.clientY;
      apply();
    };
    const up = () => {
      el.classList.remove('panning');
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  });
}

// The marker that clicking on the canvas would place: exactly one entry selected, and it is a marker
function activeMarker() {
  const st = allItemStates.find((s) => s.selection.length);
  return st && st.kind === 'marker' && st.selection.length === 1 ? st.selection[0] : null;
}

function activeIcon() {
  const st = allItemStates.find((s) => s.kind === 'icon' && s.selection.length);
  return st && st.selection.length === 1 ? st.selection[0] : null;
}

function activePath() {
  const st = allItemStates.find((s) => s.kind === 'path' && s.selection.length);
  return st && st.selection.length === 1 ? st.selection[0] : null;
}

// The layer new objects go onto: the single selected layer, if it is visible and unlocked
function placementLayer() {
  const sel = activeMap.selection;
  return sel.length === 1 && sel[0].visible && !sel[0].locked ? sel[0] : null;
}

function markerGroup(m, idPrefix, slotTexts) {
  return svgEl('g', {}, markerShape(m), ...markerTextEls(m, idPrefix, slotTexts));
}

function pathGroup(path, start, end) {
  return svgEl('g', {}, pathShape(path, start, end));
}

function pathShape(path, start, end, overrides = {}) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.max(Math.hypot(dx, dy), 0.01);
  const angle = Math.atan2(dy, dx) * 180 / Math.PI;
  const inset = overrides.inset || 0;
  const shape = {
    ...path,
    ...overrides,
    width: Math.max(length + path.height - inset * 2, 0.01),
    height: Math.max(path.height - inset * 2, 0.01),
  };
  if (inset) {
    // True inward offset: original corner radius minus the inset
    const original = {
      square: 0,
      rounded: Math.min(length + path.height, path.height) * 0.25,
      pill: Math.min(length + path.height, path.height) / 2,
    }[path.boxStyle];
    if (original !== undefined) shape.cornerRadius = Math.max(original - inset, 0);
  }
  return svgEl('g', { transform: `translate(${(start.x + end.x) / 2} ${(start.y + end.y) / 2}) rotate(${angle})` }, markerShape(shape));
}

function mergedPathsGroup(paths) {
  const g = svgEl('g', {});
  // Pass 1: every outline, centered on the edge
  paths.forEach((o) => {
    g.append(svgEl('g', { 'data-obj': o.id }, pathShape(o.path, o.start, o.end, { fill: 'none', fillAlpha: 0 })));
  });
  // Pass 2: every fill, inset to the inner edge of its own outline band.
  // The 0.25 overlap hides the antialiasing seam between fill and outline.
  paths.forEach((o) => {
    g.append(svgEl('g', { 'data-obj': o.id }, pathShape(o.path, o.start, o.end, {
      thickness: 0,
      outlineAlpha: 0,
      inset: Math.max(0, o.path.thickness / 2 - 0.25),
    })));
  });
  return g;
}

function constrainPathEndpoint(path, fixed, point) {
  if (!path.orthogonal) return point;
  const dx = point.x - fixed.x;
  const dy = point.y - fixed.y;
  return Math.abs(dx) >= Math.abs(dy) ? { x: point.x, y: fixed.y } : { x: fixed.x, y: point.y };
}

function pathEndpointGhost(path, point) {
  return svgEl('circle', {
    cx: point.x,
    cy: point.y,
    r: path.height / 2,
    fill: path.fill,
    'fill-opacity': path.fillAlpha,
    stroke: path.outline,
    'stroke-opacity': path.outlineAlpha,
    'stroke-width': 1.5 / activeMap.view.zoom,
    'vector-effect': 'non-scaling-stroke',
  });
}

const ghostEl = $('#ghost');
let ghostItem = null;
let ghostPointerPosition = { x: 0, y: 0 };
let ghostPosition = { x: 0, y: 0 };
let pathStartPoint = null;

function hideGhost() {
  ghostEl.replaceChildren();
  ghostEl.removeAttribute('transform');
  ghostItem = null;
}

function drawGhostAt(point) {
  const marker = activeMarker();
  const path = activePath();
  const icon = activeIcon();
  const layer = placementLayer();
  if ((!marker && !path && !icon) || !layer || svg.classList.contains('panning')) {
    hideGhost();
    return;
  }
  if (icon) {
    if (ghostItem !== icon) {
      ghostEl.replaceChildren(iconShape(icon));
      ghostItem = icon;
    }
    ghostPosition = snapMarkerPosition(icon, layer, point.x, point.y, snap.grid, snap.anchor, null, 'icon');
    ghostEl.setAttribute('transform', `translate(${ghostPosition.x} ${ghostPosition.y})`);
    updateSelectedCoordinates();
    return;
  }
  if (path) {
    let snappedPoint = snapPathPosition(path, layer, point.x, point.y, snap.grid, snap.anchor);
    if (pathStartPoint) snappedPoint = constrainPathEndpoint(path, pathStartPoint, snappedPoint);
    ghostEl.removeAttribute('transform');
    if (ghostItem !== path) {
      ghostEl.replaceChildren();
      ghostItem = path;
    }
    ghostEl.replaceChildren(
      ...(pathStartPoint ? [pathGroup(path, pathStartPoint, snappedPoint)] : []),
      pathEndpointGhost(path, snappedPoint),
    );
    updateSelectedCoordinates();
    return;
  }
  if (ghostItem !== marker) {
    ghostEl.replaceChildren(markerGroup(marker, 'ghost', marker.placementSlotTexts));
    ghostItem = marker;
  }
  ghostPosition = snapMarkerPosition(marker, layer, point.x, point.y, snap.grid, snap.anchor);
  ghostEl.setAttribute('transform', `translate(${ghostPosition.x} ${ghostPosition.y})`);
  updateSelectedCoordinates();
}

function canvasPoint(e) {
  const r = svg.getBoundingClientRect();
  const v = activeMap.view;
  return { x: (e.clientX - r.left - v.x) / v.zoom, y: (e.clientY - r.top - v.y) / v.zoom };
}

function updateGhost(e) {
  const item = activeMarker() || activeIcon();
  const path = activePath();
  if ((!item && !path) || !placementLayer() || svg.classList.contains('panning')) {
    hideGhost();
    return;
  }
  ghostPointerPosition = canvasPoint(e);
  drawGhostAt(ghostPointerPosition);
}

function placeMarker(e) {
  const item = activeMarker();
  const layer = placementLayer();
  if (!item || !layer) return;
  const point = canvasPoint(e);
  const { x, y } = snapMarkerPosition(item, layer, point.x, point.y, snap.grid, snap.anchor);
  const slotTexts = { ...(item.placementSlotTexts || {}) };
  activeMap.objects.push({ id: ++objectCounter, type: 'marker', marker: item, layer, x, y, slotTexts });
  renderFills();
}

function placeIcon(e) {
  const item = activeIcon();
  const layer = placementLayer();
  if (!item || !layer) return;
  const point = canvasPoint(e);
  const { x, y } = snapMarkerPosition(item, layer, point.x, point.y, snap.grid, snap.anchor, null, 'icon');
  activeMap.objects.push({ id: ++objectCounter, type: 'icon', icon: item, layer, x, y });
  renderFills();
}

function placePathPoint(e) {
  const path = activePath();
  const layer = placementLayer();
  if (!path || !layer) return;
  const cursor = canvasPoint(e);
  let point = snapPathPosition(path, layer, cursor.x, cursor.y, snap.grid, snap.anchor);
  if (pathStartPoint) point = constrainPathEndpoint(path, pathStartPoint, point);
  if (!pathStartPoint) {
    pathStartPoint = point;
    renderProperties();
    drawGhostAt(point);
    return;
  }
  activeMap.objects.push({
    id: ++objectCounter,
    type: 'path',
    path,
    layer,
    start: pathStartPoint,
    end: point,
  });
  pathStartPoint = null;
  renderFills();
  drawGhostAt(point);
}

// Picks the topmost placed marker under the cursor, or nothing
// The topmost object under the pointer that sits on a selected, unlocked layer (or on any visible layer)
function objectAt(e, anyLayer = false) {
  for (const el of document.elementsFromPoint(e.clientX, e.clientY)) {
    const node = el.closest('[data-obj]');
    if (!node) continue;
    const obj = activeMap.objects.find((o) => o.id === Number(node.dataset.obj));
    if (obj && (anyLayer || (activeMap.selection.includes(obj.layer) && !obj.layer.locked))) return obj;
  }
  return null;
}

function selectObjectAt(e) {
  const obj = objectAt(e);
  const next = obj ? [obj] : [];
  const current = activeMap.selectedObjects;
  if (next.length === current.length && next.every((o, i) => o === current[i])) return;
  setObjectSelection(next);
}

const markerTemplateSelected = () => allItemStates.some((s) => s.kind === 'marker' && s.selection.length);
const pathTemplateSelected = () => allItemStates.some((s) => s.kind === 'path' && s.selection.length);
const iconTemplateSelected = () => allItemStates.some((s) => s.kind === 'icon' && s.selection.length);

// The selected placed marker, if the press at e landed on it and it can be moved
function draggableObjectAt(e) {
  const obj = activeMap.selectedObject;
  if (e.button !== 0 || !obj || !['marker', 'icon'].includes(obj.type) || obj.layer.locked || markerTemplateSelected() || pathTemplateSelected() || iconTemplateSelected()) return null;
  return objectAt(e) === obj ? obj : null;
}

function draggablePathEndpointAt(e) {
  if (e.button !== 0 || !activeMap.selectedObject || activeMap.selectedObject.type !== 'path' || activeMap.selectedObject.layer.locked) return null;
  const el = document.elementFromPoint(e.clientX, e.clientY);
  const handle = el && el.closest('[data-path-endpoint]');
  const node = handle && handle.closest('[data-obj]');
  if (!node || Number(node.dataset.obj) !== activeMap.selectedObject.id) return null;
  return { object: activeMap.selectedObject, endpoint: handle.dataset.pathEndpoint };
}

function startObjectDrag(e, obj) {
  const start = { x: obj.x, y: obj.y };
  const from = canvasPoint(e);
  const node = document.querySelector(`#layer-fills [data-obj="${obj.id}"]`);
  svg.setPointerCapture(e.pointerId);
  const move = (ev) => {
    const p = canvasPoint(ev);
    let x = start.x + p.x - from.x;
    let y = start.y + p.y - from.y;
    ({ x, y } = snapMarkerPosition(obj[obj.type], obj.layer, x, y, snap.grid, snap.anchor, obj, obj.type));
    obj.x = x;
    obj.y = y;
    node.setAttribute('transform', `translate(${obj.x} ${obj.y})`);
    renderAnchorGuides();
    updateSelectedCoordinates();
  };
  const up = () => {
    svg.removeEventListener('pointermove', move);
    svg.removeEventListener('pointerup', up);
  };
  svg.addEventListener('pointermove', move);
  svg.addEventListener('pointerup', up);
}

// A press on any object of a multi-selection (on an unlocked layer)
function draggableGroupAt(e) {
  const group = activeMap.selectedObjects;
  if (e.button !== 0 || group.length < 2 || markerTemplateSelected() || pathTemplateSelected() || iconTemplateSelected()) return null;
  const obj = objectAt(e);
  return obj && group.includes(obj) ? obj : null;
}

// Moves the whole selection. Snapping is applied to the pressed object only (for a path, its endpoint
// nearest the press), and every other object moves by the same offset.
function startGroupDrag(e, clicked) {
  const movers = activeMap.selectedObjects.filter((o) => !o.layer.locked);
  const starts = new Map(movers.map((o) => [o, o.type === 'path' ? { start: { ...o.start }, end: { ...o.end } } : { x: o.x, y: o.y }]));
  const from = canvasPoint(e);
  let ref;
  if (clicked.type === 'path') {
    const nearStart = Math.hypot(from.x - clicked.start.x, from.y - clicked.start.y) <= Math.hypot(from.x - clicked.end.x, from.y - clicked.end.y);
    ref = { ...(nearStart ? clicked.start : clicked.end) };
  } else {
    ref = { x: clicked.x, y: clicked.y };
  }
  const startX = e.clientX;
  const startY = e.clientY;
  let moved = false;
  groupDrag = { kind: clicked.type, exclude: movers };
  renderAnchorGuides();
  svg.setPointerCapture(e.pointerId);
  const move = (ev) => {
    // A press that barely moves stays a click, so it never nudges objects onto the grid
    if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return;
    moved = true;
    const p = canvasPoint(ev);
    let x = ref.x + p.x - from.x;
    let y = ref.y + p.y - from.y;
    ({ x, y } = clicked.type === 'path'
      ? snapPathPosition(clicked.path, clicked.layer, x, y, snap.grid, snap.anchor, movers)
      : snapMarkerPosition(clicked[clicked.type], clicked.layer, x, y, snap.grid, snap.anchor, movers, clicked.type));
    const dx = x - ref.x;
    const dy = y - ref.y;
    movers.forEach((o) => {
      const origin = starts.get(o);
      if (o.type === 'path') {
        o.start = { x: origin.start.x + dx, y: origin.start.y + dy };
        o.end = { x: origin.end.x + dx, y: origin.end.y + dy };
      } else {
        o.x = origin.x + dx;
        o.y = origin.y + dy;
      }
    });
    renderFills();
  };
  const up = () => {
    svg.removeEventListener('pointermove', move);
    svg.removeEventListener('pointerup', up);
    groupDrag = null;
    renderAnchorGuides();
  };
  svg.addEventListener('pointermove', move);
  svg.addEventListener('pointerup', up);
}

function startPathEndpointDrag(e, object, endpoint) {
  const from = canvasPoint(e);
  const start = { ...object[endpoint] };
  svg.setPointerCapture(e.pointerId);
  const move = (ev) => {
    const point = canvasPoint(ev);
    const moved = { x: start.x + point.x - from.x, y: start.y + point.y - from.y };
    const opposite = object[endpoint === 'start' ? 'end' : 'start'];
    let snapped = snapPathPosition(object.path, object.layer, moved.x, moved.y, snap.grid, snap.anchor, object);
    snapped = constrainPathEndpoint(object.path, opposite, snapped);
    object[endpoint] = snapped;
    renderFills();
    updateSelectedCoordinates();
  };
  const up = () => {
    svg.removeEventListener('pointermove', move);
    svg.removeEventListener('pointerup', up);
  };
  svg.addEventListener('pointermove', move);
  svg.addEventListener('pointerup', up);
}

// Exports the active map as a standalone SVG, cropped to its objects (or the current view if it has none)
async function exportMapSvg() {
  const map = activeMap;
  if (!map) return;
  const selected = map.selectedObject;
  const selectedAll = map.selectedObjects;
  map.selectedObject = null; // keep selection boxes and handles out of the export
  map.selectedObjects = [];
  const root = svgEl('svg', { xmlns: 'http://www.w3.org/2000/svg' });
  let box;
  try {
    const fills = svgEl('g', {});
    drawLayerFills(fills, map.layers, 'export', layerObjects, false);
    root.append(...fills.childNodes);

    // Measure the objects in a hidden, attached svg since getBBox needs rendering
    const probe = svgEl('svg', { width: 0, height: 0, style: 'position:absolute;left:-9999px;visibility:hidden' });
    const content = svgEl('g', {});
    map.layers.filter((l) => l.visible).forEach((l) => content.append(layerObjects(l)));
    probe.append(content);
    document.body.append(probe);
    box = content.getBBox();
    probe.remove();
  } finally {
    map.selectedObject = selected;
    map.selectedObjects = selectedAll;
  }

  const pad = 50;
  let x, y, w, h;
  if (box.width > 0 || box.height > 0) {
    x = box.x - pad;
    y = box.y - pad;
    w = box.width + pad * 2;
    h = box.height + pad * 2;
  } else {
    const r = svg.getBoundingClientRect();
    const v = map.view;
    x = -v.x / v.zoom;
    y = -v.y / v.zoom;
    w = r.width / v.zoom;
    h = r.height / v.zoom;
  }
  root.setAttribute('viewBox', `${x} ${y} ${w} ${h}`);
  root.setAttribute('width', Math.ceil(w));
  root.setAttribute('height', Math.ceil(h));

  // Icon images are relative file references; embed them so the export stands alone
  const toDataUri = (blob) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
  const cache = new Map();
  await Promise.all([...root.querySelectorAll('image')].map(async (img) => {
    const href = img.getAttribute('href');
    if (!href || href.startsWith('data:')) return;
    try {
      if (!cache.has(href)) {
        cache.set(href, fetch(href).then((res) => {
          if (!res.ok) throw new Error(res.statusText);
          return res.blob();
        }).then(toDataUri));
      }
      img.setAttribute('href', await cache.get(href));
    } catch (error) {
      console.warn(`Could not embed ${href}`, error);
    }
  }));

  const text = `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(root)}`;
  const url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `${map.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'map'}.svg`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function objectBounds(o) {
  if (o.type === 'path') {
    const r = (o.path.height + o.path.thickness) / 2;
    return { x1: Math.min(o.start.x, o.end.x) - r, y1: Math.min(o.start.y, o.end.y) - r, x2: Math.max(o.start.x, o.end.x) + r, y2: Math.max(o.start.y, o.end.y) + r };
  }
  const item = o.type === 'icon' ? o.icon : o.marker;
  const hw = (item.width + item.thickness) / 2;
  const hh = (item.height + item.thickness) / 2;
  return { x1: o.x - hw, y1: o.y - hh, x2: o.x + hw, y2: o.y + hh };
}

// Left-drag on empty canvas draws a box and selects every object it touches (Shift/Ctrl adds to the selection)
const marqueeEl = svgEl('rect', { fill: 'rgba(74, 158, 255, 0.15)', stroke: '#4a9eff', 'stroke-width': 1, 'stroke-dasharray': '4 3', 'pointer-events': 'none', display: 'none' });
svg.append(marqueeEl);

function startMarquee(e) {
  const r = svg.getBoundingClientRect();
  const from = { clientX: e.clientX, clientY: e.clientY };
  const base = e.shiftKey || e.ctrlKey || e.metaKey ? [...activeMap.selectedObjects] : [];
  let active = false;
  svg.setPointerCapture(e.pointerId);
  const move = (ev) => {
    if (!active && Math.hypot(ev.clientX - from.clientX, ev.clientY - from.clientY) < 4) return;
    active = true;
    const set = (k, v) => marqueeEl.setAttribute(k, v);
    set('x', Math.min(from.clientX, ev.clientX) - r.left);
    set('y', Math.min(from.clientY, ev.clientY) - r.top);
    set('width', Math.abs(ev.clientX - from.clientX));
    set('height', Math.abs(ev.clientY - from.clientY));
    set('display', 'inline');
  };
  const up = (ev) => {
    svg.removeEventListener('pointermove', move);
    svg.removeEventListener('pointerup', up);
    marqueeEl.setAttribute('display', 'none');
    if (!active) return;
    const a = canvasPoint(from);
    const b = canvasPoint(ev);
    const box = { x1: Math.min(a.x, b.x), y1: Math.min(a.y, b.y), x2: Math.max(a.x, b.x), y2: Math.max(a.y, b.y) };
    const hits = activeMap.objects.filter((o) => {
      if (!activeMap.selection.includes(o.layer) || !o.layer.visible || o.layer.locked) return false;
      const t = objectBounds(o);
      return t.x1 <= box.x2 && t.x2 >= box.x1 && t.y1 <= box.y2 && t.y2 >= box.y1;
    });
    setObjectSelection([...base, ...hits.filter((o) => !base.includes(o))]);
  };
  svg.addEventListener('pointermove', move);
  svg.addEventListener('pointerup', up);
}

function initCanvas() {
  enablePanZoom(svg, () => activeMap.view, applyView, (e) => e.type === 'wheel' || (!draggableObjectAt(e) && !draggablePathEndpointAt(e)));
  // Double-clicking an object switches the layer selection to that object's layer
  svg.addEventListener('dblclick', (e) => {
    if (markerTemplateSelected() || pathTemplateSelected() || iconTemplateSelected()) return;
    const obj = objectAt(e, true);
    if (!obj) return;
    setSelection([obj.layer], obj.layer);
    if (!obj.layer.locked) setObjectSelection([obj]);
  });
  svg.addEventListener('pointermove', updateGhost);
  svg.addEventListener('pointerenter', updateGhost);
  svg.addEventListener('pointerleave', hideGhost);
  document.addEventListener('keydown', (e) => {
    const doomed = activeMap.selectedObjects.filter((o) => !o.layer.locked);
    if (e.key !== 'Delete' || !doomed.length) return;
    if (e.target.closest('input, textarea, select, [contenteditable]') || document.querySelector('dialog[open]')) return;
    activeMap.objects = activeMap.objects.filter((o) => !doomed.includes(o));
    setObjectSelection([]);
  });
  svg.addEventListener('contextmenu', (e) => {
    if (!markerTemplateSelected() && !pathTemplateSelected() && !iconTemplateSelected()) {
      if (activeMap.selectedObjects.length) {
        e.preventDefault();
        clearObjectSelection();
      }
      return;
    }
    const st = allItemStates.find((s) => ['marker', 'path', 'icon'].includes(s.kind) && s.selection.length);
    e.preventDefault();
    st.selection = [];
    st.anchor = null;
    pathStartPoint = null;
    selectionSyncers.forEach((fn) => fn());
    renderProperties();
    renderAnchorGuides();
    hideGhost();
  });

  // A press that barely moves is a click; anything more is a pan
  let down = null;
  svg.addEventListener('pointerdown', (e) => {
    down = e.button === 0 ? { x: e.clientX, y: e.clientY } : null;
    const endpoint = draggablePathEndpointAt(e);
    if (endpoint) startPathEndpointDrag(e, endpoint.object, endpoint.endpoint);
    else {
      const obj = draggableObjectAt(e);
      const group = obj ? null : draggableGroupAt(e);
      if (obj) startObjectDrag(e, obj);
      else if (group) startGroupDrag(e, group);
      else if (e.button === 0 && !markerTemplateSelected() && !pathTemplateSelected() && !iconTemplateSelected()) startMarquee(e);
    }
  });
  svg.addEventListener('pointerup', (e) => {
    if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 4) {
      if (markerTemplateSelected()) placeMarker(e);
      else if (iconTemplateSelected()) placeIcon(e);
      else if (pathTemplateSelected()) placePathPoint(e);
      else selectObjectAt(e);
    }
    down = null;
  });

  const center = () => {
    const r = svg.getBoundingClientRect();
    return [r.width / 2, r.height / 2];
  };
  $('#zoom-in').addEventListener('click', () => zoomAt(1.25, ...center()));
  $('#zoom-out').addEventListener('click', () => zoomAt(0.8, ...center()));
  $('#zoom-reset').addEventListener('click', () => {
    const [cx, cy] = center();
    activeMap.view = { x: cx, y: cy, zoom: 1 };
    applyView();
  });
  $('#new-tab').addEventListener('click', newMap);
  $('[data-action="new"]').addEventListener('click', newMap);
  $('[data-action="save"]').addEventListener('click', () => saveMap());
  $('[data-action="export"]')?.addEventListener('click', () => exportMapSvg());
  const snapChanged = () => {
    renderSnapButtons();
    renderAnchorGuides();
    drawGhostAt(ghostPointerPosition);
  };
  $('#grid-snap').addEventListener('click', () => {
    snap.grid = !snap.grid;
    snapChanged();
  });
  $('#anchor-snap').addEventListener('click', () => {
    snap.anchor = !snap.anchor;
    snapChanged();
  });
  renderSnapButtons();
  const loadInput = document.createElement('input');
  loadInput.type = 'file';
  loadInput.accept = '.json,application/json';
  loadInput.hidden = true;
  document.body.append(loadInput);
  loadInput.addEventListener('change', async () => {
    const [file] = loadInput.files;
    if (!file) return;
    try {
      loadMapData(JSON.parse(await file.text()));
    } catch (error) {
      alert(`Could not load map: ${error.message}`);
    } finally {
      loadInput.value = '';
    }
  });
  $('[data-action="load"]').addEventListener('click', () => loadInput.click());
}

// Item browsers (templates, labels/icons): placeholder in-memory data until real items exist
const menu = $('#context-menu');

// Only one item list can hold a selection at a time (it decides what is placed on the canvas)
const allItemStates = [];
const selectionSyncers = [];
const itemBrowsers = [];

function createItemBrowser(root, kinds) {
  const state = Object.fromEntries(Object.keys(kinds).map((k) => [k, { kind: k, items: [], selection: [], anchor: null }]));
  allItemStates.push(...Object.values(state));
  const ul = root.querySelector('.template-list');
  let kind = Object.keys(kinds)[0];
  let drag = null;
  const cur = () => state[kind];
  const label = () => kinds[kind].label;
  const editor = () => kinds[kind].editor;

  function syncSelection() {
    const { selection } = cur();
    ul.querySelectorAll('li').forEach((el) => el.classList.toggle('selected', selection.includes(el.itemRef)));
  }
  selectionSyncers.push(syncSelection);

  // Selection only toggles classes so a following dblclick still hits the same row
  function select(sel, anchor) {
    if (sel.length) {
      allItemStates.forEach((s) => { if (s !== cur()) { s.selection = []; s.anchor = null; } });
    }
    cur().selection = sel;
    if (anchor) cur().anchor = anchor;
    else if (!sel.length) cur().anchor = null;
    if (sel.length && ['marker', 'path', 'icon'].includes(cur().kind)) clearObjectSelection();
    selectionSyncers.forEach((fn) => fn());
    renderProperties();
    renderAnchorGuides();
    if (!activePath()) pathStartPoint = null;
    if (activeMarker() || activePath() || activeIcon()) drawGhostAt(ghostPointerPosition);
    else {
      pathStartPoint = null;
      hideGhost();
    }
  }

  function click(item, e) {
    const { items, selection, anchor } = cur();
    if (e.ctrlKey || e.metaKey) {
      if (!selection.includes(item)) select([...selection, item], item);
      else select(selection.filter((x) => x !== item), selection.length > 1 ? item : null);
    } else if (e.shiftKey) {
      const b = items.indexOf(item);
      const a = items.includes(anchor) ? items.indexOf(anchor) : b;
      select(items.slice(Math.min(a, b), Math.max(a, b) + 1));
    } else {
      select([item], item);
    }
  }

  function insertAbove(ref, item) {
    const { items } = cur();
    items.splice(Math.max(0, items.indexOf(ref)), 0, item);
  }

  function newName() {
    const { items } = cur();
    let n = items.length + 1;
    while (items.some((i) => i.name === `New ${label()} ${n}`)) n++;
    return `New ${label()} ${n}`;
  }

  function create(ref) {
    const st = cur();
    const add = (item) => {
      insertAbove(ref, item);
      render();
    };
    const ed = editor();
    if (ed) ed.open(ed.blank(), st.items, null, add);
    else add({ name: newName() });
  }

  function duplicate(targets) {
    const { items } = cur();
    const copies = targets.map((src) => {
      const copy = structuredClone(src);
      copy.name = uniqueName(items, `${src.name} copy`);
      insertAbove(src, copy);
      return copy;
    });
    render();
  }

  function remove(targets) {
    const st = cur();
    st.items = st.items.filter((i) => !targets.includes(i));
    select(st.selection.filter((i) => st.items.includes(i)));
    render();
  }

  // Kinds without an editor dialog edit by renaming in place
  function edit(item) {
    const st = cur();
    const ed = editor();
    if (ed) {
      ed.open(structuredClone(item), st.items, item, (draft) => {
        Object.assign(item, draft);
        ghostItem = null;
        renderFills();
        render();
      });
      return;
    }
    const li = [...ul.children].find((el) => el.itemRef === item);
    startRename(li, li.querySelector('.entry-name'), item);
  }

  // Right-clicking a row outside the selection selects it; inside keeps the multi-selection
  function contextMenu(e) {
    e.preventDefault();
    const st = cur();
    const row = e.target.closest('li');
    if (row && row.itemRef && !st.selection.includes(row.itemRef)) select([row.itemRef], row.itemRef);
    const targets = st.items.filter((i) => st.selection.includes(i));
    const k = label();
    const s = targets.length > 1 ? 's' : '';
    openMenu(e.clientX, e.clientY, [
      [`Edit ${k}`, () => edit(targets[0]), targets.length !== 1],
      [`New ${k}`, () => create(targets[0])],
      [`Duplicate ${k}${s}`, () => duplicate(targets), !targets.length],
      [`Delete ${k}${s}`, () => remove(targets), !targets.length],
    ]);
  }

  function clearMarks() {
    ul.querySelectorAll('.drop-before, .drop-after').forEach((el) => el.classList.remove('drop-before', 'drop-after'));
  }

  function render() {
    ul.replaceChildren();
    const st = cur();
    if (!st.items.length) {
      const li = document.createElement('li');
      li.className = 'create';
      li.textContent = `Create ${label()}`;
      li.addEventListener('click', () => create());
      ul.append(li);
      return;
    }
    const ed = editor();
    st.items.forEach((item) => {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.className = 'entry-name';
      name.textContent = item.name;
      name.addEventListener('dblclick', () => startRename(li, name, item, (text) => !ed || !st.items.some((i) => i !== item && i.name.toLowerCase() === text.toLowerCase())));
      if (ed && ed.thumb) li.append(ed.thumb(item));
      li.append(name);
      li.itemRef = item;
      li.draggable = true;
      if (st.selection.includes(item)) li.classList.add('selected');
      li.addEventListener('click', (e) => click(item, e));
      li.addEventListener('dragstart', (e) => {
        drag = item;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', item.name);
        const ghost = document.createElement('div');
        ghost.className = 'drag-ghost';
        if (ed && ed.thumb) ghost.append(ed.thumb(item));
        ghost.append(item.name);
        document.body.append(ghost);
        e.dataTransfer.setDragImage(ghost, 12, 12);
        setTimeout(() => ghost.remove());
      });
      li.addEventListener('dragend', () => { drag = null; clearMarks(); });
      li.addEventListener('dragover', (e) => {
        if (!drag || drag === item) return;
        e.preventDefault();
        const r = li.getBoundingClientRect();
        clearMarks();
        li.classList.add(e.clientY > r.top + r.height / 2 ? 'drop-after' : 'drop-before');
      });
      li.addEventListener('drop', (e) => {
        if (!drag || drag === item) return;
        e.preventDefault();
        const after = li.classList.contains('drop-after');
        st.items.splice(st.items.indexOf(drag), 1);
        st.items.splice(st.items.indexOf(item) + (after ? 1 : 0), 0, drag);
        drag = null;
        render();
      });
      ul.append(li);
    });
  }

  root.querySelectorAll('.subtabs button').forEach((btn) => {
    btn.addEventListener('click', () => {
      kind = btn.dataset.kind;
      root.querySelectorAll('.subtabs button').forEach((b) => b.classList.toggle('active', b === btn));
      render();
    });
  });
  ul.addEventListener('contextmenu', contextMenu);
  render();
  return { refresh: (targetKind) => { if (kind === targetKind) render(); } };
}

function openMenu(x, y, items) {
  menu.replaceChildren(...items.map(([label, fn, disabled]) => {
    const li = document.createElement('li');
    li.textContent = label;
    if (disabled) {
      li.className = 'disabled';
      return li;
    }
    li.addEventListener('click', () => { hideMenu(); fn(); });
    return li;
  }));
  menu.hidden = false;
  menu.style.left = `${Math.min(x, innerWidth - menu.offsetWidth)}px`;
  menu.style.top = `${Math.min(y, innerHeight - menu.offsetHeight)}px`;
}

function hideMenu() { menu.hidden = true; }

function initBrowsers() {
  itemBrowsers.push(createItemBrowser($('#templates'), {
    marker: { label: 'Marker', editor: markerEditor },
    path: { label: 'Path', editor: pathEditor },
  }));
  itemBrowsers.push(createItemBrowser($('#assets'), { icon: { label: 'Icon', editor: iconEditor }, image: { label: 'Image' } }));
  document.addEventListener('pointerdown', (e) => { if (!menu.contains(e.target)) hideMenu(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideMenu(); });
}

// Returns base, or base with " #n" appended if an item in list already uses it
function uniqueName(list, base) {
  const taken = new Set(list.map((i) => i.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  let n = 1;
  while (taken.has(`${base} #${n}`.toLowerCase())) n++;
  return `${base} #${n}`;
}

// Marker editor dialog
const markerDialog = $('#marker-dialog');
const markerForm = markerDialog.querySelector('form');
const markerPreview = $('#marker-preview');
const markerView = { x: 0, y: 0, zoom: 1 };
const markerField = (k) => markerForm.querySelector(`[data-f="${k}"]`);
let markerDraft = null;
let markerTaken = new Set();
let markerAccept = null;
let markerBg = null;

// data key -> form field key
const MARKER_FIELDS = {
  name: 'name',
  width: 'width',
  height: 'height',
  boxStyle: 'box-style',
  fill: 'fill',
  fillAlpha: 'fill-alpha',
  outlineStyle: 'outline-style',
  outline: 'outline',
  outlineAlpha: 'outline-alpha',
  thickness: 'thickness',
};
const MARKER_PERCENT = ['fillAlpha', 'outlineAlpha'];
const MARKER_NUMBERS = ['thickness', 'width', 'height'];

const pathDialog = $('#path-dialog');
const pathForm = pathDialog.querySelector('form');
const pathPreview = $('#path-preview');
const pathView = { x: 0, y: 0, zoom: 1 };
const pathField = (key) => pathForm.querySelector(`[data-f="path-${key}"]`);
const PATH_FIELDS = {
  name: 'name',
  orthogonal: 'orthogonal',
  merge: 'merge',
  height: 'height',
  boxStyle: 'box-style',
  fill: 'fill',
  fillAlpha: 'fill-alpha',
  outlineStyle: 'outline-style',
  outline: 'outline',
  outlineAlpha: 'outline-alpha',
  thickness: 'thickness',
};
let pathDraft = null;
let pathTaken = new Set();
let pathAccept = null;
let pathBg = null;

function defaultPath() {
  return {
    name: 'New Path',
    orthogonal: false,
    merge: true,
    height: 15,
    boxStyle: 'square',
    fill: '#808080',
    fillAlpha: 1,
    outlineStyle: 'solid',
    outline: '#ffffff',
    outlineAlpha: 1,
    thickness: 1,
  };
}

function defaultMarker() {
  return {
    name: 'New Marker',
    width: 110,
    height: 90, 
    boxStyle: 'rounded',
    fill: '#808080',
    fillAlpha: 1,
    outlineStyle: 'solid',
    outline: '#ffffff',
    outlineAlpha: 1,
    thickness: 3,
    slots: [defaultSlot()],
    anchors: defaultAnchors(),
  };
}

// Text slots. slots[0] is the Default slot; other slots store only the style keys they override.
const measureCtx = document.createElement('canvas').getContext('2d');
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const SLOT_STYLE_FIELDS = {
  fontFamily: 'slot-font',
  fontSize: 'slot-size',
  color: 'slot-color',
  bold: 'slot-bold',
  italic: 'slot-italic',
  hAlign: 'slot-halign',
  vAlign: 'slot-valign',
  mode: 'slot-mode',
};
const SLOT_BOOLS = ['bold', 'italic'];
const SLOT_NUMS = ['fontSize'];
const SLOT_RECT_FIELDS = { x: 'slot-x', y: 'slot-y', w: 'slot-w', h: 'slot-h' };
const MIN_SLOT_SIZE = 0.02;

let selectedSlot = null;
let overlay = null;
let textEditSlot = null;
let textEditOriginal;

function defaultSlot() {
  return {
    name: 'Label',
    default: true,
    rect: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 },
    style: {
      fontFamily: 'sans-serif',
      fontSize: 12,
      color: '#000000',
      bold: false,
      italic: false,
      hAlign: 'center',
      vAlign: 'middle',
      mode: 'wrap',
    },
  };
}

const slotStyle = (m, slot) => ({ ...m.slots[0].style, ...slot.style });

// Slot rectangle in marker coordinates (marker centered on the origin)
function slotBox(m, slot) {
  const r = slot.rect;
  return { x: -m.width / 2 + r.x * m.width, y: -m.height / 2 + r.y * m.height, w: r.w * m.width, h: r.h * m.height };
}

function wrapLines(text, measure, w) {
  const out = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const test = line ? `${line} ${word}` : word;
    if (measure(test) <= w) {
      line = test;
      continue;
    }
    if (line) out.push(line);
    line = word;
    if (measure(word) > w) {
      let chunk = '';
      for (const ch of word) {
        if (chunk && measure(chunk + ch) > w) {
          out.push(chunk);
          chunk = ch;
        } else {
          chunk += ch;
        }
      }
      line = chunk;
    }
  }
  if (line) out.push(line);
  return out.length ? out : [''];
}

// Splits at the word break that makes the two lines most even
function balancedSplit(text, measure) {
  const words = text.split(/\s+/).filter(Boolean);
  let best = [text];
  let bestWidth = Infinity;
  for (let i = 1; i < words.length; i++) {
    const pair = [words.slice(0, i).join(' '), words.slice(i).join(' ')];
    const width = Math.max(measure(pair[0]), measure(pair[1]));
    if (width < bestWidth) {
      best = pair;
      bestWidth = width;
    }
  }
  return best;
}

// Returns { size, lh, lines } for text laid out in a w x h area
function layoutText(text, st, w, h) {
  const ctx = measureCtx;
  const measure = (s) => ctx.measureText(s).width;
  const setFont = (size) => {
    ctx.font = `${st.italic ? 'italic ' : ''}${st.bold ? 'bold ' : ''}${size}px ${st.fontFamily}`;
  };
  let size = st.fontSize;
  if (st.mode === 'shrink') {
    while (size > 4) {
      setFont(size);
      if (measure(text) <= w && size * 1.2 <= h) break;
      size -= 0.5;
    }
    size = Math.max(size, 4);
    return { size, lh: size * 1.2, lines: [text] };
  }
  setFont(size);
  if (st.mode === 'clip') return { size, lh: size * 1.2, lines: [text] };
  let lines = wrapLines(text, measure, w);
  if (st.mode === 'force' && lines.length === 1) lines = balancedSplit(text, measure);
  return { size, lh: size * 1.2, lines };
}

function markerTextEls(m, idPrefix = 'slot-clip', slotTexts) {
  return m.slots.filter((slot) => !slot.default).map((slot, index) => {
    const st = slotStyle(m, slot);
    const text = (slotTexts?.[slot.name] ?? slot.text) || slot.name;
    const box = slotBox(m, slot);
    const { size, lh, lines } = layoutText(text, st, box.w, box.h);
    const block = lines.length * lh;
    const top = { top: box.y, middle: box.y + (box.h - block) / 2, bottom: box.y + box.h - block }[st.vAlign];
    const x = { left: box.x, center: box.x + box.w / 2, right: box.x + box.w }[st.hAlign];
    const texts = lines.map((line, i) => svgEl('text', {
      x,
      y: top + lh * i + lh / 2,
      'text-anchor': { left: 'start', center: 'middle', right: 'end' }[st.hAlign],
      'dominant-baseline': 'central',
      'font-family': st.fontFamily,
      'font-size': size,
      'font-weight': st.bold ? 'bold' : 'normal',
      'font-style': st.italic ? 'italic' : 'normal',
      fill: st.color,
    }, line));
    if (st.mode !== 'clip') return svgEl('g', {}, ...texts);
    const id = `${idPrefix}-${index}`;
    const clip = svgEl('clipPath', { id }, svgEl('rect', { x: box.x, y: box.y, width: box.w, height: box.h }));
    return svgEl('g', { 'clip-path': `url(#${id})` }, clip, ...texts);
  });
}

const HANDLE_DIRS = { nw: [0, 0], n: [0.5, 0], ne: [1, 0], e: [1, 0.5], se: [1, 1], s: [0.5, 1], sw: [0, 1], w: [0, 0.5] };
const HANDLE_CURSORS = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' };

// Elements are built once and repositioned, so a drag keeps its pointer capture
function buildOverlay() {
  const g = $('#marker-overlay');
  g.replaceChildren();
  overlay = null;
  if (markerTab !== 'text' || !selectedSlot) return;
  const common = { stroke: '#4a9eff', 'vector-effect': 'non-scaling-stroke' };
  const rect = svgEl('rect', { ...common, fill: 'none', 'pointer-events': 'all', cursor: 'move' });
  rect.addEventListener('pointerdown', (e) => startSlotDrag(e, 'move'));
  rect.addEventListener('dblclick', editSlotText);
  g.append(rect);
  const handles = {};
  Object.keys(HANDLE_DIRS).forEach((dir) => {
    const h = svgEl('rect', { ...common, fill: '#ffffff', cursor: HANDLE_CURSORS[dir] });
    h.addEventListener('pointerdown', (e) => startSlotDrag(e, dir));
    g.append(h);
    handles[dir] = h;
  });
  overlay = { rect, handles };
  positionOverlay();
}

function positionOverlay() {
  if (!overlay) return;
  const b = slotBox(markerDraft, selectedSlot);
  const set = (el, attrs) => Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
  set(overlay.rect, { x: b.x, y: b.y, width: b.w, height: b.h });
  const s = 8 / markerView.zoom;
  Object.entries(HANDLE_DIRS).forEach(([dir, [fx, fy]]) => {
    set(overlay.handles[dir], { x: b.x + fx * b.w - s / 2, y: b.y + fy * b.h - s / 2, width: s, height: s });
  });
}

function startSlotDrag(e, dir) {
  e.preventDefault();
  e.stopPropagation();
  const slot = selectedSlot;
  const start = { ...slot.rect };
  const sx = e.clientX;
  const sy = e.clientY;
  const el = e.currentTarget;
  el.setPointerCapture(e.pointerId);
  const move = (ev) => {
    const dx = (ev.clientX - sx) / markerView.zoom / markerDraft.width;
    const dy = (ev.clientY - sy) / markerView.zoom / markerDraft.height;
    if (dir === 'move') {
      slot.rect = { ...start, x: clamp(start.x + dx, 0, 1 - start.w), y: clamp(start.y + dy, 0, 1 - start.h) };
    } else {
      let l = start.x;
      let t = start.y;
      let r = start.x + start.w;
      let b = start.y + start.h;
      if (dir.includes('w')) l = clamp(l + dx, 0, r - MIN_SLOT_SIZE);
      if (dir.includes('e')) r = clamp(r + dx, l + MIN_SLOT_SIZE, 1);
      if (dir.includes('n')) t = clamp(t + dy, 0, b - MIN_SLOT_SIZE);
      if (dir.includes('s')) b = clamp(b + dy, t + MIN_SLOT_SIZE, 1);
      slot.rect = { x: l, y: t, w: r - l, h: b - t };
    }
    loadRectFields();
    drawMarkerPreview();
  };
  const up = () => {
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
}

function setMarkerField(field, v) {
  const el = markerField(field);
  if (el.type === 'checkbox') el.checked = v;
  else if ('toggle' in el.dataset) el.classList.toggle('on', v);
  else el.value = v;
  paintColorButton(el);
  const num = markerField(`${field}-num`);
  if (num) num.value = v;
}

// The color button shows the current color as a bar under its letter
function paintColorButton(el) {
  const btn = el.closest('.color-btn');
  if (btn) btn.style.setProperty('--c', el.value);
}

function loadRectFields() {
  Object.entries(SLOT_RECT_FIELDS).forEach(([key, field]) => setMarkerField(field, Math.round(selectedSlot.rect[key] * 100)));
}

function loadSlotForm() {
  const st = slotStyle(markerDraft, selectedSlot);
  Object.entries(SLOT_STYLE_FIELDS).forEach(([key, field]) => setMarkerField(field, st[key]));
  loadRectFields();
  $('#slot-rename').disabled = !!selectedSlot.default;
  $('#slot-delete').disabled = !!selectedSlot.default;
}

function renderSlotList() {
  const ul = $('#slot-list');
  ul.replaceChildren();
  markerDraft.slots.filter((slot) => !slot.default).forEach((slot) => {
    const li = document.createElement('li');
    li.textContent = slot.name;
    li.slotRef = slot;
    if (slot.default) li.classList.add('default');
    if (slot === selectedSlot) li.classList.add('selected');
    li.addEventListener('click', () => selectSlot(slot));
    li.addEventListener('dblclick', () => renameSlot(slot));
    ul.append(li);
  });
}

function renameSlot(slot) {
  if (slot.default) return;
  const li = [...$('#slot-list').children].find((el) => el.slotRef === slot);
  const input = document.createElement('input');
  input.type = 'text';
  input.value = slot.name;
  li.replaceChildren(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    const taken = markerDraft.slots.some((s) => s !== slot && s.name.toLowerCase() === name.toLowerCase());
    if (commit && name && !taken) slot.name = name;
    renderSlotList();
    drawMarkerPreview();
  };
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  });
}

// Double-clicking the area box types custom text into the slot; empty falls back to the slot name
function editSlotText() {
  if (!overlay) return;
  const slot = selectedSlot;
  const r = overlay.rect.getBoundingClientRect();
  const input = $('#slot-text-edit');
  textEditSlot = slot;
  textEditOriginal = slot.text;
  input.value = slot.text || slot.name;
  input.hidden = false;
  Object.assign(input.style, { left: `${r.left}px`, top: `${r.top + r.height / 2 - 14}px`, width: `${Math.max(r.width, 140)}px` });
  input.focus();
  input.select();
}

function closeTextEdit(commit) {
  const slot = textEditSlot;
  if (!slot) return;
  textEditSlot = null;
  $('#slot-text-edit').hidden = true;
  if (!commit) slot.text = textEditOriginal;
  if (!slot.text || !slot.text.trim()) delete slot.text;
  drawMarkerPreview();
}

function selectSlot(slot) {
  selectedSlot = slot;
  renderSlotList();
  loadSlotForm();
  buildOverlay();
  drawMarkerPreview();
}

function addSlot(slot, afterSlot) {
  const slots = markerDraft.slots;
  slots.splice(slots.indexOf(afterSlot) + 1, 0, slot);
  selectSlot(slot);
}

function newSlot() {
  const base = markerDraft.slots[0];
  addSlot({ name: uniqueName(markerDraft.slots, 'New Slot'), style: { ...base.style }, rect: { ...base.rect } }, markerDraft.slots.at(-1));
}

function copySlot() {
  const src = selectedSlot;
  const style = src.default ? {} : { ...src.style };
  addSlot({ name: uniqueName(markerDraft.slots, `${src.name} copy`), style, rect: { ...src.rect } }, src);
}

function deleteSlot() {
  if (selectedSlot.default) return;
  const slots = markerDraft.slots;
  const i = slots.indexOf(selectedSlot);
  slots.splice(i, 1);
  selectSlot(slots[Math.min(i, slots.length - 1)]);
}

// Applies the one slot field that changed; non-default slots only store values that differ from Default
function applySlotField(field) {
  const slot = selectedSlot;
  const el = markerField(field);
  const styleKey = Object.keys(SLOT_STYLE_FIELDS).find((k) => SLOT_STYLE_FIELDS[k] === field);
  const rectKey = Object.keys(SLOT_RECT_FIELDS).find((k) => SLOT_RECT_FIELDS[k] === field);
  if (rectKey) {
    const r = { ...slot.rect, [rectKey]: Number(el.value) / 100 };
    r.w = clamp(r.w, MIN_SLOT_SIZE, 1);
    r.h = clamp(r.h, MIN_SLOT_SIZE, 1);
    r.x = clamp(r.x, 0, 1 - r.w);
    r.y = clamp(r.y, 0, 1 - r.h);
    slot.rect = r;
    loadRectFields();
  } else if (styleKey) {
    let v = el.value;
    if (SLOT_BOOLS.includes(styleKey)) v = el.type === 'checkbox' ? el.checked : el.classList.contains('on');
    else if (SLOT_NUMS.includes(styleKey)) {
      if (v === '') return;
      v = clamp(Number(v), Number(el.min), Number(el.max));
    }
    paintColorButton(el);
    if (slot.default || v !== markerDraft.slots[0].style[styleKey]) slot.style[styleKey] = v;
    else delete slot.style[styleKey];
  }
  drawMarkerPreview();
}

// Centered on the origin; text and anchors will be added here later
function markerShape(m) {
  const { width: w, height: h, thickness: t } = m;
  const attrs = { fill: m.fill, 'fill-opacity': m.fillAlpha };
  if (t > 0) {
    Object.assign(attrs, { stroke: m.outline, 'stroke-opacity': m.outlineAlpha, 'stroke-width': t });
    if (m.outlineStyle === 'dash') attrs['stroke-dasharray'] = `${t * 2} ${t}`;
    if (m.outlineStyle === 'dots') {
      attrs['stroke-dasharray'] = `0 ${t * 2}`;
      attrs['stroke-linecap'] = 'round';
    }
  }
  if (m.boxStyle === 'circle') return svgEl('ellipse', { cx: 0, cy: 0, rx: w / 2, ry: h / 2, ...attrs });
  const rx = m.cornerRadius ?? { square: 0, rounded: Math.min(w, h) * 0.25, pill: Math.min(w, h) / 2 }[m.boxStyle];
  return svgEl('rect', { x: -w / 2, y: -h / 2, width: w, height: h, rx, ...attrs });
}

function applyPathView() {
  const { x, y, zoom } = pathView;
  $('#path-viewport').setAttribute('transform', `translate(${x} ${y}) scale(${zoom})`);
  $('#path-zoom-level').textContent = `${Math.round(zoom * 100)}%`;
}

function fitPathView() {
  const rect = pathPreview.getBoundingClientRect();
  const width = pathDraft.height * 2 + pathDraft.thickness;
  const height = pathDraft.height + pathDraft.thickness;
  const zoom = Math.min(MAX_ZOOM, 0.65 * Math.min(rect.width / width, rect.height / height));
  Object.assign(pathView, { x: rect.width / 2, y: rect.height / 2, zoom });
  applyPathView();
}

function drawPathPreview() {
  drawLayerFills($('#path-bg'), [pathBg], 'pp');
  $('#path-shape').replaceChildren(markerShape({ ...pathDraft, width: pathDraft.height * 2 }));
  fitPathView();
  $('#path-bg-swatch').style.setProperty('--c', hexToRgba(pathBg.color, pathBg.alpha));
}

function updatePath() {
  Object.entries(PATH_FIELDS).forEach(([key, field]) => {
    const el = pathField(field);
    if (el.type === 'checkbox') {
      pathDraft[key] = el.checked;
      return;
    }
    let value = el.value;
    if (['fillAlpha', 'outlineAlpha'].includes(key)) value = Number(value) / 100;
    else if (['height', 'thickness'].includes(key)) value = Number(value);
    pathDraft[key] = value;
  });
  const previewWidth = pathDraft.height * 2;
  pathField('width').value = previewWidth;
  pathField('width-num').value = previewWidth;
  const name = pathDraft.name.trim();
  const invalid = !name || pathTaken.has(name.toLowerCase());
  pathField('name').classList.toggle('invalid', invalid);
  const warn = pathField('warn');
  warn.hidden = !invalid;
  warn.textContent = name ? 'A path with this name already exists.' : 'A name is required.';
  pathForm.querySelector('button[value="accept"]').disabled = invalid;
  drawPathPreview();
}

function openPathEditor(draft, list, editing, onAccept) {
  pathDraft = structuredClone(draft);
  delete pathDraft.width;
  pathDraft.orthogonal ??= false;
  pathDraft.merge ??= true;
  pathAccept = onAccept;
  pathTaken = new Set(list.filter((path) => path !== editing).map((path) => path.name.toLowerCase()));
  pathBg = { ...structuredClone(activeMap.selection[0]), visible: true };
  $('#path-title').textContent = editing ? 'Edit Path' : 'New Path';
  Object.entries(PATH_FIELDS).forEach(([key, field]) => {
    const el = pathField(field);
    if (el.type === 'checkbox') {
      el.checked = !!pathDraft[key];
      return;
    }
    const value = ['fillAlpha', 'outlineAlpha'].includes(key) ? Math.round(pathDraft[key] * 100) : pathDraft[key];
    el.value = value;
    const number = pathField(`${field}-num`);
    if (number) number.value = value;
  });
  pathDialog.returnValue = '';
  pathDialog.showModal();
  updatePath();
}

function initPathEditor() {
  bindPairs(pathForm, updatePath);
  enablePanZoom(pathPreview, () => pathView, applyPathView);
  const zoom = (factor) => {
    const rect = pathPreview.getBoundingClientRect();
    zoomView(pathView, factor, rect.width / 2, rect.height / 2);
    applyPathView();
  };
  $('#path-zoom-in').addEventListener('click', () => zoom(1.25));
  $('#path-zoom-out').addEventListener('click', () => zoom(0.8));
  $('#path-zoom-reset').addEventListener('click', fitPathView);
  $('#path-bg-swatch').addEventListener('click', () => openColorPicker(pathBg, $('#path-bg-swatch'), drawPathPreview));
  pathDialog.addEventListener('close', () => {
    popover.hidden = true;
    $('#layers').append(popover);
    if (pathDialog.returnValue === 'accept') pathAccept({ ...pathDraft, name: pathDraft.name.trim() });
  });
}

function markerThumb(m) {
  const pad = m.thickness / 2 + 1;
  const vw = m.width + pad * 2;
  const vh = m.height + pad * 2;
  return svgEl('svg', { class: 'thumb', width: 24, height: 24, viewBox: `${-vw / 2} ${-vh / 2} ${vw} ${vh}` }, markerShape(m));
}

function pathThumb(path) {
  const preview = { ...path, width: path.height * 2 };
  const pad = path.thickness / 2 + 1;
  const vw = preview.width + pad * 2;
  const vh = preview.height + pad * 2;
  return svgEl('svg', { class: 'thumb', width: 24, height: 24, viewBox: `${-vw / 2} ${-vh / 2} ${vw} ${vh}` }, markerShape(preview));
}

function applyMarkerView() {
  const { x, y, zoom } = markerView;
  $('#marker-viewport').setAttribute('transform', `translate(${x} ${y}) scale(${zoom})`);
  $('#marker-zoom-level').textContent = `${Math.round(zoom * 100)}%`;
}

function resetMarkerView() {
  const r = markerPreview.getBoundingClientRect();
  Object.assign(markerView, { x: r.width / 2, y: r.height / 2, zoom: 1 });
  applyMarkerView();
}

function fitMarkerView() {
  const m = markerDraft;
  const r = markerPreview.getBoundingClientRect();
  // Perimeter anchors sit 30% of the marker size beyond each edge
  const spread = markerTab === 'anchors' ? 1.6 : 1;
  const w = m.width * spread + m.thickness;
  const h = m.height * spread + m.thickness;
  const zoom = Math.min(MAX_ZOOM, 0.6 * Math.min(r.width / w, r.height / h));
  Object.assign(markerView, { x: r.width / 2, y: r.height / 2, zoom });
  applyMarkerView();
}

function drawMarkerPreview() {
  drawLayerFills($('#marker-bg'), [markerBg], 'mp');
  $('#marker-shape').replaceChildren(markerShape(markerDraft), ...markerTextEls(markerDraft));
  positionOverlay();
  drawAnchors();
  $('#marker-bg-swatch').style.setProperty('--c', hexToRgba(markerBg.color, markerBg.alpha));
}

function readMarkerForm() {
  Object.entries(MARKER_FIELDS).forEach(([key, field]) => {
    const v = markerField(field).value;
    if (MARKER_PERCENT.includes(key)) markerDraft[key] = Number(v) / 100;
    else if (MARKER_NUMBERS.includes(key)) markerDraft[key] = Number(v);
    else markerDraft[key] = v;
  });
}

function loadMarkerForm() {
  Object.entries(MARKER_FIELDS).forEach(([key, field]) => {
    const v = MARKER_PERCENT.includes(key) ? Math.round(markerDraft[key] * 100) : markerDraft[key];
    markerField(field).value = v;
    const num = markerField(`${field}-num`);
    if (num) num.value = v;
  });
}

function updateMarker() {
  readMarkerForm();
  updateAnchorOffsetRanges();
  const name = markerDraft.name.trim();
  const bad = !name || markerTaken.has(name.toLowerCase());
  markerField('name').classList.toggle('invalid', bad);
  const warn = markerField('warn');
  warn.hidden = !bad;
  warn.textContent = name ? 'A marker with this name already exists.' : 'A name is required.';
  markerForm.querySelector('button[value="accept"]').disabled = bad;
  drawMarkerPreview();
}

function openMarkerEditor(draft, list, editing, onAccept) {
  markerDraft = draft;
  markerDraft.anchors.center ||= { accepts: { marker: true, path: true, icon: true, image: true } };
  // Markers saved before offsets existed have none
  Object.keys(ANCHOR_RINGS).forEach((ring) => {
    markerDraft.anchors[ring].offsetX ??= 0;
    markerDraft.anchors[ring].offsetY ??= 0;
  });
  markerAccept = onAccept;
  markerTaken = new Set(list.filter((m) => m !== editing).map((m) => m.name.toLowerCase()));
  // Preview background starts as a copy of the selected layer
  markerBg = { ...structuredClone(activeMap.selection[0]), visible: true };
  $('#marker-title').textContent = editing ? 'Edit Marker' : 'New Marker';
  selectedSlot = markerDraft.slots[0];
  textEditSlot = null;
  renderSlotList();
  loadSlotForm();
  loadAnchorForm();
  markerTab = 'style';
  savedStyleView = null;
  selectMarkerTab('style');
  loadMarkerForm();
  markerDialog.returnValue = '';
  markerDialog.showModal();
  resetMarkerView();
  updateMarker();
}

// Anchors are derived from these settings; positions are fractions of marker width/height
const ANCHOR_RINGS = { perimeter: 1.3, edge: 1, inner: 0.8 };
const ANCHOR_PLACEMENTS = [['mid', 'Midpoint'], ['corners', 'Corners'], ['double', 'Double Mid']];
const ANCHOR_KINDS = [['marker', 'Marker'], ['path', 'Path'], ['icon', 'Icon'], ['image', 'Image']];

function defaultAnchors() {
  const accepts = () => ({ marker: true, path: true, icon: true, image: true });
  const ring = () => ({ mid: false, corners: false, double: false, offsetX: 0, offsetY: 0, accepts: accepts() });
  return {
    center: { accepts: accepts() },
    perimeter: ring(),
    edge: ring(),
    inner: ring(),
  };
}

// Half-extent of the outline in the b direction at offset t along the a axis (a, b are half sizes)
function outlineExtent(t, a, b, rr) {
  t = Math.abs(t);
  if (rr === null) return b * Math.sqrt(Math.max(0, 1 - (t / a) ** 2));
  const flat = a - rr;
  if (t <= flat) return b;
  return (b - rr) + Math.sqrt(Math.max(0, rr * rr - (t - flat) ** 2));
}

// Returns [{ name, x, y, accepts: [kind...] }] for every active anchor; the center anchor "0" is always present.
// Ring anchors lie on the real box outline (rounded corners included), scaled about the center per ring.
function anchorList(m) {
  const centerAccepts = m.anchors.center?.accepts || { marker: true, path: true, icon: true, image: true };
  const out = [{ name: '0', x: 0.5, y: 0.5, accepts: Object.keys(centerAccepts).filter((kind) => centerAccepts[kind]) }];
  const add = (x, y, accepts) => {
    out.push({ name: String(out.length), x, y, accepts: Object.keys(accepts).filter((k) => accepts[k]) });
  };
  const hw = m.width / 2;
  const hh = m.height / 2;
  const rr = { square: 0, rounded: Math.min(m.width, m.height) * 0.25, pill: Math.min(m.width, m.height) / 2, circle: null }[m.boxStyle];
  const diag = Math.SQRT1_2;
  const cx = rr === null ? hw * diag : hw - rr + rr * diag;
  const cy = rr === null ? hh * diag : hh - rr + rr * diag;
  Object.entries(ANCHOR_RINGS).forEach(([ring, r]) => {
    const a = m.anchors[ring];
    const k = 2 * r - 1;
    const pts = [];
    if (a.mid) pts.push([0, -hh], [0, hh], [-hw, 0], [hw, 0]);
    if (a.corners) pts.push([-cx, -cy], [cx, -cy], [-cx, cy], [cx, cy]);
    if (a.double) {
      [-1, 1].forEach((sign) => {
        const x = (sign * hw) / 3;
        const y = (sign * hh) / 3;
        const top = outlineExtent(x, hw, hh, rr);
        const side = outlineExtent(y, hh, hw, rr);
        pts.push([x, -top], [x, top], [-side, y], [side, y]);
      });
    }
    // Per-ring offsets are in pixels and push anchors away from (positive) or toward (negative) the center
    // along each axis, so opposite sides move in opposite directions. Anchors on the center line don't move.
    const ox = a.offsetX || 0;
    const oy = a.offsetY || 0;
    pts.forEach(([x, y]) => {
      const px = k * x + Math.sign(x) * ox;
      const py = k * y + Math.sign(y) * oy;
      add(0.5 + px / m.width, 0.5 + py / m.height, a.accepts);
    });
  });
  return out;
}

function snapMarkerPosition(marker, layer, x, y, gridSnap, anchorSnap, excludeObject = null, kind = 'marker') {
  if (gridSnap) {
    const size = Math.max(Number(layer.grid.size) || 1, 0.0001);
    x = Math.round(x / size) * size;
    y = Math.round(y / size) * size;
  }
  if (anchorSnap) ({ x, y } = snapToAcceptedAnchor(kind, x, y, excludeObject));
  return { x, y };
}

function snapPathPosition(path, layer, x, y, gridSnap, anchorSnap, excludeObject = null) {
  if (gridSnap) {
    const size = Math.max(Number(layer.grid.size) || 1, 0.0001);
    x = Math.round(x / size) * size;
    y = Math.round(y / size) * size;
  }
  if (anchorSnap) ({ x, y } = snapToAcceptedAnchor('path', x, y, excludeObject));
  return { x, y };
}

// excludeObject may be one object or an array of them
function snapToAcceptedAnchor(kind, x, y, excludeObject = null) {
  const excluded = Array.isArray(excludeObject) ? excludeObject : [excludeObject];
  const radius = 12 / activeMap.view.zoom;
  let best = null;
  let bestDistance = radius * radius;
  activeMap.objects.forEach((target) => {
    if (excluded.includes(target) || target.type !== 'marker' || !target.layer.visible) return;
    const targets = anchorList(target.marker).filter((anchor) => anchor.accepts.includes(kind));
    targets.forEach((targetAnchor) => {
      const targetX = target.x + (targetAnchor.x - 0.5) * target.marker.width;
      const targetY = target.y + (targetAnchor.y - 0.5) * target.marker.height;
      const snappedX = targetX;
      const snappedY = targetY;
      const distance = (snappedX - x) ** 2 + (snappedY - y) ** 2;
      if (distance < bestDistance) {
        best = { x: snappedX, y: snappedY };
        bestDistance = distance;
      }
    });
  });
  return best || { x, y };
}

function drawAnchors() {
  const g = $('#marker-anchors');
  g.replaceChildren();
  if (markerTab !== 'anchors') return;
  const m = markerDraft;
  anchorList(m).forEach((a) => {
    g.append(svgEl('circle', {
      cx: -m.width / 2 + a.x * m.width,
      cy: -m.height / 2 + a.y * m.height,
      r: 4 / markerView.zoom,
      fill: '#ff2d95',
      stroke: '#ffffff',
      'stroke-width': 1,
      'vector-effect': 'non-scaling-stroke',
    }));
  });
}

function buildAnchorPanel() {
  const panel = $('#anchor-panel');
  const checks = (ring, items, prefix, caption) => {
    const row = document.createElement('div');
    row.className = 'check-row';
    if (caption) {
      const c = document.createElement('span');
      c.className = 'caption';
      c.textContent = caption;
      row.append(c);
    }
    items.forEach(([key, text]) => {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.dataset.f = `anchor-${ring}-${prefix}${key}`;
      label.append(input, ` ${text}`);
      row.append(label);
    });
    return row;
  };
  const offsetRow = (ring, axis) => {
    const f = `anchor-${ring}-offset${axis}`;
    const label = document.createElement('label');
    label.className = 'row';
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.dataset.f = f;
    slider.min = -100;
    slider.max = 100;
    slider.value = 0;
    const wrap = document.createElement('span');
    wrap.className = 'num';
    wrap.dataset.suffix = 'px';
    const number = document.createElement('input');
    number.type = 'number';
    number.dataset.f = `${f}-num`;
    number.min = -100;
    number.max = 100;
    number.value = 0;
    wrap.append(number);
    label.append(`Spread ${axis}`, slider, wrap);
    return label;
  };
  const section = (title, ring, kinds, placements = true) => {
    const fs = document.createElement('fieldset');
    const legend = document.createElement('legend');
    legend.textContent = title;
    fs.append(legend);
    if (placements) fs.append(checks(ring, ANCHOR_PLACEMENTS, ''));
    fs.append(checks(ring, kinds, 'accepts-', 'Accepts'));
    if (placements) fs.append(offsetRow(ring, 'X'), offsetRow(ring, 'Y'));
    panel.append(fs);
  };
  section('Center', 'center', ANCHOR_KINDS, false);
  section('Perimeter', 'perimeter', ANCHOR_KINDS);
  section('Edge', 'edge', ANCHOR_KINDS);
  section('Inner', 'inner', ANCHOR_KINDS);
}

// Data layout: anchors[ring][placement] or anchors[ring].accepts[kind]
function anchorTarget(field) {
  const [, ring, ...rest] = field.split('-');
  const prop = rest.join('-');
  return prop.startsWith('accepts-')
    ? { obj: markerDraft.anchors[ring].accepts, key: prop.slice(8) }
    : { obj: markerDraft.anchors[ring], key: prop };
}

function applyAnchorField(field) {
  field = field.replace(/-num$/, '');
  const { obj, key } = anchorTarget(field);
  const el = markerField(field);
  // The slider holds the clamped value when the number box is typed past its range
  obj[key] = el.type === 'checkbox' ? el.checked : Number(el.value);
  drawMarkerPreview();
}

// Offsets range over +/- twice the marker's width (X) or height (Y). Shrinking the marker clamps stored offsets.
function updateAnchorOffsetRanges() {
  const m = markerDraft;
  Object.keys(ANCHOR_RINGS).forEach((ring) => {
    [['offsetX', m.width * 2], ['offsetY', m.height * 2]].forEach(([key, limit]) => {
      const f = `anchor-${ring}-${key}`;
      const a = m.anchors[ring];
      a[key] = clamp(a[key] || 0, -limit, limit);
      [markerField(f), markerField(`${f}-num`)].forEach((el) => {
        el.min = -limit;
        el.max = limit;
        el.value = a[key];
      });
    });
  });
}

function loadAnchorForm() {
  $('#anchor-panel').querySelectorAll('input[type=checkbox][data-f]').forEach((el) => {
    const { obj, key } = anchorTarget(el.dataset.f);
    el.checked = !!obj[key];
  });
  updateAnchorOffsetRanges();
}

// Text and Anchors fit the marker to the preview and lock zoom and pan; Style keeps the user's view
let markerTab = 'style';
let savedStyleView = null;

function selectMarkerTab(name) {
  markerForm.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  markerForm.querySelectorAll('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== name; });
  const locked = name !== 'style';
  if (locked && markerTab === 'style') savedStyleView = { ...markerView };
  markerTab = name;
  markerPreview.classList.toggle('locked', locked);
  ['in', 'out', 'reset'].forEach((k) => { $(`#marker-zoom-${k}`).disabled = locked; });
  if (locked) {
    fitMarkerView();
  } else if (savedStyleView) {
    Object.assign(markerView, savedStyleView);
    savedStyleView = null;
    applyMarkerView();
  }
  buildOverlay();
  drawMarkerPreview();
}

function initMarkerEditor() {
  buildAnchorPanel();
  bindPairs(markerForm, (e) => {
    const k = e.target.dataset.f;
    if (k.startsWith('slot-')) applySlotField(k.replace(/-num$/, ''));
    else if (k.startsWith('anchor-')) applyAnchorField(k);
    else updateMarker();
  });
  $('#slot-new').addEventListener('click', newSlot);
  $('#slot-copy').addEventListener('click', copySlot);
  markerForm.querySelectorAll('[data-toggle]').forEach((b) => b.addEventListener('click', () => {
    b.classList.toggle('on');
    applySlotField(b.dataset.f);
  }));
  markerForm.querySelectorAll('[data-step]').forEach((b) => b.addEventListener('click', () => {
    const input = markerField('slot-size');
    input.value = clamp(Number(input.value) + Number(b.dataset.step), Number(input.min), Number(input.max));
    applySlotField('slot-size');
  }));
  $('#slot-rename').addEventListener('click', () => renameSlot(selectedSlot));
  $('#slot-delete').addEventListener('click', deleteSlot);
  const textEdit = $('#slot-text-edit');
  textEdit.addEventListener('input', () => {
    if (!textEditSlot) return;
    textEditSlot.text = textEdit.value;
    drawMarkerPreview();
  });
  textEdit.addEventListener('blur', () => closeTextEdit(true));
  textEdit.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') closeTextEdit(true);
    else if (e.key === 'Escape') {
      e.stopPropagation();
      e.preventDefault();
      closeTextEdit(false);
    }
  });
  enablePanZoom(markerPreview, () => markerView, applyMarkerView, () => markerTab === 'style');
  const zoomMarker = (factor) => {
    const r = markerPreview.getBoundingClientRect();
    zoomView(markerView, factor, r.width / 2, r.height / 2);
    applyMarkerView();
  };
  $('#marker-zoom-in').addEventListener('click', () => zoomMarker(1.25));
  $('#marker-zoom-out').addEventListener('click', () => zoomMarker(0.8));
  $('#marker-zoom-reset').addEventListener('click', resetMarkerView);
  markerForm.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => selectMarkerTab(b.dataset.tab)));
  $('#marker-bg-swatch').addEventListener('click', () => openColorPicker(markerBg, $('#marker-bg-swatch'), drawMarkerPreview));
  markerDialog.addEventListener('close', () => {
    popover.hidden = true;
    $('#layers').append(popover);
    if (markerDialog.returnValue === 'accept') markerAccept({ ...markerDraft, name: markerDraft.name.trim() });
  });
}

// Icon editor dialog
// A static page can't list a directory, so the bundled icons are named here
const ICON_FILES = [
  'anchor', 'bp', 'breed', 'bug', 'cynthia', 'dark', 'daycare', 'dragon', 'e4', 'electric', 'fairy', 'fighting',
  'fire', 'flying', 'fossil', 'ghost', 'grass', 'ground', 'ho-oh', 'ice', 'icyrock', 'magnetic', 'morimoto',
  'mossyrock', 'normal', 'poison', 'psychic', 'red', 'rock', 'shopping', 'steel', 'water',
];
const ICON_FIELDS = {
  name: 'name',
  image: 'image',
  width: 'width',
  height: 'height',
  boxStyle: 'box-style',
  fill: 'fill',
  fillAlpha: 'fill-alpha',
  outlineStyle: 'outline-style',
  outline: 'outline',
  outlineAlpha: 'outline-alpha',
  thickness: 'thickness',
};
const ICON_NUMBERS = ['width', 'height', 'thickness'];
const iconDialog = $('#icon-dialog');
const iconForm = iconDialog.querySelector('form');
const iconPreview = $('#icon-preview');
const iconView = { x: 0, y: 0, zoom: 1 };
const iconField = (key) => iconForm.querySelector(`[data-f="icon-${key}"]`);
let iconDraft = null;
let iconTaken = new Set();
let iconAccept = null;
let iconBg = null;

function defaultIcon() {
  return {
    name: 'New Icon',
    image: ICON_FILES[0],
    width: 30,
    height: 30,
    boxStyle: 'circle',
    fill: '#ffffff',
    fillAlpha: 1,
    outlineStyle: 'solid',
    outline: '#000000',
    outlineAlpha: 1,
    thickness: 1,
  };
}

function iconShape(icon) {
  const { width: w, height: h } = icon;
  return svgEl('g', {}, markerShape(icon), svgEl('image', {
    href: `Data/Icons/${icon.image}.svg`, x: -w / 2, y: -h / 2, width: w, height: h, preserveAspectRatio: 'xMidYMid meet',
  }));
}

function iconThumb(icon) {
  const pad = icon.thickness / 2 + 1;
  const vw = icon.width + pad * 2;
  const vh = icon.height + pad * 2;
  return svgEl('svg', { class: 'thumb', width: 24, height: 24, viewBox: `${-vw / 2} ${-vh / 2} ${vw} ${vh}` }, iconShape(icon));
}

function applyIconView() {
  const { x, y, zoom } = iconView;
  $('#icon-viewport').setAttribute('transform', `translate(${x} ${y}) scale(${zoom})`);
  $('#icon-zoom-level').textContent = `${Math.round(zoom * 100)}%`;
}

function resetIconView() {
  const r = iconPreview.getBoundingClientRect();
  Object.assign(iconView, { x: r.width / 2, y: r.height / 2, zoom: 1 });
  applyIconView();
}

function drawIconPreview() {
  drawLayerFills($('#icon-bg'), [iconBg], 'ip');
  $('#icon-shape').replaceChildren(iconShape(iconDraft));
  $('#icon-bg-swatch').style.setProperty('--c', hexToRgba(iconBg.color, iconBg.alpha));
}

function updateIcon() {
  Object.entries(ICON_FIELDS).forEach(([key, field]) => {
    const v = iconField(field).value;
    if (['fillAlpha', 'outlineAlpha'].includes(key)) iconDraft[key] = Number(v) / 100;
    else if (ICON_NUMBERS.includes(key)) iconDraft[key] = Number(v);
    else iconDraft[key] = v;
  });
  const name = iconDraft.name.trim();
  const bad = !name || iconTaken.has(name.toLowerCase());
  iconField('name').classList.toggle('invalid', bad);
  const warn = iconField('warn');
  warn.hidden = !bad;
  warn.textContent = name ? 'An icon with this name already exists.' : 'A name is required.';
  iconForm.querySelector('button[value="accept"]').disabled = bad;
  drawIconPreview();
}

function openIconEditor(draft, list, editing, onAccept) {
  iconDraft = draft;
  iconAccept = onAccept;
  iconTaken = new Set(list.filter((i) => i !== editing).map((i) => i.name.toLowerCase()));
  iconBg = { ...structuredClone(activeMap.selection[0]), visible: true };
  $('#icon-title').textContent = editing ? 'Edit Icon' : 'New Icon';
  Object.entries(ICON_FIELDS).forEach(([key, field]) => {
    const v = ['fillAlpha', 'outlineAlpha'].includes(key) ? Math.round(iconDraft[key] * 100) : iconDraft[key];
    iconField(field).value = v;
    const num = iconField(`${field}-num`);
    if (num) num.value = v;
  });
  iconDialog.returnValue = '';
  iconDialog.showModal();
  resetIconView();
  updateIcon();
}

function initIconEditor() {
  iconField('image').replaceChildren(...ICON_FILES.map((f) => new Option(f, f)));
  bindPairs(iconForm, updateIcon);
  enablePanZoom(iconPreview, () => iconView, applyIconView);
  const zoom = (factor) => {
    const r = iconPreview.getBoundingClientRect();
    zoomView(iconView, factor, r.width / 2, r.height / 2);
    applyIconView();
  };
  $('#icon-zoom-in').addEventListener('click', () => zoom(1.25));
  $('#icon-zoom-out').addEventListener('click', () => zoom(0.8));
  $('#icon-zoom-reset').addEventListener('click', resetIconView);
  $('#icon-bg-swatch').addEventListener('click', () => openColorPicker(iconBg, $('#icon-bg-swatch'), drawIconPreview));
  iconDialog.addEventListener('close', () => {
    popover.hidden = true;
    $('#layers').append(popover);
    if (iconDialog.returnValue === 'accept') iconAccept({ ...iconDraft, name: iconDraft.name.trim() });
  });
}

const markerEditor = { blank: defaultMarker, open: openMarkerEditor, thumb: markerThumb };
const iconEditor = { blank: defaultIcon, open: openIconEditor, thumb: iconThumb };
const pathEditor = { blank: defaultPath, open: openPathEditor, thumb: pathThumb };

initMarkerEditor();
initPathEditor();
initIconEditor();

initSplitters();
initCanvas();
initBrowsers();
newMap();