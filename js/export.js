/**
 * export.js — File Export Module
 * Generates downloadable files in DXF, IFC, CSV, TXT, JSON and KB formats.
 */

const Exporter = (() => {

  function download(content, filename, mime) {
    const blob = new Blob([content], { type: mime });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 800);
  }

  // ── DXF ─────────────────────────────────────────────────────────────
  function toDXF(routes) {
    const LAYERS = { Pipe: 'PIPE_ROUTES', Duct: 'DUCT_ROUTES', Tray: 'TRAY_ROUTES' };
    const COLORS = { Pipe: 5, Duct: 3, Tray: 30 };
    let entities = '';

    (routes || []).forEach(r => {
      const layer = LAYERS[r.system_type] || 'CAD_ROUTES';
      const color = COLORS[r.system_type] || 7;
      const wps   = r.waypoints || [];
      for (let i = 0; i < wps.length - 1; i++) {
        const a = wps[i], b = wps[i + 1];
        entities +=
          `  0\nLINE\n  8\n${layer}\n 62\n${color}\n` +
          ` 10\n${a.x.toFixed(4)}\n 20\n${a.y.toFixed(4)}\n 30\n${a.z.toFixed(4)}\n` +
          ` 11\n${b.x.toFixed(4)}\n 21\n${b.y.toFixed(4)}\n 31\n${b.z.toFixed(4)}\n`;
      }
    });

    return (
      `  0\nSECTION\n  2\nHEADER\n  9\n$ACADVER\n  1\nAC1015\n  0\nENDSEC\n` +
      `  0\nSECTION\n  2\nENTITIES\n${entities}  0\nENDSEC\n  0\nEOF\n`
    );
  }

  // ── IFC ─────────────────────────────────────────────────────────────
  function toIFC(routes, meta) {
    const ts   = new Date().toISOString();
    const proj = (meta?.project || 'CAD Project').substring(0, 60);
    let items  = '';

    (routes || []).forEach((r, i) => {
      const id  = i + 100;
      const pts = (r.waypoints || [])
        .map(p => `IFCCARTESIANPOINT((${p.x.toFixed(3)},${p.y.toFixed(3)},${p.z.toFixed(3)}))`)
        .join(',');
      if (!pts) return;
      const name = (r.description || r.system_id || '').substring(0, 40);
      items += `#${id}= IFCPOLYLINE((${pts}));\n`;
      items += `#${id + 50}= IFCANNOTATION('${r.system_id}','${name}',#${id});\n`;
    });

    return (
      `ISO-10303-21;\n` +
      `HEADER;\nFILE_DESCRIPTION(('${proj}'),'2;1');\n` +
      `FILE_NAME('corrected_model.ifc','${ts}',('CAD Agent'),('Anthropic'),'IFC4','','');\n` +
      `FILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n${items}ENDSEC;\nEND-ISO-10303-21;\n`
    );
  }

  // ── CSV ─────────────────────────────────────────────────────────────
  function toCSV(issues) {
    const esc = s => `"${(s || '').replace(/"/g, '""')}"`;
    const header = 'ID,Severity,Type,System ID,Description,Fix Applied\n';
    const rows   = (issues || []).map(i =>
      [esc(i.id), esc(i.severity), esc(i.type), esc(i.system_id), esc(i.description), esc(i.fix_applied)].join(',')
    );
    return header + rows.join('\n');
  }

  // ── TXT Engineering Report ──────────────────────────────────────────
  function toTXT(result, meta) {
    const sep  = '='.repeat(60);
    const sep2 = '-'.repeat(40);
    const lines = [
      sep,
      '  CAD ENGINEERING CORRECTION REPORT',
      sep,
      `  Project  : ${meta?.project || 'Unknown'}`,
      `  System   : ${meta?.system || 'Unknown'}`,
      `  Generated: ${new Date().toLocaleString()}`,
      sep,
      '',
      'EXECUTIVE SUMMARY',
      sep2,
      result.summary || 'No summary provided.',
      '',
      'ISSUES FOUND',
      sep2,
      ...(result.issues || []).flatMap((iss, n) => [
        `[${n + 1}] [${iss.severity}] ${iss.type}  —  ${iss.system_id || ''}`,
        `    Problem : ${iss.description}`,
        `    Fix     : ${iss.fix_applied || 'N/A'}`,
        '',
      ]),
      'ENGINEERING NOTES',
      sep2,
      result.engineering_notes || 'None.',
      '',
      sep,
    ];
    return lines.join('\n');
  }

  // ── KNOWLEDGE BASE JSON ─────────────────────────────────────────────
  function toKBJSON(kbRules) {
    const committed = (kbRules || []).filter(r => r.status === 'committed');
    return JSON.stringify({
      version: '1.1',
      exported: new Date().toISOString(),
      rule_count: committed.length,
      rules: committed.map(({ id, desc, priority, type, src }) => ({
        id, description: desc, priority, type, source: src,
      })),
    }, null, 2);
  }

  // ── PUBLIC DOWNLOAD DISPATCHER ──────────────────────────────────────
  function exportFile(format, state) {
    const { scene, result, kb, fileName } = state;
    const base = (fileName || 'model').replace(/\.[^.]+$/, '') + '_corrected';
    const meta = scene?.meta || {};

    switch (format) {
      case 'json':
        if (!scene) return;
        download(JSON.stringify(scene, null, 2), `${base}.json`, 'application/json');
        break;

      case 'dxf':
        if (!scene) return;
        download(toDXF(scene.routes), `${base}.dxf`, 'application/octet-stream');
        break;

      case 'ifc':
        if (!scene) return;
        download(toIFC(scene.routes, meta), `${base}.ifc`, 'application/octet-stream');
        break;

      case 'csv':
        if (!result) return;
        download(toCSV(result.issues), `${base}_issues.csv`, 'text/csv');
        break;

      case 'txt':
        if (!result) return;
        download(toTXT(result, meta), `${base}_report.txt`, 'text/plain');
        break;

      case 'kb':
        download(toKBJSON(kb), 'knowledge_base.json', 'application/json');
        break;

      default:
        console.warn('Unknown export format:', format);
    }
  }

  return { exportFile, toDXF, toIFC, toCSV, toTXT, toKBJSON };
})();
