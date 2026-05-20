// modules/logs-all/admin.js
// All Logs module: raw tap logs, filters, pagination, CSV export,
// inline remark edit (admin-ajax: rad_all_update_remark), bulk select & delete.
(function () {
  window.RadLogsAll = window.RadLogsAll || {};

  // ---------- tiny helpers ----------
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function q(sel, root) { return (root || document).querySelector(sel); }

  function apiGet(path) {
    var url = ((window.radConfig && window.radConfig.root) || '') + path;
    return fetch(url, {
      method: 'GET',
      credentials: 'same-origin',
      headers: { 'X-WP-Nonce': (window.radConfig && window.radConfig.nonce) || '' }
    }).then(function (res) {
      if (!res.ok) return res.text().then(function (t) { throw new Error(t || res.status); });
      return res.json();
    });
  }

  function apiPost(path, body) {
    var url = ((window.radConfig && window.radConfig.root) || '') + path;
    return fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'X-WP-Nonce': (window.radConfig && window.radConfig.nonce) || '',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    }).then(function (res) {
      if (!res.ok) return res.text().then(function (t) { throw new Error(t || res.status); });
      return res.json();
    });
  }

  function adminAjaxPost(data) {
    var root = (window.radConfig && window.radConfig.root) ? window.radConfig.root : '';
    var ajax = root.replace(/\/wp-json.*$/, '') + '/wp-admin/admin-ajax.php';
    var fd = new FormData();
    for (var k in data) fd.append(k, data[k]);
    return fetch(ajax, { method: 'POST', credentials: 'same-origin', body: fd })
      .then(function (r) { return r.text().then(function (t) { try { return JSON.parse(t); } catch (e) { throw new Error(t); } }); });
  }

  // ---------- Time / Date format helpers ----------
  // Robust time formatter:
  // Accepts:
  //  - "HH:MM" or "HH:MM:SS"
  //  - "YYYY-MM-DD HH:MM" or "YYYY-MM-DD HH:MM:SS"
  // Returns "h:mm:ss AM/PM" (seconds always present)
  function fmtTimeOnly(t) {
    if (!t) return 'N/A';
    try {
      var s = String(t).trim();

      // If there's a space (likely "YYYY-MM-DD HH:MM:SS"), take last token as time part
      if (s.indexOf(' ') >= 0) {
        var parts = s.split(' ');
        s = parts[parts.length - 1];
      }

      // Now s should be like "HH:MM" or "HH:MM:SS"
      var timeParts = s.split(':');
      if (timeParts.length < 2) return t; // unexpected format - return as-is

      var hh = parseInt(timeParts[0], 10);
      var mm = parseInt(timeParts[1], 10);
      var ss = timeParts.length >= 3 ? parseInt(timeParts[2], 10) : 0;

      if (isNaN(hh) || isNaN(mm) || isNaN(ss)) return t;

      var suffix = (hh >= 12) ? 'PM' : 'AM';
      var hour12 = hh % 12;
      if (hour12 === 0) hour12 = 12;

      // Pad minutes/seconds to 2 digits
      var mmStr = (mm < 10 ? '0' : '') + mm;
      var ssStr = (ss < 10 ? '0' : '') + ss;

      return hour12 + ':' + mmStr + ':' + ssStr + ' ' + suffix;
    } catch (e) {
      return t;
    }
  }

  function fmtDate(ymd) {
    if (!ymd) return '';
    // YYYY-MM-DD expected; fallback to passthrough
    var d = new Date(ymd + 'T00:00:00');
    if (isNaN(d)) return ymd;
    return new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'numeric', day: 'numeric' }).format(d);
  }
  function plain(v) { return (v === null || v === undefined) ? '' : String(v); }
  function todayYMD() { return new Date().toLocaleDateString('en-CA'); }
  function debounce(fn, ms) {
    var t; return function () { var args = arguments, ctx = this; clearTimeout(t); t = setTimeout(function () { fn.apply(ctx, args); }, ms); };
  }

  function filterSVG() {
    return '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M3 5h18" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M7 12h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M10 19h4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
  }

  function showConfirmModal(title, text) {
    return new Promise(function (resolve) {
      var ov = el('div', 'rad-modal-overlay');
      var box = el('div', 'rad-modal-box');
      var h = el('h3', 'rad-modal-title', title);
      var p = el('div', 'rad-modal-text', text);
      var btnRow = el('div', 'rad-modal-actions');
      var ok = el('button', 'rad-btn green', 'OK');
      var cancel = el('button', 'rad-btn ghost', 'Cancel');
      btnRow.appendChild(ok); btnRow.appendChild(cancel);
      box.appendChild(h); box.appendChild(p); box.appendChild(btnRow);
      ov.appendChild(box);
      document.body.appendChild(ov);
      ok.focus();
      ok.addEventListener('click', function () { document.body.removeChild(ov); resolve(true); });
      cancel.addEventListener('click', function () { document.body.removeChild(ov); resolve(false); });
    });
  }

  // ---------- main ----------
  window.RadLogsAll.renderAllLogs = async function (container) {
    container = container || document.getElementById('rad-root-content');
    container.innerHTML = '';

    // Header
    var header = el('div', 'rad-panel rad-logs-header rad-logs-header-stylish');
    var left = el('div', 'rad-logs-header-left');
    left.appendChild(el('h2', null, 'All Logs'));
    left.appendChild(el('div', 'rad-sub', 'Raw scan logs (all devices)'));
    header.appendChild(left);

    var right = el('div', 'rad-logs-header-right');
    var nowDiv = el('div', 'rad-logs-now', '');
    nowDiv.setAttribute('aria-live', 'polite');
    function headerNowText() {
      var now = new Date();
      var weekday = now.toLocaleDateString(undefined, { weekday: 'long' });
      var ymd = now.toLocaleDateString('en-CA');
      var time = now.toLocaleTimeString();
      return weekday + ' - ' + ymd + ' - ' + time;
    }
    nowDiv.textContent = headerNowText();
    setInterval(function () { nowDiv.textContent = headerNowText(); }, 1000);
    right.appendChild(nowDiv);

    var exportBtn = el('button', 'rad-btn green rad-export', 'Export CSV');
    exportBtn.type = 'button';
    right.appendChild(exportBtn);

    var perSel = el('select', 'rad-select rad-perpage');
    ['10', '25', '50', '100'].forEach(function (v) {
      var o = el('option'); o.value = v; o.textContent = v + ' / page'; perSel.appendChild(o);
    });
    perSel.value = '10';
    right.appendChild(perSel);

    var filterToggle = el('button', 'rad-btn ghost rad-filter-toggle');
    filterToggle.type = 'button';
    filterToggle.title = 'Toggle filters';
    filterToggle.innerHTML = filterSVG();
    right.appendChild(filterToggle);

    header.appendChild(right);
    container.appendChild(header);

    // Filters panel
    var filt = el('div', 'rad-panel rad-filters-panel');
    filt.style.display = 'none';

    var row1 = el('div', 'rad-filters-row');
    var userCol = el('div', 'rad-fcol'); userCol.appendChild(el('label', null, 'User'));
    var userSel = el('select', 'rad-select'); userSel.appendChild(new Option('All users', '')); userCol.appendChild(userSel);
    row1.appendChild(userCol);

    var uidCol = el('div', 'rad-fcol'); uidCol.appendChild(el('label', null, 'UID'));
    var uidInput = el('input', 'rad-input'); uidInput.type = 'text'; uidInput.placeholder = 'UID'; uidCol.appendChild(uidInput);
    row1.appendChild(uidCol);

    var devCol = el('div', 'rad-fcol'); devCol.appendChild(el('label', null, 'Device ID'));
    var devSel = el('select', 'rad-select'); devSel.appendChild(new Option('All devices', '')); devCol.appendChild(devSel);
    row1.appendChild(devCol);

    var fromCol = el('div', 'rad-fcol'); fromCol.appendChild(el('label', null, 'From'));
    var fromInput = el('input', 'rad-input'); fromInput.type = 'date'; fromInput.value = todayYMD(); fromCol.appendChild(fromInput);
    row1.appendChild(fromCol);

    var toCol = el('div', 'rad-fcol'); toCol.appendChild(el('label', null, 'To'));
    var toInput = el('input', 'rad-input'); toInput.type = 'date'; toInput.value = todayYMD(); toCol.appendChild(toInput);
    row1.appendChild(toCol);

    filt.appendChild(row1);

    var row2 = el('div', 'rad-filters-row');
    var classCol = el('div', 'rad-fcol'); classCol.appendChild(el('label', null, 'Classroom'));
    var classSel = el('select', 'rad-select'); classSel.appendChild(new Option('All classrooms', '')); classCol.appendChild(classSel);
    row2.appendChild(classCol);

    var roomCol = el('div', 'rad-fcol'); roomCol.appendChild(el('label', null, 'Room No.'));
    var roomSel = el('select', 'rad-select'); roomSel.appendChild(new Option('All rooms', '')); roomCol.appendChild(roomSel);
    row2.appendChild(roomCol);

    var deptCol = el('div', 'rad-fcol'); deptCol.appendChild(el('label', null, 'Department'));
    var deptSel = el('select', 'rad-select'); deptSel.appendChild(new Option('All depts', '')); deptCol.appendChild(deptSel);
    row2.appendChild(deptCol);

    filt.appendChild(row2);

    var actRow = el('div', 'rad-filters-row rad-filters-actions');
    var resetBtn = el('button', 'rad-btn ghost', 'Reset');
    actRow.appendChild(resetBtn);
    filt.appendChild(actRow);

    container.appendChild(filt);

    // Delete controls row
    var delPanel = el('div', 'rad-panel rad-delete-panel');
    delPanel.style.display = 'none';

    var delLeft = el('div', 'rad-delete-left-wrap');
    var delLabel = el('div', 'rad-delete-desc', 'Select top N logs (from current filtered results):');
    var delInput = el('input', 'rad-input rad-delete-input'); delInput.type = 'number'; delInput.min = '1'; delInput.placeholder = 'Enter number';
    delLeft.appendChild(delLabel);
    delLeft.appendChild(delInput);

    var delRight = el('div', 'rad-delete-actions');
    var selectBtn = el('button', 'rad-btn select-btn', 'Select'); selectBtn.type = 'button';
    var selectAllBtn = el('button', 'rad-btn select-all-btn', 'Select all visible');
    var clearBtn = el('button', 'rad-btn ghost clear-btn', 'Clear');
    var selectedCount = el('div', 'rad-delete-count', 'Selected: 0');
    var confirmDeleteBtn = el('button', 'rad-btn confirm-delete confirm-delete-btn', 'Confirm Delete');
    confirmDeleteBtn.disabled = true;

    delRight.appendChild(selectBtn);
    delRight.appendChild(selectAllBtn);
    delRight.appendChild(clearBtn);
    delRight.appendChild(selectedCount);
    delRight.appendChild(confirmDeleteBtn);

    delPanel.appendChild(delLeft);
    delPanel.appendChild(delRight);
    container.appendChild(delPanel);

    // Table Panel
    var panel = el('div', 'rad-panel rad-table-panel');
    var table = el('table', 'rad-table');
    table.innerHTML =
      '<thead><tr>' +
      '<th></th>' +
      '<th>SN</th>' +
      '<th>UID</th>' +
      '<th>User</th>' +
      '<th>Department</th>' +
      '<th>Classroom</th>' +
      '<th>Room No.</th>' +
      '<th>Device ID</th>' +
      '<th>Tap Time</th>' +
      '<th>Date</th>' +
      '<th>Remark</th>' +
      '</tr></thead>';
    var tbody = el('tbody'); table.appendChild(tbody);
    panel.appendChild(table);

    // Footer/pager
    var footer = el('div', 'rad-table-footer');
    var totalInfo = el('div', 'rad-total', 'Total: 0 — Page 0 / 0');
    footer.appendChild(totalInfo);
    var pager = el('div', 'rad-pager');
    pager.innerHTML = '<button class="rad-pager-btn"><<</button> <button class="rad-pager-btn"><</button> <span class="rad-page-num">1</span> <button class="rad-pager-btn">></button> <button class="rad-pager-btn">>></button>';
    footer.appendChild(pager);
    panel.appendChild(footer);
    container.appendChild(panel);

    // state
    var state = {
      rows: [],
      filtered: [],
      page: 1,
      perPage: parseInt(perSel.value, 10) || 10,
      selectedIds: new Set()
    };

    // toggle filters
    filterToggle.addEventListener('click', function () {
      var open = (filt.style.display === 'none' || filt.style.display === '');
      filt.style.display = open ? 'block' : 'none';
      delPanel.style.display = open ? 'flex' : 'none';
      filterToggle.classList.toggle('active', open);
    });

    // load aux lists
    async function loadAuxData() {
      try {
        var t = await apiGet('/teachers');
        if (t && Array.isArray(t.rows)) {
          userSel.innerHTML = ''; userSel.appendChild(new Option('All users', ''));
          t.rows.forEach(function (r) { userSel.appendChild(new Option(r.name || ('User ' + r.id), String(r.id))); });
          var deps = {};
          t.rows.forEach(function (r) { if (r.department) deps[r.department] = true; });
          deptSel.innerHTML = ''; deptSel.appendChild(new Option('All depts', ''));
          Object.keys(deps).sort().forEach(function (d) { deptSel.appendChild(new Option(d, d)); });
        }
      } catch (e) { console.warn('load teachers failed', e); }

      try {
        var dv = await apiGet('/devices');
        if (dv && Array.isArray(dv.rows)) {
          devSel.innerHTML = ''; devSel.appendChild(new Option('All devices', ''));
          dv.rows.forEach(function (r) { if (r.device_id) devSel.appendChild(new Option(r.device_id, r.device_id)); });
        }
      } catch (e) { console.warn('load devices failed', e); }

      try {
        var cl = await apiGet('/classrooms');
        if (cl && Array.isArray(cl.rows)) {
          classSel.innerHTML = ''; classSel.appendChild(new Option('All classrooms', ''));
          cl.rows.forEach(function (r) { if (r.classroom) classSel.appendChild(new Option(r.classroom, r.classroom)); });
        }
      } catch (e) { console.warn('load classrooms failed', e); }

      try {
        var rm = await apiGet('/rooms');
        if (rm && Array.isArray(rm.rows)) {
          roomSel.innerHTML = ''; roomSel.appendChild(new Option('All rooms', ''));
          rm.rows.forEach(function (r) { if (r.room_no) roomSel.appendChild(new Option(r.room_no, r.room_no)); });
        }
      } catch (e) { console.warn('load rooms failed', e); }
    }

    // fetch logs (respects date range)
    async function fetchAllLogs() {
      tbody.innerHTML = '<tr><td colspan="11">Loading...</td></tr>';
      try {
        var params = [];
        if (fromInput.value) params.push('from=' + encodeURIComponent(fromInput.value));
        if (toInput.value) params.push('to=' + encodeURIComponent(toInput.value));
        var url = '/logs/all' + (params.length ? ('?' + params.join('&')) : '');
        var res = await apiGet(url);
        if (!res || !res.rows) throw new Error('Invalid response');

        state.rows = res.rows.map(function (r) {
          return {
            id: r.id || '',
            uid: r.uid || '',
            teacher_id: r.teacher_id || '',
            teacher_name: r.teacher_name || '',
            department: r.department || (r.dept || ''),
            classroom: r.classroom || '',
            room: r.room || '',
            device_id: r.device_id || '',
            tap_time: r.tap_time || r.scan_time || '',
            scan_time: r.scan_time || '',
            date: r.date || (r.scan_time ? String(r.scan_time).split(' ')[0] : ''),
            remarks: (r.remarks !== undefined ? r.remarks : '')
          };
        });

        state.page = 1;
        // keep current selections only if IDs still exist
        var existing = new Set(state.rows.map(function (r) { return String(r.id); }));
        state.selectedIds.forEach(function (id) { if (!existing.has(id)) state.selectedIds.delete(id); });
        updateSelectedCount();
        applyFiltersAndRender();
      } catch (err) {
        tbody.innerHTML = '<tr><td colspan="11">Error loading logs: ' + (err.message || err) + '</td></tr>';
        state.rows = []; state.filtered = [];
        totalInfo.textContent = 'Total: 0 — Page 0 / 0';
      }
    }

    function applyFiltersAndRender() {
      var u = userSel.value;
      var uidq = (uidInput.value || '').trim().toLowerCase();
      var devq = (devSel.value || '').trim().toLowerCase();
      var classq = (classSel.value || '').trim().toLowerCase();
      var roomq = (roomSel.value || '').trim().toLowerCase();
      var deptq = (deptSel.value || '').trim().toLowerCase();

      state.filtered = state.rows.filter(function (r) {
        if (u && r.teacher_id && String(r.teacher_id) !== String(u)) return false;
        if (uidq && String(r.uid || '').toLowerCase().indexOf(uidq) === -1) return false;
        if (devq && String(r.device_id || '').toLowerCase().indexOf(devq) === -1) return false;
        if (classq && String(r.classroom || '').toLowerCase().indexOf(classq) === -1) return false;
        if (roomq && String(r.room || '').toLowerCase().indexOf(roomq) === -1) return false;
        if (deptq && String(r.department || '').toLowerCase().indexOf(deptq) === -1) return false;
        return true;
      });

      renderPage();
    }

    function renderPage() {
      var per = state.perPage = parseInt(perSel.value, 10) || 10;
      var total = state.filtered.length;
      var pages = Math.max(1, Math.ceil(total / per));
      if (state.page > pages) state.page = pages;
      var start = (state.page - 1) * per;
      var rows = state.filtered.slice(start, start + per);

      tbody.innerHTML = '';
      if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="11">No logs</td></tr>';
      } else {
        rows.forEach(function (r, idx) {
          var tr = el('tr');

          // Select checkbox
          var chkTd = el('td');
          chkTd.style.textAlign = 'center';
          var cb = el('input'); cb.type = 'checkbox'; cb.className = 'rad-log-chk'; cb.dataset.id = r.id;
          if (state.selectedIds.has(String(r.id))) cb.checked = true;
          cb.addEventListener('change', function () {
            if (cb.checked) state.selectedIds.add(String(r.id));
            else state.selectedIds.delete(String(r.id));
            updateSelectedCount();
          });
          chkTd.appendChild(cb);
          tr.appendChild(chkTd);

          tr.appendChild(el('td', null, String(start + idx + 1)));
          tr.appendChild(el('td', null, plain(r.uid)));
          tr.appendChild(el('td', null, plain(r.teacher_name)));
          tr.appendChild(el('td', null, plain(r.department)));
          tr.appendChild(el('td', null, plain(r.classroom)));
          tr.appendChild(el('td', null, plain(r.room)));
          tr.appendChild(el('td', null, plain(r.device_id)));
          tr.appendChild(el('td', null, fmtTimeOnly(r.tap_time)));
          tr.appendChild(el('td', null, fmtDate(r.date)));

          // Remark cell
          var remarkTd = el('td');
          remarkTd.style.display = 'flex';
          remarkTd.style.alignItems = 'center';
          remarkTd.style.justifyContent = 'center';
          remarkTd.style.gap = '8px';

          var remarkInput = el('input', 'rad-input rad-remark-input');
          remarkInput.type = 'text';
          remarkInput.value = r.remarks === null ? '' : r.remarks;
          remarkInput.dataset.id = r.id;
          remarkInput.style.width = '68%';
          remarkInput.style.boxSizing = 'border-box';
          remarkTd.appendChild(remarkInput);

          var saveBtn = el('button', 'rad-btn small', 'Save');
          saveBtn.style.marginLeft = '0';
          saveBtn.style.whiteSpace = 'nowrap';
          remarkTd.appendChild(saveBtn);

          // Save remark via admin-ajax
          saveBtn.addEventListener('click', async function () {
            saveBtn.disabled = true;
            var prev = saveBtn.textContent;
            saveBtn.textContent = 'Saving...';
            try {
              var resp = await adminAjaxPost({
                action: 'rad_all_update_remark',
                id: r.id,
                remarks: remarkInput.value || ''
              });
              if (resp && (resp.success || resp.ok)) {
                r.remarks = remarkInput.value || '';
                saveBtn.textContent = 'Saved';
                setTimeout(function () { saveBtn.textContent = 'Save'; }, 900);
              } else {
                alert((resp && resp.data && resp.data.error) ? resp.data.error : 'Save failed');
                saveBtn.textContent = prev;
              }
            } catch (e) {
              alert('Save failed: ' + (e.message || e));
              saveBtn.textContent = prev;
            } finally {
              saveBtn.disabled = false;
            }
          });

          tr.appendChild(remarkTd);
          tbody.appendChild(tr);
        });
      }

      totalInfo.textContent = 'Total: ' + total + ' — Page ' + state.page + ' / ' + pages;
      q('.rad-page-num', pager).textContent = String(state.page);
    }

    function updateSelectedCount() {
      q('.rad-delete-count', delPanel).textContent = 'Selected: ' + state.selectedIds.size;
      confirmDeleteBtn.disabled = state.selectedIds.size === 0;
    }

    // Bulk selection helpers
    selectBtn.addEventListener('click', function () {
      var n = parseInt(delInput.value, 10);
      if (!n || n <= 0) { alert('Enter a valid number'); return; }
      var toSelect = state.filtered.slice(0, n);
      toSelect.forEach(function (r) { state.selectedIds.add(String(r.id)); });
      updateSelectedCount();
      document.querySelectorAll('.rad-log-chk').forEach(function (cb) {
        if (state.selectedIds.has(cb.dataset.id)) cb.checked = true;
      });
      if (tbody.firstChild) tbody.firstChild.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    selectAllBtn.addEventListener('click', function () {
      state.filtered.forEach(function (r) { state.selectedIds.add(String(r.id)); });
      updateSelectedCount();
      document.querySelectorAll('.rad-log-chk').forEach(function (cb) { cb.checked = true; });
    });

    clearBtn.addEventListener('click', function () {
      state.selectedIds = new Set();
      updateSelectedCount();
      document.querySelectorAll('.rad-log-chk').forEach(function (cb) { cb.checked = false; });
    });

    confirmDeleteBtn.addEventListener('click', async function () {
      if (state.selectedIds.size === 0) { alert('No logs selected'); return; }
      var proceed = await showConfirmModal('Confirm delete', 'Delete ' + state.selectedIds.size + ' logs? This action cannot be undone.');
      if (!proceed) return;
      try {
        var ids = Array.from(state.selectedIds).map(function (v) { return parseInt(v, 10); });
        var resp = await apiPost('/logs/delete', { ids: ids });
        if (resp && resp.ok) {
          alert('Deleted ' + (resp.deleted || 0) + ' rows');
          var deletedSet = new Set(ids.map(String));
          state.rows = state.rows.filter(function (r) { return !deletedSet.has(String(r.id)); });
          state.filtered = state.filtered.filter(function (r) { return !deletedSet.has(String(r.id)); });
          state.selectedIds = new Set();
          updateSelectedCount();
          renderPage();
        } else {
          alert('Delete failed');
        }
      } catch (e) { alert('Delete failed: ' + (e.message || e)); }
    });

    // Pager
    pager.querySelectorAll('.rad-pager-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        var t = b.textContent.trim();
        var per = parseInt(perSel.value, 10) || 10;
        var total = state.filtered.length;
        var pages = Math.max(1, Math.ceil(total / per));
        if (t === '<<') state.page = 1;
        else if (t === '<') state.page = Math.max(1, state.page - 1);
        else if (t === '>') state.page = Math.min(pages, state.page + 1);
        else if (t === '>>') state.page = pages;
        renderPage();
      });
    });

    // Wire controls
    resetBtn.addEventListener('click', function (e) {
      e.preventDefault();
      userSel.value = '';
      uidInput.value = '';
      devSel.value = '';
      fromInput.value = todayYMD();
      toInput.value = todayYMD();
      classSel.value = '';
      roomSel.value = '';
      deptSel.value = '';
      perSel.value = '10';
      state.page = 1;
      state.selectedIds = new Set();
      updateSelectedCount();
      fetchAllLogs();
    });

    perSel.addEventListener('change', function () { renderPage(); });

    var refetch = debounce(function () { state.page = 1; fetchAllLogs(); }, 150);
    [userSel, uidInput, devSel, classSel, roomSel, deptSel, fromInput, toInput].forEach(function (i) {
      i.addEventListener('change', refetch);
      i.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); refetch(); } });
    });

    // Export CSV
    exportBtn.addEventListener('click', function () {
      if (!state.filtered || !state.filtered.length) { alert('No rows to export'); return; }
      var headers = ['SN', 'UID', 'User', 'Department', 'Classroom', 'Room No.', 'Device ID', 'Tap Time', 'Date', 'Remark'];
      var lines = [headers.join(',')];
      state.filtered.forEach(function (r, idx) {
        function esc(v) { return '"' + String(v || '').replace(/"/g, '""') + '"'; }
        var cols = [
          idx + 1,
          esc(r.uid),
          esc(r.teacher_name),
          esc(r.department),
          esc(r.classroom),
          esc(r.room),
          esc(r.device_id),
          esc(r.tap_time),
          esc(r.date),
          esc(r.remarks)
        ];
        lines.push(cols.join(','));
      });
      var blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'rad-all-logs-' + (fromInput.value || new Date().toISOString().slice(0, 10)) + '.csv';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); document.body.removeChild(a); }, 400);
    });

    // Initial load
    await loadAuxData();
    await fetchAllLogs();
  };
})();