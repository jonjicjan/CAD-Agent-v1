/**
 * app.js — Main Application Controller
 *
 * Owns all state, orchestrates Parser → ClashEngine → API → Viewer3D → UI.
 * Exposed as a global `App` object for HTML event handlers.
 */

const App = (() => {

  // ── STATE ────────────────────────────────────────────────────────────
  const state = {
    scene:      null,   // normalised scene object
    result:     null,   // AI analysis result
    schemaInfo: null,   // detected schema metadata
    fileName:   '',
    kb:         [],     // knowledge base rules
    consoleOpen: false,
  };

  // ── ANALYSIS STEP LABELS ─────────────────────────────────────────────
  const STEPS = [
    'Reading file structure...',
    'Detecting schema format...',
    'Parsing coordinate system...',
    'Building occupancy map...',
    'Running AABB clash detection...',
    'Checking engineering rule compliance...',
    'Evaluating profile sizing...',
    'Auditing routing corridors...',
    'Generating corrected waypoints...',
    'Compiling engineering report...',
  ];

  // ── NAVIGATION ───────────────────────────────────────────────────────
  function goTab(tabId) {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    const tabEl  = document.getElementById(`tab-${tabId}`);
    const pageEl = document.getElementById(`page-${tabId}`);
    if (tabEl)  tabEl.classList.add('active');
    if (pageEl) pageEl.classList.add('active');
    // Delay viewer init to let DOM paint
    if (tabId === 'viewer') setTimeout(initViewer, 80);
  }

  // ── CONSOLE TOGGLE ───────────────────────────────────────────────────
  function toggleConsole() {
    state.consoleOpen = !state.consoleOpen;
    const log    = document.getElementById('console-log');
    const toggle = document.getElementById('console-toggle');
    if (log)    log.classList.toggle('open', state.consoleOpen);
    if (toggle) toggle.textContent = state.consoleOpen ? '▴' : '▾';
  }

  function openConsole() {
    if (!state.consoleOpen) toggleConsole();
  }

  // ── FILE INPUT ───────────────────────────────────────────────────────
  function onFileSelected(file) {
    if (!file) return;
    UI.clearError();
    UI.hideSchemaPanel();
    state.fileName = file.name;
    UI.setDropZone('detecting', file.name, 'Reading file…', '', '');
    openConsole();
    UI.setProgress(5);
    UI.log(`File loaded: ${file.name} (${(file.size / 1024).toFixed(1)} KB)`);

    file.text().then(text => handleFileText(text, file.name))
      .catch(err => {
        UI.setDropZone('failed', file.name, '', '', err.message);
        UI.showError(err.message);
      });
  }

  async function handleFileText(text, fname) {
    try {
      UI.log('Running schema detection…', 'detect');
      UI.setStatus('Detecting…', 'detecting');
      UI.setDot('detecting');

      const { scene, schemaInfo } = await Parser.parse(text, fname, UI.log);
      state.scene      = scene;
      state.schemaInfo = schemaInfo;

      UI.setProgress(30);
      UI.setDropZone(
        'done', fname,
        `${(scene.cos_objects || []).length} objects · ${(scene.routes || []).length} routes`,
        `Format: ${(scene.format || '?').replace(/_/g, ' ')} · ${(scene.clashes || []).length} clashes detected`,
        ''
      );
      UI.log(
        `Converted: ${(scene.cos_objects || []).length} objects, ` +
        `${(scene.routes || []).length} routes, ${(scene.clashes || []).length} clashes`,
        'success'
      );
      UI.showSchemaPanel(schemaInfo);

      await runAnalysis(scene, fname);

    } catch (err) {
      UI.setDropZone('failed', fname, '', '', err.message);
      UI.showError(err.message);
      UI.log('Error: ' + err.message, 'error');
      UI.setDot('error');
    }
  }

  // ── ANALYSIS PIPELINE ────────────────────────────────────────────────
  async function runAnalysis(scene, fname) {
    UI.setDot('live');
    UI.setStatus('Analyzing…', 'working');

    for (let i = 0; i < STEPS.length; i++) {
      await sleep(200 + Math.random() * 180);
      UI.setProgress(30 + ((i + 1) / STEPS.length) * 70);
      UI.log(STEPS[i]);
    }

    const committedKBRules = state.kb
      .filter(r => r.status === 'committed')
      .map(r => r.desc);

    try {
      UI.log('Running AI engineering analysis…');
      const result = await API.analyseScene(scene, fname, committedKBRules);

      // Apply corrected routes
      const changed = {};
      (result.changed_routes || []).forEach(cr => { changed[cr.system_id] = cr.corrected_waypoints; });
      const correctedRoutes = (scene.routes || []).map(r => {
        if (changed[r.system_id]) {
          const wps = changed[r.system_id];
          // Validate that the AI returned a proper array of points
          if (Array.isArray(wps) && wps.length > 1) {
            const isValid = wps.every(wp => 
              typeof wp.x === 'number' && !isNaN(wp.x) && 
              typeof wp.y === 'number' && !isNaN(wp.y) && 
              typeof wp.z === 'number' && !isNaN(wp.z)
            );
            if (isValid) {
              return {
                ...r,
                waypoints: wps,
                segments: ClashEngine.rebuildSegments({ ...r, waypoints: wps }),
              };
            }
          }
          console.warn(`Ignoring invalid corrected_waypoints for ${r.system_id}`, wps);
        }
        return r;
      });

      state.result = result;
      state.scene  = {
        ...scene,
        routes: correctedRoutes,
        meta: {
          ...scene.meta,
          system_count: correctedRoutes.length,
          total_clashes: (scene.clashes || []).length,
        },
      };

      // Auto-import project engineering rules
      const projRules = scene.meta?.engineering_rules || [];
      if (projRules.length && !state.kb.find(r => r.src === 'project')) {
        projRules.forEach((r, i) => state.kb.push({
          id:       `PROJ-${String(i + 1).padStart(3, '0')}`,
          desc:     typeof r === 'string' ? r : JSON.stringify(r),
          priority: 'HIGH',
          type:     'GENERAL',
          src:      'project',
          status:   'committed',
        }));
      }

      // Add AI-suggested rules as pending
      (result.suggested_kb_rules || []).forEach((r, i) => {
        const desc = typeof r === 'string' ? r : (r.description || r.rule || JSON.stringify(r));
        state.kb.push({
          id:       `AUTO-${String(i + 1).padStart(3, '0')}`,
          desc,
          priority: 'MEDIUM',
          type:     'GENERAL',
          src:      'agent suggestion',
          status:   'pending',
        });
      });

      const n = (result.issues || []).length;
      UI.log(`Analysis complete — ${n} issue(s) found.`, 'success');
      UI.setDot('done');
      UI.setStatus('Done', 'done');

      // Update UI
      UI.renderResults(result, state.scene, state.schemaInfo);
      UI.renderKB(state.kb);
      UI.unlockExports();

      // Update issues badge
      const badge = document.getElementById('badge-issues');
      if (badge) { badge.textContent = n; badge.style.display = n ? 'inline-flex' : 'none'; }

    } catch (err) {
      UI.log('Analysis error: ' + err.message, 'error');
      UI.showError(err.message);
    }
  }

  // ── 3D VIEWER ────────────────────────────────────────────────────────
  function initViewer() {
    if (typeof THREE === 'undefined') {
      UI.showError('Three.js library failed to load. Check your internet connection.');
      return;
    }
    if (!state.scene) {
      // Show empty state with demo button
      return;
    }

    const canvas = document.getElementById('three-canvas');
    if (!canvas) return;

    canvas.style.display = 'block';
    document.getElementById('viewer-toolbar').style.display  = 'flex';
    document.getElementById('viewer-legend').style.display   = 'block';
    document.getElementById('viewer-hint').style.display     = 'block';
    document.getElementById('viewer-empty').style.display    = 'none';

    Viewer3D.init(canvas, state.scene);
  }

  async function loadDemoScene() {
    UI.log('Loading demo scene (INS MPV 18000)…');
    openConsole();
    try {
      const resp = await fetch('data/demo_scene.json');
      if (!resp.ok) throw new Error('Demo file not found');
      const scene = await resp.json();
      state.scene = scene;
      state.fileName = 'demo_scene.json';

      // Import engineering rules
      const pRules = scene.meta?.engineering_rules || [];
      if (pRules.length && !state.kb.find(r => r.src === 'project')) {
        pRules.forEach((r, i) => state.kb.push({
          id: `PROJ-${String(i + 1).padStart(3, '0')}`,
          desc: typeof r === 'string' ? r : JSON.stringify(r),
          priority: 'HIGH', type: 'GENERAL', src: 'project', status: 'committed',
        }));
      }
      UI.renderKB(state.kb);
      UI.unlockExports();
      UI.setStatus('Demo loaded', 'done');
      UI.log(`Demo loaded: ${(scene.cos_objects || []).length} objects, ${(scene.routes || []).length} routes, ${(scene.clashes || []).length} clashes`, 'success');

      // Switch to viewer
      goTab('viewer');
    } catch (err) {
      UI.log('Could not load demo: ' + err.message, 'error');
      UI.showError('Could not load demo scene: ' + err.message);
    }
  }

  // ── VIEWER CONTROLS ──────────────────────────────────────────────────
  function viewerToggleAsis() {
    const { showAsis } = Viewer3D.toggleLayer('asis');
    const btn = document.getElementById('vbtn-asis');
    if (btn) btn.classList.toggle('active', showAsis);
  }

  function viewerToggleRoutes() {
    const { showRoutes } = Viewer3D.toggleLayer('routes');
    const btn = document.getElementById('vbtn-routes');
    if (btn) btn.classList.toggle('active', showRoutes);
  }

  function viewerToggleWire() {
    const wireMode = Viewer3D.toggleWireframe();
    const btn = document.getElementById('vbtn-wire');
    if (btn) btn.classList.toggle('active', wireMode);
  }

  function viewerResetCam() { Viewer3D.resetCamera(); }

  // ── KNOWLEDGE BASE ───────────────────────────────────────────────────
  function commitKB(index) {
    if (state.kb[index]) state.kb[index].status = 'committed';
    UI.renderKB(state.kb);
  }

  function deleteKB(index) {
    state.kb.splice(index, 1);
    UI.renderKB(state.kb);
  }

  function openAddRuleForm()  { document.getElementById('kb-add-form').classList.add('open'); }
  function closeAddRuleForm() { document.getElementById('kb-add-form').classList.remove('open'); }

  function saveRule() {
    const desc = document.getElementById('form-desc').value.trim();
    if (!desc) { document.getElementById('form-desc').focus(); return; }
    const id = document.getElementById('form-id').value.trim() ||
               `R-${String(state.kb.length + 1).padStart(3, '0')}`;
    state.kb.push({
      id,
      desc,
      priority: document.getElementById('form-priority').value,
      type:     document.getElementById('form-type').value,
      src:      document.getElementById('form-source').value.trim() || 'Manual entry',
      status:   'committed',
    });
    document.getElementById('form-id').value    = '';
    document.getElementById('form-desc').value  = '';
    document.getElementById('form-source').value = '';
    closeAddRuleForm();
    UI.renderKB(state.kb);
  }

  // ── EXPORT ───────────────────────────────────────────────────────────
  function doExport(format) {
    Exporter.exportFile(format, {
      scene:    state.scene,
      result:   state.result,
      kb:       state.kb,
      fileName: state.fileName,
    });
  }

  // ── DROP ZONE EVENTS ─────────────────────────────────────────────────
  function initDropZone() {
    const dz = document.getElementById('drop-zone');
    const fi = document.getElementById('file-input');
    if (!dz || !fi) return;

    fi.addEventListener('change', e => {
      if (e.target.files[0]) onFileSelected(e.target.files[0]);
    });
    dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag'); });
    dz.addEventListener('dragleave', () => { if (!dz.classList.contains('done')) dz.classList.remove('drag'); });
    dz.addEventListener('drop', e => {
      e.preventDefault(); dz.classList.remove('drag');
      if (e.dataTransfer.files[0]) onFileSelected(e.dataTransfer.files[0]);
    });
  }

  // ── UTILS ─────────────────────────────────────────────────────────────
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ── INIT ─────────────────────────────────────────────────────────────
  function init() {
    initDropZone();
    UI.renderKB(state.kb);
    // Set initial button states on viewer
    const vba = document.getElementById('vbtn-asis');
    const vbt = document.getElementById('vbtn-routes');
    if (vba) vba.classList.add('active');
    if (vbt) vbt.classList.add('active');
  }

  // Public API
  return {
    init,
    goTab,
    toggleConsole,
    loadDemoScene,
    viewerToggleAsis,
    viewerToggleRoutes,
    viewerToggleWire,
    viewerResetCam,
    commitKB,
    deleteKB,
    openAddRuleForm,
    closeAddRuleForm,
    saveRule,
    doExport,
  };
})();

// Boot when DOM is ready
document.addEventListener('DOMContentLoaded', () => App.init());
