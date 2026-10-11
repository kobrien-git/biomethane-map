"""
Extra layers for the biomethane map, called from build.py:

  feed()          "not a home" removals and "missing home / sensitive building" additions from the
                  published Google Sheet (config/settings.json) plus config/excluded_homes.csv
  deadlines()     submission / appeal deadlines (indicative - always check with the council)
  track_new()     remembers when each application was first seen -> "New this week" + alerts
  receptors()     schools, childcare, care homes, health, worship, community & sport near each site
  natura_water()  nearest SAC / SPA and river water body
  wind()          wind rose per site (ERA5 via Open-Meteo, cached) + downwind share for each home
  layouts()       traced plant structures (config/layouts/*.geojson) -> "plant footprint"
  intl()          separation distances used elsewhere (config/intl_rules.json) -> rings + verdicts
"""
import datetime, io, json, math, os, re, time, urllib.parse
import geopandas as gpd
import numpy as np
import pandas as pd
from shapely.geometry import Point, shape
from shapely.ops import unary_union

import build as B

STATE = os.path.join(B.ROOT, 'build', 'state')
os.makedirs(STATE, exist_ok=True)
NO_RE = r'^(N|NO|FALSE|0|REJECT)'


# ------------------------------------------------------------------ helpers
def _json(path, default):
    try: return json.load(open(path))
    except Exception: return default


def _arcgis(url, env, fields='*'):
    """Query an ArcGIS FeatureServer layer inside an ITM envelope. Returns GeoDataFrame (EPSG:2157) or empty."""
    minx, miny, maxx, maxy = env
    try:
        d = json.loads(B.get(url + '/query', {'where': '1=1', 'geometry': f'{minx},{miny},{maxx},{maxy}', 'geometryType': 'esriGeometryEnvelope',
                                              'inSR': 2157, 'spatialRel': 'esriSpatialRelIntersects', 'outFields': fields, 'outSR': 2157,
                                              'f': 'geojson', 'resultRecordCount': 2000}, tries=2, timeout=60))
        if not d.get('features'): return gpd.GeoDataFrame(geometry=[], crs=2157)
        return gpd.GeoDataFrame.from_features(d['features'], crs=2157)
    except Exception as e:
        print('  arcgis failed', url.split('/services/')[-1][:60], e, flush=True)
        return gpd.GeoDataFrame(geometry=[], crs=2157)


def _latlon(txt):
    try:
        a, b = [float(x) for x in str(txt).replace(';', ',').split(',')[:2]]
        if abs(a) > 40 and abs(b) < 20: return a, b      # lat, lon
        if abs(b) > 40 and abs(a) < 20: return b, a      # lon, lat given the wrong way round
    except Exception: pass
    return None


# ------------------------------------------------------------------ 1. community feed
def feed():
    """Returns (removed_home_ids:set, additions:GeoDataFrame[kind, category, name, site, geometry])."""
    removed, adds = set(), []
    f = os.path.join(B.CFG, 'excluded_homes.csv')
    if os.path.exists(f):
        removed |= set(pd.read_csv(f, dtype=str).fillna('').home_id.str.strip())
    url = B.SETTINGS.get('report_sheet_csv')
    if url:
        try:
            raw = B.get(url)
            if raw.lstrip()[:1] == b'<': raise ValueError('sheet not published as CSV yet (got a web page)')
            df = pd.read_csv(io.BytesIO(raw), dtype=str).fillna('')
            df.columns = [c.strip().lower() for c in df.columns]
            if 'action' in df.columns:                       # unified "for_map" tab
                # rows arrive in submission order; a later row with site "UNDO" restores the home
                for _, r in df[df.action.str.lower() == 'remove'].iterrows():
                    hid = r.home_id.strip()
                    if str(r.get('site', '')).strip().upper() == 'UNDO': removed.discard(hid)
                    else: removed.add(hid)
                for _, r in df[df.action.str.lower() == 'add'].iterrows():
                    ll = _latlon(r.get('lat_lon', ''))
                    if ll: adds.append({'category': r.get('type', ''), 'name': r.get('name', ''), 'site': r.get('site', ''),
                                        'geometry': Point(ll[1], ll[0])})
            elif 'home id' in df.columns:                    # older single-purpose tab
                ok = ~df.get('approved', pd.Series('', index=df.index)).str.upper().str.match(NO_RE)
                removed |= set(df.loc[ok, 'home id'].str.strip())
            print(f'community feed: {len(removed)} removals, {len(adds)} additions', flush=True)
        except Exception as e:
            print('community feed unavailable:', e, flush=True)
    removed.discard('')
    add = gpd.GeoDataFrame(adds, geometry='geometry', crs=4326).to_crs(2157) if adds else gpd.GeoDataFrame(columns=['category', 'name', 'site', 'geometry'], geometry='geometry', crs=2157)
    return removed, add


