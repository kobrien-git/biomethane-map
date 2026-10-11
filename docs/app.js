// Biomethane & AD planning applications map – main page logic. Helpers live in common.js (BM).
const {esc, fmt, col, dmy, daysTo, store} = BM;
const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

// ---- per-viewer settings (this browser only)
const marked = new Set(store.get('marked', []));            // homes this viewer marked "not a home"
const visited = store.get('visited', {});                   // door-to-door ticks: {home_id: 'visited'|'interested'|'nothome'}
const opt = Object.assign({homeSize:4, siteSize:8, names:'auto', hideMarked:false, rules:[]}, store.get('display', {}));
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
map.on('baselayerchange', e => store.set('base', e.name));

const lyr = {sites:L.layerGroup(), rings:L.layerGroup(), ringLabels:L.layerGroup(), homes:L.layerGroup(), points:L.layerGroup().addTo(map),
             recs:L.layerGroup(), wind:L.layerGroup(), layout:L.layerGroup(), intl:L.layerGroup()};
const overlays = {'Application sites':lyr.points, 'Site boundaries':lyr.sites, 'Distance rings (250 / 500 / 1,000 m)':lyr.rings,
  'Homes within 1 km':lyr.homes, 'Schools, care, health & community':lyr.recs, 'Wind roses':lyr.wind, 'Plant layout (traced)':lyr.layout};
const userOff = new Set(store.get('off', []));             // overlays the viewer switched off
L.control.layers(base, overlays, {collapsed:true}).addTo(map);
map.on('overlayremove', e => { if (e.name) { userOff.add(e.name); store.set('off', [...userOff]); } });
map.on('overlayadd', e => { if (e.name) { userOff.delete(e.name); store.set('off', [...userOff]); } });
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
    (marked.size ? `<div class="row"><span class="dot" style="background:transparent;border:1.5px dashed #777;box-shadow:none"></span>Marked not a home (your view)</div>` : '') +
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
      <label class="cb"><input type="checkbox" id="o-hide" ${opt.hideMarked ? 'checked' : ''}> Hide homes I've marked</label>
      <div class="hint">Set sizes, then use the camera button (top left) to save a PNG. Homes show from zoom 12.</div>
    </div>`;
  L.DomEvent.disableClickPropagation(d); L.DomEvent.disableScrollPropagation(d); return d;
};
disp.addTo(map);
const ctry = L.control({position:'topright'});
ctry.onAdd = () => {
  const d = L.DomUtil.create('div', 'disp ctry leaflet-control');
  d.innerHTML = `<button aria-expanded="false" id="ctry-t">Other countries' rules ▾</button><div class="body" id="ctry-b" hidden></div>`;
  L.DomEvent.disableClickPropagation(d); L.DomEvent.disableScrollPropagation(d); return d;
};
ctry.addTo(map);
const addCtl = L.control({position:'topleft'});
addCtl.onAdd = () => { const d = L.DomUtil.create('div', 'leaflet-bar addbtn');
  d.innerHTML = `<a href="#" title="Add a missing home, school, crèche or care home" role="button" style="width:auto;padding:0 8px;font:600 12px var(--sans);line-height:30px">+ Add missing</a>`;
  L.DomEvent.disableClickPropagation(d); d.querySelector('a').onclick = e => { e.preventDefault(); startAdd(); }; return d; };
addCtl.addTo(map);

