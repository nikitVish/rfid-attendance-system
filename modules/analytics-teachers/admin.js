// modules/analytics-teachers/admin.js
(function () {

  function q(sel, root){ return (root || document).querySelector(sel); }
  function el(tag, cls, text){ var e=document.createElement(tag); if(cls) e.className=cls; if(text!==undefined) e.textContent=text; return e; }

  // ---- Time helpers ----
  function fmtTime(t){
    if(!t) return '';
    t = String(t).trim();
    if (/\b(am|pm)\b/i.test(t)) return t.replace(/am/i,'AM').replace(/pm/i,'PM');
    var m = t.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
    if(!m) return t;
    var hh = parseInt(m[1],10), mm = m[2];
    var suf = (hh >= 12) ? 'PM' : 'AM';
    hh = hh % 12; if (hh === 0) hh = 12;
    return hh + ':' + mm + ' ' + suf;
  }
  function minutesFromAny(t){
    if(!t) return 0;
    t = String(t).trim();
    var m = t.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*([AP]M)$/i);
    if(m){
      var hh = parseInt(m[1],10) % 12;
      if (/[pP]M/.test(m[3])) hh += 12;
      return hh*60 + parseInt(m[2],10);
    }
    m = t.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
    if(m){ return parseInt(m[1],10)*60 + parseInt(m[2],10); }
    return 0;
  }
  function diffMinutes(s,e){ return Math.max(0, minutesFromAny(e) - minutesFromAny(s)); }
  function toHHMM(min){ var h=Math.floor(min/60), m=min%60; return String(h).padStart(2,'0') + ':' + String(m).padStart(2,'0'); }
  function timeKey(start, end){ return (start||'') + '|' + (end||''); }

  async function apiGet(path) {
    var root = (window.radConfig && window.radConfig.root) || '';
    var nonce = (window.radConfig && window.radConfig.nonce) || '';
    var res = await fetch(root + path, { method: 'GET', credentials: 'same-origin', headers: { 'X-WP-Nonce': nonce } });
    if(!res.ok){ var txt = await res.text(); throw new Error('HTTP '+res.status+': '+txt); }
    return res.json();
  }

  async function loadTeachers() {
    var r = await apiGet('/teachers?per_page=999');
    return (r && r.rows) ? r.rows : [];
  }

  async function loadAnalytics(teacherId){
    // analytics + classroom labels
    const [j, clsResp] = await Promise.all([
      apiGet(`/analytics/teachers?teacher_id=${encodeURIComponent(teacherId)}&debug=0`),
      apiGet('/classrooms').catch(()=>null)
    ]);

    // classroom id -> label
    var classMap = {};
    if (clsResp && Array.isArray(clsResp.rows)) {
      clsResp.rows.forEach(function(r){
        var id = (r.id != null) ? String(r.id) : (r.classroom_id != null ? String(r.classroom_id) : (r.classroom != null ? String(r.classroom) : ''));
        var label = r.name || r.classroom || (id ? ('Class ' + id) : '');
        if (id) classMap[id] = label;
      });
    }

    var days = Array.isArray(j && j.days) ? j.days : [];
    var slotsRaw = Array.isArray(j && j.slots) ? j.slots : [];

    var jsToday = (new Date()).getDay(); // 0..6
    var weekdayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    function pick(v1,v2,v3){ return v1 ?? v2 ?? v3 ?? ''; }

    function resolveClassLabel(p){
      var raw = pick(p.classroom, p.classroom_name, p.class);
      var id  = (p.classroom_id != null) ? String(p.classroom_id) : '';
      if (id && classMap[id]) return classMap[id];
      if (raw && /^\d+$/.test(String(raw).trim())) { var m = classMap[String(raw).trim()]; if (m) return m; }
      if (raw && /^class\s*\d+$/i.test(String(raw)) && id && classMap[id]) return classMap[id];
      if (raw) return raw;
      return id ? (classMap[id] || ('Class ' + id)) : '';
    }

    function normPeriod(p){
      var rawStart = pick(p.raw_start, p.start_time, p.start);
      var rawEnd   = pick(p.raw_end,   p.end_time,   p.end);
      var dispStart= pick(p.time_from, rawStart, '');
      var dispEnd  = pick(p.time_to,   rawEnd,   '');
      return {
        day: '',
        classroom: resolveClassLabel(p),
        subject: p.subject || '',
        start_raw: rawStart,
        end_raw: rawEnd,
        start: fmtTime(dispStart),
        end: fmtTime(dispEnd)
      };
    }

    // Normalize weekly (keep Sunday but we’ll exclude it from totals)
    var weekly = days.map(function(d){
      var dayName = d.day || weekdayNames[d.day_index || 0] || '';
      var periods = Array.isArray(d.periods) ? d.periods.map(function(p){
        var np = normPeriod(p); np.day = dayName; return np;
      }) : [];
      // map conflicts from API if any
      var confs = Array.isArray(d.conflicts) ? d.conflicts.map(function(c){
        return {
          raw_start: c.raw_start,
          raw_end: c.raw_end,
          from: c.from,
          to: c.to,
          day: c.day,
          involved: Array.isArray(c.involved) ? c.involved.map(function(ii){
            return {
              timetable_id: ii.timetable_id || ii.id || null,
              classroom_id: ii.classroom_id || null,
              classroom: resolveClassLabel(ii),
              subject: ii.subject || ''
            };
          }) : []
        };
      }) : [];
      // keep gaps array from API (already canonical per-slot now)
      return {
        day: dayName,
        day_index: d.day_index || 0,
        periods: periods,
        gaps: Array.isArray(d.gaps) ? d.gaps.slice() : [],
        conflicts: confs
      };
    });

    // Canonical slots
    var slots = slotsRaw.map(function(s){
      return { start_raw:s.raw_start, end_raw:s.raw_end, label: s.label || (fmtTime(s.raw_start)+' to '+fmtTime(s.raw_end)) };
    }).sort(function(a,b){ return minutesFromAny(a.start_raw) - minutesFromAny(b.start_raw); });

    // Mon–Sat slice for totals
    var weekMonSat = weekly.filter(function(d){ return d.day_index >= 1 && d.day_index <= 6; });

    // Today view (if Sunday -> empty)
    var todayObj = (jsToday === 0) ? { day_index:0, day:'Sunday', periods:[], gaps:[] }
                                   : (weekly.find(d => d.day_index === jsToday) || {periods:[], gaps:[]});
    var rowsToday = todayObj.periods;

    // Counts (classes from periods length, gaps from API’s per-slot fill)
    var todayCount       = rowsToday.length;
    var todayGapsCount   = (todayObj.gaps || []).length;
    var weekCount        = weekMonSat.reduce((s,d)=> s + (d.periods ? d.periods.length : 0), 0);
    var weekGapsCount    = weekMonSat.reduce((s,d)=> s + (d.gaps ? d.gaps.length : 0), 0);

    // Durations
    var todayMinutes     = rowsToday.reduce((s,p)=> s + diffMinutes(p.start_raw, p.end_raw), 0);
    var todayGapsMinutes = (todayObj.gaps || []).reduce((s,g)=> s + diffMinutes(g.raw_from, g.raw_to), 0);
    var weekMinutes      = weekMonSat.reduce((s,d)=> s + (d.periods||[]).reduce((x,p)=> x+diffMinutes(p.start_raw,p.end_raw),0), 0);
    var weekGapsMinutes  = weekMonSat.reduce((s,d)=> s + (d.gaps||[]).reduce((x,g)=> x + diffMinutes(g.raw_from,g.raw_to),0), 0);

    return {
      raw: j,
      weekly,
      slots, // canonical headers for matrix
      stats: { todayCount, todayMinutes, weekCount, weekMinutes, todayGapsCount, todayGapsMinutes, weekGapsCount, weekGapsMinutes }
    };
  }

  // ------- UI --------
  function renderCards(host){
    var wrap = el('div','rad-duo-cards');
    function duoCard(leftLabel, leftBind, rightLabel, rightBind, rightColorClass){
      var c = el('div','rad-duo-card');
      var left = el('div','rad-duo-side rad-duo-left');
      left.appendChild(el('div','rad-duo-label', leftLabel));
      var lv = el('div','rad-duo-value val-blue','0'); lv.setAttribute('data-bind', leftBind); left.appendChild(lv);
      var right = el('div','rad-duo-side rad-duo-right');
      right.appendChild(el('div','rad-duo-label', rightLabel));
      var rv = el('div','rad-duo-value '+rightColorClass,'00:00'); rv.setAttribute('data-bind', rightBind); right.appendChild(rv);
      c.appendChild(left); c.appendChild(el('div','rad-duo-divider')); c.appendChild(right);
      return c;
    }
    wrap.appendChild(duoCard('Today Total Class','stat-today-count','Today Total Hour','stat-today-min','val-red'));
    wrap.appendChild(duoCard('Weekly Total Class','stat-week-count','Weekly Total Hour','stat-week-min','val-red'));
    wrap.appendChild(duoCard('Today Total Gaps','stat-gaps-today-count','Today Total Gaps Hour','stat-gaps-today-min','val-green'));
    wrap.appendChild(duoCard('Weekly Total Gaps','stat-gaps-week-count','Weekly Total Gaps Hour','stat-gaps-week-min','val-green'));
    host.appendChild(wrap);
  }

  function setCardStats(root, st){
    var map = {
      'stat-today-count': st.todayCount,
      'stat-today-min':   toHHMM(st.todayMinutes),
      'stat-week-count':  st.weekCount,
      'stat-week-min':    toHHMM(st.weekMinutes),
      'stat-gaps-today-count': st.todayGapsCount,
      'stat-gaps-today-min':   toHHMM(st.todayGapsMinutes),
      'stat-gaps-week-count':  st.weekGapsCount,
      'stat-gaps-week-min':    toHHMM(st.weekGapsMinutes)
    };
    Object.keys(map).forEach(function(k){
      var n = root.querySelector('[data-bind="'+k+'"]');
      if(n) n.textContent = String(map[k] ?? '');
    });
  }

  function buildMatrix(weekly, slots){
    // Mon–Sat only rows
    var daysOrder = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    var dayRows = daysOrder.map(function(day){
      var row = { day, cells: [] };
      var dayObj = weekly.find(function(w){ return w.day === day; }) || {periods:[]};
      slots.forEach(function(s){
        var p = (dayObj.periods||[]).find(function(pp){
          return timeKey(pp.start_raw, pp.end_raw) === (s.start_raw+'|'+s.end_raw);
        });
        if(p) row.cells.push({ classroom:p.classroom||'', subject:p.subject||'' });
        else row.cells.push(null); // gap
      });
      return row;
    });
    return { slots, dayRows };
  }

  function renderMatrixPanel(host, matrix, onExport){
    var panel = el('div','rad-panel');

    var bar = el('div', 'rad-matrix-bar');
    bar.appendChild(el('div','rad-panel-title','Period Matrix (Teacher-wise)'));
    var exportBtn = el('button','rad-btn small','Export Matrix CSV');
    exportBtn.addEventListener('click', onExport);
    bar.appendChild(exportBtn);
    panel.appendChild(bar);

    var tbl = el('table','rad-table');
    var thead = el('thead');
    var htr = el('tr');
    htr.appendChild(el('th',null,'Time'));
    matrix.slots.forEach(function(s){ htr.appendChild(el('th',null, s.label)); });
    thead.appendChild(htr);
    tbl.appendChild(thead);

    var tb = el('tbody');
    matrix.dayRows.forEach(function(r){
      var tr = el('tr');
      tr.appendChild(el('td',null, r.day.toUpperCase().slice(0,3)));
      r.cells.forEach(function(c){
        var td = el('td');
        if(c){
          var top = el('div','rad-matrix-class', (c.classroom || ''));
          var bot = el('div','rad-matrix-sub', (c.subject || ''));
          td.appendChild(top); td.appendChild(bot);
        }
        tr.appendChild(td);
      });
      tb.appendChild(tr);
    });
    tbl.appendChild(tb);

    panel.appendChild(tbl);
    host.appendChild(panel);

    // return the panel node so caller can append extras (like conflicts) after it if needed
    return panel;
  }

  function renderConflictsPanel(host, weekly){
    // collect all conflicts across Mon-Sat (and Sunday if present) and render nicely
    var conflictsAll = [];
    (weekly || []).forEach(function(d){
      if (Array.isArray(d.conflicts) && d.conflicts.length) {
        d.conflicts.forEach(function(c){
          conflictsAll.push({ day: d.day, day_index: d.day_index, conflict: c });
        });
      }
    });
    if (!conflictsAll.length) return; // nothing to show

    var p = el('div','rad-panel');
    p.appendChild(el('div','rad-panel-title','Scheduling Conflicts (same teacher scheduled in multiple classes at same time)'));

    conflictsAll.forEach(function(item){
      var box = el('div','rad-conflict');
      var hdr = el('div','rad-conflict-hdr', item.day + ' — ' + (item.conflict.from || '') + ' to ' + (item.conflict.to || ''));
      box.appendChild(hdr);
      var ul = el('ul','rad-conflict-list');
      (item.conflict.involved || []).forEach(function(inv){
        var li = el('li',null, (inv.classroom || '') + ' — ' + (inv.subject || ''));
        ul.appendChild(li);
      });
      box.appendChild(ul);
      p.appendChild(box);
    });

    host.appendChild(p);
  }

  function exportMatrixCSV(matrix, teacherName){
    var cols = ['Day'].concat(matrix.slots.map(function(s){ return s.label; }));
    var rows = [cols.join(',')];
    matrix.dayRows.forEach(function(r){
      var arr = [r.day];
      r.cells.forEach(function(c){
        if(!c){ arr.push(''); }
        else {
          var txt = (c.classroom||'') + (c.subject?(' | '+c.subject):'');
          if(/[" ,\n]/.test(txt)) txt = '"' + txt.replace(/"/g,'""') + '"';
          arr.push(txt);
        }
      });
      rows.push(arr.join(','));
    });

    var csv = rows.join('\n');
    var blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (teacherName ? teacherName.replace(/\s+/g,'_')+'_':'') + 'period_matrix.csv';
    document.body.appendChild(a);
    a.click();
    setTimeout(function(){ URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }

  window.RadAnalyticsTeachers = {
    render: async function(root){
      root.innerHTML = '';

      const toolbar = el('div','rad-analytics-toolbar');
      const teacherSel = el('select','rad-select');
      toolbar.appendChild(teacherSel);
      root.appendChild(toolbar);

      renderCards(root);
      const matrixHost = el('div'); root.appendChild(matrixHost);

      let teachers = [];
      try { teachers = await loadTeachers(); } catch(e) { console.error('Load teachers failed', e); }
      teachers.forEach(function(t){
        var o = el('option'); o.value = t.id; o.textContent = (t.name||('Teacher '+t.id)) + (t.department ? (' — '+t.department) : '');
        teacherSel.appendChild(o);
      });
      if(!teacherSel.value && teachers[0]) teacherSel.value = teachers[0].id;

      async function refresh(){
        matrixHost.innerHTML = '';
        try {
          var resp = await loadAnalytics(teacherSel.value);
          setCardStats(root, resp.stats);

          var matrix = buildMatrix(resp.weekly, resp.slots);
          // render matrix and get panel node back
          var panelNode = renderMatrixPanel(matrixHost, matrix, function(){
            var name = (teachers.find(function(t){ return String(t.id)===String(teacherSel.value); })||{}).name || '';
            exportMatrixCSV(matrix, name);
          });

          // conflicts: render directly after matrix panel
          renderConflictsPanel(matrixHost, resp.weekly);

        } catch(err){
          console.error(err);
          var p = el('div','rad-panel'); p.appendChild(el('div','rad-panel-title','Period Matrix (Teacher-wise)')); p.appendChild(el('div','rad-empty','Error: '+err.message));
          matrixHost.appendChild(p);
        }
      }

      teacherSel.addEventListener('change', refresh);
      refresh();
    }
  };

})();
