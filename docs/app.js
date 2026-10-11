// Biomethane & AD planning applications map – main page logic. Helpers live in common.js (BM).
const {esc, fmt, col, dmy, daysTo, store} = BM;
const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

// ---- per-viewer settings (this browser only)
const marked = new Set(store.get('marked', []));            // homes this viewer marked "not a home"
const visited = store.get('visited', {});                   // door-to-door ticks: {home_id: 'visited'|'interested'|'nothome'}
const opt = Object.assign({homeSize:4, siteSize:8, names:'auto', hideMarked:false, rules:[], drwOpacity:0.85}, store.get('display', {}));
const saveOpt = () => store.set('display', opt);

// ---- map & basemaps (default: satellite with place names)
const map = L.map('map', {zoomControl:true, preferCanvas:true}).setView([53.4,-8.0], 7);
const esri = (s, a) => L.tileLayer(`https://server.arcgisonline.com/ArcGIS/rest/services/${s}/MapServer/tile/{z}/{y}/{x}`, {maxZoom:19, crossOrigin:true, attribution:a});
const base = {
  'Satellite + place names': L.layerGroup([esri('World_Imagery', 'Imagery © Esri, Maxar, Earthstar Geographics'), esri('Reference/World_Boundaries_and_Places', ''), esri('Reference/World_Transportation', '')]),
  'Satellite (Esri)': esri('World_Imagery', 'Imagery © Esri, Maxar, Earthstar Geographics'),
  'Street map (OpenStreetMap)': L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {maxZoom:19, crossOrigin:true, attribution:'© OpenStreetMap contributors'}),
  'Topographic (Esri)': esri('World_Topo_Map', '© Esri')
};
const baseName = store.get('base', 'Satellite + place names');
(base[baseName] || base['Satellite + place names']).addTo(map);

const lyr = {sites:L.layerGroup(), rings:L.layerGroup(), ringLabels:L.layerGroup(), homes:L.layerGroup(), points:L.layerGroup().addTo(map),
             recs:L.layerGroup(), wind:L.layerGroup(), layout:L.layerGroup(), intl:L.layerGroup(), drawings:L.layerGroup()};
// Layer list: ticks are the viewer's choice; zoom limits only decide whether a ticked layer is drawn (never untick it).
const LAYERS = [
  {group:'Sites', name:'Application sites', g:lyr.points, min:0},
  {group:'Sites', name:'Site boundaries', g:lyr.sites, min:11},
  {group:'Sites', name:'Distance rings from site boundary', g:lyr.rings, min:12},
  {group:'People nearby', name:'Homes within 1 km', g:lyr.homes, min:12},
  {group:'People nearby', name:'Schools, care, health & community', g:lyr.recs, min:12},
  {group:'The plant', name:'Planning drawings (georeferenced)', g:lyr.drawings, min:14},
  {group:'The plant', name:'Plant layout (traced)', g:lyr.layout, min:13},
  {group:'Weather', name:'Wind roses', g:lyr.wind, min:13, max:15}];
const userOff = new Set(store.get('off2', ['Plant layout (traced)']));   // layers the viewer switched off (traced layout off by default)
const saveOff = () => store.set('off2', [...userOff]);
const syncLayerTicks = () => document.querySelectorAll('#lyr-b label[data-l] input').forEach(i => i.checked = !userOff.has(i.closest('label').dataset.l));
const lyrCtl = L.control({position:'topright'});
lyrCtl.onAdd = () => {
  const d = L.DomUtil.create('div', 'disp lyrs leaflet-control');
  const groups = [...new Set(LAYERS.map(l => l.group))];
  const cur = base[baseName] ? baseName : 'Satellite + place names';
  d.innerHTML = `<button aria-expanded="false" id="lyr-t">Layers ▾</button><div class="body" id="lyr-b" hidden>
    <div class="lgh">Base map</div>` + Object.keys(base).map(n => `<label class="cb"><input type="radio" name="basemap" value="${esc(n)}" ${n === cur ? 'checked' : ''}><span>${esc(n)}</span></label>`).join('') +
    groups.map(gp => `<div class="lgh">${gp}</div>` + LAYERS.filter(l => l.group === gp).map((l, i) => `<label class="cb" data-l="${esc(l.name)}">
      <input type="checkbox" ${userOff.has(l.name) ? '' : 'checked'}><span>${esc(l.name)}<small class="zh"></small></span></label>`).join('')).join('') +
    `<div class="lgh">Other countries' separation distances</div><div id="ctry-b"></div>
    <div class="hint">Greyed layers appear as you zoom in. Your choices are remembered in this browser.</div></div>`;
  L.DomEvent.disableClickPropagation(d); L.DomEvent.disableScrollPropagation(d); return d;
};
lyrCtl.addTo(map);
document.querySelectorAll('#lyr-b input[name=basemap]').forEach(i => i.onchange = () => {
  Object.values(base).forEach(b => map.removeLayer(b)); base[i.value].addTo(map); store.set('base', i.value); });
document.querySelectorAll('#lyr-b label[data-l] input').forEach(i => i.onchange = () => {
  const n = i.closest('label').dataset.l; i.checked ? userOff.delete(n) : userOff.add(n); saveOff(); zoomRules(); });
function layerHints(z){
  document.querySelectorAll('#lyr-b label[data-l]').forEach(lb => { const l = LAYERS.find(x => x.name === lb.dataset.l);
    const out = z < l.min || (l.max && z > l.max);
    lb.classList.toggle('dim', out);
    lb.querySelector('.zh').textContent = out ? (z < l.min ? ' – zoom in to see' : ' – zoom out to see') : ''; });
}
L.control.scale({imperial:false}).addTo(map);
if (L.simpleMapScreenshoter) L.simpleMapScreenshoter({position:'topleft',
  hideElementsWithSelectors:['.leaflet-control-zoom','.leaflet-control-layers','.leaflet-control-simpleMapScreenshoter','.disp','.leaflet-popup','.addbtn'],
  screenName:() => 'biomethane-map-' + new Date().toISOString().slice(0,10), mimeType:'image/png'}).addTo(map);

let D = null;                     // loaded data
const active = new Set(Object.keys(BM.STATUS));
let onlyDeadlines = false;

// ---- legend
const legend = L.control({position:'bottomright'});
legend.onAdd = () => { const d = L.DomUtil.create('div','legend'); d.id = 'legend'; return d; };
legend.addTo(map);
function drawLegend(){
  const rr = Object.entries(BM.RECEPTORS).filter(([k]) => D && D.raw.recs.features.some(f => f.properties.category === k));
  document.getElementById('legend').innerHTML =
    Object.keys(BM.STATUS).map(s => `<div class="row"><span class="dot" style="background:${col(s)}"></span>${s}</div>`).join('') +
    '<hr style="border:0;border-top:1px solid var(--line);margin:6px 0">' +
    `<div class="row"><span class="dot" style="background:${css('--home-likely')}"></span>Likely home</div>` +
    `<div class="row"><span class="dot" style="background:${css('--home-possible')};width:8px;height:8px"></span>Possible home (unverified)</div>` +
    `<div class="row"><span class="dot" style="background:#ff9800"></span>Home added by a map user</div>` +
    (marked.size ? `<div class="row"><span class="dot" style="background:transparent;border:1.5px dashed #777;box-shadow:none"></span>Removed by you (updates daily)</div>` : '') +
    `<div class="row"><span class="ring" style="border-color:#e31a1c"></span>250 m</div><div class="row"><span class="ring" style="border-color:#ff7f00"></span>500 m</div><div class="row"><span class="ring" style="border-color:#e6c300"></span>1,000 m</div>` +
    (rr.length && map.hasLayer(lyr.recs) ? '<hr style="border:0;border-top:1px solid var(--line);margin:6px 0">' + rr.map(([k, [c, l]]) => `<div class="row"><span class="ric" style="background:${c}">${l}</span>${k}</div>`).join('') : '') +
    (opt.rules.length ? '<hr style="border:0;border-top:1px solid var(--line);margin:6px 0">' + D.RULES.filter(r => opt.rules.includes(r.id)).map(r => `<div class="row"><span class="ring" style="border-color:${r.colour};border-top-style:solid"></span>${esc(r.short)}</div>`).join('') : '');
}

