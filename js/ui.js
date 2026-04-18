/**
 * ui.js — UI Rendering Module
 * Renders Results, KB panel, Schema Detection panel, and export state.
 * All functions are pure DOM mutations — no side effects on app state.
 */

const UI = (() => {

  const SEV_CLASS = { CRITICAL: 'C', HIGH: 'H', MEDIUM: 'M', LOW: 'L' };
  const TYPE_ICON = {
    CLASH: '⊗', RULE_VIOLATION: '⚑',
    PROFILE_ERROR: '◎', ROUTING_ERROR: '↯', MISSING_DATA: '?',
  };

  // ── HELPERS ─────────────────────────────────────────────────────────
  const $ = id => document.getElementById(id);
  function safe(s) { return (s || '').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  // ── CONSOLE LOG ─────────────────────────────────────────────────────
  function log(msg, type = '') {
    const el  = $('console-log');
    if (!el) return;
    const div = document.createElement('div');
    div.className = `log-line ${type === 'success' ? 'success' : type === 'error' ? 'error' : type === 'detect' ? 'detect' : ''}`;
    const glyph = type === 'success' ? '✓' : type === 'error' ? '✕' : type === 'detect' ? '◈' : '▸';
    div.innerHTML = `<span style="opacity:.4">${glyph}</span><span>${safe(msg)}</span>`;
    el.appendChild(div);
    el.scrollTop = 9999;
  }

  function clearLog() {
    const el = $('console-log');
    if (el) el.innerHTML = '';
  }

  // ── PROGRESS BAR ────────────────────────────────────────────────────
  function setProgress(pct) {
    const el = $('progress-fill');
    if (el) el.style.width = `${Math.min(100, pct)}%`;
  }

  // ── STATUS PILL ─────────────────────────────────────────────────────
  function setStatus(text, cls) {
    const el = $('status-pill');
    if (!el) return;
    el.textContent = text;
    el.className = `status-pill ${cls}`;
  }

  // ── DOT INDICATOR ───────────────────────────────────────────────────
  function setDot(state) {
    const el = $('console-dot');
    if (el) el.className = `dot ${state}`;
  }

  // ── GLOBAL ERROR TOAST ───────────────────────────────────────────────
  function showError(msg) {
    const t = $('g-toast');
    if (!t) return;
    $('g-toast-text').textContent = msg;
    t.style.display = 'block';
    setStatus('Error', 'error');
    setDot('error');
  }

  function clearError() {
    const t = $('g-toast');
    if (t) t.style.display = 'none';
  }

  // ── DROP ZONE STATE ──────────────────────────────────────────────────
  function setDropZone(state, title, sub, file, err) {
    const dz = $('drop-zone');
    if (!dz) return;
    dz.className = `drop-zone ${state}`;
    if (title !== undefined) $('dz-title').textContent = title;
    if (sub   !== undefined) $('dz-sub').textContent   = sub;
    if (file  !== undefined) $('dz-file').textContent  = file;
    if (err   !== undefined) {
      const e = $('dz-err');
      if (e) { e.textContent = err; e.style.display = err ? 'block' : 'none'; }
    }
  }

  // ── SCHEMA DETECTION PANEL ──────────────────────────────────────────
  function showSchemaPanel(info) {
    const panel = $('schema-panel');
    if (!panel) return;
    panel.classList.add('visible');

    const badge = $('sp-badge');
    badge.textContent = info.confidence ? `${info.type} — ${info.confidence}` : info.type;
    badge.className   = `sp-badge ${info.type === 'known' ? 'known' : info.type === 'ai' ? 'ai' : 'warn'}`;
    $('sp-title').textContent = info.fmt || info.detectedFormat || 'Detected format';
    $('sp-body').textContent  = info.desc || info.schemaNotes || '';

    const fieldsEl = $('sp-fields');
    fieldsEl.innerHTML = '';
    (info.fields || []).forEach(f => {
      const span = document.createElement('span');
      span.className = 'sp-field matched';
      span.textContent = f;
      fieldsEl.appendChild(span);
    });
  }

  function hideSchemaPanel() {
    const panel = $('schema-panel');
    if (panel) panel.classList.remove('visible');
  }

  // ── RESULTS PAGE ────────────────────────────────────────────────────
  function renderResults(result, scene, schemaInfo) {
    const container = $('results-body');
    if (!container) return;

    const issues  = result.issues || [];
    const crit    = issues.filter(i => i.severity === 'CRITICAL').length;
    const high    = issues.filter(i => i.severity === 'HIGH').length;
    const fixed   = issues.filter(i => i.fix_applied).length;
    const clashes = (scene.clashes || []).length;

    let html = `
      <div class="stat-grid">
        <div class="stat-card">
          <div class="stat-label">Issues found</div>
          <div class="stat-value">${issues.length}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Critical</div>
          <div class="stat-value" style="color:${crit ? '#ef4444' : '#22c55e'}">${crit}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">AABB clashes</div>
          <div class="stat-value" style="color:${clashes ? '#f97316' : '#22c55e'}">${clashes}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Fixes applied</div>
          <div class="stat-value" style="color:#22c55e">${fixed}</div>
        </div>
      </div>`;

    if (result.summary) {
      html += `<div class="summary-box">${safe(result.summary)}</div>`;
    }

    if (schemaInfo) {
      const sib = $('schema-info-bar');
      if (sib) {
        sib.classList.add('visible');
        sib.innerHTML = `<span style="color:#93c5fd">Format detected:</span> ${safe(schemaInfo.fmt || schemaInfo.detectedFormat || '')} — ${safe(schemaInfo.desc || schemaInfo.schemaNotes || '')}`;
      }
    }

    html += `<div class="issues-title">Issues identified</div><div class="issues-list">`;

    if (!issues.length) {
      html += `<div style="text-align:center;padding:20px;color:#22c55e;font-size:12px">✓ No issues found — routing is clean</div>`;
    } else {
      issues.forEach(iss => {
        const cls = SEV_CLASS[iss.severity] || 'L';
        const icon = TYPE_ICON[iss.type] || '·';
        html += `
          <div class="issue-card ${cls}">
            <div class="issue-top">
              <span class="sev-dot"></span>
              <span class="sev-label">${safe(iss.severity || 'LOW')}</span>
              <span class="issue-type">${icon} ${safe((iss.type || '').replace(/_/g, ' '))}</span>
              ${iss.system_id ? `<span class="issue-sid">${safe(iss.system_id)}</span>` : ''}
            </div>
            <div class="issue-desc">${safe(iss.description || '')}</div>
            ${iss.fix_applied
              ? `<div class="issue-fix"><span style="opacity:.5">→</span><span>${safe(iss.fix_applied)}</span></div>`
              : ''}
          </div>`;
      });
    }
    html += `</div>`;

    if (result.engineering_notes) {
      html += `
        <div class="eng-notes-box">
          <div class="eng-notes-title">Engineering notes</div>
          <div class="eng-notes-text">${safe(result.engineering_notes)}</div>
        </div>`;
    }

    container.innerHTML = html;

    // Update results badge
    const bid = $('badge-issues');
    if (bid) { bid.textContent = issues.length; bid.style.display = issues.length ? 'inline-flex' : 'none'; }
  }

  // ── KNOWLEDGE BASE PANEL ─────────────────────────────────────────────
  function renderKB(kbRules, callbacks) {
    const safeRules = Array.isArray(kbRules) ? kbRules : [];
    const pending  = safeRules.filter(r => r && r.status === 'pending').length;
    const countEl  = $('kb-count');
    const badgeEl  = $('badge-kb');
    const noticeEl = $('kb-pending-notice');
    const listEl   = $('kb-list');

    if (countEl)  countEl.textContent = safeRules.length + ' rules';
    if (badgeEl)  badgeEl.textContent = safeRules.length;
    if (noticeEl) noticeEl.style.display = pending ? 'block' : 'none';

    if (!listEl) return;

    if (!safeRules.length) {
      listEl.innerHTML = '<div style="text-align:center;padding:24px;color:#334155;font-size:11px">No rules yet. Upload a file or add manually.</div>';
      return;
    }

    listEl.innerHTML = safeRules.map((r, i) => {
      if (!r) return '';
      return `
      <div class="kb-item ${r.status}">
        <span class="kb-priority ${r.priority}">${r.priority}</span>
        <div class="kb-body-text">
          <div class="kb-id-text">[${safe(r.id)}]</div>
          <div class="kb-desc-text">${safe(r.desc)}</div>
          <div class="kb-src-text">${safe(r.src || '')}</div>
        </div>
        <div class="kb-actions">
          ${r.status === 'pending'
            ? `<button class="btn-commit" onclick="App.commitKB(${i})">Commit ✓</button>`
            : ''}
          ${r.status === 'committed'
            ? `<span class="committed-tag">✓</span>`
            : ''}
          <button class="btn-delete" onclick="App.deleteKB(${i})">✕</button>
        </div>
      </div>`;
    }).join('');
  }

  // ── EXPORT UNLOCK ────────────────────────────────────────────────────
  function unlockExports() {
    ['x-json', 'x-dxf', 'x-ifc', 'x-csv', 'x-txt'].forEach(id => {
      const el = $(id);
      if (el) el.disabled = false;
    });
    const note = $('export-note');
    if (note) note.textContent = 'Corrected model ready. All formats include applied fixes from the analysis.';
  }

  return {
    log, clearLog, setProgress, setStatus, setDot,
    showError, clearError,
    setDropZone, showSchemaPanel, hideSchemaPanel,
    renderResults, renderKB, unlockExports,
  };
})();
