"""
Rebuilds the Irish biomethane / AD applications map data.

Steps
 1. Query the National Planning Applications dataset for AD / biogas / biomethane applications
    lodged or decided since START_DATE.
 2. Group them into sites using config/projects.csv (curated). Anything new that is not listed
    there or in config/excluded_applications.csv is added as its own site and written to
    docs/data/review.csv so a person can check it.
 3. For each site, find buildings within 1 km of the site boundary (Microsoft building footprints,
    OpenStreetMap where Microsoft has gaps), classify likely / possible homes and count them in
    0-250 m, 250-500 m and 500-1,000 m bands.
 4. Remove homes reported as "not a home" (config/excluded_homes.csv, plus rows marked
    approved in the Google Sheet behind the map's report form - see config/settings.json).
 5. Write GeoJSON + CSV for the web map in docs/data/.

Run:  python build/build.py
"""
import csv, datetime, gzip, hashlib, io, json, os, re, subprocess, sys, time, urllib.parse
import geopandas as gpd
import mercantile
import numpy as np
import pandas as pd
from shapely.geometry import Point, shape
from shapely.ops import polylabel

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CFG, OUT, CACHE = (os.path.join(ROOT, d) for d in ('config', 'docs/data', 'build/cache'))
os.makedirs(OUT, exist_ok=True); os.makedirs(CACHE, exist_ok=True)
START_DATE = '2021-01-01'
TODAY = datetime.date.today()
NPA = "https://services.arcgis.com/NzlPQPKn5QF9v2US/arcgis/rest/services/IrishPlanningApplications/FeatureServer/"
MS_INDEX = "https://minedbuildings.z5.web.core.windows.net/global-buildings/dataset-links.csv"
KEYWORDS = ['ANAEROBIC', 'BIOMETHANE', 'BIO-METHANE', 'BIOGAS', 'DIGESTER', 'DIGESTATE', 'RENEWABLE GAS']
SETTINGS = json.load(open(os.path.join(CFG, 'settings.json'))) if os.path.exists(os.path.join(CFG, 'settings.json')) else {}
BANDS = [(0, 250, '0–250 m'), (250, 500, '250–500 m'), (500, 1000, '500–1,000 m')]


def get(url, params=None, data=None, tries=4, timeout=180):
    if params: url = url + '?' + urllib.parse.urlencode(params)
    cmd = ['curl', '-sSL', '--fail', '-m', str(timeout), '--retry', '3' if timeout >= 120 else '0', '-A', 'biomethane-map', url]
    if data: cmd += ['--data-urlencode', data]
    for k in range(tries):
        r = subprocess.run(cmd, capture_output=True)
        if r.returncode == 0: return r.stdout
        time.sleep(5 * (k + 1))
    raise RuntimeError(f'download failed: {url[:120]}')


def ts(v):
    try: return datetime.datetime.fromtimestamp(int(v) / 1000, datetime.timezone.utc).date() if v else None
    except Exception: return None


def norm(ref): return str(ref or '').strip()


# ---------------------------------------------------------------- 1. applications
def fetch_applications():
    where = '(' + ' OR '.join(f"UPPER(DevelopmentDescription) LIKE '%{k}%'" for k in KEYWORDS) + ')' + \
        f" AND (ReceivedDate >= timestamp '{START_DATE} 00:00:00' OR DecisionDate >= timestamp '{START_DATE} 00:00:00')"
    d = json.loads(get(NPA + '1/query', {'where': where, 'outFields': '*', 'outSR': 4326, 'f': 'geojson', 'resultRecordCount': 2000}))
    return d['features']


def fetch_refs(auth, ref):
    w = f"PlanningAuthority='{auth}' AND (ApplicationNumber='{ref}' OR ApplicationNumber LIKE '{ref} %')"
    return json.loads(get(NPA + '1/query', {'where': w, 'outFields': '*', 'outSR': 4326, 'f': 'geojson'}))['features']


