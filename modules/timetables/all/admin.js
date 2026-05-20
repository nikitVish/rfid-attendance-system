// modules/timetables/all/admin.js
// All Timetables module (stable):
// - Teacher id -> name mapping (grid uses teacherMap fallback)
// - Grid: drops placeholder 12:00-12:00 columns
// - Editor: removes "Apply Monday..." option; filters blank/placeholder rows on save
// - Header: delete icon to remove a classroom timetable
// - Accordion header uses classroom LABEL (e.g., "Class 5"), APIs still use ID/key
// - Export button per classroom to download that timetable as CSV

(function () {
  'use strict';
  window.RadTimetablesAll = window.RadTimetablesAll || {};

  function el(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt !== undefined) e.textContent = txt; return e; }
  function q(sel, root) { return (root || document).querySelector(sel); }
  function qa(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function pad2(n) { return String(n).padStart(2, '0'); }

  function hhmmTo12(hhmm) {
    if (!hhmm) return '';
    var p = String(hhmm).split(':'); var hh = parseInt(p[0], 10) || 0; var mm = pad2((p[1] || '00').slice(0, 2));
    var ap = hh >= 12 ? 'PM' : 'AM'; var h12 = hh % 12; if (h12 === 0) h12 = 12;
    return pad2(h12) + ':' + mm + ' ' + ap;
  }
  function to24FromSpinner(h, m, ap) {
    var hh = parseInt(h, 10) || 12; var mmv = pad2(parseInt(m, 10) || 0); ap = (ap || 'AM').toUpperCase();
    if (ap === 'PM' && hh < 12) hh += 12;
    if (ap === 'AM' && hh === 12) hh = 0;
    return pad2(hh) + ':' + mmv;
  }
  function from24ToSpinnerVals(hhmm) {
    var p = String(hhmm || '12:00').split(':'); var hh = parseInt(p[0], 10) || 0; var mm = pad2(p[1] ? p[1].slice(0, 2) : 0);
    var ap = hh >= 12 ? 'PM' : 'AM'; var hh12 = hh % 12; if (hh12 === 0) hh12 = 12;
    return { h: pad2(hh12), m: mm, ap: ap };
  }

  function apiGet(path) {
    var base = (window.radConfig && window.radConfig.root) ? window.radConfig.root : '';
    return fetch(base + path, { method: 'GET', credentials: 'same-origin', headers: { 'X-WP-Nonce': (window.radConfig && window.radConfig.nonce) || '' } })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .catch(function (e) { console.warn('GET fail', path, e); return null; });
  }
  function apiPost(path, body) {
    var base = (window.radConfig && window.radConfig.root) ? window.radConfig.root : '';
    return fetch(base + path, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'X-WP-Nonce': (window.radConfig && window.radConfig.nonce) || '', 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    }).then(function (r) { return r.json().catch(function () { return { ok: false, message: 'invalid-json' }; }); });
  }

  // helpers to validate/normalize periods
  function normTime(hhmm) {
    if (!hhmm) return '';
    var p = String(hhmm).split(':');
    var h = parseInt(p[0], 10); if (isNaN(h)) return '';
    var m = parseInt(p[1] || '0', 10); if (isNaN(m)) m = 0;
    return pad2(h) + ':' + pad2(m);
  }
  function isMeaningfulPeriod(p) {
    if (!p) return false;
    var s = normTime(p.start), e = normTime(p.end);
    var hasTime = s && e && s !== e;
    var hasContent = (p.subject && p.subject.trim()) || (p.teacher && String(p.teacher).trim());
    return !!(hasTime || hasContent);
  }

  // Build grid (drops placeholder 12:00-12:00)
  // NOTE: accepts teacherMap to resolve teacher IDs to names.
  function buildTimetableGrid(timetable, teacherMap) {
    var days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    var periods = [];

    function pushPeriod(p) {
      var s = normTime(p.start), e = normTime(p.end);
      if (!s || !e || s === e) return; // skip placeholders
      var key = s + '||' + e;
      if (!periods.some(function (x) { return x.key === key; })) periods.push({ key: key, start: s, end: e });
    }

    days.forEach(function (d) { (timetable[d] || []).forEach(pushPeriod); });
    periods.sort(function (a, b) { return (a.start || '').localeCompare(b.start || ''); });

    var table = el('table', 'rad-tt-grid');
    var thead = el('thead'); var thr = el('tr');
    thr.appendChild(el('th', 'rad-tt-dayhead', 'Day'));
    periods.forEach(function (p) {
      thr.appendChild(el('th', 'rad-tt-periodhead', hhmmTo12(p.start) + ' - ' + hhmmTo12(p.end)));
    });
    thead.appendChild(thr); table.appendChild(thead);

    var tbody = el('tbody');
    days.forEach(function (d) {
      var tr = el('tr');
      tr.appendChild(el('td', 'rad-tt-day', d));
      periods.forEach(function (p) {
        var cell = el('td', 'rad-tt-cell');
        var slot = (timetable[d] || []).find(function (s) { return normTime(s.start) === p.start && normTime(s.end) === p.end; });
        if (slot && isMeaningfulPeriod(slot)) {
          var subj = el('div', 'rad-tt-subject', slot.subject || '');
          var teacherId = String(slot.teacher || slot.teacher_id || '');
          var teacherName =
            (slot.teacher_name && String(slot.teacher_name).trim()) ||
            (teacherMap && teacherMap[teacherId]) || '';
          var tch = el('div', 'rad-tt-teacher', teacherName);
          cell.appendChild(subj); cell.appendChild(tch);
        } else {
          cell.appendChild(el('div', 'rad-tt-empty-cell', '-'));
        }
        tr.appendChild(cell);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    return table;
  }

  function createTimeSpinner(initial24) {
    var wrap = el('div', 'rad-tt-time-spinner');
    var hour = el('select', ''); for (var i = 1; i <= 12; i++) { var o = el('option'); o.value = pad2(i); o.textContent = pad2(i); hour.appendChild(o); }
    var colon = el('span', 'rad-tt-time-colon', ':');
    var minute = el('select', ''); for (var j = 0; j < 60; j++) { var om = el('option'); om.value = pad2(j); om.textContent = pad2(j); minute.appendChild(om); }
    var ap = el('select', ''); ['AM', 'PM'].forEach(function (x) { var o = el('option'); o.value = x; o.textContent = x; ap.appendChild(o); });
    wrap.appendChild(hour); wrap.appendChild(colon); wrap.appendChild(minute); wrap.appendChild(ap);
    if (initial24) { var v = from24ToSpinnerVals(initial24); hour.value = v.h; minute.value = v.m; ap.value = v.ap; }
    wrap.get24 = function () { return to24FromSpinner(hour.value, minute.value, ap.value); };
    wrap.set24 = function (hhmm) { var v = from24ToSpinnerVals(hhmm || '12:00'); hour.value = v.h; minute.value = v.m; ap.value = v.ap; };
    wrap.onChange = function (cb) { [hour, minute, ap].forEach(function (x) { x.addEventListener('change', cb); }); };
    return wrap;
  }

  function createEditorPeriod(index, data, teachers) {
    var card = el('div', 'rad-tt-period-card');
    var head = el('div', 'rad-tt-period-title');
    var titleLeft = el('div', 'rad-tt-period-title-left');
    function buildTitle() {
      var subj = data && data.subject ? data.subject : '';
      var s = data && data.start ? hhmmTo12(data.start) : '';
      var e = data && data.end ? hhmmTo12(data.end) : '';
      var time = (s && e && s !== e) ? (' (' + s + ' - ' + e + ')') : (s ? (' (' + s + ')') : '');
      return 'Period ' + (index + 1) + (subj ? (' ' + subj) : '') + time;
    }
    titleLeft.appendChild(el('span', '', buildTitle()));
    head.appendChild(titleLeft);
    var right = el('div', 'rad-tt-period-head-right');
    var trash = el('button', 'rad-tt-del-icon'); trash.type = 'button'; trash.title = 'Delete period'; trash.innerHTML = '🗑';
    var caret = el('button', 'rad-tt-collapse-toggle'); caret.type = 'button'; caret.innerHTML = '▾';
    right.appendChild(trash); right.appendChild(caret); head.appendChild(right); card.appendChild(head);

    var body = el('div', 'rad-tt-period-body');
    body.appendChild(el('label', null, 'Teacher'));
    var teacherSel = el('select', 'rad-tt-input rad-tt-teacher'); teacherSel.appendChild(new Option('Select teacher', ''));
    (teachers || []).forEach(function (t) { teacherSel.appendChild(new Option(t.name || ('#' + t.id), t.id || t.name)); });
    if (data && data.teacher) teacherSel.value = data.teacher;
    body.appendChild(teacherSel);

    body.appendChild(el('label', null, 'Subject'));
    var subjInput = el('input', 'rad-tt-input rad-tt-subject'); subjInput.type = 'text'; subjInput.value = (data && data.subject) || '';
    body.appendChild(subjInput);

    var row = el('div', 'rad-tt-times-row');
    var sWrap = el('div', 'rad-tt-times-col'); sWrap.appendChild(el('label', null, 'Start Time'));
    var spS = createTimeSpinner((data && data.start) ? data.start : '12:00'); sWrap.appendChild(spS);
    var eWrap = el('div', 'rad-tt-times-col'); eWrap.appendChild(el('label', null, 'End Time'));
    var spE = createTimeSpinner((data && data.end) ? data.end : '12:00'); eWrap.appendChild(spE);
    row.appendChild(sWrap); row.appendChild(eWrap); body.appendChild(row);
    card.appendChild(body);

    card.classList.remove('open'); body.style.display = 'none'; trash.style.display = 'none';
    function setOpen(v) { if (v) { card.classList.add('open'); body.style.display = 'block'; caret.innerHTML = '▴'; trash.style.display = 'inline-block'; } else { card.classList.remove('open'); body.style.display = 'none'; caret.innerHTML = '▾'; trash.style.display = 'none'; } }
    head.addEventListener('click', function (e) { if (e.target === trash) return; setOpen(!card.classList.contains('open')); });
    card.addEventListener('mouseenter', function () { if (!card.classList.contains('open')) trash.style.display = 'inline-block'; });
    card.addEventListener('mouseleave', function () { if (!card.classList.contains('open')) trash.style.display = 'none'; });
    trash.addEventListener('click', function (ev) { ev.stopPropagation(); if (card._onDelete) card._onDelete(); });

    function updateTitle() {
      var subjVal = subjInput.value || '';
      var s = spS.get24(), e = spE.get24();
      var time = (s && e && s !== e) ? (' (' + hhmmTo12(s) + ' - ' + hhmmTo12(e) + ')') : (s ? (' (' + hhmmTo12(s) + ')') : '');
      titleLeft.firstChild.textContent = 'Period ' + (index + 1) + (subjVal ? (' ' + subjVal) : '') + time;
    }
    subjInput.addEventListener('input', updateTitle);
    spS.onChange(updateTitle); spE.onChange(updateTitle);

    return {
      el: card,
      getValue: function () {
        return {
          teacher: teacherSel.value || '',
          teacher_name: (teacherSel.options[teacherSel.selectedIndex] || {}).text || '',
          subject: subjInput.value || '',
          start: spS.get24(),
          end: spE.get24()
        };
      },
      setDeleteHandler: function (cb) { card._onDelete = cb; },
      setIndex: function (i) { index = i; updateTitle(); },
      open: function () { setOpen(true); },
      close: function () { setOpen(false); }
    };
  }

  // ---- NEW: export helper for single classroom timetable ----
  // ---- Export helper (old requirement format: 2 header rows + 2 rows per day) ----
function exportTimetableCsv(displayName, timetable, teacherMap) {
  var days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

  // Short labels for left side (Day column)
  var dayShort = {
    'Monday': 'MON',
    'Tuesday': 'TUES',
    'Wednesday': 'WED',
    'Thursday': 'THURS',
    'Friday': 'FRI',
    'Saturday': 'SAT',
    'Sunday': 'SUN'
  };

  // Roman numerals for PERIOD row
  function toRoman(n) {
    var map = [
      [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']
    ];
    var res = '';
    map.forEach(function (pair) {
      while (n >= pair[0]) {
        res += pair[1];
        n -= pair[0];
      }
    });
    return res || '';
  }

  // Time range label: "8:20 to9:00"
  function timeRangeLabel(start24, end24) {
    var s = normTime(start24);
    var e = normTime(end24);
    if (!s || !e) return '';
    var sp = s.split(':'), ep = e.split(':');
    var sh = parseInt(sp[0], 10) || 0;
    var eh = parseInt(ep[0], 10) || 0;
    var sm = sp[1] || '00';
    var em = ep[1] || '00';
    return sh + ':' + sm + ' to ' + eh + ':' + em;
  }

  // unique time-slots (same logic as grid)
  var periods = [];
  function pushPeriod(p) {
    var s = normTime(p.start), e = normTime(p.end);
    if (!s || !e || s === e) return; // skip placeholders
    var key = s + '||' + e;
    if (!periods.some(function (x) { return x.key === key; })) {
      periods.push({ key: key, start: s, end: e });
    }
  }

  days.forEach(function (d) {
    (timetable[d] || []).forEach(pushPeriod);
  });

  periods.sort(function (a, b) {
    return (a.start || '').localeCompare(b.start || '');
  });

  if (!periods.length) {
    alert('No periods found in timetable to export.');
    return;
  }

  var rows = [];

  // Header row 1: Time | 8:20 to9:00 | 9:00 to9:40 | ...
  var header1 = ['Time'];
  periods.forEach(function (p) {
    header1.push(timeRangeLabel(p.start, p.end));
  });
  rows.push(header1);

  // Header row 2: PERIOD | I | II | III | ...
  var header2 = ['PERIOD'];
  periods.forEach(function (_p, idx) {
    header2.push(toRoman(idx + 1));
  });
  rows.push(header2);

  // Each day -> 2 rows (subjects + teachers)
  days.forEach(function (d) {
    var subjectsRow = [dayShort[d] || d]; // e.g. MON
    var teachersRow = [''];               // blank for merge

    periods.forEach(function (p) {
      var slot = (timetable[d] || []).find(function (s) {
        return normTime(s.start) === p.start && normTime(s.end) === p.end;
      });

      if (slot && isMeaningfulPeriod(slot)) {
        var teacherId = String(slot.teacher || slot.teacher_id || '');
        var teacherName =
          (slot.teacher_name && String(slot.teacher_name).trim()) ||
          (teacherMap && teacherMap[teacherId]) || '';

        subjectsRow.push(slot.subject || '');
        teachersRow.push(teacherName || '');
      } else {
        subjectsRow.push('');
        teachersRow.push('');
      }
    });

    // Agar poora din blank hai to skip kar dete hain
    var hasContent = subjectsRow.slice(1).some(Boolean) || teachersRow.slice(1).some(Boolean);
    if (hasContent) {
      rows.push(subjectsRow);
      rows.push(teachersRow);
    }
  });

  // CSV build + download
  var csv = rows.map(function (r) {
    return r.map(function (v) {
      var s = String(v == null ? '' : v);
      s = s.replace(/"/g, '""');
      return '"' + s + '"';
    }).join(',');
  }).join('\r\n');

  var blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  var a = document.createElement('a');
  var safeName = (displayName || 'Classroom').replace(/[^a-z0-9\-]+/gi, '_');
  a.download = 'timetable-' + safeName + '.csv';
  a.href = URL.createObjectURL(blob);
  document.body.appendChild(a);
  a.click();
  setTimeout(function () {
    URL.revokeObjectURL(a.href);
    document.body.removeChild(a);
  }, 0);
}


  // -----------------------------------------------------------

  window.RadTimetablesAll.render = async function (container) {
    container = container || document.getElementById('rad-root-content');
    container.innerHTML = '';

    var headPanel = el('div', 'rad-panel rad-tt-header');
    headPanel.appendChild(el('h2', null, 'Classroom Timetables'));
    container.appendChild(headPanel);

    var panel = el('div', 'rad-panel rad-tt-main'); container.appendChild(panel);

    // load classrooms & teachers
    var [classResp, teachersResp] = await Promise.all([apiGet('/classrooms'), apiGet('/teachers')]);
    var teachers = (teachersResp && Array.isArray(teachersResp.rows)) ? teachersResp.rows : [];
    var teacherMap = {}; teachers.forEach(function (t) { teacherMap[String(t.id)] = t.name || t.title || t.display_name || ''; });

    // Build a label map: classroom key/id -> friendly label ("Class X" or provided name)
    var classLabelMap = {};
    if (classResp && Array.isArray(classResp.rows)) {
      classResp.rows.forEach(function (r) {
        var key = String(r.id || r.classroom_id || r.classroom || r.name || '');
        var label = r.classroom || r.name || (key ? ('Class ' + key) : 'Classroom');
        if (key) classLabelMap[key] = label;
      });
    }

    // timetables (store as { [key]: { days: {...}, label: 'Class X' } })
    var ttResp = await (apiGet('/timetables/list') || apiGet('/timetables'));
    var timetablesMap = {};
    if (ttResp && Array.isArray(ttResp.rows)) {
      ttResp.rows.forEach(function (r) {
        var key = String(r.classroom || r.class || r.classroom_id || '');
        var days = r.days || r.schedule || {};
        var label = classLabelMap[key] || r.classroom_name || r.classroom_label || (key ? ('Class ' + key) : 'Classroom');
        if (key) timetablesMap[key] = { days: days, label: label };
      });
    } else if (ttResp && typeof ttResp === 'object' && ttResp.rows === undefined) {
      Object.keys(ttResp).forEach(function (key) {
        var days = ttResp[key] || {};
        var label = classLabelMap[key] || (key ? ('Class ' + key) : 'Classroom');
        timetablesMap[key] = { days: days, label: label };
      });
    }

    // Accordion
    var acc = el('div', 'rad-tt-accordion');
    Object.keys(timetablesMap).forEach(function (key) {
      var info = timetablesMap[key] || {};
      var displayName = info.label || classLabelMap[String(key)] || String(key);

      var item = el('div', 'rad-tt-accordion-item');
      var header = el('div', 'rad-tt-acc-header'); // button-like div for custom icons

      var titleSpan = el('span', 'rad-tt-title', 'Classroom: ' + displayName);
      var actions = el('span', 'rad-tt-header-actions');

      // Delete icon
      var delBtn = el('button', 'rad-tt-del-class', '🗑'); delBtn.type = 'button'; delBtn.title = 'Delete timetable';

      // NEW: Export button
      var exportBtn = el('button', 'rad-tt-export', 'Export');
      exportBtn.type = 'button';
      exportBtn.title = 'Export timetable as CSV';

      // Chevron
      var chev = el('button', 'rad-tt-chevron', '▾'); chev.type = 'button';

      actions.appendChild(delBtn);
      actions.appendChild(exportBtn);
      actions.appendChild(chev);
      header.appendChild(titleSpan);
      header.appendChild(actions);
      item.appendChild(header);

      var panelInner = el('div', 'rad-tt-acc-panel');
      var editBtn = el('button', 'rad-tt-edit-btn', 'Edit'); editBtn.type = 'button';
      editBtn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        openEditorModal(key, info.days || {}, teachers, displayName); // pass key for API, label for UI
      });
      panelInner.appendChild(editBtn);

      var tableWrap = el('div', 'rad-tt-grid-wrap');
      // pass teacherMap so grid can resolve teacher IDs to names
      tableWrap.appendChild(buildTimetableGrid(info.days || {}, teacherMap));
      panelInner.appendChild(tableWrap);
      item.appendChild(panelInner);
      acc.appendChild(item);

      header.addEventListener('click', function (ev) {
        if (ev.target === delBtn || ev.target === exportBtn) return; // handled separately
        var open = item.classList.toggle('open');
        chev.textContent = open ? '▴' : '▾';
        editBtn.style.display = open ? 'inline-block' : 'none';
      });

      // Delete handler
      delBtn.addEventListener('click', async function (ev) {
        ev.stopPropagation();
        if (!confirm('Delete timetable for "' + displayName + '"? This cannot be undone.')) return;
        var resp = await apiPost('/timetables', { classroom: key, days: {} }); // wipes by replacing with empty (ID/key preserved)
        if (resp && resp.ok) {
          alert('Timetable deleted');
          if (window.RadTimetablesAll && typeof window.RadTimetablesAll.render === 'function') {
            window.RadTimetablesAll.render(container);
          }
        } else {
          alert('Delete failed: ' + (resp && (resp.message || resp.error) || 'unknown'));
        }
      });

      // NEW: export handler for this specific classroom
      exportBtn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        exportTimetableCsv(displayName, info.days || {}, teacherMap);
      });
    });

    if (!Object.keys(timetablesMap).length) {
      panel.appendChild(el('div', 'rad-tt-empty', 'No timetables found.'));
    } else {
      panel.appendChild(acc);
    }

    panel.appendChild(el('div', 'rad-tt-note', 'Tip: Click any classroom header to expand and view its weekly timetable. Use the Edit button to modify this classroom timetable in-place.'));
  };

  function mapDayKeyToFull(k) {
    if (!k) return k;
    var small = String(k).trim().slice(0, 3).toLowerCase();
    var map = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };
    return map[small] || k;
  }

  // NOTE: now accepts (classroomId, timetable, teachersList, displayLabel)
  async function openEditorModal(classroomId, timetable, teachersList, displayLabel) {
    var teachers = Array.isArray(teachersList) ? teachersList : [];
    var teacherMap = {}; teachers.forEach(function (t) { teacherMap[String(t.id)] = t.name || t.title || t.display_name || ''; });
    var daysFull = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    var daysShort = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

    // normalize timetable into state (do NOT inject placeholder rows here)
    var state = { daysMap: {}, currentDay: '', teachers: teachers };
    daysFull.forEach(function (d) {
      var arr = Array.isArray(timetable[d]) ? timetable[d].map(function (p) {
        return {
          teacher: p.teacher || p.teacher_id || '',
          teacher_name: p.teacher_name || teacherMap[String(p.teacher || p.teacher_id || '')] || '',
          subject: p.subject || '',
          start: normTime(p.start || ''),
          end: normTime(p.end || '')
        };
      }).filter(isMeaningfulPeriod) : [];
      state.daysMap[d] = arr;
    });

    // modal
    var modal = el('div', 'rad-tt-editor-modal');
    var overlay = el('div', 'rad-tt-editor-overlay'); modal.appendChild(overlay);
    var dialog = el('div', 'rad-tt-editor-dialog');
    var header = el('div', 'rad-tt-editor-header');
    header.appendChild(el('h3', null, 'Edit Timetable — ' + (displayLabel || classroomId)));
    var closeBtn = el('button', 'rad-tt-editor-close', '✕'); closeBtn.type = 'button'; header.appendChild(closeBtn);
    dialog.appendChild(header);

    var body = el('div', 'rad-tt-editor-body');
    var editorWrap = el('div', 'rad-tt-editor-wrap');
    editorWrap.appendChild(el('div', 'rad-tt-editor-class', 'Classroom: ' + (displayLabel || classroomId)));

    // tabs (Apply Monday removed as requested)
    var tabs = el('div', 'rad-tt-days-tabs');
    daysShort.forEach(function (s, i) { var b = el('button', 'rad-tt-daytab', s); b.dataset.day = daysFull[i]; tabs.appendChild(b); });
    editorWrap.appendChild(tabs);

    var periodsContainer = el('div', 'rad-tt-periods-list'); editorWrap.appendChild(periodsContainer);
    var addBar = el('button', 'rad-tt-add-period', '+ Add Another Period'); addBar.type = 'button';

    var actions = el('div', 'rad-tt-editor-actions');
    var saveBtn = el('button', 'rad-tt-save-btn', 'Save Changes'); saveBtn.type = 'button';
    var cancelBtn = el('button', 'rad-tt-cancel-btn', 'Cancel'); cancelBtn.type = 'button';
    actions.appendChild(cancelBtn); actions.appendChild(saveBtn);

    editorWrap.appendChild(addBar);
    editorWrap.appendChild(actions);
    body.appendChild(editorWrap);
    dialog.appendChild(body); modal.appendChild(dialog); document.body.appendChild(modal);

    function closeModal() { modal.remove(); }
    closeBtn.addEventListener('click', closeModal); cancelBtn.addEventListener('click', closeModal); overlay.addEventListener('click', closeModal);

    function ensureDay(d) {
      if (!Array.isArray(state.daysMap[d]) || state.daysMap[d].length === 0) {
        state.daysMap[d] = []; // start empty; user can add
      }
      return state.daysMap[d];
    }

    function saveCurrentDayFromDOM() {
      var list = qa('.rad-tt-period-card', periodsContainer);
      var arr = [];
      list.forEach(function (pEl) {
        var teacherSel = q('select.rad-tt-teacher', pEl);
        var subjInput = q('input.rad-tt-subject', pEl);
        var spinners = qa('.rad-tt-time-spinner', pEl);
        var start = (spinners[0] && typeof spinners[0].get24 === 'function') ? spinners[0].get24() : '';
        var end = (spinners[1] && typeof spinners[1].get24 === 'function') ? spinners[1].get24() : '';
        var row = {
          teacher: (teacherSel && teacherSel.value) || '',
          teacher_name: (teacherSel && teacherSel.options[teacherSel.selectedIndex] && teacherSel.options[teacherSel.selectedIndex].text) || '',
          subject: (subjInput && subjInput.value) || '',
          start: normTime(start),
          end: normTime(end)
        };
        if (isMeaningfulPeriod(row)) arr.push(row);
      });
      state.daysMap[state.currentDay] = arr;
      // propagate end -> next start if next has no time
      var cur = state.daysMap[state.currentDay];
      for (var i = 0; i < cur.length - 1; i++) {
        if (!cur[i + 1].start) cur[i + 1].start = cur[i].end || cur[i + 1].start;
      }
    }

    function renderForDay(day) {
      periodsContainer.innerHTML = '';
      var arr = ensureDay(day);
      arr.forEach(function (p, idx) {
        var comp = createEditorPeriod(idx, p, state.teachers);
        comp.setDeleteHandler(function () {
          var cur = state.daysMap[day] || [];
          cur.splice(idx, 1);
          state.daysMap[day] = cur;
          renderForDay(day);
        });
        // autosave when any control changes
        qa('input, select', comp.el).forEach(function (inp) {
          inp.addEventListener('change', function () { saveCurrentDayFromDOM(); });
        });
        periodsContainer.appendChild(comp.el);
      });
    }

    function setActiveTab(dayFull) {
      qa('.rad-tt-daytab', tabs).forEach(function (x) { x.classList.remove('active'); });
      var btn = Array.prototype.slice.call(qa('.rad-tt-daytab', tabs)).find(function (b) { return b.dataset.day === dayFull; });
      if (btn) btn.classList.add('active');
      state.currentDay = dayFull;
      renderForDay(dayFull);
    }

    tabs.addEventListener('click', function (ev) {
      var b = ev.target.closest && ev.target.closest('.rad-tt-daytab'); if (!b) return;
      saveCurrentDayFromDOM(); setActiveTab(b.dataset.day);
    });

    addBar.addEventListener('click', function (ev) {
      ev.preventDefault();
      saveCurrentDayFromDOM();
      var list = ensureDay(state.currentDay);
      var last = list[list.length - 1];
      list.push({ teacher: '', teacher_name: '', subject: '', start: last ? last.end : '', end: '' });
      renderForDay(state.currentDay);
      var lastEl = periodsContainer.lastElementChild; if (lastEl) { var head = q('.rad-tt-period-title', lastEl); if (head) head.click(); }
    });

    saveBtn.addEventListener('click', async function () {
      saveCurrentDayFromDOM();
      // deep-clean payload: keep only meaningful rows
      var payload = { classroom: classroomId, days: {} }; // IMPORTANT: use ID/key for API
      daysFull.forEach(function (d) {
        var arr = (state.daysMap[d] || []).filter(isMeaningfulPeriod).map(function (p) {
          return { teacher: p.teacher || '', teacher_name: p.teacher_name || '', subject: p.subject || '', start: normTime(p.start), end: normTime(p.end) };
        });
        if (arr.length) payload.days[d] = arr;
      });

      var resp = await apiPost('/timetables', payload);
      if (resp && resp.ok) {
        smallToast('Saved timetable');
        modal.remove();
        var root = document.getElementById('rad-root-content');
        if (window.RadTimetablesAll && typeof window.RadTimetablesAll.render === 'function') setTimeout(function () { window.RadTimetablesAll.render(root); }, 200);
      } else {
        alert('Save failed: ' + (resp && (resp.message || resp.error || JSON.stringify(resp)) || 'unknown'));
      }
    });

    // open today’s tab by default
    var todayIdx = (new Date()).getDay(); var mapIdx = todayIdx === 0 ? 6 : todayIdx - 1;
    setTimeout(function () { setActiveTab(daysFull[mapIdx]); }, 30);

    function smallToast(msg) {
      var t = el('div', 'rad-tt-toast', msg); document.body.appendChild(t);
      setTimeout(function () { t.style.opacity = 1; }, 10);
      setTimeout(function () { t.style.opacity = 0; setTimeout(function () { t.remove(); }, 400); }, 1400);
    }
  }

  window.RadTimetablesAll._helpers = { hhmmTo12: hhmmTo12, isMeaningfulPeriod: isMeaningfulPeriod };
})();
