/**
 * parser.js — Universal CAD JSON Parser
 *
 * 3-tier detection pipeline:
 *   Tier 1: Heuristic detection for known formats  (instant, no API)
 *   Tier 2: Partial match formats                  (API assisted)
 *   Tier 3: Fully unknown JSON                     (full AI conversion)
 *
 * All converters produce a normalised scene object:
 * {
 *   format, meta, cos_objects[], routes[],
 *   clashes[], clash_segment_keys[], clashing_cos_oids[], rule_violations[]
 * }
 */

const Parser = (() => {

  // ── EQUIPMENT HALF-EXTENTS (metres) ─────────────────────────────────
  const EQUIP_HALF = {
    pump: 0.6, heat_exchanger: 1.2, sea_chest: 0.8,
    filter: 0.4, tank: 1.5, overboard_valve: 0.3,
    generator: 0.8, hvac_chiller: 1.0, ro_plant: 1.2,
    valve: 0.3, compressor: 0.8, motor: 0.5,
  };

  const mm = v => parseFloat((v * 0.001).toFixed(3));

  // ── TIER 1: HEURISTIC SCHEMA DETECTION ──────────────────────────────
  function detectSchema(data) {
    if (typeof data !== 'object' || data === null) return null;

    // Our own scene JSON
    if (data.cos_objects && data.routes)
      return { fmt: 'scene_json', confidence: 'HIGH', desc: 'Native Scene JSON — cos_objects + routes arrays.' };

    // SWC / CADMATIC routing model
    if (data.components && data.routes && (data.zones || data._metadata))
      return { fmt: 'swc', confidence: 'HIGH', desc: 'SWC/CADMATIC routing model — components, routes, zones.' };

    // Simple routing model with components and routes
    if (data.components && data.routes)
      return { fmt: 'swc', confidence: 'HIGH', desc: 'Component-based routing model.' };

    // P&ID with lines array
    if (data.piping && Array.isArray(data.piping))
      return { fmt: 'pid', confidence: 'MEDIUM', desc: 'P&ID JSON with piping[] array.' };
    if (data.lines && data.equipment)
      return { fmt: 'pid', confidence: 'MEDIUM', desc: 'P&ID JSON — lines + equipment objects.' };

    // BIM / Revit element list
    if (data.elements && Array.isArray(data.elements) && data.elements[0]?.category)
      return { fmt: 'bim', confidence: 'MEDIUM', desc: 'BIM/Revit element list with category properties.' };

    // Flat array of objects with coordinates
    if (Array.isArray(data) && data.length > 0) {
      const first = data[0];
      if (first.x !== undefined || first.position || first.coordinates || first.geometry)
        return { fmt: 'point_array', confidence: 'LOW', desc: 'Array of positioned/geometry objects.' };
    }

    // Generic routing (has known routing keys anywhere)
    const flat = JSON.stringify(data);
    const hasRouteKeys = flat.includes('"waypoints"') || flat.includes('"path"') || flat.includes('"polyline"') || flat.includes('"segments"');
    const hasCoordKeys = flat.includes('"x"') && flat.includes('"y"') && flat.includes('"z"');
    const hasSystemKeys = data.pipes || data.ducts || data.cables || data.trays || data.systems;

    if (hasSystemKeys && hasRouteKeys)
      return { fmt: 'generic_routing', confidence: 'MEDIUM', desc: 'Generic routing model with system type keys.' };
    if (hasRouteKeys)
      return { fmt: 'routing_generic', confidence: 'LOW', desc: 'JSON contains routing path keys.' };
    if (hasCoordKeys)
      return { fmt: 'coord_data', confidence: 'LOW', desc: 'JSON contains 3D coordinate data.' };

    return null;
  }

  // ── KNOWN FORMAT CONVERTERS ─────────────────────────────────────────

  function convertScene(data) {
    // Already in correct format — ensure segments exist
    const routes = (data.routes || []).map(r => {
      if (!r.segments || r.segments.length === 0) {
        r.segments = ClashEngine.rebuildSegments(r);
      }
      return r;
    });
    return { ...data, routes, format: 'scene_json' };
  }

  function convertSWC(data) {
    const cos = [];

    // Zones → bounding boxes
    (data.zones || []).forEach(z => cos.push({
      oid: z.id, name: z.name, type: 'zone', has_clash: false,
      bounds: {
        min_x: mm(z.x_range[0]), min_y: mm(z.y_range[0]), min_z: mm(z.z_range[0]),
        max_x: mm(z.x_range[1]), max_y: mm(z.y_range[1]), max_z: mm(z.z_range[1]),
      },
    }));

    // Components → bounding boxes
    (data.components || []).forEach(c => {
      const p = c.position;
      const h = EQUIP_HALF[c.type] || 0.5;
      cos.push({
        oid: c.id, name: c.label || c.id, type: c.type || 'equipment', has_clash: false,
        bounds: {
          min_x: mm(p.x) - h, min_y: mm(p.y) - h, min_z: mm(p.z) - h,
          max_x: mm(p.x) + h, max_y: mm(p.y) + h, max_z: mm(p.z) + h,
        },
      });
    });

    function makeRoute(id, stype, desc, path, dia) {
      const r = (dia / 2) / 1000;
      const wps = path.map(p => ({ x: mm(p.x), y: mm(p.y), z: mm(p.z) }));
      const segs = wps.slice(0, -1).map((a, i) => {
        const b = wps[i + 1];
        return {
          seg_index: i,
          length_m: parseFloat(Math.hypot(b.x-a.x, b.y-a.y, b.z-a.z).toFixed(3)),
          bounds: ClashEngine.segmentBbox(a, b, r),
        };
      });
      const sysType = stype.includes('suction') ? 'Pipe' : stype.includes('discharge') ? 'Duct' : 'Tray';
      return {
        system_id: id, system_type: sysType, raw_type: stype, description: desc,
        profile_type: 'circular', size: { diameter_mm: dia }, waypoints: wps, segments: segs,
      };
    }

    const routes = [];
    (data.routes || []).forEach(r => {
      routes.push(makeRoute(r.id, r.system_type, r.description || r.id, r.path, r.profile.diameter_mm));
      (r.branches || []).forEach(br => routes.push(
        makeRoute(br.branch_id, r.system_type + '_br', 'Branch → ' + (br.to || ''),
          br.path, br.profile?.diameter_mm || r.profile.diameter_mm)
      ));
    });

    const scene = {
      format: 'swc',
      meta: {
        project: data._metadata?.project,
        system: data._metadata?.system,
        deck: data._metadata?.deck,
        total_clashes: 0, total_rule_violations: 0,
        cos_object_count: cos.length, system_count: routes.length,
        engineering_rules: data.engineering_rules_applied || [],
      },
      cos_objects: cos, routes,
      clashes: [], clash_segment_keys: [], clashing_cos_oids: [], rule_violations: [],
    };

    return ClashEngine.applyToScene(scene);
  }

  // ── TIER 3: AI UNIVERSAL CONVERTER ──────────────────────────────────

  async function aiConvert(data, fname, onLog) {
    onLog('No known schema matched — calling AI universal converter...', 'detect');

    const keys = Object.keys(Array.isArray(data) ? { array: data } : data).slice(0, 20);
    const sample = {};
    keys.forEach(k => {
      const v = data[k];
      if (Array.isArray(v))       sample[k] = v.slice(0, 2);
      else if (typeof v === 'object' && v !== null) sample[k] = v;
      else                        sample[k] = v;
    });

    const prompt = `You are a CAD data engineer. Convert this JSON file to a normalized 3D routing scene.

FILE: ${fname}
TOP-LEVEL KEYS: ${JSON.stringify(keys)}
SAMPLE DATA (first 2 items of arrays):
${JSON.stringify(sample, null, 1).substring(0, 3500)}

Analyze the data and:
1. Identify what kind of CAD/engineering data this is
2. Map 3D objects/equipment to cos_objects with bounding boxes (in METRES)
3. Map routing paths (pipes/ducts/cables/trays) to routes with waypoints
4. Extract any engineering rules or constraints

If coordinates appear to be in mm, convert to metres (divide by 1000).
If no bounding boxes exist, estimate from position + typical equipment size.
For routes without explicit waypoints, extract from path/geometry fields.

Return ONLY valid compact JSON (no markdown, no backticks):
{
  "detected_format": "description of file type",
  "confidence": "HIGH|MEDIUM|LOW",
  "schema_notes": "how fields were mapped",
  "scene": {
    "meta": { "project": "name or Unknown", "system": "description", "total_clashes": 0, "total_rule_violations": 0, "cos_object_count": 0, "system_count": 0, "engineering_rules": [] },
    "cos_objects": [{ "oid": "id", "name": "display name", "type": "equipment|structure|wall|zone", "has_clash": false, "bounds": {"min_x":0,"min_y":0,"min_z":0,"max_x":1,"max_y":1,"max_z":1} }],
    "routes": [{ "system_id": "id", "system_type": "Pipe|Duct|Tray", "description": "what this is", "profile_type": "circular|rectangular", "size": {"diameter_mm": 100}, "waypoints": [{"x":0,"y":0,"z":0}], "segments": [{"seg_index":0,"bounds":{"min_x":0,"min_y":0,"min_z":0,"max_x":1,"max_y":1,"max_z":1},"length_m":1.0}] }],
    "clashes": [], "clash_segment_keys": [], "clashing_cos_oids": [], "rule_violations": []
  }
}`;

    const resp = await API.call([{ role: 'user', content: prompt }], 4096);
    const raw = resp;
    const si = raw.indexOf('{'), ei = raw.lastIndexOf('}');
    if (si < 0 || ei < 0) throw new Error('AI returned no valid JSON');
    const result = JSON.parse(raw.substring(si, ei + 1));

    if (!result.scene) throw new Error('AI conversion returned no scene');

    const scene = result.scene;
    // Rebuild segments from waypoints if missing
    (scene.routes || []).forEach(r => {
      if (!r.segments || r.segments.length === 0) {
        r.segments = ClashEngine.rebuildSegments(r);
      }
    });

    scene.format = 'ai_converted';
    ClashEngine.applyToScene(scene);

    return {
      scene,
      detectedFormat: result.detected_format || 'Unknown',
      confidence: result.confidence || 'LOW',
      schemaNotes: result.schema_notes || '',
    };
  }

  // ── MAIN ENTRY POINT ─────────────────────────────────────────────────

  /**
   * Parse any JSON text into a normalised scene.
   * @param {string} text    - raw file content
   * @param {string} fname   - filename (for context)
   * @param {function} onLog - log callback (msg, type)
   * @returns {Promise<{scene, schemaInfo}>}
   */
  async function parse(text, fname, onLog = () => {}) {
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new Error('Invalid JSON: ' + e.message.substring(0, 80));
    }

    const fields = Object.keys(Array.isArray(data) ? { array: data } : data).slice(0, 15);
    const detected = detectSchema(data);

    if (detected) {
      onLog(`Schema detected: ${detected.fmt} (confidence: ${detected.confidence})`, 'detect');

      // HIGH confidence — convert directly
      if (detected.confidence === 'HIGH') {
        let scene;
        if (detected.fmt === 'scene_json') scene = convertScene(data);
        else if (detected.fmt === 'swc')   scene = convertSWC(data);
        else {
          // Other HIGH confidence formats — fall through to AI
          const res = await aiConvert(data, fname, onLog);
          return { scene: res.scene, schemaInfo: { ...detected, ...res } };
        }
        return { scene, schemaInfo: { ...detected, fields } };
      }
    }

    // MEDIUM / LOW / unknown — use AI
    const res = await aiConvert(data, fname, onLog);
    return {
      scene: res.scene,
      schemaInfo: {
        fmt: res.detectedFormat,
        confidence: res.confidence,
        desc: res.schemaNotes,
        fields,
      },
    };
  }

  return { parse, detectSchema };
})();