def build_sites():
    projects = pd.read_csv(os.path.join(CFG, 'projects.csv'), dtype=str).fillna('')
    excluded = pd.read_csv(os.path.join(CFG, 'excluded_applications.csv')).fillna('')
    excl = {(a, norm(r)) for a, r in zip(excluded.planning_authority, excluded.application_ref)}
    known = {(a, norm(r)) for a, refs in zip(projects.planning_authority, projects.application_refs) for r in refs.split(';')}
    found = fetch_applications()
    apps, review = [], []
    by_key = {}
    for f in found:
        p = f['properties']; key = (p['PlanningAuthority'], norm(p['ApplicationNumber']))
        by_key.setdefault(key, []).append(f)
    # curated projects (fetch any refs the keyword search missed, e.g. grid injection, older cases)
    for _, pr in projects.iterrows():
        for ref in pr.application_refs.split(';'):
            key = (pr.planning_authority, norm(ref))
            fs = by_key.get(key) or fetch_refs(*key)
            for f in fs:
                f['properties']['_project'] = pr.project; apps.append(f)
    # auto-detected new applications
    for key, fs in by_key.items():
        if key in known or key in excl: continue
        p = fs[0]['properties']
        name = 'NEW – ' + (p.get('DevelopmentAddress') or key[1]).split(',')[0].strip().title()
        for f in fs:
            f['properties']['_project'] = name; apps.append(f)
        review.append({'planning_authority': key[0], 'application_ref': key[1], 'address': p.get('DevelopmentAddress'),
                       'received': str(ts(p.get('ReceivedDate'))), 'description': (p.get('DevelopmentDescription') or '')[:300]})
    pd.DataFrame(review).to_csv(os.path.join(OUT, 'review.csv'), index=False)
    g = gpd.GeoDataFrame.from_features(apps, crs=4326).to_crs(2157)
    g = g[g.geometry.notna()]
    for c in ['Decision', 'AppealRefNumber', 'AppealDecision', 'ApplicationNumber']: g[c] = g[c].fillna('').astype(str).str.strip()
    g['rec'] = g.ReceivedDate.apply(ts); g['dec'] = g.DecisionDate.apply(ts)
    rows = []
    meta = projects.set_index('project')
    for name, s in g.groupby('_project'):
        s = s.sort_values('rec'); last = s.iloc[-1]
        dec, ap, apd = last.Decision, last.AppealRefNumber, last.AppealDecision
        if 'refus' in dec.lower(): st = 'Refused'
        elif any(k in dec.lower() for k in ['grant', 'condition', 'permission']): st = 'Granted'
        elif dec in ('', 'N/A', 'nan'): st = 'No decision recorded'
        else: st = dec
        if ap and not apd: st += ' – appealed'
        elif ap and apd: st += f' – appeal decision: {apd.title()}'
        grp = ('Pending decision' if last.rec and (TODAY - last.rec).days < 550 else 'No decision recorded') if st.startswith('No decision') else \
              'Under appeal' if 'appealed' in st else 'Refused' if 'Refused' in st and 'Refused' in st.split('appeal decision:')[-1] else \
              'Granted' if ('Granted' in st or 'Conditional' in st or 'Grant' in st) else 'Other'
        m = meta.loc[name] if name in meta.index else None
        if m is not None and m.status_override: grp = m.status_override
        note = st if m is None or not m.status_note else m.status_note
        tonnes = re.findall(r'([\d,\.]{2,})\s*(?:tonnes|t)\s*(?:per annum|/yr|p\.a|per year|of)', ' '.join(s.DevelopmentDescription.fillna('')), re.I)
        geom = last.geometry
        rows.append(dict(project=name, county=(m.county if m is not None else ''), planning_authority=last.PlanningAuthority,
                         type=(m.type if m is not None else 'Not yet reviewed'), developer=(m.developer if m is not None else ''),
                         application_refs=', '.join(dict.fromkeys(s.ApplicationNumber)),
                         appeal_refs=', '.join(sorted({a for a in s.AppealRefNumber if a})),
                         first_lodged=str(s.rec.min()), latest_lodged=str(last.rec), latest_decision=str(last.dec or ''),
                         status=grp, status_note=note,
                         tonnes_per_year=(m.tonnes_per_year if m is not None and m.get('tonnes_per_year', '') else (tonnes[0].replace(',', '') if tonnes else '')),
                         tonnes_source=(m.tonnes_source if m is not None and m.get('tonnes_per_year', '') else ('Planning description' if tonnes else '')),
                         site_area_ha=round(geom.area / 1e4, 2), approx_location=bool(geom.area < 500),
                         planning_link=last.get('LinkAppDetails', '') or '', description=str(last.DevelopmentDescription)[:500],
                         needs_review=m is None, geometry=geom))
    # pre-application sites (no boundary yet)
    pre = pd.read_csv(os.path.join(CFG, 'pre_application_sites.csv'), dtype=str).fillna('')
    for _, r in pre.iterrows():
        rows.append(dict(project=r.project, county=r.county, planning_authority='', type='Pre-application', developer=r.developer,
                         application_refs='', appeal_refs='', first_lodged='', latest_lodged='', latest_decision='',
                         status='Pre-application', status_note=r.status_note, tonnes_per_year=r.get('tonnes_per_year', ''),
                         tonnes_source=r.get('tonnes_source', ''), site_area_ha=None,
                         approx_location=True, planning_link=r.source_url, description=r.location_accuracy, needs_review=False,
                         geometry=Point(float(r.itm_x), float(r.itm_y))))
    sites = gpd.GeoDataFrame(rows, crs=2157)
    sites['site_id'] = [hashlib.md5(p.encode()).hexdigest()[:8] for p in sites['project']]
    return sites


