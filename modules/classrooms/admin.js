// modules/classrooms/admin.js
(function(){
  window.RadClassrooms = window.RadClassrooms || {};

  function el(t,c,txt){ var e=document.createElement(t); if(c) e.className=c; if(txt!==undefined) e.textContent = txt; return e; }
  function q(sel, root){ return (root||document).querySelector(sel); }

  function apiFetch(path, opts){
    var url = (window.radConfig && window.radConfig.root ? window.radConfig.root : '') + path;
    opts = opts || {};
    opts.credentials = 'same-origin';
    opts.headers = opts.headers || {};
    opts.headers['X-WP-Nonce'] = (window.radConfig && window.radConfig.nonce) || '';
    return fetch(url, opts).then(async function(res){
      var txt = await res.text();
      try {
        var j = txt ? JSON.parse(txt) : {};
        if (!res.ok) {
          var msg = (j && j.message) ? j.message : txt || res.status;
          throw new Error(msg);
        }
        return j;
      } catch(e){
        if (!res.ok) throw new Error(txt || res.status);
        try { return JSON.parse(txt); } catch(e2){ return txt; }
      }
    });
  }

  // modal helpers
  function openModal(html){
    var overlay = el('div','rad-modal-overlay');
    var modal = el('div','rad-modal');
    modal.innerHTML = html;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    return {overlay: overlay, modal: modal};
  }
  function closeModal(overlay){ if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay); }

  // toast
  function ensureToasts(){
    if (document.getElementById('rad-toasts')) return;
    var c = el('div','rad-toasts'); c.id='rad-toasts'; document.body.appendChild(c);
  }
  function showToast(msg, type){
    ensureToasts();
    var c = document.getElementById('rad-toasts');
    var t = el('div','rad-toast ' + (type || 'info'), msg);
    c.appendChild(t);
    setTimeout(()=>{ t.style.opacity=0; t.style.transform='translateY(-8px)'; }, 3000);
    setTimeout(()=>{ try { t.remove(); } catch(e){} }, 3600);
  }

  function escapeHtml(s){ if (!s) return ''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  // export CSV helper
  function downloadCSV(filename, rows){
    var csv = rows.map(r => r.map(c => {
      if (c === null || c === undefined) return '';
      var s = String(c).replace(/"/g, '""');
      return '"' + s + '"';
    }).join(',')).join('\n');
    var blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
    var link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  // render main UI
  window.RadClassrooms.renderAllClassrooms = async function(container){
    container = container || document.getElementById('rad-root-content');
    container.innerHTML = '';

    var header = el('div','rad-panel rad-rooms-header');
    header.appendChild(el('h2',null,'All Classrooms'));
    var right = el('div',null);
    var exportBtn = el('button','rad-btn rad-export','Export');
    exportBtn.type='button';
    var addBtn = el('button','rad-btn rad-add-room','+ Add Classroom');
    addBtn.type='button';
    right.appendChild(exportBtn);
    right.appendChild(addBtn);
    header.appendChild(right);
    container.appendChild(header);

    var panel = el('div','rad-panel');
    var table = el('table','rad-table');
    table.innerHTML = '<thead><tr><th>SN</th><th>Classroom</th><th>Department</th><th>Room No.</th><th>Device</th><th>Action</th></tr></thead>';
    var tbody = el('tbody'); table.appendChild(tbody);
    panel.appendChild(table);
    container.appendChild(panel);

    var state = { classrooms: [], rooms: [], devices: [], departments: [] };

    async function loadLookups(){
      try {
        var d = await apiFetch('/devices');
        state.devices = (d && d.rows) ? d.rows : [];
      } catch(e){ state.devices = []; console.warn('devices load failed', e); }

      try {
        var r = await apiFetch('/rooms');
        state.rooms = (r && r.rows) ? r.rows : [];
      } catch(e){ state.rooms = []; console.warn('rooms load failed', e); }

      try {
        var dep = await apiFetch('/departments');
        state.departments = (dep && dep.rows) ? dep.rows : [];
      } catch(e){ state.departments = []; console.warn('departments load failed', e); }
    }

    async function loadClassrooms(){
      tbody.innerHTML = '<tr><td colspan="6">Loading...</td></tr>';
      try {
        var resp = await apiFetch('/classrooms');
        state.classrooms = (resp && resp.rows) ? resp.rows : [];
        renderRows();
      } catch(err){
        tbody.innerHTML = '<tr><td colspan="6" style="color:#b91c1c;">Error loading classrooms: ' + (err.message||err) + '</td></tr>';
      }
    }

    function findDeviceById(id){
      if (!id) return null;
      for(var i=0;i<state.devices.length;i++){
        var d = state.devices[i];
        // device_id property can be device_id or deviceId etc
        var did = d.device_id || d.deviceId || d.id || d.device || '';
        if (String(did) === String(id)) return d;
      }
      return null;
    }

    function renderRows(){
      tbody.innerHTML = '';
      if (!state.classrooms || state.classrooms.length === 0){
        tbody.innerHTML = '<tr><td colspan="6">No classrooms</td></tr>';
        return;
      }
      state.classrooms.forEach(function(c, idx){
        var tr = el('tr');
        tr.appendChild(el('td',null,String(idx+1)));
        tr.appendChild(el('td',null, escapeHtml(c.classroom || '')));
        tr.appendChild(el('td',null, escapeHtml(c.department || '')));
        tr.appendChild(el('td',null, escapeHtml(c.room_no || '')));
        var devCell = el('td',null, '');
        var dText = (c.device_id ? (escapeHtml(c.device_id) + (c.device_name ? ' — ' + escapeHtml(c.device_name) : '')) : '');
        devCell.textContent = dText;
        tr.appendChild(devCell);

        var a = el('td',null);
        var edit = el('button','rad-btn small rad-edit-btn','Edit'); edit.type='button';
        edit.dataset.id = c.id;
        var del = el('button','rad-btn small rad-delete-btn','Delete'); del.type='button';
        del.dataset.id = c.id;
        a.appendChild(edit); a.appendChild(del);
        tr.appendChild(a);
        tbody.appendChild(tr);

        edit.addEventListener('click', function(){ openEditModal(c); });
        del.addEventListener('click', async function(){
          if (!confirm('Delete this classroom?')) return;
          try {
            await apiFetch('/classrooms/' + encodeURIComponent(c.id), { method:'DELETE' });
            showToast('Classroom deleted', 'success');
            await reloadAll();
          } catch(e){ showToast('Delete failed: ' + (e.message||e), 'error'); }
        });
      });
    }

    addBtn.addEventListener('click', function(){
      openAddModal();
    });

    exportBtn.addEventListener('click', function(){
      // CSV columns: SN,Classroom,Department,Room No.,Device ID,Device Name
      var rows = [];
      var hdr = ['SN','Classroom','Department','Room No.','Device ID','Device Name'];
      rows.push(hdr);
      state.classrooms.slice().reverse().forEach(function(c, idx){
        rows.push([idx+1, c.classroom || '', c.department || '', c.room_no || '', c.device_id || '', c.device_name || '']);
      });
      downloadCSV('classrooms_export.csv', rows);
    });

    // Add modal: only single Classroom text field
    function openAddModal(){
      var html = '<h3>Add Classroom</h3>' +
        '<label>Classroom</label><input class="rad-input" id="rad_new_classroom" placeholder="Enter classroom name">' +
        '<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:12px;">' +
          '<button class="rad-btn cancel">Cancel</button>' +
          '<button class="rad-btn save">Add Classroom</button>' +
        '</div>';
      var m = openModal(html);
      var modal = m.modal, overlay = m.overlay;
      modal.querySelector('.cancel').onclick = function(){ closeModal(overlay); };
      modal.querySelector('.save').onclick = async function(){
        var cname = modal.querySelector('#rad_new_classroom').value.trim();
        if (!cname){ alert('Classroom required'); return; }
        modal.querySelector('.save').disabled = true; modal.querySelector('.save').textContent = 'Saving...';
        try {
          var payload = { classroom: cname, department: '', room_no: '', device_id:'', device_name:'' };
          var resp = await apiFetch('/classrooms', { method:'POST', headers: Object.assign({'Content-Type':'application/json'}, {}), body: JSON.stringify(payload) });
          if (resp && resp.classroom_id) {
            showToast('Classroom added', 'success');
            closeModal(overlay);
            await reloadAll();
          } else {
            alert('Save failed');
          }
        } catch(err){
          alert('Save failed: ' + (err.message||err));
        } finally {
          try { modal.querySelector('.save').disabled = false; modal.querySelector('.save').textContent = 'Add Classroom'; } catch(e){}
        }
      };
    }

    // Edit modal: show dropdown for classroom names and fields for department, room_no, device id (device name auto)
    async function openEditModal(item){
      // refresh lookups
      await loadLookups();
      // reload classrooms to fill dropdown options
      try {
        var r = await apiFetch('/classrooms');
        state.classrooms = (r && r.rows) ? r.rows : state.classrooms;
      } catch(e){ console.warn('failed reload classrooms', e); }

      // build classroom dropdown
      var clsOptions = '<option value="">-- Select Classroom --</option>';
      state.classrooms.forEach(function(c){
        var sel = (String(c.id) === String(item.id)) ? ' selected' : '';
        clsOptions += '<option value="'+ escapeHtml(c.classroom) +'" data-id="'+ (c.id || '') +'"'+sel+'>'+ escapeHtml(c.classroom) +'</option>';
      });
      // department options
      var depOptions = '<option value="">-- Select Department (optional) --</option>';
      state.departments.forEach(function(d){ depOptions += '<option value="'+ escapeHtml(d) +'">'+ escapeHtml(d) +'</option>'; });

      // room options
      var roomOptions = '<option value="">-- Select Room (optional) --</option>';
      state.rooms.forEach(function(rm){ roomOptions += '<option value="'+ escapeHtml(rm.room_no || rm.room_no || '') +'">'+ escapeHtml(rm.room_no || '') +'</option>'; });

      // device dropdown: only devices not already assigned to other classroom (allow current assignment)
      var usedDeviceIds = {};
      state.classrooms.forEach(function(cc){
        if (cc && cc.device_id) usedDeviceIds[cc.device_id] = cc.id;
      });

      var deviceOptions = '<option value="">-- Select Device (optional) --</option>';
      state.devices.forEach(function(d){
        var did = d.device_id || d.deviceId || d.id || '';
        // allow if not used OR used by this item
        if (!did) return;
        if (usedDeviceIds[did] && String(usedDeviceIds[did]) !== String(item.id)) return;
        var label = d.label || d.name || d.device_name || '';
        deviceOptions += '<option value="'+ escapeHtml(did) +'" data-name="'+ escapeHtml(label) +'">'+ escapeHtml(did) +'</option>';
      });

      var html = '<h3>Edit Classroom</h3>' +
        '<label>Classroom</label><select class="rad-select" id="rad_edit_classroom">' + clsOptions + '</select>' +
        '<label>Department</label><select class="rad-select" id="rad_edit_department">' + depOptions + '</select>' +
        '<label>Room No.</label><select class="rad-select" id="rad_edit_room">' + roomOptions + '</select>' +
        '<label>Device ID (optional)</label><select class="rad-select" id="rad_edit_device">' + deviceOptions + '</select>' +
        '<label>Device Name (auto)</label><input class="rad-input" id="rad_edit_device_name" readonly>' +
        '<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:12px;">' +
          '<button class="rad-btn cancel">Cancel</button>' +
          '<button class="rad-btn save">Update Classroom</button>' +
        '</div>';
      var m = openModal(html);
      var modal = m.modal, overlay = m.overlay;

      // prefill values
      var classroomSelect = modal.querySelector('#rad_edit_classroom');
      var depSelect = modal.querySelector('#rad_edit_department');
      var roomSelect = modal.querySelector('#rad_edit_room');
      var deviceSelect = modal.querySelector('#rad_edit_device');
      var deviceNameInput = modal.querySelector('#rad_edit_device_name');

      // set initial values
      // classroom select already have selected value by matching id; if not, try matching classroom text
      try { if (item.department) depSelect.value = item.department; } catch(e){}
      try { if (item.room_no) roomSelect.value = item.room_no; } catch(e){}
      try { if (item.device_id) deviceSelect.value = item.device_id; } catch(e){}
      var dev = findDeviceById(item.device_id);
      deviceNameInput.value = dev ? (dev.label || dev.name || dev.device_name || '') : (item.device_name || '');

      // when device id select changes -> fill device name
      deviceSelect.addEventListener('change', function(){
        var did = deviceSelect.value;
        var dd = findDeviceById(did);
        if (dd) {
          deviceNameInput.value = dd.label || dd.name || dd.device_name || '';
        } else {
          deviceNameInput.value = '';
        }
      });

      modal.querySelector('.cancel').onclick = function(){ closeModal(overlay); };
      modal.querySelector('.save').onclick = async function(){
        var selectedClassroomName = classroomSelect.value.trim();
        if (!selectedClassroomName){ alert('Please select classroom'); return; }

        // find ID of selected classroom (we allow changing the name by selecting another classroom entry)
        var selectedId = item.id;
        // If user selected a different classroom option (by id) find matching id from state.classrooms by classroom name
        var matched = state.classrooms.find(function(cc){ return String(cc.classroom) === String(selectedClassroomName); });
        if (matched) selectedId = matched.id;

        var payload = {
          classroom: selectedClassroomName,
          department: depSelect.value || '',
          room_no: roomSelect.value || '',
          device_id: deviceSelect.value || '',
          device_name: deviceNameInput.value || ''
        };

        modal.querySelector('.save').disabled = true; modal.querySelector('.save').textContent = 'Updating...';
        try {
          var resp = await apiFetch('/classrooms/' + encodeURIComponent(selectedId), { method:'PUT', headers: Object.assign({'Content-Type':'application/json'}, {}), body: JSON.stringify(payload) });
          if (resp && resp.ok) {
            showToast('Classroom updated', 'success');
            closeModal(overlay);
            await reloadAll();
          } else {
            alert('Update failed');
          }
        } catch(err){
          alert('Update failed: ' + (err.message||err));
        } finally {
          try { modal.querySelector('.save').disabled = false; modal.querySelector('.save').textContent = 'Update Classroom'; } catch(e){}
        }
      };
    }

    async function reloadAll(){
      await loadLookups();
      await loadClassrooms();
    }

    // initial load
    await loadLookups();
    await loadClassrooms();
  };

  // create toast container early
  document.addEventListener('DOMContentLoaded', function(){ if (!document.getElementById('rad-toasts')) { var c = document.createElement('div'); c.id='rad-toasts'; c.className='rad-toasts'; document.body.appendChild(c); } });

})();