function toggler(btnId, bodyId, label){
  document.getElementById(btnId).onclick = e => { const b = document.getElementById(bodyId), t = e.currentTarget;
    b.hidden = !b.hidden; t.setAttribute('aria-expanded', !b.hidden); t.textContent = label + (b.hidden ? ' ▾' : ' ▴'); };
}
toggler('disp-t', 'disp-b', 'Display'); toggler('ctry-t', 'ctry-b', "Other countries' rules");
document.getElementById('o-names').value = opt.names;
document.getElementById('o-home').oninput = e => { opt.homeSize = +e.target.value; saveOpt(); styleHomes(); };
document.getElementById('o-site').oninput = e => { opt.siteSize = +e.target.value; saveOpt(); D.SITES.forEach(s => s.marker.setRadius(opt.siteSize)); };
document.getElementById('o-names').onchange = e => { opt.names = e.target.value; saveOpt(); zoomRules(); };
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
  L.popup({maxWidth:260}).setLatLng(e.latlng).setContent(`<div class="hp"><b>Add something missing here?</b><br>
    ${near ? `Nearest site: ${esc(near.s.project)} (${fmt(near.d)} m)` : ''}
    <div class="row"><a class="hb" style="background:#2f6b4f;color:#fff;border-color:#2f6b4f" target="_blank" rel="noopener"
      href="${BM.reportAddUrl(e.latlng.lat, e.latlng.lng, near ? near.s.project : '')}">Open the short form ↗</a></div>
    <div class="note" style="margin-top:6px">It's added to the map at the next daily update.</div></div>`).openOn(map);
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
  // other countries' rings
  D.RULE_LYR = {};
  D.RULES.forEach(r => { D.RULE_LYR[r.id] = L.geoJSON({type:'FeatureCollection', features:D.raw.intlRings.features.filter(f => f.properties.rule === r.id)},
    {interactive:false, style: f => ({color:r.colour, weight:2.2, dashArray:f.properties.kind === 'sensitive' ? '2 5' : null, fill:false})}); });
  buildCountryPanel();
  // site markers
  D.SITES.forEach(s => { s.marker = L.circleMarker([s.lat, s.lon], {radius:opt.siteSize, color:'#fff', weight:2, fillColor:col(s.status), fillOpacity:1})
      .on('click', () => select(s.site_id)); s.marker.addTo(lyr.points); });
  updateRingLabels(); buildChips(); renderNew(); renderList(); zoomRules(); drawLegend();
  const h = location.hash.slice(1); if (h) select(h);
});

// ---- other countries panel
function buildCountryPanel(){
  const b = document.getElementById('ctry-b');
  b.innerHTML = D.RULES.map(r => `<label class="cb"><input type="checkbox" data-r="${r.id}" ${opt.rules.includes(r.id) ? 'checked' : ''}>
     <span><span class="swatch" style="background:${r.colour}"></span>${esc(r.short)}</span></label>`).join('') +
    `<div class="hint">Rings show each country's separation distance around every site (zoom in to see them). Dotted = distance to schools / care / settlements.
     Each site's card says whether it would meet each rule. Sources and caveats: <a href="${BM.RESEARCH}" target="_blank" rel="noopener">NBCG comparison ↗</a>. Not legal advice; no distance is a proven safe distance.</div>`;
  b.querySelectorAll('input[data-r]').forEach(i => i.onchange = () => {
    opt.rules = [...b.querySelectorAll('input[data-r]:checked')].map(x => x.dataset.r); saveOpt(); applyRules(); drawLegend();
    const cur = document.getElementById('detail').dataset.site; if (cur) select(cur, false); });
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
    ${m ? `<div class="ok">You marked this as not a home. It is left out of your counts and will be removed for everyone at the next daily update.</div>` : ''}
    <div class="row">
      ${!p.home_id ? '' : m ? `<button data-act="undo" data-id="${esc(p.home_id)}">Undo</button>`
          : `<button class="warn" data-act="report" data-id="${esc(p.home_id)}" data-site="${esc(p.project)}">Not a home? Report it</button>`}
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
    if (b.dataset.act === 'report') { marked.add(id); window.open(BM.reportRemoveUrl(id, b.dataset.site), '_blank', 'noopener'); } else marked.delete(id);
    store.set('marked', [...marked]); refreshAfterChange(); e.popup.setContent(homePopup(e.popup._source.feature)); map.fire('popupopen', {popup:e.popup}); });
  el.querySelectorAll('select[data-act=visit]').forEach(s => s.onchange = () => {
    if (s.value) visited[s.dataset.id] = s.value; else delete visited[s.dataset.id];
    store.set('visited', visited); styleHomes(); });
});
function refreshAfterChange(){ styleHomes(); updateRingLabels(); renderList(); const cur = document.getElementById('detail').dataset.site; if (cur) select(cur, false); }

