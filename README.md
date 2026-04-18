# CAD Engineering Agent

A browser-based AI agent that ingests CAD routing files in **any JSON structure**, detects clashes and engineering rule violations, and delivers corrected files ready for AutoCAD, CADMATIC, Revit, or Navisworks.

---

## Quick Start

1. Open `index.html` in Chrome, Edge, or Firefox.
2. Drop any JSON file onto the upload zone.
3. The agent detects the schema, runs clash detection, and calls Claude for engineering analysis.
4. Download corrected files from the Export tab.

**No server required** — runs entirely in the browser.

---

## File Structure

```
cad_agent/
├── index.html          Main entry point — all UI markup
├── css/
│   └── style.css       Full dark-theme stylesheet
├── js/
│   ├── clash.js        AABB bounding-box clash detection engine
│   ├── api.js          Anthropic Claude API wrapper
│   ├── parser.js       Universal 3-tier JSON schema detector + converters
│   ├── viewer3d.js     Three.js 3D viewer (CAD Z-up coordinate system)
│   ├── export.js       DXF / IFC / CSV / TXT / JSON / KB exporters
│   ├── ui.js           DOM rendering — results, KB panel, schema panel
│   └── app.js          Main controller — state, orchestration, navigation
└── data/
    └── demo_scene.json Pre-converted INS MPV 18000 SWC scene
```

---

## Supported Input Formats

| Format | Detection | Notes |
|--------|-----------|-------|
| Scene JSON (native) | Tier 1 — instant | `cos_objects` + `routes` arrays |
| SWC / CADMATIC routing model | Tier 1 — instant | `components` + `routes` + `zones` |
| P&ID JSON | Tier 1 → AI | `piping[]` or `lines` + `equipment` |
| BIM / Revit JSON | Tier 1 → AI | `elements[].category` |
| Generic routing JSON | Tier 2 — AI | Contains `waypoints`/`path`/`polyline` |
| Any other JSON | Tier 3 — full AI | Claude analyses structure and converts |

### Schema Detection Pipeline

```
Upload JSON
    │
    ▼
Tier 1: Heuristic scan (instant, no API)
    │  HIGH confidence → direct conversion
    │  MEDIUM / LOW confidence → escalate
    ▼
Tier 2: Partial match  (AI confirms + fills gaps)
    │
    ▼
Tier 3: Full AI conversion
    Claude reads top-level keys + 2-item array samples
    Returns normalised scene with cos_objects + routes
```

---

## What the Agent Checks

| Check | Description |
|-------|-------------|
| AABB Clashes | Axis-aligned bounding box intersection between every route segment and every COS object |
| Rule Violations | Vertical separation, minimum clearances, routing priority from the Knowledge Base |
| Profile Sizing | Undersized pipes/ducts for application or flow rate |
| Routing Errors | Routes passing through equipment bodies, walls, or structure |
| Missing Data | Undefined profiles, missing coordinates, incomplete connectivity |

---

## Export Formats

| Format | Use case |
|--------|----------|
| `.json` | Re-import, 3D viewer, CADMATIC pipeline |
| `.dxf`  | AutoCAD, BricsCAD, LibreCAD, ZWCAD, SketchUp |
| `.ifc`  | Autodesk Revit, Navisworks, CADMATIC, Tekla, ArchiCAD |
| `.csv`  | Issue report — Excel, Google Sheets, Jira import |
| `.txt`  | Engineering report — email, PDF print, drawing revision |
| `kb.json` | Portable Knowledge Base — reuse across projects |

---

## Knowledge Base

Rules are stored in the KB panel and applied to every analysis:

- **Auto-import**: engineering rules found in the uploaded file are committed automatically
- **AI suggestions**: Claude proposes new rules after analysis — review and commit selectively
- **Manual add**: use the `+ Add rule` form to enter rules from standards (SOLAS, IEC, plant codes)
- **Persist**: export `kb.json` and save alongside your project files for consistent enforcement

---

## Architecture Notes

### Coordinate System
The app uses CAD convention (Z-up): `X = East, Y = North, Z = Up`.
Three.js uses Y-up: all coordinates are transformed via `(x, y, z) → THREE.Vector3(x, z, y)`.

### Clash Detection
The engine (`clash.js`) runs O(segments × objects) AABB intersection tests.
Connection-point overlaps (pipe entering its own pump) are filtered by a minimum overlap volume threshold (0.0005 m³).
For very large scenes (1000+ objects), consider adding a spatial grid partition in `ClashEngine.detect()`.

### AI Integration
All Claude calls go through `api.js`. Two call types:
1. **Schema conversion** (`parser.js`) — converts unknown JSON to normalised scene
2. **Engineering analysis** (`api.js → analyseScene`) — identifies issues and suggests fixes

---

## Browser Requirements

- Chrome 90+ / Edge 90+ / Firefox 88+ (WebGL2 for Three.js)
- Internet access required for Claude API calls
- No server, no build step, no dependencies to install

---

## Adding New Known Formats

To add a new format that converts without AI:

1. Add a detection rule in `parser.js → detectSchema()` returning `{fmt, confidence, desc}`
2. Add a converter function `convertMyFormat(data)` that returns a normalised scene object
3. Add a case in `Parser.parse()` to call your converter when the format matches

The normalised scene schema:
```json
{
  "format": "my_format",
  "meta": { "project": "", "system": "", "total_clashes": 0, ... },
  "cos_objects": [{ "oid": "", "name": "", "type": "equipment|zone|wall|structure", "has_clash": false, "bounds": { "min_x":0,"min_y":0,"min_z":0,"max_x":1,"max_y":1,"max_z":1 } }],
  "routes": [{ "system_id": "", "system_type": "Pipe|Duct|Tray", "profile_type": "circular", "size": {"diameter_mm":100}, "waypoints": [{"x":0,"y":0,"z":0}], "segments": [{"seg_index":0,"bounds":{...},"length_m":1.0}] }],
  "clashes": [], "clash_segment_keys": [], "clashing_cos_oids": [], "rule_violations": []
}
```