// ---- display panel + other countries' rules + add-missing button
const disp = L.control({position:'topright'});
disp.onAdd = () => {
  const d = L.DomUtil.create('div', 'disp leaflet-control');
  d.innerHTML = `<button aria-expanded="false" id="disp-t">Display ▾</button>
    <div class="body" id="disp-b" hidden>
      <label>Home dot size <input type="range" id="o-home" min="2" max="14" step="1" value="${opt.homeSize}"></label>
      <label>Site marker size <input type="range" id="o-site" min="4" max="20" step="1" value="${opt.siteSize}"></label>
      <label>Site names
        <select id="o-names"><option value="auto">Show when zoomed in</option><option value="on">Always show</option><option value="off">Hide</option></select></label>
      <label class="cb"><input type="checkbox" id="o-hide" ${opt.hideMarked ? 'checked' : ''}> Hide buildings I've removed</label>
      <label>Planning drawing opacity <input type="range" id="o-drw" min="0.2" max="1" step="0.05" value="${opt.drwOpacity}"></label>
      <div class="hint">Set sizes, then use the camera button (top left) to save a PNG. Homes show from zoom 12.</div>
    </div>`;
  L.DomEvent.disableClickPropagation(d); L.DomEvent.disableScrollPropagation(d); return d;
};
disp.addTo(map);
const addCtl = L.control({position:'topleft'});
addCtl.onAdd = () => { const d = L.DomUtil.create('div', 'leaflet-bar addbtn');
  d.innerHTML = `<a href="#" title="Add a missing home, school, crèche or care home" role="button" style="width:auto;padding:0 8px;font:600 12px var(--sans);line-height:30px">+ Add missing</a>`;
  L.DomEvent.disableClickPropagation(d); d.querySelector('a').onclick = e => { e.preventDefault(); startAdd(); }; return d; };
addCtl.addTo(map);

function toggler(btnId, bodyId, label){
  document.getElementById(btnId).onclick = e => { const b = document.getElementById(bodyId), t = e.currentTarget;
    b.hidden = !b.hidden; t.setAttribute('aria-expanded', !b.hidden); t.textContent = label + (b.hidden ? ' ▾' : ' ▴');
    document.body.classList.toggle('panel-open', [...document.querySelectorAll('.disp .body')].some(x => !x.hidden)); };
}
toggler('lyr-t', 'lyr-b', 'Layers'); toggler('disp-t', 'disp-b', 'Display');
document.getElementById('o-names').value = opt.names;
document.getElementById('o-home').oninput = e => { opt.homeSize = +e.target.value; saveOpt(); styleHomes(); };
document.getElementById('o-site').oninput = e => { opt.siteSize = +e.target.value; saveOpt(); D.SITES.forEach(s => s.marker.setRadius(opt.siteSize)); };
document.getElementById('o-names').onchange = e => { opt.names = e.target.value; saveOpt(); zoomRules(); };
document.getElementById('o-drw').oninput = e => { opt.drwOpacity = +e.target.value; saveOpt(); (D?.DRW_LYR || []).forEach(o => o.setOpacity(opt.drwOpacity)); };
document.getElementById('o-hide').onchange = e => { opt.hideMarked = e.target.checked; saveOpt(); styleHomes(); };

// ---- add a missing home / sensitive building
let adding = false;
function startAdd(){
  adding = true; document.body.classList.add('addmode');
  const t = document.createElement('div'); t.className = 'toast'; t.id = 'addtoast';
  t.innerHTML = 'Click the map where the missing home, school, crèche or care home is <button>Cancel</button>';
  t.querySelector('button').onclick = stopAdd; document.body.appendChild(t);
  if (map.getZoom() < 15) t.firstChild.textContent = 'Zoom in close, then click where the missing home, school, crèche or care home is ';
}
function stopAdd(){ adding = false; document.body.classList.remove('addmode'); document.getElementById('addtoast')?.remove(); }
map.on('click', e => {
  if (!adding) return;
  const near = D.SITES.map(s => ({s, d:map.distance([s.lat, s.lon], e.latlng)})).sort((a, b) => a.d - b.d)[0];
  stopAdd();
  const pop = L.popup({maxWidth:280}).setLatLng(e.latlng).setContent(`<div class="hp addform"><b>Add something missing here</b>
    ${near ? `<div class="note">Nearest site: ${esc(near.s.project)} (${fmt(near.d)} m)</div>` : ''}
    <label>What is here?<select id="a-type">${BM.ADD_TYPES.map(t => `<option>${esc(t)}</option>`).join('')}</select></label>
    <label id="a-namel" hidden>Name of the place<input id="a-name" maxlength="80" placeholder="e.g. St Mary's National School"></label>
    <div class="row"><button class="go" id="a-go">Add to map</button></div>
    <div class="note">Shown to everyone from the next daily update. No names of residents, please.</div></div>`).openOn(map);
  const el = pop.getElement(), ty = el.querySelector('#a-type');
  ty.onchange = () => el.querySelector('#a-namel').hidden = ty.value.startsWith('Home');
  el.querySelector('#a-go').onclick = () => { const t = ty.value, n = el.querySelector('#a-name').value.trim();
    BM.addPlace(e.latlng.lat, e.latlng.lng, near ? near.s.project : '', t, t.startsWith('Home') ? '' : n);
    L.circleMarker(e.latlng, {radius:opt.homeSize + 1, color:'#fff', weight:1.5, fillColor:'#ff9800', fillOpacity:1}).bindTooltip(`Added by you: ${esc(t)}${n ? ' – ' + esc(n) : ''} (live for everyone after the next daily update)`).addTo(map);
    pop.setContent('<div class="hp"><b>Thanks – added.</b><div class="note">It appears for everyone at the next daily update.</div></div>'); };
});