# ---------------------------------------------------------------- 2. homes
_ms_index = None
def ms_index():
    global _ms_index
    if _ms_index is None:
        _ms_index = [r for r in csv.DictReader(io.StringIO(get(MS_INDEX).decode())) if r['Location'] == 'Ireland']
    return _ms_index


def ms_buildings(area_2157):
    a4326 = gpd.GeoSeries([area_2157], crs=2157).to_crs(4326).iloc[0]
    qks = {mercantile.quadkey(t) for t in mercantile.tiles(*a4326.bounds, 9)}
    geoms = []
    for r in ms_index():
        if r['QuadKey'] not in qks: continue
        fn = os.path.join(CACHE, 'ms_' + r['QuadKey'] + '_' + os.path.basename(r['Url']))
        if not os.path.exists(fn):
            open(fn, 'wb').write(get(r['Url']))
        with gzip.open(fn, 'rt') as f:
            for line in f:
                g = shape(json.loads(line)['geometry'])
                if g.intersects(a4326): geoms.append(g)
    b = gpd.GeoDataFrame(geometry=geoms, crs=4326).to_crs(2157); b['osm_tag'] = None
    return b


def osm_buildings(area_2157):
    extra = os.path.join(CFG, 'extra_buildings.geojson')   # manual supplement (e.g. saved OSM extracts)
    if os.path.exists(extra):
        e = gpd.read_file(extra).to_crs(2157)
        e = e.rename(columns={'building': 'osm_tag'})
        e = e[e.is_valid & e.intersects(area_2157)]
        if len(e) >= 5:
            return e[['osm_tag', 'geometry']]
    c = gpd.GeoSeries([area_2157.centroid], crs=2157).to_crs(4326).iloc[0]
    rad = int(np.sqrt(area_2157.area / np.pi) + 300)
    q = f'[out:json][timeout:90];way["building"](around:{rad},{c.y},{c.x});out tags geom;'
    for ep in ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter']:
        try:
            d = json.loads(get(ep, data='data=' + q)); break
        except Exception: d = {'elements': []}
    feats = []
    for e in d['elements']:
        if 'geometry' not in e or len(e['geometry']) < 4: continue
        ring = [(p['lon'], p['lat']) for p in e['geometry']]
        feats.append({'type': 'Feature', 'properties': {'osm_tag': e.get('tags', {}).get('building')}, 'geometry': {'type': 'Polygon', 'coordinates': [ring]}})
    if not feats: return gpd.GeoDataFrame(geometry=[], crs=2157)
    b = gpd.GeoDataFrame.from_features(feats, crs=4326).to_crs(2157)
    return b[b.is_valid & b.intersects(area_2157)]