# ------------------------------------------------------------------ 2. deadlines
def deadlines(sites):
    """Indicative deadlines. Observations on a planning application: within 5 weeks of the council receiving it.
    Appeal to An Coimisiún Pleanála: within 4 weeks of the council's decision."""
    obs, app = [], []
    for _, s in sites.iterrows():
        rec = pd.to_datetime(s.latest_lodged, errors='coerce'); dec = pd.to_datetime(s.latest_decision, errors='coerce')
        o = (rec + pd.Timedelta(days=35)).date().isoformat() if pd.notna(rec) and pd.isna(dec) and s.status == 'Pending decision' else ''
        a = (dec + pd.Timedelta(days=28)).date().isoformat() if pd.notna(dec) and s.status in ('Granted', 'Refused', 'Under appeal', 'Other') else ''
        obs.append(o); app.append(a)
    sites['obs_deadline'] = obs; sites['appeal_deadline'] = app
    return sites


# ------------------------------------------------------------------ 3. new applications
def track_new(sites):
    fn = os.path.join(STATE, 'first_seen.json')
    seen = _json(fn, {})
    first_run = not seen
    new = []
    for _, s in sites.iterrows():
        for ref in [r.strip() for r in str(s.application_refs).split(',') if r.strip()] or [s.site_id]:
            key = f'{s.planning_authority}|{ref}'
            if key not in seen:
                seen[key] = B.TODAY.isoformat()
                if not first_run: new.append({'site_id': s.site_id, 'project': s.project, 'ref': ref, 'authority': s.planning_authority,
                                              'lodged': s.latest_lodged, 'status': s.status, 'link': s.planning_link})
    json.dump(seen, open(fn, 'w'), indent=0, sort_keys=True)
    # "new" = an application first seen in the last 14 days, or lodged in the last 14 days
    def is_new(s):
        keys = [f'{s.planning_authority}|{r.strip()}' for r in str(s.application_refs).split(',') if r.strip()]
        fs = [seen.get(k) for k in keys if seen.get(k)]
        lod = pd.to_datetime(s.latest_lodged, errors='coerce')
        recent_seen = any((B.TODAY - datetime.date.fromisoformat(d)).days <= 14 for d in fs) and not first_run and fs and min(fs) != min(seen.values())
        recent_lodged = pd.notna(lod) and (B.TODAY - lod.date()).days <= 14
        return bool(recent_seen or recent_lodged)
    sites['is_new'] = [is_new(s) for _, s in sites.iterrows()]
    if new:
        lines = [f"- **{n['project']}** – {n['authority']} {n['ref']} (lodged {n['lodged']}, {n['status']}) {n['link']}" for n in new]
        open(os.path.join(STATE, 'alert.md'), 'w').write('New AD / biogas planning activity found by the daily refresh:\n\n' + '\n'.join(lines) +
                                                         '\n\nMap: https://kobrien-git.github.io/biomethane-map/\n')
    elif os.path.exists(os.path.join(STATE, 'alert.md')):
        os.remove(os.path.join(STATE, 'alert.md'))
    print('new applications this run:', len(new), flush=True)
    return sites


# ------------------------------------------------------------------ 4. sensitive receptors
SCHOOLS_PRI = 'https://services6.arcgis.com/MmUrOQU5v1he9gfS/arcgis/rest/services/MainstreamPrimarySchoolsIreland/FeatureServer/0'
SCHOOLS_POST = 'https://services6.arcgis.com/MmUrOQU5v1he9gfS/arcgis/rest/services/Post_Primary_Schools_Ireland/FeatureServer/6'
HOSPITALS = 'https://services.arcgis.com/NzlPQPKn5QF9v2US/ArcGIS/rest/services/Hospital/FeatureServer/0'
OSM_CACHE = os.path.join(B.CFG, 'osm_receptors.json')