// ---- load everything
BM.load().then(data => {
  D = data; const m = D.meta;
  if (m.last_updated) document.getElementById('sub').textContent = `${D.SITES.length} sites · applications lodged or decided since 2021 · updated ${dmy(m.last_updated)}`;
  const rc = {250:'#e31a1c',500:'#ff7f00',1000:'#e6c300'};
  L.geoJSON(D.raw.polys, {style: f => ({color:col(f.properties.status), weight:2, fillOpacity:.15}), onEachFeature:(f,l)=>l.on('click',()=>select(f.properties.site_id))}).addTo(lyr.sites);
  L.geoJSON(D.raw.rings, {style: f => ({color:rc[f.properties.distance_m], weight:1.6, dashArray:'6 5', fill:false}), interactive:false}).addTo(lyr.rings);
  D.RING_LBL = {};
  D.raw.rings.features.forEach(f => { const p = f.properties, b = L.geoJSON(f).getBounds();
    const t = L.tooltip({permanent:true, direction:'top', className:'ringlbl'}).setLatLng([b.getNorth(), b.getCenter().lng]).addTo(lyr.ringLabels);
    (D.RING_LBL[p.site_id] ||= []).push({d:p.distance_m, t}); });
  // homes
  D.HOME_MK = D.raw.homes.features.map(f => { const p = f.properties;
    const mk = L.circleMarker([f.geometry.coordinates[1], f.geometry.coordinates[0]], {color:'#fff', weight:1, fillOpacity:1});
    mk.feature = f;
    mk.bindTooltip(() => `${esc(p.tier)} · ${fmt(p.dist_m)} m from ${esc(p.project)} boundary${p.downwind_pct != null ? ` · downwind ${p.downwind_pct}% of hours` : ''}${marked.has(p.home_id) ? ' · marked not a home' : ''}`);
    mk.bindPopup(() => homePopup(f), {maxWidth:290}); return mk; });
  styleHomes();
  // receptors
  D.raw.recs.features.forEach(f => { const p = f.properties, [c, l] = BM.RECEPTORS[p.category] || BM.RECEPTORS['Other sensitive'];
    L.marker([f.geometry.coordinates[1], f.geometry.coordinates[0]], {icon:L.divIcon({className:'recicon', html:`<span class="ric" style="background:${c}">${l}</span>`, iconSize:[0,0]})})
     .bindTooltip(`<b>${esc(p.name)}</b><br>${esc(p.category)} · ${fmt(p.dist_m)} m from site boundary<br><span style="opacity:.7">Source: ${esc(p.source)}</span>`)
     .addTo(lyr.recs); });
  // wind roses
  D.SITES.forEach(s => { const w = D.WIND[s.site_id]; if (!w) return;
    L.marker([s.lat, s.lon], {interactive:false, icon:L.divIcon({className:'windicon', html:BM.rose(w, 120, {bg:'rgba(255,255,255,.6)', grid:'#555', text:'#111'}), iconSize:[120,120], iconAnchor:[60,60]})}).addTo(lyr.wind); });
  // traced plant layouts
  if (D.raw.lay.features.length) L.geoJSON(D.raw.lay, {style:{color:'#ff5722', weight:1.5, fillColor:'#ff5722', fillOpacity:.35},
    onEachFeature:(f, l) => l.bindTooltip(`${esc(f.properties.label || f.properties.kind || 'Structure')}${f.properties.open ? ' (open)' : ''}`)}).addTo(lyr.layout);
  // georeferenced planning drawings (each image loads only when zoomed in near its site)
  D.DRW_LYR = D.DRAWINGS.map(d => { const o = L.imageOverlay('drawings/' + d.file, d.bounds, {opacity:opt.drwOpacity, interactive:false, alt:d.title || 'Planning drawing'});
    o.meta = d; return o; });
  // other countries' rings
  D.RULE_LYR = {};
  D.RULES.forEach(r => { D.RULE_LYR[r.id] = L.geoJSON({type:'FeatureCollection', features:D.raw.intlRings.features.filter(f => f.properties.rule === r.id)},
    {interactive:false, style: f => ({color:r.colour, weight:2.2, dashArray:f.properties.kind === 'sensitive' ? '2 5' : null, fill:false})}); });
  buildCountryPanel();
  // site markers
  D.SITES.forEach(s => { s.marker = L.circleMarker([s.lat, s.lon], {radius:opt.siteSize, color:'#fff', weight:2, fillColor:col(s.status), fillOpacity:1})
      .on('click', () => select(s.site_id)); s.marker.addTo(lyr.points); });
  updateRingLabels(); buildChips(); renderNew(); renderList(); zoomRules(); drawLegend();
  const h = location.hash.slice(1); if (h) select(h); else welcome();
});

// ---- other countries panel
function buildCountryPanel(){
  const b = document.getElementById('ctry-b');
  b.innerHTML = D.RULES.map(r => `<div class="rrow"><label class="cb"><input type="checkbox" data-r="${r.id}" ${opt.rules.includes(r.id) ? 'checked' : ''}>
     <span><span class="swatch" style="background:${r.colour}"></span>${esc(r.short)}</span></label><button class="ibtn" data-info="${r.id}" aria-label="About the ${esc(r.country)} rule">i</button></div>`).join('') +
    `<div class="hint">Rings show each rule's distance around every site (zoom in). Dotted = distance to schools, care and settlements. Each site's card says whether it would meet each rule.
     From the <a href="${BM.RESEARCH}" target="_blank" rel="noopener">NBCG international comparison ↗</a>. Not legal advice; no distance is a proven safe distance.</div>`;
  b.querySelectorAll('input[data-r]').forEach(i => i.onchange = () => {
    opt.rules = [...b.querySelectorAll('input[data-r]:checked')].map(x => x.dataset.r); saveOpt(); applyRules(); drawLegend();
    const cur = document.getElementById('detail').dataset.site; if (cur) select(cur, false); });
  b.querySelectorAll('[data-info]').forEach(x => x.onclick = e => { e.stopPropagation(); ruleInfo(D.RULES.find(r => r.id === x.dataset.info), x); });
  applyRules();
}
function applyRules(){ D.RULES.forEach(r => { const on = opt.rules.includes(r.id) && map.getZoom() >= 11; on ? lyr.intl.addLayer(D.RULE_LYR[r.id]) : lyr.intl.removeLayer(D.RULE_LYR[r.id]); });
  map.hasLayer(lyr.intl) || lyr.intl.addTo(map); }

// ---- counts honouring homes this viewer has marked
function counts(id){
  const c = {250:[0,0], 500:[0,0], 1000:[0,0]}; let mine = 0;
  (D.HOMES[id] || []).forEach(f => { const p = f.properties;
    if (marked.has(p.home_id)) { mine++; return; }
    const k = p.tier === 'Possible home' ? 1 : 0;
    [250,500,1000].forEach(b => { if (p.dist_m <= b) c[b][k]++; }); });
  return {c, mine};
}
function updateRingLabels(){ Object.entries(D.RING_LBL).forEach(([id, arr]) => { const {c} = counts(id);
  arr.forEach(({d, t}) => t.setContent(`${d.toLocaleString('en-IE')} m · ${c[d][0]} likely + ${c[d][1]} possible homes`)); }); }
function styleHomes(){
  const r = opt.homeSize;
  D.HOME_MK.forEach(mk => { const p = mk.feature.properties, m = marked.has(p.home_id);
    if (m && opt.hideMarked) { lyr.homes.removeLayer(mk); return; }
    lyr.homes.addLayer(mk);
    const fill = p.tier === 'Reported home' ? '#ff9800' : p.tier === 'Likely home' ? css('--home-likely') : css('--home-possible');
    mk.setRadius(p.tier === 'Possible home' ? Math.max(2, r - 1) : r);
    mk.setStyle(m ? {color:'#666', weight:1.5, dashArray:'2 2', fillColor:'#fff', fillOpacity:.35}
                  : {color: visited[p.home_id] ? '#00e676' : '#fff', weight: visited[p.home_id] ? 2.5 : (r >= 8 ? 1.5 : 1), dashArray:null, fillColor:fill, fillOpacity:1}); });
  if (D) drawLegend();
}
function homePopup(f){
  const p = f.properties, m = marked.has(p.home_id), [lon, lat] = f.geometry.coordinates;
  const g = `https://www.google.com/maps/@${lat},${lon},120m/data=!3m1!1e3`, v = visited[p.home_id];
  return `<div class="hp"><b>${esc(p.tier)}</b> · ${fmt(p.dist_m)} m from the ${esc(p.project)} site boundary
    ${p.plant_m != null ? `<br>${fmt(p.plant_m)} m from the nearest plant structure` : ''}
    ${p.downwind_pct != null ? `<br>Downwind of the site about <b>${p.downwind_pct}%</b> of hours` : ''}
    <div class="id">ID ${esc(p.home_id || '–')}</div>
    ${!p.home_id ? '<div class="row">' : m ? `<div class="ok">Removed from the map. It drops out for everyone at the next daily update.</div><div class="row"><button data-act="undo" data-id="${esc(p.home_id)}" data-site="${esc(p.project)}">It is a home – put it back</button>`
        : `<details class="nh"><summary>Not a home?</summary><select data-reason>${BM.REMOVE_REASONS.map(r => `<option>${esc(r)}</option>`).join('')}</select>
           <button class="warn" data-act="remove" data-id="${esc(p.home_id)}" data-site="${esc(p.project)}">Remove from map</button></details><div class="row">`}
      <a class="hb" href="${g}" target="_blank" rel="noopener">Satellite ↗</a>
      <a class="hb" href="${BM.directions(lat, lon)}" target="_blank" rel="noopener">Directions ↗</a>
    </div>
    <div class="row" style="margin-top:6px">Door-to-door (only you see this):
      <select data-act="visit" data-id="${esc(p.home_id)}">
        <option value="">–</option><option value="visited" ${v==='visited'?'selected':''}>Called / leaflet left</option>
        <option value="interested" ${v==='interested'?'selected':''}>Spoke – interested</option><option value="nothome" ${v==='nothome'?'selected':''}>No answer</option></select></div></div>`;
}
map.on('popupopen', e => {
  const el = e.popup.getElement();
  el.querySelectorAll('button[data-act]').forEach(b => b.onclick = () => {
    const id = b.dataset.id; if (!id) return;
    if (b.dataset.act === 'remove') { marked.add(id); BM.removeHome(id, b.dataset.site, el.querySelector('select[data-reason]')?.value || BM.REMOVE_REASONS[0]); }
    else { marked.delete(id); BM.removeHome(id, b.dataset.site, '', true); }
    store.set('marked', [...marked]); refreshAfterChange(); e.popup.setContent(homePopup(e.popup._source.feature)); map.fire('popupopen', {popup:e.popup}); });
  el.querySelectorAll('select[data-act=visit]').forEach(s => s.onchange = () => {
    if (s.value) visited[s.dataset.id] = s.value; else delete visited[s.dataset.id];
    store.set('visited', visited); styleHomes(); });
});
function refreshAfterChange(){ styleHomes(); updateRingLabels(); renderList(); const cur = document.getElementById('detail').dataset.site; if (cur) select(cur, false); }

