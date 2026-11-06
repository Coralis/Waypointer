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
  const map = { name: `Untitled ${++mapCounter}`, view: { x: rect.width / 2, y: rect.height / 2, zoom: 1 } };
  maps.push(map);
  selectMap(map);
}

function selectMap(map) {
  activeMap = map;
  renderTabs();
  applyView();
}

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

initSplitters();
initCanvas();
newMap();