function zoomRules(){
  const z = map.getZoom(), want = (g, name, on) => { on && !userOff.has(name) ? map.addLayer(g) : map.removeLayer(g); };
  want(lyr.sites, 'Site boundaries', z >= 11); want(lyr.rings, 'Distance rings (250 / 500 / 1,000 m)', z >= 12); want(lyr.ringLabels, 'Distance rings (250 / 500 / 1,000 m)', z >= 14);
  want(lyr.homes, 'Homes within 1 km', z >= 12); want(lyr.recs, 'Schools, care, health & community', z >= 12); want(lyr.wind, 'Wind roses', z >= 13 && z <= 15);
  want(lyr.layout, 'Plant layout (traced)', z >= 13);
  applyRules();
  const perm = opt.names === 'on' || (opt.names === 'auto' && z >= 9);
  D && D.SITES.forEach(s => { s.marker.unbindTooltip().bindTooltip(esc(s.project), {className:'lbl', direction:'right', offset:[8,0], permanent: perm && opt.names !== 'off'}); });
  if (D) drawLegend();
}
map.on('zoomend', zoomRules);

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

// ---- site detail card
function select(id, move = true){
  const s = D.SITES.find(x => x.site_id === id); if (!s) return;
  history.replaceState(null, '', '#' + id);
  const poly = D.POLYS[id];
  if (move) { if (poly) map.fitBounds(L.geoJSON(poly).getBounds().pad(1.2), {maxZoom:15}); else map.setView([s.lat, s.lon], 14); }
  const row = (k, v) => v ? `<dt>${k}</dt><dd>${v}</dd>` : '';
  const {c, mine} = counts(id);
  const [l250,p250] = c[250], [l500,p500] = c[500], [l1k,p1k] = c[1000];
  const gmaps = `https://www.google.com/maps/@${s.lat},${s.lon},800m/data=!3m1!1e3`;
  const tpy = +String(s.tonnes_per_year || '').replace(/,/g, '');
  const w = D.WIND[id], pv = BM.prevailing(w);
  const recs = (D.RECS[id] || []).slice().sort((a, b) => a.properties.dist_m - b.properties.dist_m);
  const dl = deadlineOf(s);
  const dlBox = dl ? `<div class="deadline open">${dl.kind === 'obs'
      ? `<b>Submissions to the council close ${dmy(dl.date)}</b> (${dl.days === 0 ? 'today' : dl.days + ' day' + (dl.days > 1 ? 's' : '') + ' left'}).<br>Anyone can make a written submission (€20 fee) within 5 weeks of the council receiving the application.`
      : `<b>Appeal to An Coimisiún Pleanála by ${dmy(dl.date)}</b> (${dl.days} day${dl.days > 1 ? 's' : ''} left).<br>Usually only people who made a submission to the council can appeal (4 weeks from the decision).`}
      <div class="note" style="margin-top:4px">Indicative date worked out from the national planning data – always confirm on the planning file.</div></div>`
    : s.status === 'Under appeal' ? `<div class="deadline closed">Under appeal. Observations on an appeal are due within 4 weeks of the appeal being lodged – check the case on <a href="https://www.pleanala.ie/en-ie/case-search" target="_blank" rel="noopener">pleanala.ie ↗</a>.</div>` : '';
  const intl = s.intl && s.intl.rules ? D.RULES.map(r => { const v = s.intl.rules.find(x => x.id === r.id); if (!v) return '';
      const [t, cl] = BM.VERDICT[v.verdict] || ['', '#666'];
      return `<tr><td><span class="swatch" style="background:${r.colour}"></span>${esc(r.short)}<div class="why">${esc(BM.verdictText(r, v, s))}</div></td><td class="v" style="color:${cl}">${t}</td></tr>`; }).join('') : '';
  const d = document.getElementById('detail'); d.hidden = false; d.dataset.site = id;
  d.innerHTML = `
    <h2>${esc(s.project)}</h2>
    <span class="pill" style="background:${col(s.status)}">${esc(s.status)}</span> ${s.is_new ? '<span class="badge new">New</span>' : ''}
    ${s.planning_link ? `<a class="btn primary plan" href="${esc(s.planning_link)}" target="_blank" rel="noopener">Open planning file${s.application_refs ? ' · ' + esc(String(s.application_refs).split(',')[0]) : ''} ↗</a>` : ''}
    ${dlBox}
    <dl class="kv">
      ${row('Status', esc(s.status_note))}
      ${row('County', esc(s.county))}
      ${row('Type', esc(s.type))}
      ${row('Developer', esc(s.developer))}
      ${row('Planning refs', esc(s.application_refs))}
      ${row('Appeal refs', esc(s.appeal_refs))}
      ${row('Lodged', s.latest_lodged && s.latest_lodged !== 'None' ? dmy(s.latest_lodged) : '')}
      ${row('Decision', s.latest_decision && s.latest_decision !== 'None' ? dmy(s.latest_decision) : '')}
      ${row('Scale', tpy ? `${fmt(tpy)} tonnes / year (≈${fmt(tpy / 365)} t/day)<br><span class="note">Source: ${esc(s.tonnes_source || 'planning data')}</span>` : '<span class="note">Tonnage not confirmed yet</span>')}
      ${row('Site area', s.site_area_ha ? s.site_area_ha + ' ha' : '')}
    </dl>
    <table class="counts" aria-label="Homes within distance of site boundary">
      <thead><tr><th>Within</th><th>Likely</th><th>Possible</th><th>Total</th></tr></thead>
      <tbody>
        <tr><td>250 m</td><td>${fmt(l250)}</td><td>${fmt(p250)}</td><td>${fmt(l250+p250)}</td></tr>
        <tr><td>500 m</td><td>${fmt(l500)}</td><td>${fmt(p500)}</td><td>${fmt(l500+p500)}</td></tr>
        <tr><td>1,000 m</td><td>${fmt(l1k)}</td><td>${fmt(p1k)}</td><td>${fmt(l1k+p1k)}</td></tr>
      </tbody>
    </table>
    ${mine ? `<div class="mine">Excludes ${mine} building${mine > 1 ? 's' : ''} you marked as not a home.</div>` : ''}
    <div class="note">Distances from the site boundary. ${s.approx_location ? '<b>Site boundary not published – location approximate.</b> ' : ''}Homes are estimated from building footprints. Click a dot to report one that isn't a home, or use <b>+ Add missing</b> on the map.</div>

    ${w ? `<div class="sect"><h3>Wind</h3><div class="windrow">${BM.rose(w, 118, {grid:css('--muted'), text:css('--fg')})}
      <div style="font-size:12.5px">Prevailing wind from the <b>${pv.from}</b> (${pv.pct}% of hours), so the plant's air most often drifts <b>${pv.towards}</b>.<br>
      <b>${fmt(s.downwind_homes_1km)}</b> mapped homes within 1 km are downwind at least 10% of the time.
      <div class="note" style="margin-top:4px">Hourly 10 m wind 2021–2025, ERA5 reanalysis via Open-Meteo. Calm ${w.calm_pct}% of hours.</div></div></div></div>` : ''}

    <div class="sect"><h3>Schools, care, health & community within 1 km</h3>
      ${recs.length ? `<ul class="rlist">${recs.map(f => { const p = f.properties, [cc, l] = BM.RECEPTORS[p.category] || BM.RECEPTORS['Other sensitive'];
        return `<li><span class="ric" style="background:${cc}">${l}</span>${esc(p.name)} <span class="note">${esc(p.category)}</span><span class="d">${fmt(p.dist_m)} m</span></li>`; }).join('')}</ul>`
        : '<div class="note">None found in Dept. of Education, HSE or OpenStreetMap data. Know of one? Use <b>+ Add missing</b>.</div>'}
      <dl class="kv" style="margin-top:8px">
        ${row('Nearest SAC', s.sac_name ? `${esc(s.sac_name)} – ${s.sac_m === 0 ? '<b>site touches it</b>' : fmt(s.sac_m) + ' m'}` : 'None within 15 km')}
        ${row('Nearest SPA', s.spa_name ? `${esc(s.spa_name)} – ${s.spa_m === 0 ? '<b>site touches it</b>' : fmt(s.spa_m) + ' m'}` : 'None within 15 km')}
        ${row('Nearest river', s.river_name ? `${esc(s.river_name)} – ${s.river_m === 0 ? '<b>on or beside the site</b>' : fmt(s.river_m) + ' m'}` : 'None mapped within 1 km')}
      </dl></div>

    ${intl ? `<div class="sect"><h3>Would it meet other countries' separation distances?</h3>
      <table class="intl">${intl}</table>
      <div class="note" style="margin-top:6px">Measured from the ${esc(s.intl.measured_from || 'site boundary')}${s.intl.measured_from === 'site boundary' ? ' – the plant itself may be further away, so treat "Would not meet" as a prompt to check the layout' : ''}. Scope and measuring rules differ by country; not legal advice and not a safe distance.
      <a href="${BM.RESEARCH}" target="_blank" rel="noopener">Sources ↗</a> · Show rings with <b>Other countries' rules</b> on the map.</div></div>` : ''}

    <div class="sect"><h3>Door to door</h3>
      <div class="note">Tools for visiting nearby homes. Visit ticks stay in this browser only; nothing about residents is stored.</div>
      <div class="btns">
        <a class="btn primary" href="print.html?site=${id}&mode=canvass" target="_blank" rel="noopener">Walking list & map (print)</a>
        <button class="btn" id="gpx">Download route (GPX)</button>
        <a class="btn" href="print.html?site=${id}&mode=report" target="_blank" rel="noopener">One-page site report (PDF)</a>
      </div></div>

    <div class="btns" style="margin-top:14px">
      <a class="btn" href="${gmaps}" target="_blank" rel="noopener">Google satellite ↗</a>
      <button class="btn" id="dl">Download homes (CSV)</button>
      <button class="btn" id="close">Close</button>
    </div>`;
  document.getElementById('close').onclick = () => { d.hidden = true; delete d.dataset.site; history.replaceState(null,'',location.pathname); };
  const live = () => (D.HOMES[id] || []).filter(f => !marked.has(f.properties.home_id));
  document.getElementById('dl').onclick = () => {
    const rows = [['site','home_id','tier','distance_from_boundary_m','downwind_pct','latitude','longitude']].concat(live().map(f =>
      [s.project, f.properties.home_id, f.properties.tier, f.properties.dist_m, f.properties.downwind_pct ?? '', f.geometry.coordinates[1].toFixed(5), f.geometry.coordinates[0].toFixed(5)]));
    BM.download(s.project.replace(/[^\w]+/g,'_') + '_homes.csv', rows.map(r => r.map(v => `"${String(v ?? '').replace(/"/g,'""')}"`).join(',')).join('\n'), 'text/csv'); };
  document.getElementById('gpx').onclick = () => BM.download(s.project.replace(/[^\w]+/g,'_') + '_homes.gpx', BM.gpx(s.project, BM.route(live())), 'application/gpx+xml');
  if (move) document.getElementById('panel').scrollTop = 0;
}