def residential_planning(area_2157):
    minx, miny, maxx, maxy = area_2157.bounds
    d = json.loads(get(NPA + '1/query', {'where': '1=1', 'geometry': f'{minx},{miny},{maxx},{maxy}', 'geometryType': 'esriGeometryEnvelope',
                                         'inSR': 2157, 'spatialRel': 'esriSpatialRelIntersects', 'outFields': 'DevelopmentDescription',
                                         'outSR': 2157, 'f': 'geojson', 'resultRecordCount': 2000}))
    res = re.compile(r'dwelling|house|bungalow|residen|extension to|septic|wastewater treatment system|percolation', re.I)
    farm = re.compile(r'slatted|cattle|livestock|milking|agricultural shed|silage|slurry|poultry', re.I)
    fs = [f for f in d['features'] if f.get('geometry') and res.search(f['properties'].get('DevelopmentDescription') or '')
          and not farm.search((f['properties'].get('DevelopmentDescription') or '')[:120])]
    return gpd.GeoDataFrame.from_features(fs, crs=2157) if fs else gpd.GeoDataFrame(geometry=[], crs=2157)


def aspect(g):
    r = g.minimum_rotated_rectangle; xs, ys = r.exterior.coords.xy
    e = [np.hypot(xs[k + 1] - xs[k], ys[k + 1] - ys[k]) for k in range(2)]
    return max(e) / max(min(e), 0.1)


HOUSE_TAGS = ['house', 'residential', 'detached', 'bungalow', 'semidetached_house', 'terrace', 'farmhouse']
NOT_HOUSE = ['barn', 'shed', 'farm_auxiliary', 'industrial', 'warehouse', 'garage', 'garages', 'cowshed', 'stable',
             'commercial', 'retail', 'greenhouse', 'agricultural', 'static_caravan']


def homes_for_site(site):
    geom = site.geometry
    zone = geom.buffer(1000)
    key = hashlib.md5(geom.wkb).hexdigest()[:12]
    cf = os.path.join(CACHE, f'homes_{key}.geojson')
    if os.path.exists(cf):
        return gpd.read_file(cf)
    b = ms_buildings(zone)
    if len(b[b.intersects(zone)]) < 5:           # Microsoft gap -> OpenStreetMap
        b = pd.concat([b, osm_buildings(zone)], ignore_index=True)
    b = gpd.GeoDataFrame(b, crs=2157)
    b = b[b.intersects(zone) & ~b.within(geom)].copy()
    if b.empty:
        h = gpd.GeoDataFrame(columns=['tier', 'dist_m', 'band', 'geometry'], geometry='geometry', crs=2157)
        h.to_file(cf, driver='GeoJSON'); return h
    b['area_m2'] = b.area.round(0); b['aspect'] = b.geometry.apply(aspect)
    resp = residential_planning(zone)
    near_res = b.geometry.buffer(25).intersects(resp.union_all()) if len(resp) else False
    b['pres'] = near_res | b.osm_tag.isin(HOUSE_TAGS)
    b = b[~b.osm_tag.isin(NOT_HOUSE)]
    sel = b[(b.pres & b.area_m2.between(50, 400)) | (b.area_m2.between(60, 320) & (b.aspect < 2.8))].copy()
    sel = sel.sort_values('area_m2', ascending=False); idx = sel.sindex; drop = set()
    for i, r in sel.iterrows():
        if i in drop: continue
        for j in idx.query(r.geometry.buffer(6), predicate='intersects'):
            k = sel.index[j]
            if k != i and k not in drop and sel.loc[k, 'area_m2'] <= r.area_m2: drop.add(k)
    sel = sel.drop(index=list(drop))
    sel['tier'] = np.where(sel.pres, 'Likely home', 'Possible home')
    sel['dist_m'] = sel.geometry.distance(geom).round(0)
    sel['band'] = pd.cut(sel.dist_m, [-1, 250, 500, 1000], labels=[b[2] for b in BANDS]).astype(str)
    sel['geometry'] = sel.geometry.representative_point()
    h = gpd.GeoDataFrame(sel[['tier', 'dist_m', 'band', 'geometry']], crs=2157)
    h.to_file(cf, driver='GeoJSON')
    return h