function zoomRules(){
  const z = map.getZoom(), want = (g, name, on) => { on && !userOff.has(name) ? map.addLayer(g) : map.removeLayer(g); };
  LAYERS.forEach(l => want(l.g, l.name, z >= l.min && (!l.max || z <= l.max)));
  want(lyr.ringLabels, 'Distance rings from site boundary', z >= 14);
  layerHints(z); showDrawings();
  applyRules();
  const perm = opt.names === 'on' || (opt.names === 'auto' && z >= 9);
  D && D.SITES.forEach(s => { s.marker.unbindTooltip().bindTooltip(esc(s.project), {className:'lbl', direction:'right', offset:[8,0], permanent: perm && opt.names !== 'off'}); });
  if (D) drawLegend();
}
map.on('zoomend', zoomRules);
function showDrawings(){
  if (!D || !D.DRW_LYR) return;
  const on = map.hasLayer(lyr.drawings), vb = map.getBounds().pad(0.3);
  D.DRW_LYR.forEach(o => { (on && vb.intersects(o.getBounds())) ? lyr.drawings.addLayer(o) : lyr.drawings.removeLayer(o); });
}
map.on('moveend', showDrawings);

// ---- deadlines
function deadlineOf(s){
  const o = daysTo(s.obs_deadline), a = daysTo(s.appeal_deadline);
  if (s.obs_deadline && o >= 0) return {kind:'obs', date:s.obs_deadline, days:o};
  if (s.appeal_deadline && a >= 0 && s.status !== 'Under appeal') return {kind:'appeal', date:s.appeal_deadline, days:a};
  return null;
}
function badges(s){
  const out = [], d = deadlineOf(s);
  if (d) out.push(`<span class="badge ${d.days <= 7 ? 'due' : 'soon'}">${d.kind === 'obs' ? 'Submissions close' : 'Appeal by'} ${dmy(d.date).replace(/ \d{4}$/, '')}${d.days <= 7 ? ` · ${d.days === 0 ? 'today' : d.days + ' day' + (d.days > 1 ? 's' : '')}` : ''}</span>`);
  if (s.is_new) out.push('<span class="badge new">New</span>');
  return out.join('');
}
function renderNew(){
  const box = document.getElementById('newbox'), n = D.SITES.filter(s => s.is_new), dl = D.SITES.filter(s => deadlineOf(s));
  if (!n.length && !dl.length) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = (n.length ? `<b>New in the last 2 weeks</b><div>${n.map(s => `<a data-id="${s.site_id}">${esc(s.project)}</a>`).join(' · ')}</div>` : '') +
    (dl.length ? `<b style="display:block;margin-top:${n.length ? 6 : 0}px">Open deadlines</b><div>${dl.sort((a,b) => deadlineOf(a).days - deadlineOf(b).days)
      .map(s => { const d = deadlineOf(s); return `<a data-id="${s.site_id}">${esc(s.project)}</a> – ${d.kind === 'obs' ? 'submissions' : 'appeal'} by ${dmy(d.date)}`; }).join('<br>')}</div>` : '');
  box.querySelectorAll('a[data-id]').forEach(a => a.onclick = () => select(a.dataset.id));
}

// ---- list & chips
function buildChips(){
  const c = document.getElementById('chips');
  const nd = D.SITES.filter(s => deadlineOf(s)).length;
  c.innerHTML = Object.keys(BM.STATUS).map(s => { const n = D.SITES.filter(x => x.status === s).length;
    return n ? `<button class="chip" aria-pressed="true" data-s="${s}"><span class="dot" style="background:${col(s)}"></span>${s} <b>${n}</b></button>` : ''; }).join('') +
    (nd ? `<button class="chip" aria-pressed="false" id="chip-dl">⏰ Open deadlines <b>${nd}</b></button>` : '');
  c.querySelectorAll('.chip[data-s]').forEach(b => b.onclick = () => { const s = b.dataset.s, on = b.getAttribute('aria-pressed') === 'true';
    b.setAttribute('aria-pressed', !on); on ? active.delete(s) : active.add(s); renderList(); });
  const dl = document.getElementById('chip-dl'); if (dl) dl.onclick = () => { onlyDeadlines = !onlyDeadlines; dl.setAttribute('aria-pressed', onlyDeadlines); renderList(); };
}
document.getElementById('q').addEventListener('input', renderList);
function renderList(){
  const q = document.getElementById('q').value.toLowerCase().trim();
  const vis = D.SITES.filter(s => active.has(s.status) && (!onlyDeadlines || deadlineOf(s)) && (!q || [s.project,s.county,s.developer,s.application_refs,s.appeal_refs].join(' ').toLowerCase().includes(q)));
  D.SITES.forEach(s => { vis.includes(s) ? lyr.points.addLayer(s.marker) : lyr.points.removeLayer(s.marker); });
  vis.sort((a,b) => (a.county||'').localeCompare(b.county||'') || a.project.localeCompare(b.project));
  document.getElementById('list').innerHTML = vis.map(s => { const {c} = counts(s.site_id), bd = badges(s); return `
    <div class="site" role="listitem" tabindex="0" data-id="${s.site_id}">
      <span class="dot" style="background:${col(s.status)}"></span>
      <span class="name">${esc(s.project)}</span>
      <span class="n" title="Likely + possible homes within 1 km">${fmt(c[1000][0] + c[1000][1])} homes</span>
      <span class="meta">${esc(s.county)} · ${esc(s.status)}${s.application_refs ? ' · ' + esc(s.application_refs) : ''}${s.planning_link ? ` · <a class="plink" href="${esc(s.planning_link)}" target="_blank" rel="noopener">Planning file ↗</a>` : ''}</span>
      ${bd ? `<span class="badges">${bd}</span>` : ''}
    </div>`; }).join('') || '<p class="note" style="padding:16px">No sites match.</p>';
  document.querySelectorAll('.site').forEach(el => { el.onclick = e => { if (e.target.closest('a')) return; select(el.dataset.id); };
    el.onkeydown = e => { if (e.key === 'Enter') select(el.dataset.id); }; });
}