document.getElementById('about').onclick = e => { e.preventDefault();
  const d = document.getElementById('detail'); d.hidden = false; delete d.dataset.site;
  d.innerHTML = `<h2>About the data</h2>
  <p class="note"><b>Applications:</b> National Planning Applications dataset (Dept. of Housing, data.gov.ie), filtered for anaerobic digestion, biogas and biomethane applications lodged or decided since 1 Jan 2021, grouped into sites and checked by hand. Status notes add appeal and court outcomes. Tonnage comes from the planning description or the group's tracker (source shown). Refreshed daily.</p>
  <p class="note"><b>Deadlines</b> are indicative: submissions within 5 weeks of the council receiving an application; appeals within 4 weeks of the decision. Always confirm on the planning file.</p>
  <p class="note"><b>Homes:</b> Microsoft Global ML Building Footprints (ODbL) with OpenStreetMap where Microsoft has gaps; house-sized buildings are kept. <i>Likely</i> = residential planning record or OpenStreetMap house tag nearby; <i>Possible</i> = unconfirmed. Map users can report buildings that aren't homes and add missing homes; these apply at the next daily update (the maintainer can reverse any).</p>
  <p class="note"><b>Schools, care & community:</b> Dept. of Education school lists, HSE hospitals, OpenStreetMap, plus additions from map users. <b>SAC/SPA:</b> NPWS. <b>Rivers:</b> EPA WFD river water bodies. <b>Wind:</b> ERA5 reanalysis 2021–2025 via Open-Meteo (CC BY 4.0).</p>
  <p class="note"><b>Other countries' rules:</b> from the NBCG international comparison (<a href="${BM.RESEARCH}" target="_blank" rel="noopener">sources</a>). Policy information, not legal advice; no distance is a proven safe distance.</p>
  <p class="note">No names, addresses or Eircodes are held.</p>
  <div class="btns"><button class="btn" onclick="this.closest('#detail').hidden=true">Close</button></div>`;
};
