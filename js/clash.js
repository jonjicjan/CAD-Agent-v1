/**
 * clash.js — AABB Bounding Box Clash Detection Engine
 * Checks every route segment against every COS object.
 * O(segments × objects) — for large scenes use spatial grid partitioning.
 */

const ClashEngine = (() => {

  /**
   * Returns true if two axis-aligned bounding boxes intersect.
   */
  function intersects(a, b) {
    return (
      a.min_x < b.max_x && a.max_x > b.min_x &&
      a.min_y < b.max_y && a.max_y > b.min_y &&
      a.min_z < b.max_z && a.max_z > b.min_z
    );
  }

  /**
   * Compute the volume of intersection of two AABBs.
   */
  function overlapVolume(a, b) {
    const ox = Math.max(0, Math.min(a.max_x, b.max_x) - Math.max(a.min_x, b.min_x));
    const oy = Math.max(0, Math.min(a.max_y, b.max_y) - Math.max(a.min_y, b.min_y));
    const oz = Math.max(0, Math.min(a.max_z, b.max_z) - Math.max(a.min_z, b.min_z));
    return parseFloat((ox * oy * oz).toFixed(6));
  }

  /**
   * Build AABB for a single route segment.
   * @param {object} wp1 - start waypoint {x, y, z}
   * @param {object} wp2 - end waypoint {x, y, z}
   * @param {number} radius - profile half-extent in metres
   */
  function segmentBbox(wp1, wp2, radius) {
    const r = radius || 0.05;
    return {
      min_x: Math.min(wp1.x, wp2.x) - r,
      min_y: Math.min(wp1.y, wp2.y) - r,
      min_z: Math.min(wp1.z, wp2.z) - r,
      max_x: Math.max(wp1.x, wp2.x) + r,
      max_y: Math.max(wp1.y, wp2.y) + r,
      max_z: Math.max(wp1.z, wp2.z) + r,
    };
  }

  /**
   * Get profile radius in metres from a route definition.
   */
  function profileRadius(route) {
    if (route.profile_type === 'circular') {
      return ((route.size && route.size.diameter_mm) || 100) / 2 / 1000;
    }
    // rectangular — use max half-dimension as conservative radius
    if (route.size) {
      return Math.max(route.size.width_mm || 100, route.size.height_mm || 100) / 2 / 1000;
    }
    return 0.05;
  }

  /**
   * Rebuild segment bounding boxes for a route from its waypoints.
   */
  function rebuildSegments(route) {
    const r = profileRadius(route);
    const wps = route.waypoints || [];
    return wps.slice(0, -1).map((a, i) => {
      const b = wps[i + 1];
      return {
        seg_index: i,
        bounds: segmentBbox(a, b, r),
        length_m: parseFloat(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z).toFixed(3)),
      };
    });
  }

  /**
   * Main clash detection.
   * Skips zones and (optionally) connection equipment.
   * Minimum overlap volume threshold filters out tiny floating-point touches.
   *
   * @param {Array} routes      - array of route objects with segments[]
   * @param {Array} cosObjects  - array of COS objects with bounds
   * @param {number} minVol     - minimum overlap volume to report (m³)
   * @returns {{ clashes, clashKeys, clashOids }}
   */
  function detect(routes, cosObjects, minVol = 0.0005) {
    const clashes = [];
    const clashKeys = new Set();
    const clashOids = new Set();

    const checkObjects = cosObjects.filter(o => o.type !== 'zone');

    for (const route of routes) {
      const segments = route.segments || rebuildSegments(route);
      for (const seg of segments) {
        if (!seg.bounds) continue;
        for (const obj of checkObjects) {
          if (!obj.bounds) continue;
          if (intersects(seg.bounds, obj.bounds)) {
            const vol = overlapVolume(seg.bounds, obj.bounds);
            if (vol >= minVol) {
              const key = `${route.system_id}::${seg.seg_index}`;
              clashes.push({
                system_id: route.system_id,
                seg_index: seg.seg_index,
                start_wp: (route.waypoints || [])[seg.seg_index] || {},
                end_wp: (route.waypoints || [])[seg.seg_index + 1] || {},
                clashing_oid: obj.oid,
                clashing_name: obj.name,
                overlap_volume: vol,
              });
              clashKeys.add(key);
              clashOids.add(obj.oid);
            }
          }
        }
      }
    }

    return { clashes, clashKeys, clashOids };
  }

  /**
   * Apply detected clash data to a scene object (mutates).
   */
  function applyToScene(scene) {
    if (!scene || !scene.routes || !scene.cos_objects) return scene;
    const checkObjects = scene.cos_objects.filter(o => o.type !== 'zone');
    const { clashes, clashKeys, clashOids } = detect(scene.routes, checkObjects);

    scene.cos_objects.forEach(o => { o.has_clash = clashOids.has(o.oid); });
    scene.clashes = clashes;
    scene.clash_segment_keys = [...clashKeys];
    scene.clashing_cos_oids = [...clashOids];
    if (scene.meta) scene.meta.total_clashes = clashes.length;

    return scene;
  }

  return { detect, applyToScene, rebuildSegments, profileRadius, segmentBbox };
})();
