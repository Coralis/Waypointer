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
    tabs.append(tab);
  });
}

function newMap() {
  const rect = svg.getBoundingClientRect();
  const map = {
    name: `Untitled ${++mapCounter}`,
    view: { x: rect.width / 2, y: rect.height / 2, zoom: 1 },
    layers: [{ name: 'Background', visible: true, locked: false, color: '#2b2b2b', alpha: 1, grid: { style: 'solid', color: '#ffffff', alpha: 0.3, size: 50 } }],
  };
  maps.push(map);
  selectMap(map);
}

function selectMap(map) {
  activeMap = map;
  renderTabs();
  applyView();
  renderLayers();
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
  const g = $('#layer-fills');
  g.replaceChildren();
  const defs = svgEl('defs', {});
  g.append(defs);
  [...activeMap.layers].reverse().forEach((l, i) => {
    if (!l.visible) return;
    const box = { x: -5000, y: -5000, width: 10000, height: 10000 };
    g.append(svgEl('rect', { ...box, fill: l.color, 'fill-opacity': l.alpha }));
    if (l.grid.style !== 'none') {
      defs.append(gridPattern(`grid-${i}`, l.grid));
      g.append(svgEl('rect', { ...box, fill: `url(#grid-${i})` }));
    }
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
    name.textContent = l.name;
    li.append(vis, lock, sw, name);
    layerList.append(li);
  });
  renderFills();
}

function hexToRgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

function openColorPicker(layer, anchor) {
  popoverLayer = layer;
  const g = layer.grid;
  setField('layer-color', layer.color);
  setField('layer-alpha', Math.round(layer.alpha * 100));
  setField('grid-style', g.style);
  setField('grid-color', g.color);
  setField('grid-alpha', Math.round(g.alpha * 100));
  setField('grid-size', g.size);
  popover.hidden = false;
  const r = anchor.getBoundingClientRect();
  popover.style.left = `${Math.max(8, Math.min(r.left, innerWidth - popover.offsetWidth - 8))}px`;
  popover.style.top = `${Math.min(r.bottom + 4, innerHeight - popover.offsetHeight - 8)}px`;
}

// Sets a field and its paired number box, if any
function setField(id, value) {
  $(`#${id}`).value = value;
  const num = $(`#${id}-num`);
  if (num) num.value = value;
}

function initLayers() {
  const num = (id) => Number($(`#${id}`).value);
  const update = () => {
    const l = popoverLayer;
    l.color = $('#layer-color').value;
    l.alpha = num('layer-alpha') / 100;
    l.grid.style = $('#grid-style').value;
    l.grid.color = $('#grid-color').value;
    l.grid.alpha = num('grid-alpha') / 100;
    l.grid.size = num('grid-size');
    renderLayers();
  };
  popover.addEventListener('input', (e) => {
    const id = e.target.id;
    // Keep slider and number box in sync, clamped to the slider range
    const pair = id.endsWith('-num') ? $(`#${id.slice(0, -4)}`) : $(`#${id}-num`);
    if (pair) {
      const range = id.endsWith('-num') ? pair : e.target;
      if (e.target.value === '') return;
      const v = Math.min(Number(range.max), Math.max(Number(range.min), Number(e.target.value)));
      if (id.endsWith('-num')) pair.value = v;
      else pair.value = e.target.value;
    }
    update();
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

function zoomAt(factor, cx, cy) {
  const v = activeMap.view;
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.zoom * factor));
  const k = zoom / v.zoom;
  v.x = cx - (cx - v.x) * k;
  v.y = cy - (cy - v.y) * k;
  v.zoom = zoom;
  applyView();
}

function initCanvas() {
  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = svg.getBoundingClientRect();
    zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });

  svg.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.button !== 1) return;
    e.preventDefault();
    svg.setPointerCapture(e.pointerId);
    svg.classList.add('panning');
    let lastX = e.clientX;
    let lastY = e.clientY;
    const move = (ev) => {
      activeMap.view.x += ev.clientX - lastX;
      activeMap.view.y += ev.clientY - lastY;
      lastX = ev.clientX;
      lastY = ev.clientY;
      applyView();
    };
    const up = () => {
      svg.classList.remove('panning');
      svg.removeEventListener('pointermove', move);
      svg.removeEventListener('pointerup', up);
    };
    svg.addEventListener('pointermove', move);
    svg.addEventListener('pointerup', up);
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
}

// Templates list (placeholder data model until real templates exist)
const templates = { marker: [], path: [] };
let templateKind = 'marker';
let selectedTemplate = null;
const kindLabel = () => (templateKind === 'marker' ? 'Marker' : 'Path');
const menu = $('#context-menu');

function createTemplate(name) {
  const list = templates[templateKind];
  const t = { name: name || `New ${kindLabel()} ${list.length + 1}` };
  list.push(t);
  selectedTemplate = t;
  renderTemplates();
}

function renderTemplates() {
  const ul = $('#template-list');
  ul.replaceChildren();
  const list = templates[templateKind];
  if (!list.length) {
    const li = document.createElement('li');
    li.className = 'create';
    li.textContent = `Create ${kindLabel()}`;
    li.addEventListener('click', () => createTemplate());
    ul.append(li);
    return;
  }
  list.forEach((t) => {
    const li = document.createElement('li');
    li.textContent = t.name;
    if (t === selectedTemplate) li.classList.add('selected');
    li.addEventListener('click', () => { selectedTemplate = t; renderTemplates(); });
    li.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      selectedTemplate = t;
      renderTemplates();
      showMenu(e.clientX, e.clientY, t);
    });
    ul.append(li);
  });
}

function showMenu(x, y, t) {
  const k = kindLabel();
  const items = [[`Create New ${k}`, () => createTemplate()]];
  if (t) {
    // Edit is a stub until the properties editor exists
    items.unshift(['Edit', () => { selectedTemplate = t; renderTemplates(); }]);
    items.splice(1, 0, [`Copy into New ${k}`, () => createTemplate(`${t.name} Copy`)]);
  }
  menu.replaceChildren(...items.map(([label, fn]) => {
    const li = document.createElement('li');
    li.textContent = label;
    li.addEventListener('click', () => { hideMenu(); fn(); });
    return li;
  }));
  menu.hidden = false;
  menu.style.left = `${Math.min(x, innerWidth - menu.offsetWidth)}px`;
  menu.style.top = `${Math.min(y, innerHeight - menu.offsetHeight)}px`;
}

function hideMenu() { menu.hidden = true; }

function initTemplates() {
  document.querySelectorAll('.subtabs button').forEach((btn) => {
    btn.addEventListener('click', () => {
      templateKind = btn.dataset.kind;
      selectedTemplate = null;
      document.querySelectorAll('.subtabs button').forEach((b) => b.classList.toggle('active', b === btn));
      renderTemplates();
    });
  });
  $('#template-list').addEventListener('contextmenu', (e) => {
    if (e.target.closest('li:not(.create)')) return;
    e.preventDefault();
    showMenu(e.clientX, e.clientY, null);
  });
  document.addEventListener('pointerdown', (e) => { if (!menu.contains(e.target)) hideMenu(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideMenu(); });
  renderTemplates();
}

initSplitters();
initCanvas();
initTemplates();
newMap();
