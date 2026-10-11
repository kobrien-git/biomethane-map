// Shared helpers for the map (index.html) and the printable site pages (print.html).
const BM = (() => {
  const STATUS = {
    'Under appeal':'#c8361f','Pending decision':'#e08a1e','Granted':'#6a3d9a','Refused':'#2e8b57',
    'No decision recorded':'#8a8f8c','Other':'#b9bdb9','Pre-application':'#1f78b4'};
  const RECEPTORS = {   // category -> [colour, letter, plural label]
    'School':['#d81b60','S','Schools'], 'Childcare':['#f06292','C','Childcare / crèches'], 'Care home':['#8e24aa','N','Nursing & care homes'],
    'Health':['#00897b','H','Health'], 'Place of worship':['#5d4037','W','Places of worship'], 'Community':['#3949ab','CC','Community centres'],
    'Sport & play':['#43a047','P','Sport & play'], 'Other sensitive':['#757575','!','Other sensitive places']};
  const SENSITIVE = ['School','Childcare','Care home','Health'];
  const SECT = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
  const FORM_REMOVE = 'https://docs.google.com/forms/d/e/1FAIpQLSeQ6yt1p3A4eeOU-7DVH03bn1wXRUkQcujYXRvA4WqSP3q8pA/viewform';
  const FORM_ADD = 'https://docs.google.com/forms/d/e/1FAIpQLSc2xuCaQHZcKnEpbf5iZCkTC0taxOvpwi9WLYt9W8IyqXLLFA/viewform';
  const RESEARCH = 'https://kobrien-git.github.io/nbcg-ad-comparison/';

  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const fmt = n => (n==null||n===''||isNaN(n)) ? '–' : Math.round(n).toLocaleString('en-IE');
  const col = s => STATUS[s] || STATUS.Other;
  const today = () => { const d = new Date(); d.setHours(0,0,0,0); return d; };
  const dmy = iso => iso ? new Date(iso + 'T00:00:00').toLocaleDateString('en-IE', {day:'numeric', month:'short', year:'numeric'}) : '';
  const daysTo = iso => iso ? Math.round((new Date(iso + 'T00:00:00') - today()) / 864e5) : null;

  const reportRemoveUrl = (id, site) => `${FORM_REMOVE}?usp=pp_url&entry.667896400=${encodeURIComponent(id)}&entry.96613515=${encodeURIComponent(site)}`;
  // Silent submissions straight into the Google Forms (no approval step; the daily update applies them for everyone).
  const post = (form, fields) => fetch(form.replace('/viewform', '/formResponse'), {method:'POST', mode:'no-cors', body:new URLSearchParams(fields)}).then(() => true).catch(() => false);
  const REMOVE_REASONS = ['Farm or agricultural building', 'Commercial, industrial or community building', 'Garage, shed or outbuilding of a house already counted', 'Derelict or demolished', 'No building here'];
  const ADD_TYPES = ['Home (lived in)', 'School', 'Creche or childcare', 'Nursing or care home', 'Health centre or hospital', 'Other sensitive place (sports ground, church, community hall)'];
  const removeHome = (id, site, reason, undo) => post(FORM_REMOVE, {'entry.667896400':id, 'entry.96613515':undo ? 'UNDO' : site,
    'entry.1232506106':undo ? REMOVE_REASONS[0] : reason, 'entry.1240421585':undo ? 'Undo: this is a home' : ''});
  const addPlace = (lat, lon, site, type, name) => post(FORM_ADD, {'entry.751238912':lat.toFixed(5) + ', ' + lon.toFixed(5), 'entry.1784884230':site || '',
    'entry.1469452492':type, 'entry.1825738653':name || ''});
  const reportAddUrl = (lat, lon, site) => `${FORM_ADD}?usp=pp_url&entry.751238912=${encodeURIComponent(lat.toFixed(5) + ', ' + lon.toFixed(5))}&entry.1784884230=${encodeURIComponent(site || '')}`;
  const directions = (lat, lon) => `https://www.google.com/maps/dir/?api=1&destination=${lat.toFixed(6)},${lon.toFixed(6)}`;

  const store = {
    get(k, d){ try { const v = localStorage.getItem('bm_' + k); return v == null ? d : JSON.parse(v); } catch(e){ return d; } },
    set(k, v){ try { localStorage.setItem('bm_' + k, JSON.stringify(v)); } catch(e){} }
  };

  async function load(){
    const get = (n, d) => fetch('data/' + n, {cache:'no-cache'}).then(r => r.ok ? r.json() : d).catch(() => d);
    const [pts, polys, rings, homes, recs, intlRings, rules, wind, lay, meta, drw] = await Promise.all([
      get('site_points.geojson'), get('sites.geojson'), get('rings.geojson'), get('homes.geojson'),
      get('receptors.geojson', {features:[]}), get('intl_rings.geojson', {features:[]}), get('intl_rules.json', {rules:[]}),
      get('wind.json', {}), get('layouts.geojson', {features:[]}), get('meta.json', {}), get('drawings.json', {drawings:[]})]);
    const by = (fc) => { const o = {}; fc.features.forEach(f => (o[f.properties.site_id] ||= []).push(f)); return o; };
    const SITES = pts.features.map(f => {
      const p = {...f.properties, lat:f.geometry.coordinates[1], lon:f.geometry.coordinates[0]};
      try { p.intl = typeof p.intl === 'string' ? JSON.parse(p.intl) : (p.intl || {}); } catch(e) { p.intl = {}; }
      return p; });
    const POLYS = {}; polys.features.forEach(f => POLYS[f.properties.site_id] = f);
    return {SITES, POLYS, RINGS:by(rings), HOMES:by(homes), RECS:by(recs), INTL:by(intlRings), RULES:rules.rules || [], RULES_META:rules,
            WIND:wind, LAYOUT:by(lay), DRAWINGS:drw.drawings || [], meta, raw:{polys, rings, homes, recs, intlRings, lay}};
  }

  // ---- wind rose (SVG). Petals point to where the wind comes FROM.
  function rose(w, size = 120, opts = {}){
    if (!w || !w.freq_pct) return '';
    const f = w.freq_pct, max = Math.max(...f), c = size / 2, R = c - 14;
    const pet = f.map((v, i) => {
      const a0 = (i * 22.5 - 8) * Math.PI / 180, a1 = (i * 22.5 + 8) * Math.PI / 180, r = Math.max(2, R * v / max);
      const p = a => `${(c + r * Math.sin(a)).toFixed(1)},${(c - r * Math.cos(a)).toFixed(1)}`;
      return `<path d="M${c},${c} L${p(a0)} A${r.toFixed(1)},${r.toFixed(1)} 0 0,1 ${p(a1)} Z" fill="${opts.fill || '#1f6fb2'}" fill-opacity=".8" stroke="#fff" stroke-width=".6"><title>From ${SECT[i]}: ${v}% of hours</title></path>`;
    }).join('');
    const ring = [.5, 1].map(k => `<circle cx="${c}" cy="${c}" r="${(R * k).toFixed(1)}" fill="none" stroke="${opts.grid || '#9aa'}" stroke-width=".6" stroke-dasharray="2 2"/>`).join('');
    const lab = ['N','E','S','W'].map((t, i) => { const a = i * Math.PI / 2; return `<text x="${(c + (R + 8) * Math.sin(a)).toFixed(1)}" y="${(c - (R + 8) * Math.cos(a) + 3.5).toFixed(1)}" font-size="10" font-weight="600" text-anchor="middle" fill="${opts.text || '#333'}">${t}</text>`; }).join('');
    return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="Wind rose">${opts.bg ? `<circle cx="${c}" cy="${c}" r="${c - 1}" fill="${opts.bg}"/>` : ''}${ring}${pet}${lab}</svg>`;
  }
  function prevailing(w){
    if (!w) return null; const f = w.freq_pct;
    let k = 0, best = -1; for (let i = 0; i < 16; i++) { const s = f[(i + 15) % 16] + f[i] + f[(i + 1) % 16]; if (s > best) { best = s; k = i; } }
    return {from: SECT[k], pct: Math.round(best), towards: SECT[(k + 8) % 16]};
  }

  // ---- other countries' separation distances
  const VERDICT = {
    fail: ['Would not meet', '#b3261e'], pass: ['Would meet', '#2e7d32'], below_threshold: ['Rule would not apply', '#6b7280'],
    unknown_tonnage: ['Depends on tonnage', '#a16207'], info: ['For comparison', '#6b7280']};
  function verdictText(rule, v, s){
    if (!v) return '';
    const n = v.homes, ns = v.sensitive, what = [];
    if (n) what.push(`${n} home${n > 1 ? 's' : ''}${v.likely_homes != null && v.likely_homes !== n ? ` (${v.likely_homes} likely)` : ''} within ${v.distance_m} m`);
    if (ns) what.push(`${ns} school/care/health site${ns > 1 ? 's' : ''} within ${rule.sensitive_m} m`);
    if (v.verdict === 'fail') return what.join('; ');
    if (v.verdict === 'pass') return `No mapped homes within ${v.distance_m} m${rule.sensitive_m ? ` or sensitive sites within ${rule.sensitive_m} m` : ''}`;
    if (v.verdict === 'below_threshold') return `Plant (~${fmt(s.intl.tonnes_per_day)} t/day) is below the ${rule.applies_tpd_min} t/day threshold. ${what.length ? '(' + what.join('; ') + ')' : ''}`;
    if (v.verdict === 'unknown_tonnage') return `Applies at ${rule.applies_tpd_min} t/day or more; tonnage not yet confirmed. ${what.length ? what.join('; ') : 'No mapped homes within ' + v.distance_m + ' m'}`;
    return what.length ? what.join('; ') : `No mapped homes within ${v.distance_m} m`;
  }

  // ---- canvass route: nearest-neighbour ordering starting at the home nearest the site
  function route(homes){
    const pts = homes.map(f => ({f, lat:f.geometry.coordinates[1], lon:f.geometry.coordinates[0]}));
    if (!pts.length) return [];
    const d = (a, b) => { const x = (b.lon - a.lon) * Math.cos(a.lat * Math.PI / 180), y = b.lat - a.lat; return Math.hypot(x, y); };
    pts.sort((a, b) => a.f.properties.dist_m - b.f.properties.dist_m);
    const out = [pts.shift()];
    while (pts.length) { const last = out[out.length - 1]; let bi = 0, bd = 1e9; pts.forEach((p, i) => { const dd = d(last, p); if (dd < bd) { bd = dd; bi = i; } }); out.push(pts.splice(bi, 1)[0]); }
    return out.map(p => p.f);
  }
  function gpx(name, homes){
    const wpts = homes.map((f, i) => `<wpt lat="${f.geometry.coordinates[1].toFixed(6)}" lon="${f.geometry.coordinates[0].toFixed(6)}"><name>${i + 1}</name><desc>${esc(f.properties.tier)}, ${fmt(f.properties.dist_m)} m from site</desc></wpt>`).join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="biomethane-map" xmlns="http://www.topografix.com/GPX/1/1">\n<metadata><name>${esc(name)} – homes within 1 km</name></metadata>\n${wpts}\n</gpx>`;
  }
  function download(name, text, type){ const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], {type})); a.download = name; document.body.appendChild(a); a.click(); a.remove(); }

  return {STATUS, RECEPTORS, SENSITIVE, SECT, RESEARCH, REMOVE_REASONS, ADD_TYPES, removeHome, addPlace, esc, fmt, col, dmy, daysTo, reportRemoveUrl, reportAddUrl, directions, store, load, rose, prevailing,
          VERDICT, verdictText, route, gpx, download};
})();