def _osm_category(t):
    a, sf, hc, le, bu = (t.get(k, '') for k in ('amenity', 'social_facility', 'healthcare', 'leisure', 'building'))
    if a in ('school', 'college', 'university') or bu == 'school': return 'School'
    if a in ('kindergarten', 'childcare') or bu == 'kindergarten': return 'Childcare'
    if a == 'nursing_home' or sf in ('nursing_home', 'assisted_living', 'group_home'): return 'Care home'
    if a in ('hospital', 'clinic', 'doctors') or hc in ('hospital', 'clinic', 'doctor', 'centre') or bu == 'hospital': return 'Health'
    if a == 'social_facility': return 'Care home'
    if a == 'place_of_worship' or bu in ('church', 'chapel'): return 'Place of worship'
    if a == 'community_centre': return 'Community'
    if le in ('pitch', 'sports_centre', 'playground'): return 'Sport & play'
    return None


def _overpass(bbox):
    w, s, e, n = bbox
    q = f'''[out:json][timeout:60];(
 nwr["amenity"~"^(school|kindergarten|childcare|college|university|hospital|clinic|doctors|nursing_home|social_facility|place_of_worship|community_centre)$"]({s},{w},{n},{e});
 nwr["social_facility"~"nursing_home|assisted_living|group_home"]({s},{w},{n},{e});
 nwr["healthcare"~"^(hospital|clinic|doctor|centre)$"]({s},{w},{n},{e});
 nwr["leisure"~"^(pitch|sports_centre|playground)$"]["name"]({s},{w},{n},{e});
 nwr["building"~"^(school|kindergarten|hospital|church|chapel)$"]({s},{w},{n},{e}););out center tags;'''
    d = json.loads(B.get('https://overpass-api.de/api/interpreter', data='data=' + q, tries=1, timeout=45))
    out = []
    for el in d['elements']:
        c = (el.get('lat'), el.get('lon')) if 'lat' in el else (el.get('center', {}).get('lat'), el.get('center', {}).get('lon'))
        if c[0] is None: continue
        out.append({'id': f"{el['type'][0]}{el['id']}", 'lat': c[0], 'lon': c[1], 'tags': {k: v for k, v in el.get('tags', {}).items()
                    if k in ('amenity', 'social_facility', 'healthcare', 'leisure', 'building', 'name', 'religion', 'operator')}})
    return out


def receptors(sites, additions, refresh_osm=True):
    cache = _json(OSM_CACHE, {})
    rows = []
    refresh_osm = refresh_osm and os.environ.get('BM_OFFLINE') != '1'
    for _, s in sites.iterrows():
        zone = s.geometry.buffer(1000); env = zone.bounds
        bbox = gpd.GeoSeries([s.geometry.buffer(1500)], crs=2157).to_crs(4326).total_bounds.round(5).tolist()
        # official schools & hospitals
        for url, cat, namef in [(SCHOOLS_PRI, 'School', 'Official_Name'), (SCHOOLS_POST, 'School', None), (HOSPITALS, 'Health', None)]:
            g = _arcgis(url, env)
            if g.empty: continue
            nm = namef if namef in g.columns else next((c for c in g.columns if c.lower() in ('official_name', 'officialname', 'name', 'school_name', 'hospital', 'hospital_name')), None)
            for _, r in g.iterrows():
                rows.append({'site_id': s.site_id, 'category': cat, 'name': str(r.get(nm, '') or '').title() if nm else '', 'source': 'Dept. of Education' if cat == 'School' else 'HSE / Dept. of Housing',
                             'geometry': r.geometry if r.geometry.geom_type == 'Point' else r.geometry.representative_point()})
        # OpenStreetMap (cached; refreshed when reachable and older than 30 days)
        ent = cache.get(s.site_id)
        stale = not ent or (B.TODAY - datetime.date.fromisoformat(ent.get('fetched', '2000-01-01'))).days > 30
        if refresh_osm and stale:
            try:
                cache[s.site_id] = {'fetched': B.TODAY.isoformat(), 'elements': _overpass(bbox)}; time.sleep(1)
            except Exception as e:
                print('  overpass unavailable - will retry next run:', e, flush=True); refresh_osm = False
        for el in (cache.get(s.site_id) or {}).get('elements', []):
            cat = _osm_category(el['tags'])
            if not cat: continue
            p = gpd.GeoSeries([Point(el['lon'], el['lat'])], crs=4326).to_crs(2157).iloc[0]
            rows.append({'site_id': s.site_id, 'category': cat, 'name': el['tags'].get('name', ''), 'source': 'OpenStreetMap', 'geometry': p})
        # community additions (non-home types)
        if len(additions):
            a = additions[additions.intersects(zone) & ~additions.category.str.lower().str.startswith('home')]
            for _, r in a.iterrows():
                cat = ('School' if 'school' in r.category.lower() else 'Childcare' if 'cr' in r.category.lower()[:3] or 'child' in r.category.lower()
                       else 'Care home' if 'nursing' in r.category.lower() or 'care' in r.category.lower() else 'Health' if 'health' in r.category.lower() or 'hospital' in r.category.lower()
                       else 'Other sensitive')
                rows.append({'site_id': s.site_id, 'category': cat, 'name': r['name'], 'source': 'Reported by a map user', 'geometry': r.geometry})
    json.dump(cache, open(OSM_CACHE, 'w'))
    if not rows:
        return gpd.GeoDataFrame(columns=['site_id', 'category', 'name', 'source', 'dist_m', 'geometry'], geometry='geometry', crs=2157)
    r = gpd.GeoDataFrame(rows, geometry='geometry', crs=2157)
    geo = sites.set_index('site_id').geometry
    r['dist_m'] = [round(g.distance(geo[sid])) for g, sid in zip(r.geometry, r.site_id)]
    r = r[r.dist_m <= 1000]
    # de-duplicate: same site + category within 120 m -> keep official / named one
    r['_rank'] = r.source.map({'Dept. of Education': 0, 'HSE / Dept. of Housing': 0, 'Reported by a map user': 1}).fillna(2)
    r = r.sort_values(['site_id', '_rank', 'dist_m'])
    keep = []
    for sid, g in r.groupby('site_id'):
        taken = []
        for i, row in g.iterrows():
            if any(row.category == c and row.geometry.distance(p) < 120 for c, p in taken): continue
            taken.append((row.category, row.geometry)); keep.append(i)
    r = r.loc[keep].drop(columns='_rank')
    r['name'] = r['name'].fillna('').replace('', np.nan).fillna(r.category)
    print('receptors within 1 km:', len(r), dict(r.category.value_counts()), flush=True)
    return r