// ---- site detail card (replaces the list while open; tabs keep it short)
let curTab = 'ov';
const nearestLikely = id => { const h = (D.HOMES[id] || []).filter(f => !marked.has(f.properties.home_id) && f.properties.tier !== 'Possible home');
  if (!h.length) return null; const f = h.reduce((a, b) => a.properties.dist_m <= b.properties.dist_m ? a : b); return f.properties; };
function closeCard(){ const d = document.getElementById('detail'); d.hidden = true; delete d.dataset.site; document.body.classList.remove('card-open');
  history.replaceState(null, '', location.pathname); }
function intlNote(s){
  if (!s.intl) return '';
  return s.intl.provisional === false || /plant/.test(s.intl.measured_from || '')
    ? 'Measured from the plant structures traced from the planning drawing, as these countries do.'
    : `<b>Provisional.</b> Measured from the ${esc(s.intl.measured_from || 'site boundary')}. These countries measure from the plant itself (tanks, buildings, storage), which is usually further away, so a plant traced from the drawing will replace this.`;
}
function select(id, move = true){
  const s = D.SITES.find(x => x.site_id === id); if (!s) return;
  history.replaceState(null, '', '#' + id);
  const poly = D.POLYS[id];
  if (move) { if (poly) map.fitBounds(L.geoJSON(poly).getBounds().pad(1.2), {maxZoom:15}); else map.setView([s.lat, s.lon], 14); }
  const row = (k, v) => v ? `<dt>${k}</dt><dd>${v}</dd>` : '';
  const {c, mine} = counts(id);
  const [l250,p250] = c[250], [l500,p500] = c[500], [l1k,p1k] = c[1000];
  const tpy = +String(s.tonnes_per_year || '').replace(/,/g, '');
  const w = D.WIND[id], pv = BM.prevailing(w);
  const recs = (D.RECS[id] || []).slice().sort((a, b) => a.properties.dist_m - b.properties.dist_m);
  const near = nearestLikely(id);
  const dl = deadlineOf(s);
  const dlBox = dl ? `<div class="deadline open">${dl.kind === 'obs'
      ? `<b>Submissions to the council close ${dmy(dl.date)}</b> (${dl.days === 0 ? 'today' : dl.days + ' day' + (dl.days > 1 ? 's' : '') + ' left'}).<br>Anyone can make a written submission (€20 fee) within 5 weeks of the council receiving the application.`
      : `<b>Appeal to An Coimisiún Pleanála by ${dmy(dl.date)}</b> (${dl.days} day${dl.days > 1 ? 's' : ''} left).<br>Usually only people who made a submission to the council can appeal (4 weeks from the decision).`}
      <div class="note" style="margin-top:4px">Indicative date worked out from the national planning data – always confirm on the planning file.</div></div>`
    : s.status === 'Under appeal' ? `<div class="deadline closed">Under appeal. Observations on an appeal are due within 4 weeks of the appeal being lodged – check the case on <a href="https://www.pleanala.ie/en-ie/case-search" target="_blank" rel="noopener">pleanala.ie ↗</a>.</div>` : '';
  const intl = s.intl && s.intl.rules ? D.RULES.map(r => { const v = s.intl.rules.find(x => x.id === r.id); if (!v) return '';
      const [t, cl] = BM.VERDICT[v.verdict] || ['', '#666'];
      return `<tr><td><button class="rulebtn" data-rule="${r.id}" title="What is this rule?"><span class="swatch" style="background:${r.colour}"></span>${esc(r.short)} <span class="i">i</span></button>
        <div class="why">${esc(BM.verdictText(r, v, s))}</div></td><td class="v" style="color:${cl}">${t}</td></tr>`; }).join('') : '';
  const drw = D.DRAWINGS.filter(x => x.site_id === id);
  const d = document.getElementById('detail'); d.hidden = false; d.dataset.site = id; document.body.classList.add('card-open');
  const tabs = [['ov', 'Overview'], ['near', 'Nearby'], ['intl', 'Other countries'], ['act', 'Take action']];
  d.innerHTML = `
    <div class="cardtop"><button class="link" id="back">← All sites</button><button class="link" id="share">Copy link to this site</button></div>
    <h2>${esc(s.project)}</h2>
    <span class="pill" style="background:${col(s.status)}">${esc(s.status)}</span> ${s.is_new ? '<span class="badge new">New</span>' : ''}
    ${s.planning_link ? `<a class="btn primary plan" href="${esc(s.planning_link)}" target="_blank" rel="noopener">Open planning file${s.application_refs ? ' · ' + esc(String(s.application_refs).split(',')[0]) : ''} ↗</a>` : ''}
    ${dlBox}
    <div class="tabs" role="tablist">${tabs.map(([k, l]) => `<button role="tab" data-tab="${k}" aria-selected="${k === curTab}">${l}</button>`).join('')}</div>

    <div class="tabp" data-p="ov">
      <table class="counts" aria-label="Homes within distance of site boundary">
        <thead><tr><th>Homes within</th><th>Likely</th><th>Possible</th><th>Total</th></tr></thead>
        <tbody>
          <tr><td>250 m</td><td>${fmt(l250)}</td><td>${fmt(p250)}</td><td>${fmt(l250+p250)}</td></tr>
          <tr><td>500 m</td><td>${fmt(l500)}</td><td>${fmt(p500)}</td><td>${fmt(l500+p500)}</td></tr>
          <tr><td>1,000 m</td><td>${fmt(l1k)}</td><td>${fmt(p1k)}</td><td>${fmt(l1k+p1k)}</td></tr>
        </tbody>
      </table>
      ${near ? `<div class="note">Nearest likely home: <b>${fmt(near.dist_m)} m</b> from the site boundary${near.plant_m != null ? `, <b>${fmt(near.plant_m)} m</b> from the nearest plant structure` : ''}.</div>` : ''}
      ${mine ? `<div class="mine">Excludes ${mine} building${mine > 1 ? 's' : ''} you removed (they drop out for everyone at the next daily update).</div>` : ''}
      <div class="note" style="margin-top:4px">Counted from the red-line site boundary. ${s.approx_location ? '<b>Site boundary not published – location approximate.</b> ' : ''}Homes are estimated from building footprints – click a dot to remove one that isn't a home, or use <b>+ Add missing</b>.</div>
      ${drw.map(x => `<div class="drwnote"><b>Planning drawing on the map:</b> ${esc(x.title)}. <a href="#" data-drw="${esc(x.file)}">Zoom to it</a> · fade it under <b>Display</b>.<br><span class="note">Fitted to the red-line boundary, accurate to a few metres. Source: ${esc(x.source)}</span></div>`).join('')}
      <dl class="kv">
        ${row('Status', esc(s.status_note))}
        ${row('Scale', tpy ? `${fmt(tpy)} tonnes / year (≈${fmt(tpy / 365)} t/day)<br><span class="note">Source: ${esc(s.tonnes_source || 'planning data')}</span>` : '<span class="note">Tonnage not confirmed yet</span>')}
        ${row('Developer', esc(s.developer))}
        ${row('County', esc(s.county))}
        ${row('Type', esc(s.type))}
        ${row('Planning refs', esc(s.application_refs))}
        ${row('Appeal refs', esc(s.appeal_refs))}
        ${row('Lodged', s.latest_lodged && s.latest_lodged !== 'None' ? dmy(s.latest_lodged) : '')}
        ${row('Decision', s.latest_decision && s.latest_decision !== 'None' ? dmy(s.latest_decision) : '')}
        ${row('Site area', s.site_area_ha ? s.site_area_ha + ' ha' : '')}
      </dl>
    </div>

    <div class="tabp" data-p="near">
      ${w ? `<h3>Wind</h3><div class="windrow">${BM.rose(w, 118, {grid:css('--muted'), text:css('--fg')})}
        <div style="font-size:12.5px">Prevailing wind from the <b>${pv.from}</b> (${pv.pct}% of hours), so the plant's air most often drifts <b>${pv.towards}</b>.<br>
        <b>${fmt(s.downwind_homes_1km)}</b> mapped homes within 1 km are downwind at least 10% of the time.
        <div class="note" style="margin-top:4px">Hourly 10 m wind 2021–2025, ERA5 reanalysis via Open-Meteo. Calm ${w.calm_pct}% of hours.</div></div></div>` : ''}
      <h3>Schools, care, health & community within 1 km</h3>
      ${recs.length ? `<ul class="rlist">${recs.map(f => { const p = f.properties, [cc, l] = BM.RECEPTORS[p.category] || BM.RECEPTORS['Other sensitive'];
        return `<li><span class="ric" style="background:${cc}">${l}</span>${esc(p.name)} <span class="note">${esc(p.category)}</span><span class="d">${fmt(p.dist_m)} m</span></li>`; }).join('')}</ul>`
        : '<div class="note">None found in Dept. of Education, HSE or OpenStreetMap data. Know of one? Use <b>+ Add missing</b>.</div>'}
      <h3>Protected sites & water</h3>
      <dl class="kv">
        ${row('Nearest SAC', s.sac_name ? `${esc(s.sac_name)} – ${s.sac_m === 0 ? '<b>site touches it</b>' : fmt(s.sac_m) + ' m'}` : 'None within 15 km')}
        ${row('Nearest SPA', s.spa_name ? `${esc(s.spa_name)} – ${s.spa_m === 0 ? '<b>site touches it</b>' : fmt(s.spa_m) + ' m'}` : 'None within 15 km')}
        ${row('Nearest river', s.river_name ? `${esc(s.river_name)} – ${s.river_m === 0 ? '<b>on or beside the site</b>' : fmt(s.river_m) + ' m'}` : 'None mapped within 1 km')}
      </dl>
    </div>

    <div class="tabp" data-p="intl">
      ${intl ? `<div class="note" style="margin-bottom:6px">Would this application meet the separation distances used elsewhere? Tap a rule to see what it is and how it's measured.</div>
        <table class="intl">${intl}</table>
        <div class="note" style="margin-top:6px">${intlNote(s)} Not legal advice and not a safe distance. Show the rings under <b>Layers</b>.
        <a href="${BM.RESEARCH}" target="_blank" rel="noopener">About the NBCG international comparison ↗</a></div>` : '<div class="note">Not available for this site.</div>'}
    </div>

    <div class="tabp" data-p="act">
      <h3>For a submission or observation</h3>
      <div class="btns">
        <button class="btn primary" id="facts">Copy key facts</button>
        <a class="btn" href="print.html?site=${id}&mode=report" target="_blank" rel="noopener">One-page site report (PDF)</a>
      </div>
      <div class="note" style="margin-top:4px">Copies a plain-text summary (homes, nearest home, schools, wind, protected sites, other countries' distances) to paste into your own submission. Check every figure against the planning file and on the ground.</div>
      <h3>Door to door</h3>
      <div class="btns">
        <a class="btn" href="print.html?site=${id}&mode=canvass" target="_blank" rel="noopener">Walking list & map (print)</a>
        <button class="btn" id="dl">Homes list (CSV)</button>
      </div>
      <div class="note" style="margin-top:4px">Visit ticks are kept in this browser only; nothing about residents is stored.</div>
      <h3>Look closer</h3>
      <div class="btns"><a class="btn" href="https://www.google.com/maps/@${s.lat},${s.lon},800m/data=!3m1!1e3" target="_blank" rel="noopener">Google satellite ↗</a>
        <a class="btn" href="${BM.directions(s.lat, s.lon)}" target="_blank" rel="noopener">Directions to site ↗</a></div>
    </div>`;
  const showTab = k => { curTab = k; d.querySelectorAll('.tabs button').forEach(b => b.setAttribute('aria-selected', b.dataset.tab === k));
    d.querySelectorAll('.tabp').forEach(p => p.hidden = p.dataset.p !== k); };
  d.querySelectorAll('.tabs button').forEach(b => b.onclick = () => showTab(b.dataset.tab)); showTab(curTab);
  document.getElementById('back').onclick = closeCard;
  document.getElementById('share').onclick = e => copy(location.origin + location.pathname + '#' + id, e.currentTarget, 'Link copied');
  document.getElementById('facts').onclick = e => copy(factsText(s), e.currentTarget, 'Copied – paste into your submission');
  d.querySelectorAll('.rulebtn').forEach(b => b.onclick = () => ruleInfo(D.RULES.find(r => r.id === b.dataset.rule), b));
  const live = () => (D.HOMES[id] || []).filter(f => !marked.has(f.properties.home_id));
  document.getElementById('dl').onclick = () => {
    const rows = [['site','home_id','tier','distance_from_boundary_m','downwind_pct','latitude','longitude']].concat(live().map(f =>
      [s.project, f.properties.home_id, f.properties.tier, f.properties.dist_m, f.properties.downwind_pct ?? '', f.geometry.coordinates[1].toFixed(5), f.geometry.coordinates[0].toFixed(5)]));
    BM.download(s.project.replace(/[^\w]+/g,'_') + '_homes.csv', rows.map(r => r.map(v => `"${String(v ?? '').replace(/"/g,'""')}"`).join(',')).join('\n'), 'text/csv'); };
  d.querySelectorAll('a[data-drw]').forEach(a => a.onclick = e => { e.preventDefault();
    const o = D.DRW_LYR.find(x => x.meta.file === a.dataset.drw); if (!o) return;
    userOff.delete('Planning drawings (georeferenced)'); saveOff(); syncLayerTicks();
    map.fitBounds(o.getBounds(), {maxZoom:18}); map.once('moveend', zoomRules); });
  d.scrollTop = 0;
}
function copy(text, btn, msg){
  const done = () => { const t = btn.textContent; btn.textContent = msg; setTimeout(() => btn.textContent = t, 2200); };
  (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(done).catch(() => { const ta = document.createElement('textarea'); ta.value = text;
    document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); done(); } catch(e) {} ta.remove(); });
}
function factsText(s){
  const id = s.site_id, {c} = counts(id), near = nearestLikely(id), w = D.WIND[id], pv = BM.prevailing(w);
  const tpy = +String(s.tonnes_per_year || '').replace(/,/g, '');
  const recs = (D.RECS[id] || []).slice().sort((a, b) => a.properties.dist_m - b.properties.dist_m).slice(0, 8);
  const L = [];
  L.push(`${s.project}${s.application_refs ? ' – planning ref. ' + s.application_refs : ''}${s.appeal_refs ? ', appeal ' + s.appeal_refs : ''}`);
  L.push(`Status: ${s.status}${s.status_note ? ' (' + s.status_note + ')' : ''}.`);
  if (tpy) L.push(`Scale: about ${fmt(tpy)} tonnes of feedstock a year (≈${fmt(tpy / 365)} tonnes a day).`);
  L.push('');
  L.push(`Homes near the site boundary (likely homes, plus unconfirmed buildings in brackets):`);
  [250, 500, 1000].forEach(b => L.push(`  within ${b.toLocaleString('en-IE')} m: ${c[b][0]} (+${c[b][1]})`));
  if (near) L.push(`The nearest likely home is about ${fmt(near.dist_m)} m from the site boundary${near.plant_m != null ? ` and ${fmt(near.plant_m)} m from the nearest plant structure` : ''}.`);
  if (recs.length) { L.push(''); L.push('Schools, care, health and community places within 1 km:'); recs.forEach(f => { const q = f.properties; L.push(`  ${q.name}${q.name !== q.category ? ' (' + q.category + ')' : ''} – ${fmt(q.dist_m)} m`); }); }
  if (w) { L.push(''); L.push(`Wind: prevailing wind from the ${pv.from} (${pv.pct}% of hours, ERA5 2021–2025), so emissions most often drift ${pv.towards}. ${fmt(s.downwind_homes_1km)} homes within 1 km are downwind at least 10% of the time.`); }
  const nat = [];
  if (s.sac_name) nat.push(`${s.sac_name}${/SAC/.test(s.sac_name) ? '' : ' SAC'} ${s.sac_m === 0 ? 'adjoins the site' : fmt(s.sac_m) + ' m away'}`);
  if (s.spa_name) nat.push(`${s.spa_name}${/SPA/.test(s.spa_name) ? '' : ' SPA'} ${s.spa_m === 0 ? 'adjoins the site' : fmt(s.spa_m) + ' m away'}`);
  if (s.river_name) nat.push(`River ${s.river_name.replace(/^River\s+/i, '')} ${s.river_m === 0 ? 'on or beside the site' : fmt(s.river_m) + ' m away'}`);
  if (nat.length) { L.push(''); L.push('Protected sites and water: ' + nat.join('; ') + '.'); }
  if (s.intl && s.intl.rules) {
    L.push(''); L.push(`Separation distances used in other countries (measured from the ${s.intl.measured_from}${s.intl.provisional === false ? '' : ', provisional'}):`);
    D.RULES.filter(r => !r.info_only).forEach(r => { const v = s.intl.rules.find(x => x.id === r.id); if (!v) return;
      L.push(`  ${r.label}: ${(BM.VERDICT[v.verdict] || [''])[0]} – ${BM.verdictText(r, v, s)}`); });
    L.push('  These are other jurisdictions\' rules or suggestions, not Irish law and not proven safe distances.');
  }
  L.push(''); L.push(`Source: National Biogas Concern Group biomethane map, ${location.origin + location.pathname}#${id} (data updated ${dmy(D.meta.last_updated)}). Homes are estimated from building footprints; distances are approximate.`);
  return L.join('\n');
}
// small popover explaining a country's rule
function ruleInfo(r, anchor){
  document.getElementById('pop')?.remove(); if (!r) return;
  const p = document.createElement('div'); p.id = 'pop'; p.className = 'pop'; p.setAttribute('role', 'dialog');
  p.innerHTML = `<button class="x" aria-label="Close">×</button><b>${esc(r.country)}</b><div>${esc(r.label)}</div>
    <div class="h">Measured from</div><div>${esc(r.measured_from || '')}</div>
    <div class="h">When it applies</div><div>${esc(r.scope)}</div>
    ${r.info_only ? '<div class="h">On this map</div><div>Shown for comparison only – no verdict.</div>' : ''}
    <div class="lnk"><a href="${esc(r.page || BM.RESEARCH)}" target="_blank" rel="noopener">Read more in the NBCG comparison ↗</a>${r.source_url && r.source_url !== r.page ? ` · <a href="${esc(r.source_url)}" target="_blank" rel="noopener">Official source ↗</a>` : ''}</div>`;
  document.body.appendChild(p);
  const a = anchor.getBoundingClientRect(), W = 300; p.style.width = W + 'px';
  const pan = document.getElementById('panel').getBoundingClientRect(), inPanel = anchor.closest('#panel') && innerWidth > 760;
  let x = inPanel ? pan.right + 10 : a.right + 8; if (x + W > innerWidth - 8) x = Math.max(8, a.left - W - 8);
  p.style.left = x + 'px'; p.style.top = Math.max(8, Math.min(a.top - 10, innerHeight - p.offsetHeight - 8)) + 'px';
  p.querySelector('.x').onclick = () => p.remove();
  setTimeout(() => document.addEventListener('click', function f(e){ if (!p.contains(e.target)) { p.remove(); document.removeEventListener('click', f); } }), 0);
}
document.addEventListener('keydown', e => { if (e.key !== 'Escape') return;
  if (document.getElementById('pop')) return document.getElementById('pop').remove();
  if (measuring) return stopMeasure(); if (adding) return stopAdd(); if (!document.getElementById('detail').hidden) closeCard(); });

