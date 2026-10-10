# Biomethane & AD planning applications – Ireland

Interactive map of anaerobic digestion / biogas / biomethane planning applications lodged or decided
since 1 January 2021, with estimated homes within 250 m, 500 m and 1 km of each site boundary.

**Live map:** https://kobrien-git.github.io/biomethane-map/

## How it updates
* Every day (about 06:17) a GitHub Action (`.github/workflows/refresh.yml`) re-runs `build/build.py`, which re-queries
  the National Planning Applications dataset and rebuilds everything in `docs/data/`.
* You can also refresh by hand: **Actions → Refresh map data → Run workflow**.
* Newly lodged AD/biogas applications that are not yet in `config/projects.csv` appear on the map as
  "NEW – …" sites and are listed in `docs/data/review.csv` for someone to check.

## "Not a home" reports
1. A map user clicks a home dot and chooses **Not a home? Report it**. It drops out of *their* counts
   straight away (saved in their browser only) and a prefilled Google Form opens.
2. Responses land in the Google Sheet **Biomethane map - not-a-home reports** (Drive › Biomethane Map).
3. To approve one, type **Y** in the *Approved (Y)* column. The `approved_for_map` tab lists approved Home IDs;
   only that tab is published (File › Share › Publish to web › approved_for_map › CSV). Raw reports stay private.
4. The next daily refresh removes approved homes for everyone and recounts.
5. You can also add Home IDs by hand to `config/excluded_homes.csv`.

Home IDs (e.g. `H582791-614378`) are the home's Irish Grid (ITM) easting-northing, so they stay the same
between refreshes.

## Editing (all in the GitHub website, no software needed)
| File | What it controls |
|---|---|
| `config/projects.csv` | Which applications belong to which site, site name, type, developer, and manual status corrections (`status_override`, `status_note`) for appeals / court cases the national data hasn't caught up with |
| `config/pre_application_sites.csv` | Sites with no planning application yet (point location, marked approximate) |
| `config/excluded_applications.csv` | Keyword matches that are not AD plants (breweries, slurry tanks…) |
| `config/excluded_homes.csv` | Home IDs to remove by hand (as well as approved form reports) |
| `config/settings.json` | Link to the published `approved_for_map` CSV |
| `config/extra_buildings.geojson` | Extra building outlines where the Microsoft footprints have gaps |

Status values for `status_override`: `Under appeal`, `Pending decision`, `Granted`, `Refused`, `No decision recorded`, `Other`, `Pre-application`.

## Data sources
* Planning: National Planning Applications (Department of Housing, Local Government and Heritage, data.gov.ie, CC BY 4.0)
* Buildings: Microsoft Global ML Building Footprints (ODbL); OpenStreetMap contributors (ODbL)
* Basemaps: OpenStreetMap; Esri World Imagery / Topographic

Home counts are estimates from building footprints (size/shape filter, plus nearby residential planning
records). They are unverified and may include farm buildings or miss recently built houses.
No names, addresses or Eircodes are stored.
