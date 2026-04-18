/**
 * viewer3d.js — Three.js 3D Viewer
 * Renders COS objects, routed systems, and clash highlights.
 * CAD coordinate system: X=East, Y=North, Z=Up
 * Three.js:              X=East, Y=Up,   Z=South  → swap Y↔Z
 */

const Viewer3D = (() => {

  // Three.js globals
  let renderer = null, camera = null, scene = null;
  let cosGroup  = null, routeGroup = null;

  // Camera controls
  let isDragging = false, isRightClick = false;
  let prevMouse  = { x: 0, y: 0 };
  let spherical  = { theta: 0.8, phi: 1.0, radius: 30 };
  let target     = null;

  // Display state
  let wireMode   = false;
  let showAsis   = true;
  let showRoutes = true;

  // Colour maps
  const ROUTE_FILL  = { Pipe: 0x1e3a8a, Duct: 0x14532d, Tray: 0x78350f };
  const ROUTE_EDGE  = { Pipe: 0x60a5fa, Duct: 0x4ade80,  Tray: 0xfbbf24 };

  // ── COORDINATE TRANSFORM ───────────────────────────────────────────
  function cad2three(x, y, z) {
    // CAD: Z-up → Three.js: Y-up
    return new THREE.Vector3(x, z, y);
  }

  // ── GEOMETRY HELPERS ────────────────────────────────────────────────
  function makeMesh(bounds, mat) {
    if (!bounds) return null;
    const cx = (bounds.min_x + bounds.max_x) / 2;
    const cy = (bounds.min_y + bounds.max_y) / 2;
    const cz = (bounds.min_z + bounds.max_z) / 2;
    const sx = Math.max(bounds.max_x - bounds.min_x, 0.01);
    const sy = Math.max(bounds.max_y - bounds.min_y, 0.01);
    const sz = Math.max(bounds.max_z - bounds.min_z, 0.01);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(sx, sz, sy), mat);
    mesh.position.copy(cad2three(cx, cy, cz));
    return mesh;
  }

  function makeEdges(mesh, color, opacity = 0.6) {
    if (!mesh) return null;
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(mesh.geometry),
      new THREE.LineBasicMaterial({ color, transparent: true, opacity })
    );
    edges.position.copy(mesh.position);
    return edges;
  }

  // ── SCENE BUILD ─────────────────────────────────────────────────────
  function buildCosObjects(data) {
    while (cosGroup.children.length) cosGroup.remove(cosGroup.children[0]);

    (data.cos_objects || []).forEach(obj => {
      if (!obj.bounds) return;
      const isZone  = obj.type === 'zone';
      const isWall  = obj.type === 'wall';
      const isClash = obj.has_clash;

      const color   = isZone ? 0x0d2035 : isClash ? 0x7f1d1d : obj.type === 'equipment' ? 0x1a365d : 0x374151;
      const opacity = isZone ? 0.05 : isClash ? 0.88 : isWall ? 0.2 : 0.72;

      const mat = new THREE.MeshLambertMaterial({
        color, transparent: true, opacity,
        side: isZone ? THREE.BackSide : THREE.FrontSide,
      });

      const mesh = makeMesh(obj.bounds, mat);
      if (!mesh) return;
      cosGroup.add(mesh);

      if (!isZone && !isWall) {
        const edgeColor = isClash ? 0xef4444 : obj.type === 'equipment' ? 0x2b6cb0 : 0x4a5568;
        const edge = makeEdges(mesh, edgeColor, 0.55);
        if (edge) cosGroup.add(edge);
      }
      if (isZone) {
        const edge = makeEdges(mesh, 0x1e3a5f, 0.15);
        if (edge) cosGroup.add(edge);
      }
    });
  }

  function buildRoutes(data) {
    while (routeGroup.children.length) routeGroup.remove(routeGroup.children[0]);

    const clashKeys = new Set(data.clash_segment_keys || []);

    (data.routes || []).forEach(route => {
      const fill = ROUTE_FILL[route.system_type] || 0x1e3a8a;
      const edge = ROUTE_EDGE[route.system_type] || 0x60a5fa;

      // Segment boxes
      (route.segments || []).forEach(seg => {
        if (!seg.bounds) return;
        const isClash = clashKeys.has(`${route.system_id}::${seg.seg_index}`);
        const mat = new THREE.MeshLambertMaterial({
          color: isClash ? 0x7f1d1d : fill,
          transparent: true, opacity: isClash ? 0.88 : 0.72,
        });
        const mesh = makeMesh(seg.bounds, mat);
        if (!mesh) return;
        routeGroup.add(mesh);
        const em = makeEdges(mesh, isClash ? 0xef4444 : edge, 0.65);
        if (em) routeGroup.add(em);
      });

      // Centreline
      const pts = (route.waypoints || []).map(p => cad2three(p.x, p.y, p.z));
      if (pts.length > 1) {
        const geo = new THREE.BufferGeometry().setFromPoints(pts);
        routeGroup.add(new THREE.Line(geo, new THREE.LineBasicMaterial({ color: edge, linewidth: 2 })));
      }
    });
  }

  // ── CAMERA ──────────────────────────────────────────────────────────
  function updateCamera() {
    if (!camera || !target) return;
    camera.position.set(
      target.x + spherical.radius * Math.sin(spherical.phi) * Math.sin(spherical.theta),
      target.y + spherical.radius * Math.cos(spherical.phi),
      target.z + spherical.radius * Math.sin(spherical.phi) * Math.cos(spherical.theta)
    );
    camera.lookAt(target);
  }

  // ── INIT ────────────────────────────────────────────────────────────
  /**
   * Initialise or re-render the viewer.
   * Must be called after the canvas element has layout dimensions.
   * @param {HTMLCanvasElement} canvas
   * @param {object} sceneData — normalised scene object
   */
  function init(canvas, sceneData) {
    if (typeof THREE === 'undefined') throw new Error('Three.js not loaded');
    if (!canvas)     throw new Error('Canvas element not found');
    if (!sceneData)  return;

    const W = canvas.parentElement.offsetWidth  || 800;
    const H = canvas.parentElement.offsetHeight || 450;

    if (!renderer) {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
      renderer.setClearColor(0x060d18);

      scene  = new THREE.Scene();
      target = new THREE.Vector3(7, 2, 5);

      camera = new THREE.PerspectiveCamera(50, W / H, 0.01, 500);
      scene.add(new THREE.AmbientLight(0xffffff, 0.55));
      const dl = new THREE.DirectionalLight(0xffffff, 0.7);
      dl.position.set(15, 20, 10);
      scene.add(dl);

      const grid = new THREE.GridHelper(32, 32, 0x1e293b, 0x1e293b);
      grid.position.set(7, 0, 5);
      scene.add(grid);

      cosGroup   = new THREE.Group();
      routeGroup = new THREE.Group();
      scene.add(cosGroup);
      scene.add(routeGroup);

      // Mouse events
      canvas.addEventListener('mousedown', e => {
        isDragging   = true;
        isRightClick = e.button === 2;
        prevMouse    = { x: e.clientX, y: e.clientY };
      });
      canvas.addEventListener('contextmenu', e => e.preventDefault());
      window.addEventListener('mouseup', () => { isDragging = false; });
      window.addEventListener('mousemove', e => {
        if (!isDragging) return;
        const dx = e.clientX - prevMouse.x;
        const dy = e.clientY - prevMouse.y;
        if (isRightClick) {
          const right = new THREE.Vector3()
            .crossVectors(camera.getWorldDirection(new THREE.Vector3()), camera.up)
            .normalize();
          target.addScaledVector(right, -dx * 0.015);
          target.addScaledVector(camera.up,  dy * 0.015);
        } else {
          spherical.theta -= dx * 0.005;
          spherical.phi    = Math.max(0.1, Math.min(3.1, spherical.phi + dy * 0.005));
        }
        prevMouse = { x: e.clientX, y: e.clientY };
        updateCamera();
      });
      canvas.addEventListener('wheel', e => {
        spherical.radius = Math.max(1, Math.min(100, spherical.radius + e.deltaY * 0.025));
        updateCamera();
      });

      // Render loop
      (function loop() {
        requestAnimationFrame(loop);
        if (renderer && scene && camera) renderer.render(scene, camera);
      })();
    }

    renderer.setSize(W, H);
    camera.aspect = W / H;
    camera.updateProjectionMatrix();
    updateCamera();

    buildCosObjects(sceneData);
    buildRoutes(sceneData);
    cosGroup.visible   = showAsis;
    routeGroup.visible = showRoutes;
  }

  // ── PUBLIC CONTROLS ─────────────────────────────────────────────────
  function toggleLayer(which) {
    if (which === 'asis') {
      showAsis = !showAsis;
      if (cosGroup) cosGroup.visible = showAsis;
    } else {
      showRoutes = !showRoutes;
      if (routeGroup) routeGroup.visible = showRoutes;
    }
    return { showAsis, showRoutes };
  }

  function toggleWireframe() {
    wireMode = !wireMode;
    if (scene) scene.traverse(obj => {
      if (obj.isMesh && obj.material) obj.material.wireframe = wireMode;
    });
    return wireMode;
  }

  function resetCamera() {
    spherical = { theta: 0.8, phi: 1.0, radius: 30 };
    if (target) target.set(7, 2, 5);
    updateCamera();
  }

  function getState() { return { showAsis, showRoutes, wireMode }; }

  return { init, toggleLayer, toggleWireframe, resetCamera, getState };
})();