// ---- measure distances (e.g. from a home to the digester)
let measuring = false, mPts = [], mLine = null, mLbl = null;
const measCtl = L.control({position:'topleft'});
measCtl.onAdd = () => { const d = L.DomUtil.create('div', 'leaflet-bar addbtn measbtn');
  d.innerHTML = `<a href="#" role="button" title="Measure a distance on the map">Measure</a>`;
  L.DomEvent.disableClickPropagation(d); d.querySelector('a').onclick = e => { e.preventDefault();
    if (measuring) stopMeasure(); else if (mPts.length) { clearMeasure(); setMB('Measure'); } else startMeasure(); }; return d; };
measCtl.addTo(map);
const setMB = t => document.querySelector('.measbtn a').textContent = t;
function startMeasure(){ stopAdd(); clearMeasure(); measuring = true; document.body.classList.add('addmode'); setMB('Finish');
  toast('Click points on the map to measure. Press <b>Finish</b> or Esc when done.', 'measuretoast'); }
function stopMeasure(){ measuring = false; document.body.classList.remove('addmode'); document.getElementById('measuretoast')?.remove();
  if (mPts.length < 2) { clearMeasure(); setMB('Measure'); } else setMB('Clear'); }
function clearMeasure(){ mPts = []; mLine && map.removeLayer(mLine); mLbl && map.removeLayer(mLbl); mLine = mLbl = null; }
function toast(html, id){ document.getElementById(id)?.remove(); const t = document.createElement('div'); t.className = 'toast'; t.id = id; t.innerHTML = html; document.body.appendChild(t); return t; }
map.on('click', e => { if (!measuring) return;
  mPts.push(e.latlng); mLine ? mLine.setLatLngs(mPts) : (mLine = L.polyline(mPts, {color:'#ffeb3b', weight:3, dashArray:'6 4'}).addTo(map));
  let m = 0; for (let i = 1; i < mPts.length; i++) m += map.distance(mPts[i - 1], mPts[i]);
  mLbl && map.removeLayer(mLbl);
  if (mPts.length > 1) mLbl = L.tooltip({permanent:true, direction:'right', className:'ringlbl measlbl'}).setLatLng(e.latlng).setContent(m >= 1000 ? (m / 1000).toFixed(2) + ' km' : Math.round(m) + ' m').addTo(map);
});

