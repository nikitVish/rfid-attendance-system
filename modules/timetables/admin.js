// modules/timetables/admin.js
(function(){
  // delegator: loads submodule JS/CSS from 'all' or 'add' subfolders and exposes RadTimetables.render
  function joinUrlParts() {
    var parts = Array.prototype.slice.call(arguments);
    return parts.map(function(p, i){ if (typeof p !== 'string') return ''; if (i === 0) { return p.replace(/\/+$/,''); } return p.replace(/^\/+|\/+$/g,''); }).filter(Boolean).join('/');
  }
  function ensureCss(path) {
    if (!window.radConfig || !window.radConfig.pluginUrl) { console.warn('ensureCss: radConfig.pluginUrl missing'); return; }
    var full = joinUrlParts(window.radConfig.pluginUrl, path);
    if (document.querySelector('link[data-rad-css="' + full + '"]')) return;
    var l = document.createElement('link'); l.rel='stylesheet'; l.href = full; l.setAttribute('data-rad-css', full); document.head.appendChild(l);
  }
  function loadScript(path, cb) {
    if (!window.radConfig || !window.radConfig.pluginUrl) { console.error('loadScript: radConfig.pluginUrl missing'); cb(); return; }
    var src = joinUrlParts(window.radConfig.pluginUrl, path);
    if (document.querySelector('script[data-rad-src="'+src+'"]')) {
      // already present
      if (cb) setTimeout(cb, 30);
      return;
    }
    var s = document.createElement('script'); s.async = true; s.src = src; s.setAttribute('data-rad-src', src);
    s.onload = function(){ if (cb) cb(); };
    s.onerror = function(){ console.error('failed loading', src); if (cb) cb(); };
    document.body.appendChild(s);
  }

  // try to load submodule by name: 'all' or 'add'
  function loadSubmodule(name, cb) {
    var jsPath = 'modules/timetables/' + name + '/admin.js';
    var cssPath = 'modules/timetables/' + name + '/admin.css';
    ensureCss(cssPath);
    loadScript(jsPath, cb);
  }

  // Public API expected by rad-app.js: RadTimetables.render(root, sub)
  window.RadTimetables = window.RadTimetables || {};
  window.RadTimetables.render = function(root, sub) {
    root = root || document.getElementById('rad-root-content');
    sub = (sub || 'all');
    // decide which submodule function to call. We will load the submodule if not loaded and then call its render.
    if (sub === 'all') {
      loadSubmodule('all', function(){
        if (window.RadTimetablesAll && typeof window.RadTimetablesAll.renderAll === 'function') {
          window.RadTimetablesAll.renderAll(root);
        } else {
          // fallback: try global RadTimetablesAll.render (older naming)
          if (window.RadTimetablesAll && typeof window.RadTimetablesAll.render === 'function') window.RadTimetablesAll.render(root);
          else root.innerHTML = '<div class="rad-panel">All Timetables module loaded but render function not found.</div>';
        }
      });
    } else if (sub === 'add') {
      loadSubmodule('add', function(){
        if (window.RadTimetablesAdd && typeof window.RadTimetablesAdd.renderAdd === 'function') {
          window.RadTimetablesAdd.renderAdd(root);
        } else {
          if (window.RadTimetablesAdd && typeof window.RadTimetablesAdd.render === 'function') window.RadTimetablesAdd.render(root);
          else root.innerHTML = '<div class="rad-panel">Add Timetable module loaded but render function not found.</div>';
        }
      });
    } else {
      root.innerHTML = '<div class="rad-panel">Unknown timetables submodule: '+String(sub)+'</div>';
    }
  };

  // small no-style CSS to ensure minimal visual consistency if admin.css wasn't loaded
  var minimal = document.createElement('style');
  minimal.innerHTML = '.rad-panel{background:#fff;border-radius:8px;padding:12px;border:1px solid #eef4f8;margin-bottom:12px;}';
  document.head.appendChild(minimal);

})();