# ------------------------------------------------------------------ 5. Natura 2000 & rivers
SAC = 'https://services-eu1.arcgis.com/Jhij7i46ouO8Cc0N/ArcGIS/rest/services/NPWSDesignatedAreas/FeatureServer/3'
SPA = 'https://services-eu1.arcgis.com/Jhij7i46ouO8Cc0N/ArcGIS/rest/services/NPWSDesignatedAreas/FeatureServer/0'
EPA_RIVERS = 'https://gis.epa.ie/geoserver/wfs'

def natura_water(sites):
    out = {c: [] for c in ['sac_name', 'sac_m', 'spa_name', 'spa_m', 'river_name', 'river_m']}
    for _, s in sites.iterrows():
        g = s.geometry
        for key, url in (('sac', SAC), ('spa', SPA)):
            best = ('', None)
            for rad in (2000, 15000):
                d = _arcgis(url, g.buffer(rad).bounds, 'SITE_NAME,SITECODE')
                if not d.empty:
                    d['dd'] = d.distance(g); r = d.sort_values('dd').iloc[0]
                    if r.dd <= rad: best = (f"{re.sub(r'\b(Sac|Spa|Nha)\b', lambda m: m.group(1).upper(), str(r.SITE_NAME).title())} ({r.SITECODE})", round(r.dd)); break
            out[f'{key}_name'].append(best[0]); out[f'{key}_m'].append(best[1])
        best = ('', None)
        try:
            minx, miny, maxx, maxy = g.buffer(1000).bounds
            js = json.loads(B.get(EPA_RIVERS, {'service': 'WFS', 'version': '2.0.0', 'request': 'GetFeature', 'typeNames': 'EPA:WFD_RIVERWATERBODIES_CYCLE3',
                                               'outputFormat': 'application/json', 'srsName': 'EPSG:2157', 'bbox': f'{minx},{miny},{maxx},{maxy},EPSG:2157'}, tries=2, timeout=60))
            if js.get('features'):
                d = gpd.GeoDataFrame.from_features(js['features'], crs=2157); d['dd'] = d.distance(g); r = d.sort_values('dd').iloc[0]
                nm = next((r[c] for c in ('NAME', 'Name', 'name', 'EU_NAME', 'SEG_NAME') if c in d.columns and r[c]), 'River water body')
                if r.dd <= 1000: best = (re.sub(r'_\d+$', '', str(nm)).replace('_', ' ').strip().title(), round(r.dd))
        except Exception as e:
            print('  rivers unavailable', e, flush=True)
        out['river_name'].append(best[0]); out['river_m'].append(best[1])
    for k, v in out.items(): sites[k] = v
    return sites