# ---------------------------------------------------------------- 3. exclusions
def home_id(pt):
    """Stable ID from the home's ITM position (metres), e.g. H582731-614545."""
    return f'H{pt.x:.0f}-{pt.y:.0f}'


def excluded_homes():
    ids = set()
    f = os.path.join(CFG, 'excluded_homes.csv')
    if os.path.exists(f):
        ids |= set(pd.read_csv(f, dtype=str).fillna('').home_id.str.strip())
    url = SETTINGS.get('report_sheet_csv')
    if url:
        try:
            df = pd.read_csv(io.BytesIO(get(url)), dtype=str).fillna('')
            cols = {c.lower().strip(): c for c in df.columns}
            idc = next((cols[c] for c in cols if 'home id' in c), None)
            apc = next((cols[c] for c in cols if c.startswith('approved')), None)
            if idc and apc:
                ok = df[apc].str.strip().str.lower().isin(['y', 'yes', 'true', '1', 'x', 'approved'])
                got = set(df.loc[ok, idc].str.strip())
                print(f'report sheet: {len(df)} reports, {len(got)} approved', flush=True)
                ids |= got
            else:
                print('report sheet: no "Home ID" / "Approved" column found', flush=True)
        except Exception as e:  # never fail the whole refresh because of the sheet
            print('report sheet unavailable:', e, flush=True)
    ids.discard('')
    return ids


