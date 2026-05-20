// public/js/rad-app.js  -- Full file (restore working routing + modules)
(function () {
  // small helpers
  function q(sel, root) { return (root || document).querySelector(sel); }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }

  // REST helpers (with nonce) - expects radConfig localized by PHP
  async function apiGet(path, opts) {
    var url = (window.radConfig && window.radConfig.root ? window.radConfig.root : '') + path;
    var res = await fetch(url, Object.assign({
      method: 'GET',
      credentials: 'same-origin',
      headers: { 'X-WP-Nonce': (window.radConfig && window.radConfig.nonce) || '' }
    }, opts || {}));
    if (!res.ok) { var txt = await res.text(); throw new Error('HTTP ' + res.status + ': ' + txt); }
    return res.json();
  }
  async function apiPost(path, body, method = 'POST') {
    var url = (window.radConfig && window.radConfig.root ? window.radConfig.root : '') + path;
    var res = await fetch(url, {
      method: method,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-WP-Nonce': (window.radConfig && window.radConfig.nonce) || '' },
      body: JSON.stringify(body)
    });
    var txt = await res.text();
    try { var j = JSON.parse(txt); } catch (e) { throw new Error('Invalid JSON: ' + txt); }
    if (!res.ok) throw new Error(j.message || JSON.stringify(j));
    return j;
  }

  /* ---------- Fallback renderers (kept for compatibility) ---------- */
  function renderOverview(container) {
    container.innerHTML = '';
    var header = el('h2', null, 'Overview');
    container.appendChild(header);
    var controls = el('div', 'rad-controls');
    var dateInput = el('input', 'rad-date'); dateInput.type = 'date'; dateInput.value = new Date().toISOString().slice(0, 10);
    var refreshBtn = el('button', 'rad-btn', 'Refresh');
    controls.appendChild(dateInput); controls.appendChild(refreshBtn);
    var status = el('div', 'rad-status', '');
    controls.appendChild(status); container.appendChild(controls);
    var cardsWrap = el('div', 'rad-cards-wrap'); container.appendChild(cardsWrap);
    async function load() {
      refreshBtn.disabled = true; status.textContent = 'Loading...';
      try {
        var data = await apiGet('/analytics/cards?date=' + encodeURIComponent(dateInput.value));
        if (data && data.counts) {
          cardsWrap.innerHTML = '';
          var map = [
            ['Total Staff', 'total_active_staff', 'rad-blue'],
            ['On Time', 'on_time', 'rad-green'],
            ['Early Arrival', 'early_arrival', 'rad-teal'],
            ['Late Arrival', 'late_arrival', 'rad-orange'],
            ['Early Exit', 'early_exit', 'rad-gold'],
            ['Late Exit', 'late_exit', 'rad-red'],
            ['Absent', 'absent', 'rad-gray']
          ];
          map.forEach(function (item) {
            var card = el('div', 'rad-card ' + item[2]);
            var lab = el('div', 'rad-card-label', item[0]);
            var val = el('div', 'rad-card-value', String(data.counts[item[1]] || 0));
            card.appendChild(lab); card.appendChild(val); cardsWrap.appendChild(card);
          });
        } else cardsWrap.innerHTML = '<div>No data</div>';
      } catch (err) { status.textContent = 'Error: ' + err.message; console.error(err); } finally { refreshBtn.disabled = false; status.textContent = ''; }
    }
    refreshBtn.addEventListener('click', load); dateInput.addEventListener('change', load); load();
  }

  function renderMembersAdd(container) {
    container.innerHTML = ''; container.appendChild(el('h2', null, 'Add Member'));
    var panel = el('div', 'rad-panel'); container.appendChild(panel);
    var form = el('form', 'rad-form'); panel.appendChild(form);
    form.appendChild(el('label', null, 'Full Name *')); var nameInput = el('input', 'rad-input'); nameInput.type = 'text'; form.appendChild(nameInput);
    form.appendChild(el('label', null, 'Department *')); var deptInput = el('input', 'rad-input'); deptInput.type = 'text'; form.appendChild(deptInput);
    form.appendChild(el('label', null, 'Phone Number *')); var phoneInput = el('input', 'rad-input'); phoneInput.type = 'text'; form.appendChild(phoneInput);
    form.appendChild(el('label', null, 'Role *')); var roleSelect = el('select', 'rad-select'); ['Staff', 'Manager', 'Admin'].forEach(function (r) { var o = el('option'); o.value = r; o.textContent = r; roleSelect.appendChild(o); }); form.appendChild(roleSelect);
    form.appendChild(el('label', null, 'UUID (Scan using RFID) *')); var uidInput = el('input', 'rad-input'); uidInput.type = 'text'; form.appendChild(uidInput);
    var fetchBtn = el('button', 'rad-btn small', 'Fetch Latest UUID'); fetchBtn.type = 'button'; fetchBtn.style.marginTop = '8px';
    fetchBtn.onclick = async function (e) { e.preventDefault(); fetchBtn.disabled = true; fetchBtn.textContent = 'Fetching...'; try { var r = await fetch(radConfig.root + '/latest-uid'); var j = await r.json(); if (j && j.uid) { uidInput.value = j.uid; } else alert('No UID found'); } catch (err) { alert('Error: ' + err.message); } finally { fetchBtn.disabled = false; fetchBtn.textContent = 'Fetch Latest UUID'; } };
    form.appendChild(fetchBtn);
    form.appendChild(el('label', null, 'Password *')); var passInput = el('input', 'rad-input'); passInput.type = 'password'; form.appendChild(passInput);
    var submitBtn = el('button', 'rad-btn', 'Add User'); submitBtn.type = 'submit'; form.appendChild(submitBtn);
    var msg = el('div', 'rad-message', ''); form.appendChild(msg);
    form.addEventListener('submit', async function (ev) {
      ev.preventDefault(); msg.textContent = '';
      if (!nameInput.value.trim()) { msg.textContent = 'Name required'; nameInput.focus(); return; }
      if (!deptInput.value.trim()) { msg.textContent = 'Department required'; deptInput.focus(); return; }
      if (!/^\d{6,15}$/.test(phoneInput.value.trim())) { msg.textContent = 'Phone must be numeric (6-15 digits)'; phoneInput.focus(); return; }
      if (!uidInput.value.trim()) { msg.textContent = 'RFID UUID required'; uidInput.focus(); return; }
      if (!passInput.value || passInput.value.length < 4) { msg.textContent = 'Password min 4 chars'; passInput.focus(); return; }
      submitBtn.disabled = true; submitBtn.textContent = 'Saving...';
      try {
        var payload = { name: nameInput.value.trim(), department: deptInput.value.trim(), phone: phoneInput.value.trim(), role: roleSelect.value, uid: uidInput.value.trim(), password: passInput.value };
        var res = await fetch(radConfig.root + '/teachers', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-WP-Nonce': radConfig.nonce }, body: JSON.stringify(payload) });
        var txt = await res.text(); var j = JSON.parse(txt); if (!res.ok) throw new Error(j.message || txt);
        msg.style.color = '#16a34a'; msg.textContent = 'Member added (ID: ' + (j.teacher_id || '') + ')';
        nameInput.value = deptInput.value = phoneInput.value = passInput.value = '';
      } catch (err) { msg.style.color = '#b91c1c'; msg.textContent = 'Error: ' + err.message; } finally { submitBtn.disabled = false; submitBtn.textContent = 'Add User'; }
    });
  }

  async function renderMembersAll(container) {
    container.innerHTML = ''; container.appendChild(el('h2', null, 'All Members')); var panel = el('div', 'rad-panel'); container.appendChild(panel);
    var table = el('table', 'rad-table'); table.innerHTML = '<thead><tr><th>ID</th><th>Name</th><th>Department</th><th>Phone</th><th>Role</th><th>UID</th></tr></thead>'; var tbody = el('tbody'); table.appendChild(tbody); panel.appendChild(table);
    try {
      var res = await apiGet('/teachers');
      if (res && res.rows) {
        res.rows.forEach(function (r) {
          var uid = (r.meta && r.meta.uid) ? r.meta.uid : '';
          var tr = el('tr');
          tr.appendChild(el('td', null, String(r.id)));
          tr.appendChild(el('td', null, r.name || ''));
          tr.appendChild(el('td', null, r.department || ''));
          tr.appendChild(el('td', null, r.phone || ''));
          tr.appendChild(el('td', null, r.role || ''));
          tr.appendChild(el('td', null, String(uid)));
          tbody.appendChild(tr);
        });
      } else { panel.appendChild(el('div', null, 'No teachers found')); }
    } catch (err) { panel.appendChild(el('div', null, 'Error loading teachers: ' + err.message)); }
  }

  /* ---------- Robust Module loader helpers ---------- */
  function joinUrlParts() {
    var parts = Array.prototype.slice.call(arguments);
    return parts.map(function (p, i) { if (typeof p !== 'string') return ''; if (i === 0) { return p.replace(/\/+$/, ''); } return p.replace(/^\/+|\/+$/g, ''); }).filter(Boolean).join('/');
  }
  function ensureCss(path) {
    if (!window.radConfig || !window.radConfig.pluginUrl) { console.warn('ensureCss: radConfig.pluginUrl missing'); return; }
    var full = joinUrlParts(window.radConfig.pluginUrl, path);
    if (document.querySelector('link[data-rad-css="' + full + '"]')) return;
    var l = document.createElement('link'); l.rel = 'stylesheet'; l.href = full; l.setAttribute('data-rad-css', full);
    l.onload = function () { console.info('Loaded CSS:', full); };
    l.onerror = function () { console.error('Failed loading CSS:', full); };
    document.head.appendChild(l);
  }
  function loadModule(pathJs, pathCss, globalReadyCheck, onloaded) {
    if (!window.radConfig || !window.radConfig.pluginUrl) { console.error('loadModule: radConfig.pluginUrl missing'); onloaded(); return; }
    var src = joinUrlParts(window.radConfig.pluginUrl, pathJs);
    if (pathCss) ensureCss(pathCss);
    if (globalReadyCheck && window[globalReadyCheck]) { console.info('Module already loaded:', globalReadyCheck); onloaded(); return; }
    if (document.querySelector('script[data-rad-src="' + src + '"]')) {
      console.info('Module script present, waiting for init:', src);
      var trials = 0;
      var waitFor = setInterval(function () {
        trials++;
        if ((!globalReadyCheck) || window[globalReadyCheck]) { clearInterval(waitFor); onloaded(); }
        else if (trials > 40) { clearInterval(waitFor); console.warn('Module loaded but global not found:', globalReadyCheck); onloaded(); }
      }, 80);
      return;
    }
    var s = document.createElement('script'); s.async = true; s.setAttribute('data-rad-src', src); s.src = src;
    s.onload = function () { console.info('Loaded module script:', src); setTimeout(onloaded, 30); };
    s.onerror = function () { console.error('Failed to load module script:', src); onloaded(); };
    document.body.appendChild(s);
  }

  /* ---------- Sidebar enhancer: ensure Analytics link exists ---------- */
  function ensureAnalyticsSidebar() {
    var nav = document.querySelector('.rad-sidebar nav ul');
    if (!nav) return;
    if (nav.querySelector('a[href="#analytics/teachers"]')) return;

    var heading = document.createElement('li');
    heading.style.marginTop = '12px';
    heading.style.fontWeight = '700';
    heading.style.color = '#374151';
    heading.textContent = 'Analytics';

    var li = document.createElement('li');
    var a = document.createElement('a');
    a.href = '#analytics/teachers';
    a.className = 'rad-side-link';
    a.textContent = 'Teacher Analytics';
    li.appendChild(a);

    var graceLink = nav.querySelector('a[href="#grace/add"]');
    if (graceLink) {
      var graceItem = graceLink.closest('li');
      if (graceItem && graceItem.parentNode) {
        var parent = graceItem.parentNode;
        parent.insertBefore(heading, graceItem.nextSibling);
        parent.insertBefore(li, heading.nextSibling);
      } else {
        nav.appendChild(heading); nav.appendChild(li);
      }
    } else {
      nav.appendChild(heading); nav.appendChild(li);
    }
  }

  /* ---------- Router + mount (uses dynamic loader) ---------- */
  function updateSidebar(hash) {
    document.querySelectorAll('.rad-side-link').forEach(function (a) {
      a.classList.toggle('active', a.getAttribute('href') === hash);
    });
    ensureAnalyticsSidebar();
  }

  async function route() {
    var hash = (location.hash || '#overview').toLowerCase();
    updateSidebar(hash);
    var root = document.getElementById('rad-root-content');
    if (!root) return;

    if (hash.indexOf('#overview') === 0) {
      loadModule('modules/overview/admin.js', 'modules/overview/admin.css', 'RadOverview', function () {
        if (window.RadOverview && typeof window.RadOverview.render === 'function') { window.RadOverview.render(root); }
        else if (typeof renderOverview === 'function') { renderOverview(root); }
        else { root.innerHTML = '<div class="rad-panel">Overview module loaded, but render function not found.</div>'; }
      });
      return;
    } else if (hash.indexOf('#members') === 0) {
      var subpage = 'all';
      if (hash.indexOf('#members/add') === 0) subpage = 'add';
      loadModule('modules/members/admin.js', 'modules/members/admin.css', 'RadMembers', function () {
        if (window.RadMembers && typeof window.RadMembers.render === 'function') {
          window.RadMembers.render(root, subpage);
        } else {
          if (subpage === 'add' && typeof renderMembersAdd === 'function') renderMembersAdd(root);
          else if (typeof renderMembersAll === 'function') renderMembersAll(root);
        }
      });
      return;
    } else if (hash.indexOf('#logs') === 0) {
      if (hash.indexOf('#logs/staff') === 0) {
        loadModule('modules/logs-staff/admin.js', 'modules/logs-staff/admin.css', 'RadLogs', function () {
          if (window.RadLogs && typeof window.RadLogs.renderStaffLogs === 'function') window.RadLogs.renderStaffLogs(root);
          else root.innerHTML = '<div class="rad-panel">Staff logs module loaded, but render function not found.</div>';
        });
      } else if (hash.indexOf('#logs/all') === 0) {
        loadModule('modules/logs-all/admin.js', 'modules/logs-all/admin.css', 'RadLogsAll', function () {
          var trials = 0, maxTrials = 25;
          (function tryRender() {
            trials++;
            if (window.RadLogsAll && typeof window.RadLogsAll.renderAllLogs === 'function') {
              try { window.RadLogsAll.renderAllLogs(root); }
              catch (err) { console.error('RadLogsAll.renderAllLogs threw:', err); root.innerHTML = '<div class="rad-panel">Error while rendering All Logs: ' + (err && err.message ? err.message : 'unknown') + '</div>'; }
            } else if (trials < maxTrials) setTimeout(tryRender, 60);
            else root.innerHTML = '<div class="rad-panel">All logs module loaded, but render function not found.</div>';
          })();
        });
      } else {
        location.hash = '#logs/staff';
      }
      return;
    } else if (hash.indexOf('#timetables') === 0) {
      var ttSub = (hash.indexOf('#timetables/add') === 0) ? 'add' : 'all';
      loadModule('modules/timetables/admin.js', 'modules/timetables/admin.css', 'RadTimetables', function () {
        if (window.RadTimetables && typeof window.RadTimetables.render === 'function') window.RadTimetables.render(root, ttSub);
        else renderOverview(root);
      });
      return;
    } else if (hash.indexOf('#rooms') === 0) {
      loadModule('modules/rooms/admin.js', 'modules/rooms/admin.css', 'RadRooms', function () {
        if (window.RadRooms && typeof window.RadRooms.renderAllRooms === 'function') window.RadRooms.renderAllRooms(root);
        else root.innerHTML = '<div class="rad-panel">All Rooms module loaded, but render function not found.</div>';
      });
      return;
    } else if (hash.indexOf('#classrooms') === 0) {
      loadModule('modules/classrooms/admin.js', 'modules/classrooms/admin.css', 'RadClassrooms', function () {
        if (window.RadClassrooms && typeof window.RadClassrooms.renderAllClassrooms === 'function') window.RadClassrooms.renderAllClassrooms(root);
        else root.innerHTML = '<div class="rad-panel">Classrooms module loaded, but render function not found.</div>';
      });
      return;
    } else if (hash.indexOf('#devices') === 0) {
      loadModule('modules/devices/admin.js', 'modules/devices/admin.css', 'RadDevices', function () {
        if (window.RadDevices && typeof window.RadDevices.renderAllDevices === 'function') window.RadDevices.renderAllDevices(root);
        else root.innerHTML = '<div class="rad-panel">Devices module loaded, but render function not found.</div>';
      });
      return;
    } else if (hash.indexOf('#grace') === 0) {
      loadModule('modules/grace/admin.js', 'modules/grace/admin.css', 'RadGrace', function () {
        if (window.RadGrace) {
          var fn = window.RadGrace.renderAddGrace || window.RadGrace.render || window.RadGrace.mount;
          if (typeof fn === 'function') { fn(document.getElementById('rad-root-content')); return; }
        }
        document.getElementById('rad-root-content').innerHTML = '<div class="rad-panel">Grace module loaded, but render function not found.</div>';
      });
      return;
    } else if (hash.indexOf('#settings') === 0) {
      if (hash.indexOf('#settings/permissions') === 0) {
        loadModule('modules/settings/admin.js', 'modules/settings/admin.css', 'RadSettings', function () {
          if (window.RadSettings && typeof window.RadSettings.renderPermissions === 'function') window.RadSettings.renderPermissions(root);
          else root.innerHTML = '<div class="rad-panel">Settings module loaded, but render function not found.</div>';
        });
      } else {
        location.hash = '#settings/permissions';
      }
      return;
    } else if (hash.indexOf('#analytics') === 0) {
      if (hash.indexOf('#analytics/teachers') === 0) {
        loadModule('modules/analytics-teachers/admin.js', 'modules/analytics-teachers/admin.css', 'RadAnalyticsTeachers', function () {
          if (window.RadAnalyticsTeachers && typeof window.RadAnalyticsTeachers.render === 'function') {
            window.RadAnalyticsTeachers.render(root);
          } else {
            root.innerHTML =
              '<div class="rad-panel">' +
              '<h2 style="margin:0 0 8px;">Teacher Analytics</h2>' +
              '<p>Analytics module will appear here (workload, empty periods, CSV export).</p>' +
              '</div>';
          }
        });
      } else {
        location.hash = '#analytics/teachers';
      }
      return;
    }

    root.innerHTML = '<div class="rad-panel">Module not implemented.</div>';
  }

  // Hook up router after DOM is ready
  window.addEventListener('hashchange', route);
  document.addEventListener('DOMContentLoaded', function () {
    // ensure link exists as soon as DOM is ready
    ensureAnalyticsSidebar();

    // internal nav
    document.addEventListener('click', function (ev) {
      var a = ev.target.closest && ev.target.closest('.rad-side-link');
      if (a) {
        var href = a.getAttribute('href');
        if (href && href.startsWith('#')) { ev.preventDefault(); location.hash = href; }
      }
    }, true);

    // initial render
    route();
  });
})();