# ------------------------------------------------------------------ 6. wind
WIND = os.path.join(B.OUT, 'wind.json')
SECT = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']

def _rose(lat, lon):
    u = ('https://archive-api.open-meteo.com/v1/archive?' + urllib.parse.urlencode({'latitude': round(lat, 4), 'longitude': round(lon, 4),
         'start_date': '2021-01-01', 'end_date': '2025-12-31', 'hourly': 'wind_direction_10m,wind_speed_10m', 'timezone': 'UTC'}))
    d = json.loads(B.get(u, tries=1, timeout=45))
    cnt = [0] * 16; sp = [0.0] * 16; calm = 0; n = 0
    for a, v in zip(d['hourly']['wind_direction_10m'], d['hourly']['wind_speed_10m']):
        if a is None or v is None: continue
        n += 1
        if v < 2: calm += 1; continue
        k = int(((a + 11.25) % 360) // 22.5); cnt[k] += 1; sp[k] += v
    return {'n': n, 'calm_pct': round(100 * calm / n, 1), 'freq_pct': [round(100 * c / n, 2) for c in cnt],
            'mean_kmh': [round(sp[i] / cnt[i], 1) if cnt[i] else 0 for i in range(16)], 'lat': round(lat, 5), 'lon': round(lon, 5),
            'period': '2021-2025', 'source': 'Open-Meteo historical archive (ERA5 reanalysis), hourly 10 m wind'}


def wind(sites, pts4326):
    cache = _json(WIND, {})
    ok = os.environ.get('BM_OFFLINE') != '1'
    for sid, p in zip(pts4326.site_id, pts4326.geometry):
        if sid not in cache and ok:
            try: cache[sid] = _rose(p.y, p.x); time.sleep(1)
            except Exception as e: print('  wind source unavailable - will retry next run:', e, flush=True); ok = False
    json.dump(cache, open(WIND, 'w'))
    pf, pp = [], []
    for sid in sites.site_id:
        w = cache.get(sid)
        if not w: pf.append(''); pp.append(None); continue
        f = w['freq_pct']
        k = max(range(16), key=lambda i: f[i - 1] + f[i] + f[(i + 1) % 16])        # smoothed peak
        pf.append(SECT[k]); pp.append(round(f[k - 1] + f[k] + f[(k + 1) % 16], 1))
    sites['prevailing_from'] = pf; sites['prevailing_pct'] = pp   # % of hours from that direction +/- one sector
    return sites, cache


def downwind_pct(home_pt, site_geom, rose):
    """% of hours the wind blows from the site towards this home (wind FROM the opposite bearing, +/- one sector)."""
    if not rose: return None
    c = site_geom.centroid
    brg = (math.degrees(math.atan2(home_pt.x - c.x, home_pt.y - c.y)) + 360) % 360     # bearing site -> home
    frm = (brg + 180) % 360
    k = int(((frm + 11.25) % 360) // 22.5); f = rose['freq_pct']
    return round(f[k - 1] / 2 + f[k] + f[(k + 1) % 16] / 2, 1)


# ------------------------------------------------------------------ 7. traced layouts
LAYOUT_DIR = os.path.join(B.CFG, 'layouts')

def layouts():
    """config/layouts/<anything>.geojson, features with site_id, label, kind, open (bool). Returns GeoDataFrame EPSG:2157."""
    parts = []
    if os.path.isdir(LAYOUT_DIR):
        for f in sorted(os.listdir(LAYOUT_DIR)):
            if f.endswith('.geojson'):
                g = gpd.read_file(os.path.join(LAYOUT_DIR, f))
                parts.append(g.to_crs(2157) if g.crs else g.set_crs(4326).to_crs(2157))
    if not parts: return gpd.GeoDataFrame(columns=['site_id', 'label', 'kind', 'open', 'geometry'], geometry='geometry', crs=2157)
    return gpd.GeoDataFrame(pd.concat(parts, ignore_index=True), crs=2157)


# ------------------------------------------------------------------ 8. international separation distances
def _trim(g, w=15):
    """Red-line boundary with strips narrower than ~2*w m removed (access roads, pipe and cable corridors, sightline splays)."""
    if g is None or g.area < 2000: return g
    t = g.buffer(-w).buffer(w)
    if t.is_empty: return g
    parts = list(t.geoms) if t.geom_type == 'MultiPolygon' else [t]
    big = max(p.area for p in parts)
    t = unary_union([p for p in parts if p.area >= 0.1 * big])
    return t if t.area >= 0.3 * g.area else g


def intl(sites, homes, recs, lay):
    cfg = _json(os.path.join(B.CFG, 'intl_rules.json'), {'rules': []})
    rules = cfg['rules']; rings = []; verdicts = {}
    lm = lay[lay['measure'].fillna(True).astype(bool)] if len(lay) and 'measure' in lay.columns else lay
    foot = {sid: unary_union(g.geometry.tolist()) for sid, g in lm.groupby('site_id')} if len(lm) else {}
    # France excludes storage of raw crops only (e.g. silage clamps) from the installation
    lf = lm[lm['kind'].fillna('') != 'raw_storage'] if len(lm) and 'kind' in lm.columns else lm
    foot_fr = {sid: unary_union(g.geometry.tolist()) for sid, g in lf.groupby('site_id')} if len(lf) else {}
    open_sites = set(lay[lay.get('open', False) == True].site_id) if len(lay) and 'open' in lay.columns else set()
    for _, s in sites.iterrows():
        src = foot.get(s.site_id)
        measured = 'plant structures (traced from the site layout)' if src is not None else 'site boundary'
        if src is None: src = _trim(s.geometry); measured = 'site boundary' if src is s.geometry else 'site boundary (access roads and pipe corridors removed)'
        src_fr = foot_fr.get(s.site_id, src)
        tpy = pd.to_numeric(str(s.tonnes_per_year).replace(',', ''), errors='coerce'); tpd = tpy / 365 if pd.notna(tpy) else None
        h = homes[homes.site_id == s.site_id]; r = recs[recs.site_id == s.site_id]
        hd = h.geometry.distance(src) if len(h) else pd.Series(dtype=float)
        rd = r.geometry.distance(src) if len(r) else pd.Series(dtype=float)
        sens = r.category.isin(['School', 'Childcare', 'Care home', 'Health']) if len(r) else pd.Series(dtype=bool)
        out = []
        for ru in rules:
            dm = ru.get('dwelling_open_m') if (s.site_id in open_sites and ru.get('dwelling_open_m')) else ru['dwelling_m']
            o = src_fr if ru['id'] == 'FR' else src
            hd = h.geometry.distance(o) if len(h) else pd.Series(dtype=float)
            rd = r.geometry.distance(o) if len(r) else pd.Series(dtype=float)
            nh = int((hd <= dm).sum()) if len(hd) else 0
            nl = int(((hd <= dm) & (h.tier != 'Possible home')).sum()) if len(hd) else 0
            ns = int(((rd <= ru['sensitive_m']) & sens).sum()) if ru.get('sensitive_m') and len(rd) else 0
            thr = ru.get('applies_tpd_min')
            if ru.get('info_only'): v = 'info'
            elif thr and tpd is None: v = 'unknown_tonnage'
            elif thr and tpd < thr: v = 'below_threshold'
            else: v = 'fail' if (nh or ns) else 'pass'
            out.append({'id': ru['id'], 'distance_m': dm, 'homes': nh, 'likely_homes': nl, 'sensitive': ns, 'verdict': v})
            if s.geometry.area > 500 or src is not s.geometry:
                rings.append({'site_id': s.site_id, 'rule': ru['id'], 'distance_m': dm, 'kind': 'dwelling', 'geometry': o.buffer(dm, 32)})
                if ru.get('sensitive_m') and ru['sensitive_m'] != dm:
                    rings.append({'site_id': s.site_id, 'rule': ru['id'], 'distance_m': ru['sensitive_m'], 'kind': 'sensitive', 'geometry': o.buffer(ru['sensitive_m'], 32)})
        verdicts[s.site_id] = {'measured_from': measured, 'provisional': src is not foot.get(s.site_id), 'tonnes_per_day': round(tpd) if tpd else None, 'rules': out}
    rg = gpd.GeoDataFrame(rings, geometry='geometry', crs=2157) if rings else gpd.GeoDataFrame(columns=['site_id', 'rule', 'distance_m', 'kind', 'geometry'], geometry='geometry', crs=2157)
    rg['geometry'] = rg.geometry.boundary.simplify(2)            # outlines only (small file)
    return rg, verdicts, cfg