# ---------------------------------------------------------------- 4. outputs
def main():
    import extras as X
    sites = build_sites()
    print(len(sites), 'sites', flush=True)
    sites = X.deadlines(sites)
    sites = X.track_new(sites)
    drop, additions = X.feed()
    lay = X.layouts()
    pts = sites.copy()
    pts['geometry'] = [g if g.geom_type == 'Point' else polylabel(max(getattr(g, 'geoms', [g]), key=lambda x: x.area), tolerance=1.0) for g in sites.geometry]
    sites, roses = X.wind(sites, pts.to_crs(4326))
    lm = lay[lay['measure'].fillna(True).astype(bool)] if len(lay) and 'measure' in lay.columns else lay
    foot = {sid: g.unary_union for sid, g in lm.groupby('site_id').geometry} if len(lm) else {}
    homes, rings = [], []; dropped = 0
    add_homes = additions[additions.category.str.lower().str.startswith('home')] if len(additions) else additions
    for i, s in sites.iterrows():
        print('homes:', s.project, flush=True)
        h = homes_for_site(s).copy()
        if len(add_homes):                                  # homes added by map users
            a = add_homes[add_homes.intersects(s.geometry.buffer(1000)) & ~add_homes.within(s.geometry)]
            if len(a):
                a = gpd.GeoDataFrame({'tier': 'Reported home', 'geometry': a.geometry.values}, crs=2157)
                a['dist_m'] = a.geometry.distance(s.geometry).round(0)
                a['band'] = pd.cut(a.dist_m, [-1, 250, 500, 1000], labels=[b[2] for b in BANDS]).astype(str)
                h = pd.concat([h, a], ignore_index=True)
        h['site_id'] = s.site_id; h['project'] = s.project
        h['home_id'] = [home_id(g) for g in h.geometry]
        h = h.drop_duplicates('home_id')
        n = len(h); h = h[~h.home_id.isin(drop)]; dropped += n - len(h)
        h['downwind_pct'] = [X.downwind_pct(g, s.geometry, roses.get(s.site_id)) for g in h.geometry]
        f = foot.get(s.site_id)
        h['plant_m'] = h.geometry.distance(f).round(0) if f is not None else None
        likely = h.tier.isin(['Likely home', 'Reported home'])
        for lo, hi, lab in BANDS:
            cl = int(((h.dist_m <= hi) & likely).sum()); cp = int(((h.dist_m <= hi) & ~likely).sum())
            sites.loc[i, f'likely_within_{hi}m'] = cl; sites.loc[i, f'possible_within_{hi}m'] = cp
            ring = s.geometry.buffer(hi, 48).difference(s.geometry)
            rings.append({'site_id': s.site_id, 'project': s.project, 'distance_m': hi, 'likely_homes_within': cl,
                          'possible_homes_within': cp, 'geometry': ring})
        sites.loc[i, 'nearest_home_m'] = float(h.dist_m.min()) if len(h) else None
        dw = h[(h.dist_m <= 1000) & (h.downwind_pct.fillna(0) >= 10)]
        sites.loc[i, 'downwind_homes_1km'] = int(len(dw))
        homes.append(h)
    homes = gpd.GeoDataFrame(pd.concat(homes, ignore_index=True), crs=2157)
    print('homes removed as not-a-home:', dropped, flush=True)
    recs = X.receptors(sites, additions)
    for i, s in sites.iterrows():
        r = recs[recs.site_id == s.site_id]
        sites.loc[i, 'receptors_1km'] = int(len(r))
        sites.loc[i, 'sensitive_500m'] = int(((r.dist_m <= 500) & r.category.isin(['School', 'Childcare', 'Care home', 'Health'])).sum())
    sites = X.natura_water(sites)
    intl_rings, verdicts, rules = X.intl(sites, homes, recs, lay)
    sites['intl'] = [json.dumps(verdicts.get(sid, {})) for sid in sites.site_id]
    rings = gpd.GeoDataFrame(rings, crs=2157)
    pts = sites.copy(); pts['geometry'] = [g if g.geom_type == 'Point' else polylabel(max(getattr(g, 'geoms', [g]), key=lambda x: x.area), tolerance=1.0) for g in sites.geometry]
    w = lambda gdf, name: open(os.path.join(OUT, name), 'w').write(gdf.to_crs(4326).to_json(drop_id=True, to_wgs84=False))
    poly = sites[sites.geometry.geom_type != 'Point']
    w(poly.drop(columns=['description', 'intl']), 'sites.geojson'); w(pts, 'site_points.geojson'); w(rings, 'rings.geojson')
    w(homes[['home_id', 'site_id', 'project', 'tier', 'dist_m', 'band', 'downwind_pct', 'plant_m', 'geometry']], 'homes.geojson')
    w(recs[['site_id', 'category', 'name', 'source', 'dist_m', 'geometry']], 'receptors.geojson')
    w(intl_rings, 'intl_rings.geojson')
    w(lay if len(lay) else gpd.GeoDataFrame(columns=['site_id', 'label', 'kind', 'geometry'], geometry='geometry', crs=2157), 'layouts.geojson')
    json.dump(rules, open(os.path.join(OUT, 'intl_rules.json'), 'w'), indent=1)
    cols = ['project', 'county', 'planning_authority', 'type', 'developer', 'status', 'status_note', 'application_refs', 'appeal_refs',
            'first_lodged', 'latest_lodged', 'latest_decision', 'obs_deadline', 'appeal_deadline', 'tonnes_per_year', 'tonnes_source', 'site_area_ha',
            'likely_within_250m', 'possible_within_250m', 'likely_within_500m', 'possible_within_500m',
            'likely_within_1000m', 'possible_within_1000m', 'nearest_home_m', 'downwind_homes_1km', 'prevailing_from',
            'receptors_1km', 'sensitive_500m', 'sac_name', 'sac_m', 'spa_name', 'spa_m', 'river_name', 'river_m',
            'approx_location', 'planning_link']
    sites[cols].sort_values(['status', 'project']).to_csv(os.path.join(OUT, 'sites_summary.csv'), index=False)
    json.dump({'last_updated': TODAY.isoformat(), 'sites': int(len(sites)), 'homes_points': int(len(homes)),
               'start_date': START_DATE, 'homes_removed': int(dropped), 'community_additions': int(len(additions)),
               'needs_review': int(sites.needs_review.sum())},
              open(os.path.join(OUT, 'meta.json'), 'w'), indent=1)
    print('done', TODAY)


if __name__ == '__main__':
    main()
