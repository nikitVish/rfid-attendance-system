// modules/rooms/admin.js
(function(){
  window.RadRooms = window.RadRooms || {};

  function el(t,c,txt){ var e=document.createElement(t); if(c) e.className=c; if(txt!==undefined) e.textContent=txt; return e; }
  function q(sel, root){ return (root||document).querySelector(sel); }

  function apiFetch(path, opts){
    var root = (window.radConfig && window.radConfig.root) ? window.radConfig.root : (window.location.origin + '/wp-json/rad/v2');
    var url = root + path;
    opts = opts || {};
    opts.credentials = 'same-origin';
    opts.headers = opts.headers || {};
    // X-WP-Nonce from radConfig
    if (window.radConfig && window.radConfig.nonce) opts.headers['X-WP-Nonce'] = window.radConfig.nonce;
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
  function openModal(innerHtml){
    var overlay = el('div','rad-modal-overlay');
    var modal = el('div','rad-modal');
    modal.innerHTML = innerHtml;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    return {overlay: overlay, modal: modal};
  }
  function closeModal(overlay){ if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay); }

  // toasts
  function ensureToasts(){ if (document.getElementById('rad-toasts')) return; var c = el('div','rad-toasts'); c.id='rad-toasts'; document.body.appendChild(c); }
  function showToast(msg, type){
    ensureToasts();
    var c = document.getElementById('rad-toasts');
    var t = el('div','rad-toast ' + (type || 'info'), msg);
    c.appendChild(t);
    setTimeout(()=>{ t.style.opacity=0; t.style.transform='translateY(-8px)'; }, 3000);
    setTimeout(()=>{ try { t.remove(); } catch(e){} }, 3600);
  }

  function escapeHtml(s){ if (!s && s!==0) return ''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  // confirm modal returns Promise<boolean>
  function confirmModal(title, msg){
    return new Promise(function(res){
      var html = '<h3>'+escapeHtml(title)+'</h3><div style="margin-top:8px;color:#374151;">'+escapeHtml(msg)+'</div>' +
                 '<div style="display:flex;justify-content:flex-end;gap:10px;margin-top:16px;">' +
                 '<button class="rad-btn cancel">Cancel</button>' +
                 '<button class="rad-btn danger confirm">Delete</button></div>';
      var m = openModal(html);
      var modal = m.modal, overlay = m.overlay;
      modal.querySelector('.cancel').onclick = function(){ closeModal(overlay); res(false); };
      modal.querySelector('.confirm').onclick = function(){ closeModal(overlay); res(true); };
    });
  }

  // main render
  window.RadRooms.renderAllRooms = async function(container){
    container = container || document.getElementById('rad-root-content');
    container.innerHTML = '';

    var header = el('div','rad-panel rad-rooms-header');
    header.appendChild(el('h2',null,'All Rooms'));
    var addBtn = el('button','rad-btn rad-add-room','+ Add Room'); addBtn.type='button';
    header.appendChild(addBtn);
    container.appendChild(header);

    var panel = el('div','rad-panel');
    var table = el('table','rad-table');
    table.innerHTML = '<thead><tr><th>SN</th><th>Room No.</th><th>Device ID</th><th>Classroom</th><th>Action</th></tr></thead>';
    var tbody = el('tbody'); table.appendChild(tbody);
    panel.appendChild(table);
    container.appendChild(panel);

    var state = { rooms: [], devices: [], classrooms: [] };

    async function loadLookups(){
      try {
        var d = await apiFetch('/devices');
        state.devices = (d && d.rows) ? d.rows : [];
      } catch(e){ state.devices = []; console.warn('devices load failed', e); }
      try {
        var c = await apiFetch('/classrooms');
        state.classrooms = (c && c.rows) ? c.rows : [];
      } catch(e){ state.classrooms = []; console.warn('classrooms load failed', e); }
    }

    async function loadRooms(){
      tbody.innerHTML = '<tr><td colspan="5">Loading...</td></tr>';
      try {
        var r = await apiFetch('/rooms');
        state.rooms = (r && r.rows) ? r.rows : [];
        renderRows();
      } catch(err){
        tbody.innerHTML = '<tr><td colspan="5" style="color:#b91c1c;">Error loading rooms: '+(err.message||err)+'</td></tr>';
      }
    }

    function renderRows(){
      tbody.innerHTML = '';
      if (!state.rooms || state.rooms.length === 0){
        tbody.innerHTML = '<tr><td colspan="5">No rooms</td></tr>';
        return;
      }
      state.rooms.forEach(function(r, idx){
        var tr = el('tr');
        tr.appendChild(el('td',null,String(idx+1)));
        tr.appendChild(el('td',null, escapeHtml(r.room_no || '')));
        tr.appendChild(el('td',null, escapeHtml(r.device_id || '')));
        tr.appendChild(el('td',null, escapeHtml(r.classroom || '')));
        var a = el('td',null);
        var edit = el('button','rad-btn small rad-edit-btn','Edit'); edit.type='button';
        edit.dataset.id = r.id;
        var del = el('button','rad-btn small rad-delete-btn','Delete'); del.type='button';
        del.style.background = '#ef4444'; del.style.color = '#fff';
        del.dataset.id = r.id;
        a.appendChild(edit); a.appendChild(del);
        tr.appendChild(a);
        tbody.appendChild(tr);

        edit.addEventListener('click', function(){ openEditModal(r); });
        del.addEventListener('click', async function(){
          var ok = await confirmModal('Confirm delete', 'Delete this room? This will remove it from database.');
          if (!ok) return;
          try {
            await apiFetch('/rooms/' + encodeURIComponent(r.id), { method:'DELETE' });
            showToast('Room deleted', 'success');
            await loadRooms();
          } catch(e){ showToast('Delete failed: ' + (e.message||e), 'error'); }
        });
      });
    }

    // OPEN ADD: only Room No.
    function openAddModal(){
      var html = '<h3>Add Room</h3>' +
        '<label>Room No.</label><input class="rad-input" id="rad_room_no">' +
        '<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:12px;">' +
          '<button class="rad-btn cancel">Cancel</button>' +
          '<button class="rad-btn save">Add Room</button>' +
        '</div>';
      var m = openModal(html);
      var modal = m.modal, overlay = m.overlay;
      modal.querySelector('.cancel').onclick = function(){ closeModal(overlay); };
      modal.querySelector('.save').onclick = async function(){
        var room_no = modal.querySelector('#rad_room_no').value.trim();
        if (!room_no){ alert('Room No required'); return; }
        modal.querySelector('.save').disabled = true; modal.querySelector('.save').textContent = 'Saving...';
        try {
          var payload = { room_no: room_no };
          var resp = await apiFetch('/rooms', { method:'POST', headers: Object.assign({'Content-Type':'application/json'}, {}), body: JSON.stringify(payload) });
          if (resp && resp.room_id) {
            showToast('Room added', 'success');
            closeModal(overlay);
            await loadRooms();
          } else {
            alert('Save failed');
          }
        } catch(err){
          alert('Save failed: ' + (err.message||err));
        } finally {
          try { modal.querySelector('.save').disabled = false; modal.querySelector('.save').textContent = 'Add Room'; } catch(e){}
        }
      };
    }

    // OPEN EDIT: only Room No. editable
    async function openEditModal(room){
      var html = '<h3>Edit Room</h3>' +
        '<label>Room No.</label><input class="rad-input" id="rad_edit_room_no" value="'+ escapeHtml(room.room_no || '') +'">' +
        '<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:12px;">' +
          '<button class="rad-btn cancel">Cancel</button>' +
          '<button class="rad-btn save">Update Room</button>' +
        '</div>';
      var m = openModal(html);
      var modal = m.modal, overlay = m.overlay;
      modal.querySelector('.cancel').onclick = function(){ closeModal(overlay); };
      modal.querySelector('.save').onclick = async function(){
        var room_no = modal.querySelector('#rad_edit_room_no').value.trim();
        if (!room_no){ alert('Room No required'); return; }
        modal.querySelector('.save').disabled = true; modal.querySelector('.save').textContent = 'Updating...';
        try {
          var payload = { id: room.id, room_no: room_no };
          var resp = await apiFetch('/rooms', { method:'PUT', headers: Object.assign({'Content-Type':'application/json'}, {}), body: JSON.stringify(payload) });
          if (resp && resp.ok) {
            showToast('Room updated', 'success');
            closeModal(overlay);
            await loadRooms();
          } else {
            alert('Update failed');
          }
        } catch(err){
          alert('Update failed: ' + (err.message||err));
        } finally {
          try { modal.querySelector('.save').disabled = false; modal.querySelector('.save').textContent = 'Update Room'; } catch(e){}
        }
      };
    }

    addBtn.addEventListener('click', function(){ openAddModal(); });

    // initial load
    await loadLookups();
    await loadRooms();
  };

  // create toast container on DOM ready
  document.addEventListener('DOMContentLoaded', function(){ ensureToasts(); });

})();