// ---- about, welcome & tour
function aboutHTML(){ return `<div class="cardtop"><button class="link" onclick="closeCard()">← All sites</button></div><h2>About the map and data</h2>
  <p class="note"><b>Applications:</b> National Planning Applications dataset (Dept. of Housing, data.gov.ie), filtered for anaerobic digestion, biogas and biomethane applications lodged or decided since 1 Jan 2021, grouped into sites and checked by hand. Status notes add appeal and court outcomes. Tonnage comes from the planning description or the group's tracker (source shown). Refreshed daily.</p>
  <p class="note"><b>Deadlines</b> are indicative: submissions within 5 weeks of the council receiving an application; appeals within 4 weeks of the decision. Always confirm on the planning file.</p>
  <p class="note"><b>Homes:</b> Microsoft Global ML Building Footprints (ODbL) with OpenStreetMap where Microsoft has gaps; house-sized buildings are kept. <i>Likely</i> = residential planning record or OpenStreetMap house tag nearby; <i>Possible</i> = unconfirmed. Anyone can remove a building that isn't a home or add a missing one; changes apply for everyone at the next daily update and every change is logged, so mistakes or mischief can be reversed.</p>
  <p class="note"><b>Planning drawings & plant layouts:</b> site layout drawings from the public planning files, fitted to each application's red-line boundary (typically within 1–3 m) and shown as a see-through layer when zoomed in. "Plant layout (traced)" outlines the tanks and buildings read off those drawings; other countries' distances are measured from these where available.</p>
  <p class="note"><b>Schools, care & community:</b> Dept. of Education school lists, HSE hospitals, OpenStreetMap, plus additions from map users. <b>SAC/SPA:</b> NPWS. <b>Rivers:</b> EPA WFD river water bodies. <b>Wind:</b> ERA5 reanalysis 2021–2025 via Open-Meteo (CC BY 4.0).</p>
  <p class="note"><b>Other countries' rules:</b> from the <a href="${BM.RESEARCH}" target="_blank" rel="noopener">NBCG international comparison of AD siting and community protections ↗</a>. Policy information, not legal advice; no distance is a proven safe distance.</p>
  <p class="note">No names, addresses or Eircodes are held. Best used on a laptop or tablet.</p>
  <div class="btns"><button class="btn primary" onclick="startTour()">Take the tour</button></div>`; }
