(function(){
  window.RadLogs = window.RadLogs || {};

  function el(tag, cls, txt){ var e=document.createElement(tag); if(cls) e.className=cls; if(txt!=null) e.textContent=txt; return e; }
  function q(sel, root){ return (root||document).querySelector(sel); }
  function apiGet(path){
    var base = (window.radConfig && window.radConfig.root) ? window.radConfig.root : '';
    return fetch(base + path, {credentials:'same-origin', headers:{'X-WP-Nonce': (window.radConfig && window.radConfig.nonce)||''}})
      .then(function(r){ if(!r.ok) return r.text().then(function(t){ throw new Error(t||r.status); }); return r.json(); });
  }
  function adminAjaxPost(data){
    var root = (window.radConfig && window.radConfig.root) ? window.radConfig.root : '';
    var ajax = root.replace(/\/wp-json.*$/,'') + '/wp-admin/admin-ajax.php';
    var fd = new FormData(); Object.keys(data).forEach(function(k){ fd.append(k, data[k]); });
    return fetch(ajax, {method:'POST', credentials:'same-origin', body: fd})
      .then(function(r){ return r.text().then(function(t){ try { return JSON.parse(t); } catch(e){ throw new Error(t); } }); });
  }

  function timeFmtSec(secs){
    if(!secs || secs<=0) return '-';
    var h = Math.floor(secs/3600), m = Math.floor((secs%3600)/60);
    return (h>0? (h+'h '):'') + (m>0? (m+'m') : '');
  }
  function fmtSignedDelta(sec){ if(sec==null) return '-';
    var s = Math.abs(sec); var m = Math.floor(s/60); var ss = Math.abs(s%60);
    var sign = sec===0 ? '' : (sec>0? '+':'-');
    return sign + String(m).padStart(2,'0') + ':' + String(ss).padStart(2,'0');
  }
  function chip(text, kind){ return el('span','sl-chip '+(kind||''), text); }
  function statusKind(label){
    label = (label||'').toLowerCase();
    if (label==='on time') return 'green';
    if (label==='early entry' || label==='late exit') return 'yellow';
    if (label==='early exit' || label==='late entry') return 'red';
    return 'gray';
  }
  function filterSVG(){ return '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 5h18" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M7 12h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M10 19h4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>'; }

  // Stable key used both client side and server side to store remarks
  function rowKey(r){
    return (r.date||'') + '|' + (r.uid||'') + '|' + (r.classroom||'') + '|' + (r.time_from||'');
  }

  window.RadLogs.renderStaffLogs = async function(container){
    container.innerHTML = '';

    /* ---------- Header ---------- */
    var head = el('div','sl-header rad-panel');
    var left = el('div','sl-head-left');
    left.appendChild(el('h2',null,'Staff Logs (Scheduled)'));
    head.appendChild(left);

    var right = el('div','sl-head-right');
    var nowDiv = el('div','sl-now');
    function tick(){
      var now = new Date();
      nowDiv.textContent = now.toLocaleDateString(undefined,{weekday:'long'}) +
        ' - ' + now.toLocaleDateString('en-CA') + ' - ' + now.toLocaleTimeString();
    }
    tick(); setInterval(tick,1000);
    right.appendChild(nowDiv);

    var exportBtn = el('button','sl-btn green','Export CSV'); right.appendChild(exportBtn);

    var perSel = el('select','sl-select');
    ['10','25','50','100'].forEach(function(v){ var o=el('option'); o.value=v; o.textContent=v+' / page'; perSel.appendChild(o); });
    right.appendChild(perSel);

    var filterToggle = el('button','sl-btn ghost sl-filter-toggle'); filterToggle.innerHTML = filterSVG(); right.appendChild(filterToggle);
    head.appendChild(right);
    container.appendChild(head);

    /* ---------- Filters (EXACTLY TWO ROWS) ---------- */
    var filt = el('div','sl-filters rad-panel'); filt.style.display='none';

    var row1 = el('div','sl-f-row');

    var userCol = el('div','sl-f-col');
    userCol.appendChild(el('label',null,'User'));
    var userSel = el('select','sl-select'); userSel.appendChild(new Option('All users',''));
    userCol.appendChild(userSel);
    row1.appendChild(userCol);

    var uidCol = el('div','sl-f-col');
    uidCol.appendChild(el('label',null,'UID'));
    var uidInput = el('input','sl-input'); uidInput.placeholder='UID';
    uidCol.appendChild(uidInput);
    row1.appendChild(uidCol);

    var devCol = el('div','sl-f-col');
    devCol.appendChild(el('label',null,'Device ID'));
    var devSel = el('select','sl-select'); devSel.appendChild(new Option('All devices',''));
    devCol.appendChild(devSel);
    row1.appendChild(devCol);

    var fromCol = el('div','sl-f-col'); fromCol.appendChild(el('label',null,'From'));
    var fromInput = el('input','sl-input'); fromInput.type='date'; fromInput.value = new Date().toLocaleDateString('en-CA');
    fromCol.appendChild(fromInput); row1.appendChild(fromCol);

    var toCol = el('div','sl-f-col'); toCol.appendChild(el('label',null,'To'));
    var toInput = el('input','sl-input'); toInput.type='date'; toInput.value = new Date().toLocaleDateString('en-CA');
    toCol.appendChild(toInput); row1.appendChild(toCol);

    filt.appendChild(row1);

    var row2 = el('div','sl-f-row');

    var classCol = el('div','sl-f-col'); classCol.appendChild(el('label',null,'Classroom'));
    var classSel = el('select','sl-select'); classSel.appendChild(new Option('All classrooms',''));
    classCol.appendChild(classSel); row2.appendChild(classCol);

    var roomCol = el('div','sl-f-col'); roomCol.appendChild(el('label',null,'Room No.'));
    var roomSel = el('select','sl-select'); roomSel.appendChild(new Option('All rooms',''));
    roomCol.appendChild(roomSel); row2.appendChild(roomCol);

    var deptCol = el('div','sl-f-col'); deptCol.appendChild(el('label',null,'Department'));
    var deptSel = el('select','sl-select'); deptSel.appendChild(new Option('All depts',''));
    deptCol.appendChild(deptSel); row2.appendChild(deptCol);

    var eStatCol = el('div','sl-f-col'); eStatCol.appendChild(el('label',null,'Entry Status'));
    var eStatSel = el('select','sl-select');
    ['','On Time','Early Entry','Late Entry','No Tap'].forEach(function(s){ eStatSel.appendChild(new Option(s||'All', s)); });
    eStatCol.appendChild(eStatSel); row2.appendChild(eStatCol);

    var xStatCol = el('div','sl-f-col'); xStatCol.appendChild(el('label',null,'Exit Status'));
    var xStatSel = el('select','sl-select');
    ['','On Time','Early Exit','Late Exit','No Tap'].forEach(function(s){ xStatSel.appendChild(new Option(s||'All', s)); });
    xStatCol.appendChild(xStatSel); row2.appendChild(xStatCol);

    filt.appendChild(row2);

    /* ---------- Delete controls (show only when filters open) ---------- */
    var delRow = el('div','sl-delete rad-panel'); delRow.style.display='none';
    var delLeft = el('div','sl-delete-left');
    delLeft.appendChild(el('div','sl-delete-label','Select top N logs (from current filtered results):'));
    var delInput = el('input','sl-input'); delInput.type='number'; delInput.min='1'; delInput.placeholder='Enter number';
    delLeft.appendChild(delInput);
    var delRight = el('div','sl-delete-right');
    var btnSelect = el('button','sl-btn green','Select');
    var btnSelectAll = el('button','sl-btn green','Select all visible');
    var btnClear = el('button','sl-btn ghost','Clear');
    var selCount = el('div','sl-delete-count','Selected: 0');
    var btnDelete = el('button','sl-btn primary','Confirm Delete'); btnDelete.disabled = true;
    delRight.appendChild(btnSelect); delRight.appendChild(btnSelectAll); delRight.appendChild(btnClear);
    delRight.appendChild(selCount); delRight.appendChild(btnDelete);
    delRow.appendChild(delLeft); delRow.appendChild(delRight);

    container.appendChild(filt);
    container.appendChild(delRow);

    /* ---------- Table ---------- */
    var panel = el('div','sl-panel');
    var table = el('table','sl-table');
    table.innerHTML = `
      <thead>
        <tr>
          <th>SN</th>
          <th>User</th>
          <th>Department</th>
          <th>Classroom</th>
          <th>Room No.</th>
          <th>Subject</th>
          <th>Scheduled Time</th>
          <th>Time</th>
          <th>Entry</th>
          <th>Exit</th>
          <th>Device</th>
          <th>Date</th>
          <th>Total</th>
          <th>Remark</th>
        </tr>
      </thead>
    `;
    var tbody = el('tbody'); table.appendChild(tbody); panel.appendChild(table);

    var pager = el('div','sl-pager');
    var prev = el('button','sl-btn small','<');
    var next = el('button','sl-btn small','>');
    var pageLab = el('span','sl-page','');
    pager.appendChild(prev); pager.appendChild(pageLab); pager.appendChild(next);
    panel.appendChild(pager);
    container.appendChild(panel);

    /* ---------- State ---------- */
    var state = { page:1, per: parseInt(perSel.value,10), rows:[], total:null, serverPaged:false, selected: new Set() };
    function updateSelCount(){
      selCount.textContent = 'Selected: ' + state.selected.size;
      btnDelete.disabled = state.selected.size === 0;
    }

    /* ---------- UI wiring ---------- */
    filterToggle.addEventListener('click', function(){
      var show = (filt.style.display==='none');
      filt.style.display = show ? 'block' : 'none';
      delRow.style.display = show ? 'flex' : 'none';
      filterToggle.classList.toggle('active', show);
    });

    async function loadOptions(){
      var dv = null;
      try {
        var t = await apiGet('/teachers');
        if (t && Array.isArray(t.rows)) {
          userSel.innerHTML=''; userSel.appendChild(new Option('All users',''));
          var deps = {};
          t.rows.forEach(function(r){ userSel.appendChild(new Option(r.name || ('User '+r.id), String(r.id))); if(r.department) deps[r.department]=true; });
          deptSel.innerHTML=''; deptSel.appendChild(new Option('All depts',''));
          Object.keys(deps).sort().forEach(function(d){ deptSel.appendChild(new Option(d,d)); });
        }
      } catch(e){}

      try { 
        dv = await apiGet('/devices');
        if (dv && Array.isArray(dv.rows)) {
          devSel.innerHTML=''; devSel.appendChild(new Option('All devices',''));
          dv.rows.forEach(function(r){ if(r.device_id) devSel.appendChild(new Option(r.device_id, r.device_id)); });
        }
      } catch(e){}

      try { var cl = await apiGet('/classrooms');
        if (cl && Array.isArray(cl.rows)) {
          classSel.innerHTML=''; classSel.appendChild(new Option('All classrooms',''));
          cl.rows.forEach(function(r){ if(r.classroom) classSel.appendChild(new Option(r.classroom, r.classroom)); });
        }
      } catch(e){}

      try { var rm = await apiGet('/rooms');
        if (rm && Array.isArray(rm.rows)) {
          roomSel.innerHTML=''; roomSel.appendChild(new Option('All rooms',''));
          rm.rows.forEach(function(r){ if(r.room_no) roomSel.appendChild(new Option(r.room_no, r.room_no)); });
        }
      } catch(e){}

      // Add any device-provided classroom labels to the classroom select (avoid duplicates)
      try {
        if (dv && Array.isArray(dv.rows)) {
          var existing = {};
          Array.from(classSel.options).forEach(function(o){ existing[o.value] = true; });
          dv.rows.forEach(function(r){
            if (r.classroom && !existing[r.classroom]) {
              classSel.appendChild(new Option(r.classroom, r.classroom));
              existing[r.classroom] = true;
            }
          });
        }
      } catch(e){}
    }

    function deviceLabel(r){
      var a = r.device_in || '';
      var b = r.device_out || '';
      if (a && b && a!==b) return a + ' / ' + b;
      return a || b || '';
    }

    function render(){
      var per = state.per = parseInt(perSel.value,10);
      var totalCount = (state.serverPaged && typeof state.total === 'number') ? state.total : state.rows.length;
      var pages = Math.max(1, Math.ceil(totalCount / per));
      if (state.page > pages) state.page = pages;

      var pageRows;
      // if server provided paging, state.rows already contains only current page
      if (state.serverPaged) {
        pageRows = state.rows || [];
      } else {
        var start = (state.page-1) * per;
        pageRows = state.rows.slice(start, start+per);
      }

      tbody.innerHTML = '';
      if (!pageRows.length){
        var tr = el('tr'); var td = el('td','sl-empty','No logs'); td.colSpan=14; tr.appendChild(td); tbody.appendChild(tr);
      } else {
        // When server-paged, SN should reflect absolute position in full result set
        var baseSN = state.serverPaged ? ((state.page-1) * per) : ((state.page-1) * per);
        pageRows.forEach(function(r, idx){
          var tr = el('tr');
          var k = rowKey(r);

          // SN with red check if selected
          var snTd = el('td');
          if (state.selected.has(k)) {
            var mark = el('span','sl-sn-check','✔️');
            snTd.appendChild(mark);
          } else {
            snTd.textContent = String(baseSN + idx + 1);
          }
          tr.appendChild(snTd);

          tr.appendChild(el('td',null,r.teacher||''));        // User
          tr.appendChild(el('td',null,r.department||''));     // Department
          tr.appendChild(el('td',null,r.classroom||''));       // Classroom
          tr.appendChild(el('td',null,r.room_no||''));         // Room No.
          tr.appendChild(el('td',null,r.subject||''));         // Subject

          // Scheduled Time column (from timetable)
          var schedTd = el('td');
          schedTd.textContent = (r.time_from || '-') + ' - ' + (r.time_to || '-');
          tr.appendChild(schedTd);

          // Time col: In (top) / Out (bottom)
          var tTd = el('td');
          tTd.innerHTML = `<div>${r.in_time || '-'}</div><div class="sl-dim">${r.out_time || '-'}</div>`;
          tr.appendChild(tTd);

          // Entry (delta + chip)
          var eTd = el('td');
          eTd.appendChild(el('div','sl-delta', fmtSignedDelta(r.entry_delta)));
          eTd.appendChild(chip(r.entry_status || '-', statusKind(r.entry_status)));
          tr.appendChild(eTd);

          // Exit (delta + chip)
          var xTd = el('td');
          xTd.appendChild(el('div','sl-delta', fmtSignedDelta(r.exit_delta)));
          xTd.appendChild(chip(r.exit_status || '-', statusKind(r.exit_status)));
          tr.appendChild(xTd);

          tr.appendChild(el('td',null, deviceLabel(r)));      // Device(s)
          tr.appendChild(el('td',null, r.date || ''));         // Date
          tr.appendChild(el('td',null, timeFmtSec(r.total_secs))); // Total

          // Remark
          var rm = el('td');
          var inp = el('input','sl-remark');
          inp.value = r.remark || '';
          var sb = el('button','sl-btn small','Save');
          sb.onclick = function(){
            sb.disabled = true; sb.textContent='Saving...';
            // NOTE: use unique action name to avoid clashes
            adminAjaxPost({action:'rad_staff_update_remark', row_id:k, remark: inp.value})
              .then(function(resp){
                if (resp && (resp.success || resp.ok)) {
                  sb.textContent='Saved';
                } else {
                  sb.textContent='Error';
                }
                setTimeout(function(){ sb.textContent='Save'; sb.disabled=false; },900);
              })
              .catch(function(){
                sb.textContent='Error';
                setTimeout(function(){ sb.textContent='Save'; sb.disabled=false; },900);
              });
          };
          rm.appendChild(inp); rm.appendChild(sb);
          tr.appendChild(rm);

          tbody.appendChild(tr);
        });
      }

      pageLab.textContent = 'Page ' + state.page + ' / ' + Math.max(1, Math.ceil(((state.serverPaged && typeof state.total === 'number') ? state.total : state.rows.length) / state.per));
    }

    async function load(){
      tbody.innerHTML = '<tr><td colspan="14">Loading...</td></tr>';
      state.selected.clear(); updateSelCount();

      var ps = [];
      if (fromInput.value) ps.push('from='+encodeURIComponent(fromInput.value));
      if (toInput.value)   ps.push('to='  +encodeURIComponent(toInput.value));
      if (userSel.value)   ps.push('teacher_id='+encodeURIComponent(userSel.value));
      if (uidInput.value)  ps.push('uid='+encodeURIComponent(uidInput.value));
      if (devSel.value)    ps.push('device='+encodeURIComponent(devSel.value));
      if (classSel.value)  ps.push('classroom='+encodeURIComponent(classSel.value));
      if (roomSel.value)   ps.push('room='+encodeURIComponent(roomSel.value));
      if (deptSel.value)   ps.push('department='+encodeURIComponent(deptSel.value));
      if (eStatSel.value)  ps.push('entry_status='+encodeURIComponent(eStatSel.value));
      if (xStatSel.value)  ps.push('exit_status='+encodeURIComponent(xStatSel.value));

      // send page & per_page to server so server returns correct page
      ps.push('page=' + encodeURIComponent(state.page || 1));
      ps.push('per_page=' + encodeURIComponent(parseInt(perSel.value,10) || 10));

      var url = '/logs/staff' + (ps.length?('?'+ps.join('&')):'');
      try {
        var j = await apiGet(url);
        // if server returned total -> server-side paging
        if (j && typeof j.total === 'number') {
          state.serverPaged = true;
          state.total = j.total;
          state.rows = j.rows || [];
        } else {
          state.serverPaged = false;
          state.total = null;
          state.rows = j.rows || [];
        }
        render();
      } catch(e){
        tbody.innerHTML = '<tr><td colspan="14">Error: '+(e.message||e)+'</td></tr>';
      }
    }

    // Inputs → reload
    [userSel,uidInput,devSel,fromInput,toInput,classSel,roomSel,deptSel,eStatSel,xStatSel].forEach(function(i){
      i.addEventListener('change', function(){ state.page=1; load(); });
      i.addEventListener('keydown', function(e){ if (e.key==='Enter'){ state.page=1; load(); } });
    });

    perSel.addEventListener('change', function(){ state.page = 1; load(); });

    prev.addEventListener('click', function(){
      var per = parseInt(perSel.value,10);
      var totalCount = (state.serverPaged && typeof state.total === 'number') ? state.total : state.rows.length;
      var pages = Math.max(1, Math.ceil(totalCount / per));
      state.page = Math.max(1, state.page-1);
      if (state.serverPaged) load(); else render();
    });
    next.addEventListener('click', function(){
      var per = parseInt(perSel.value,10);
      var totalCount = (state.serverPaged && typeof state.total === 'number') ? state.total : state.rows.length;
      var pages = Math.max(1, Math.ceil(totalCount / per));
      state.page = Math.min(pages, state.page+1);
      if (state.serverPaged) load(); else render();
    });

    /* ---------- Delete actions (visual selection only) ---------- */
    btnSelect.addEventListener('click', function(){
      var n = parseInt(delInput.value,10);
      if (!n || n <= 0) return;
      state.selected.clear();
      state.rows.slice(0, n).forEach(function(r){ state.selected.add(rowKey(r)); });
      updateSelCount();
      render();
    });

    btnSelectAll.addEventListener('click', function(){
      var start = (state.page-1)*state.per;
      state.rows.slice(start, start+state.per).forEach(function(r){ state.selected.add(rowKey(r)); });
      updateSelCount();
      render();
    });

    btnClear.addEventListener('click', function(){
      state.selected.clear();
      updateSelCount();
      render();
    });

    btnDelete.addEventListener('click', function(){
      alert('Delete is not supported in Staff (Scheduled) view. Use All Logs to delete raw scans.');
    });

    // Export (includes Scheduled Time)
    exportBtn.addEventListener('click', function(){
      if (!state.rows.length) { alert('No rows to export'); return; }
      var headers = ['SN','User','UID','Department','Classroom','Room No.','Subject','Scheduled Time','In Time','Out Time','Entry Δ','Entry Status','Exit Δ','Exit Status','Device(s)','Date','Total'];
      var lines = [headers.join(',')];
      state.rows.forEach(function(r,idx){
        var cols = [
          idx+1,
          '"' + (r.teacher||'').replace(/"/g,'""') + '"',
          '"' + (r.uid||'').replace(/"/g,'""') + '"',
          '"' + (r.department||'').replace(/"/g,'""') + '"',
          '"' + (r.classroom||'').replace(/"/g,'""') + '"',
          '"' + (r.room_no||'').replace(/"/g,'""') + '"',
          '"' + (r.subject||'').replace(/"/g,'""') + '"',
          '"' + ((r.time_from||'') + ' - ' + (r.time_to||'')).replace(/"/g,'""') + '"',
          '"' + (r.in_time||'').replace(/"/g,'""') + '"',
          '"' + (r.out_time||'').replace(/"/g,'""') + '"',
          '"' + fmtSignedDelta(r.entry_delta) + '"',
          '"' + (r.entry_status||'').replace(/"/g,'""') + '"',
          '"' + fmtSignedDelta(r.exit_delta) + '"',
          '"' + (r.exit_status||'').replace(/"/g,'""') + '"',
          '"' + (deviceLabel(r)||'').replace(/"/g,'""') + '"',
          '"' + (r.date||'').replace(/"/g,'""') + '"',
          '"' + (timeFmtSec(r.total_secs)||'').replace(/"/g,'""') + '"'
        ];
        lines.push(cols.join(','));
      });
      var blob = new Blob([lines.join('\r\n')], {type:'text/csv;charset=utf-8;'});
      var a = document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='staff-logs.csv'; document.body.appendChild(a); a.click(); setTimeout(function(){ URL.revokeObjectURL(a.href); document.body.removeChild(a); }, 400);
    });

    await loadOptions();
    await load();
  };

})();