document.getElementById('about').onclick = e => { e.preventDefault();
  const d = document.getElementById('detail'); d.hidden = false; delete d.dataset.site; document.body.classList.add('card-open'); d.innerHTML = aboutHTML(); d.scrollTop = 0; };
document.getElementById('help').onclick = () => welcome(true);

function welcome(force){
  if (!force && store.get('intro_seen', false)) return;
  const small = innerWidth < 900;
  const m = document.createElement('div'); m.className = 'modal'; m.id = 'welcome';
  m.innerHTML = `<div class="mbox" role="dialog" aria-labelledby="wt">
    <h2 id="wt">Biomethane & AD planning applications in Ireland</h2>
    <p>Every anaerobic digestion and biomethane application since 2021, with the homes, schools and care settings around each one – built for communities taking part in the planning process.</p>
    <ul class="feat">
      <li><b>Find a site</b> and open its planning file, deadline and key facts.</li>
      <li><b>See the plant on the ground</b> – the applicant's own site layout drawing laid over the satellite image.</li>
      <li><b>Count who's affected</b> – homes, schools and care settings within 250 m, 500 m and 1 km, and who's downwind.</li>
      <li><b>Compare with other countries</b> – would it meet the separation distances used in France, Germany or Ontario?</li>
      <li><b>Act</b> – copy the key facts for a submission, print a one-page report or a door-to-door walking list.</li>
      <li><b>Fix the map</b> – add a missing home or school, or remove a building that isn't a home. No sign-up.</li>
    </ul>
    ${small ? '<p class="warnline">This map works best on a laptop or tablet – on a phone some panels are cramped.</p>' : '<p class="note">Works best on a laptop or tablet.</p>'}
    <div class="btns"><button class="btn primary" id="w-tour">Show me around (1 minute)</button><button class="btn" id="w-go">Go to the map</button></div></div>`;
  document.body.appendChild(m);
  const close = () => { store.set('intro_seen', true); m.remove(); };
  m.querySelector('#w-go').onclick = close; m.querySelector('#w-tour').onclick = () => { close(); startTour(); };
  m.onclick = e => { if (e.target === m) close(); };
}
const TOUR = [
  {sel:'.controls', title:'Every application', text:'Search by place, county, developer or planning reference. Tap the coloured chips to filter by status; "Open deadlines" shows sites where you can still make a submission or appeal.'},
  {sel:'#detail', title:'The site card', text:'Click any site on the map or in the list. The card opens with the planning file, the deadline, and how many homes are within 250 m, 500 m and 1 km.',
   before:() => { const s = D.SITES.find(x => deadlineOf(x) && D.DRAWINGS.some(d => d.site_id === x.site_id)) || D.SITES.find(x => D.DRAWINGS.some(d => d.site_id === x.site_id)) || D.SITES[0]; curTab = 'ov'; select(s.site_id); }},
  {sel:'#detail .tabs', title:'Four tabs', text:'<b>Nearby</b>: schools, care, protected sites and the wind. <b>Other countries</b>: would it meet their separation distances? <b>Take action</b>: copy the key facts for a submission, print a site report or a walking list for door-to-door.'},
  {sel:'#map', before:() => { const id = document.getElementById('detail').dataset.site, o = D.DRW_LYR.find(x => x.meta.site_id === id);
     if (o) { userOff.delete('Planning drawings (georeferenced)'); saveOff(); syncLayerTicks(); map.fitBounds(o.getBounds(), {maxZoom:17}); } }, title:'The plant on the ground', text:'Zoomed in, the applicant\'s own site layout drawing is laid over the satellite image, so you can see exactly where the tanks and buildings would go relative to homes.', pad:-60},
  {sel:'#lyr-t', title:'Layers', text:'Switch layers on and off here: planning drawings, homes, schools, wind roses, and rings showing the separation distances used in other countries. Tap the <b>i</b> beside a country to see what its rule is and how it\'s measured.'},
  {sel:'.addbtn:not(.measbtn)', title:'Fix the map', text:'Missing a home, school or crèche? Add it here. A dot that isn\'t a home? Click it and remove it. No sign-up – changes apply for everyone at the next daily update.'},
  {sel:'.measbtn', title:'Measure', text:'Click points to measure any distance – for example from your house to the digester on the planning drawing.'},
  {sel:'#help', title:'That\'s it', text:'Reopen this guide any time from <b>How to use</b>. "About the data" explains every source.'}];
let tourI = -1;
function startTour(){ document.getElementById('welcome')?.remove(); tourI = -1; nextStep(1); }
function endTour(){ document.querySelectorAll('.tour-hl,.tour-box').forEach(e => e.remove()); tourI = -1; }
function nextStep(dir){
  tourI += dir; if (tourI < 0) tourI = 0; if (tourI >= TOUR.length) return endTour();
  const st = TOUR[tourI]; if (st.before) st.before();
  setTimeout(() => {
    document.querySelectorAll('.tour-hl,.tour-box').forEach(e => e.remove());
    const el = document.querySelector(st.sel); if (!el) return nextStep(dir);
    const r = el.getBoundingClientRect(), pad = st.pad ?? 6;
    const hl = document.createElement('div'); hl.className = 'tour-hl';
    Object.assign(hl.style, {left:(r.left - pad) + 'px', top:(r.top - pad) + 'px', width:(r.width + 2 * pad) + 'px', height:(r.height + 2 * pad) + 'px'});
    const b = document.createElement('div'); b.className = 'tour-box'; b.setAttribute('role', 'dialog');
    b.innerHTML = `<div class="n">${tourI + 1} of ${TOUR.length}</div><b>${st.title}</b><p>${st.text}</p>
      <div class="btns"><button class="btn" data-t="skip">Close</button>${tourI ? '<button class="btn" data-t="back">Back</button>' : ''}<button class="btn primary" data-t="next">${tourI === TOUR.length - 1 ? 'Done' : 'Next'}</button></div>`;
    document.body.append(hl, b);
    const W = 320; b.style.width = W + 'px';
    let x = r.right + 14, y = r.top;
    if (x + W > innerWidth - 10) x = r.left - W - 14;
    if (x < 10) { x = Math.min(Math.max(10, r.left), innerWidth - W - 10); y = r.bottom + 14; }
    if (r.height > innerHeight * .6 && r.width > innerWidth * .4) { x = r.left + 30; y = r.top + 30; }
    b.style.left = x + 'px'; b.style.top = Math.max(10, Math.min(y, innerHeight - b.offsetHeight - 10)) + 'px';
    b.querySelector('[data-t=next]').onclick = () => nextStep(1); b.querySelector('[data-t=skip]').onclick = endTour;
    b.querySelector('[data-t=back]')?.addEventListener('click', () => nextStep(-1));
  }, st.before ? 450 : 50);
}
