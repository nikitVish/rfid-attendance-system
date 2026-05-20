// modules/devices/admin.js
(function(){
  window.RadDevices = window.RadDevices || {};

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
  function ensureToasts(){ if (document.getElementById('rad-toasts')) return; var c = el('div','rad-toasts'); c.id='rad-toasts'; document.body.appendChild(c); }
  function showToast(msg, type){ ensureToasts(); var c = document.getElementById('rad-toasts'); var t = el('div','rad-toast ' + (type || 'info'), msg); c.appendChild(t); setTimeout(()=>{ t.style.opacity=0; t.style.transform='translateY(-8px)'; }, 3000); setTimeout(()=>{ try { t.remove(); } catch(e){} }, 3600); }

  function escapeHtml(s){ if (!s) return ''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  window.RadDevices.renderAllDevices = async function(container){
    container = container || document.getElementById('rad-root-content');
    container.innerHTML = '';

    var header = el('div','rad-panel rad-rooms-header');
    header.appendChild(el('h2',null,'All Devices'));
    var right = el('div',null);
    var addBtn = el('button','rad-btn rad-add-device','+ Add Device');
    addBtn.type='button';
    right.appendChild(addBtn);
    header.appendChild(right);
    container.appendChild(header);

    var panel = el('div','rad-panel');
    var table = el('table','rad-table');
    table.innerHTML = '<thead><tr><th>SN</th><th>Device ID</th><th>Device Name</th><th>Room No.</th><th>Classroom</th><th>Action</th></tr></thead>';
    var tbody = el('tbody'); table.appendChild(tbody);
    panel.appendChild(table);
    container.appendChild(panel);

    var state = { devices: [], classrooms: [] };

    async function loadLookups(){
      try {
        var c = await apiFetch('/classrooms');
        state.classrooms = (c && c.rows) ? c.rows : [];
      } catch(e){ state.classrooms = []; console.warn('classrooms load failed', e); }
    }

    async function loadDevices(){
      tbody.innerHTML = '<tr><td colspan="6">Loading...</td></tr>';
      try {
        var resp = await apiFetch('/devices');
        state.devices = (resp && resp.rows) ? resp.rows : [];
        renderRows();
      } catch(err){
        tbody.innerHTML = '<tr><td colspan="6" style="color:#b91c1c;">Error loading devices: ' + (err.message||err) + '</td></tr>';
      }
    }

    function renderRows(){
      tbody.innerHTML = '';
      if (!state.devices || state.devices.length === 0){
        tbody.innerHTML = '<tr><td colspan="6">No devices</td></tr>';
        return;
      }
      state.devices.forEach(function(d, idx){
        var tr = el('tr');
        tr.appendChild(el('td',null,String(idx+1)));
        tr.appendChild(el('td',null, escapeHtml(d.device_id || '')));
        tr.appendChild(el('td',null, escapeHtml(d.label || ''))); // device name
        tr.appendChild(el('td',null, escapeHtml(d.room_no || '')));
        tr.appendChild(el('td',null, escapeHtml(d.classroom || '')));
        var a = el('td',null);
        var edit = el('button','rad-btn small rad-edit-btn','Edit'); edit.type='button'; edit.dataset.id = d.id;
        var del = el('button','rad-btn small rad-delete-btn','Delete'); del.type='button'; del.dataset.id = d.id;
        a.appendChild(edit); a.appendChild(del);
        tr.appendChild(a);
        tbody.appendChild(tr);

        edit.addEventListener('click', function(){ openEditModal(d); });
        del.addEventListener('click', async function(){
          if (!confirm('Delete this device?')) return;
          try {
            await apiFetch('/devices/' + encodeURIComponent(d.id), { method:'DELETE' });
            showToast('Device deleted', 'success');
            await reloadAll();
          } catch(e){ showToast('Delete failed: ' + (e.message||e), 'error'); }
        });
      });
    }

    addBtn.addEventListener('click', function(){ openAddModal(); });

    // Add modal: only Device ID & Device Name
    function openAddModal(){
      var html = '<h3>Add Device</h3>' +
        '<label>Device ID</label><input class="rad-input" id="rad_new_device_id" placeholder="Enter device id">' +
        '<label>Device Name</label><input class="rad-input" id="rad_new_device_name" placeholder="Device name (e.g. Main Door)">' +
        '<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:12px;">' +
          '<button class="rad-btn cancel">Cancel</button>' +
          '<button class="rad-btn save">Add Device</button>' +
        '</div>';
      var m = openModal(html);
      var modal = m.modal, overlay = m.overlay;
      modal.querySelector('.cancel').onclick = function(){ closeModal(overlay); };
      modal.querySelector('.save').onclick = async function(){
        var device_id = modal.querySelector('#rad_new_device_id').value.trim();
        var device_name = modal.querySelector('#rad_new_device_name').value.trim();
        if (!device_id){ alert('Device ID required'); return; }
        modal.querySelector('.save').disabled = true; modal.querySelector('.save').textContent = 'Saving...';
        try {
          var payload = { device_id: device_id, device_name: device_name };
          var resp = await apiFetch('/devices', { method:'POST', headers: Object.assign({'Content-Type':'application/json'}, {}), body: JSON.stringify(payload) });
          if (resp && resp.device_id) {
            showToast('Device added', 'success');
            closeModal(overlay);
            try { await apiFetch('/devices/sync-locations', { method:'POST' }); } catch(e){ /* ignore */ }
            await reloadAll();
          } else {
            alert('Save failed');
          }
        } catch(err){
          alert('Save failed: ' + (err.message||err));
        } finally {
          try { modal.querySelector('.save').disabled = false; modal.querySelector('.save').textContent = 'Add Device'; } catch(e){}
        }
      };
    }

    // Edit modal: only Device ID & Device Name editable
    function openEditModal(item){
      var html = '<h3>Edit Device</h3>' +
        '<label>Device ID</label><input class="rad-input" id="rad_edit_device_id" value="'+ escapeHtml(item.device_id || '') +'">' +
        '<label>Device Name</label><input class="rad-input" id="rad_edit_device_name" value="'+ escapeHtml(item.label || '') +'">' +
        '<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:12px;">' +
          '<button class="rad-btn cancel">Cancel</button>' +
          '<button class="rad-btn save">Update Device</button>' +
        '</div>';
      var m = openModal(html);
      var modal = m.modal, overlay = m.overlay;

      modal.querySelector('.cancel').onclick = function(){ closeModal(overlay); };
      modal.querySelector('.save').onclick = async function(){
        var device_id = modal.querySelector('#rad_edit_device_id').value.trim();
        var device_name = modal.querySelector('#rad_edit_device_name').value.trim();
        if (!device_id){ alert('Device ID required'); return; }
        modal.querySelector('.save').disabled = true; modal.querySelector('.save').textContent = 'Updating...';
        try {
          var payload = { device_id: device_id, device_name: device_name };
          var resp = await apiFetch('/devices/' + encodeURIComponent(item.id), { method:'PUT', headers: Object.assign({'Content-Type':'application/json'}, {}), body: JSON.stringify(payload) });
          if (resp && resp.ok) {
            try { await apiFetch('/devices/sync-locations', { method:'POST' }); } catch(e){ /* ignore */ }
            showToast('Device updated', 'success');
            closeModal(overlay);
            await reloadAll();
          } else {
            alert('Update failed');
          }
        } catch(err){
          alert('Update failed: ' + (err.message||err));
        } finally {
          try { modal.querySelector('.save').disabled = false; modal.querySelector('.save').textContent = 'Update Device'; } catch(e){}
        }
      };
    }

    async function reloadAll(){
      await loadLookups();
      await loadDevices();
    }

    // initial load
    await loadLookups();
    await loadDevices();
  };

  // ensure toast container exists on load
  document.addEventListener('DOMContentLoaded', function(){ if (!document.getElementById('rad-toasts')) { var c = document.createElement('div'); c.id='rad-toasts'; c.className='rad-toasts'; document.body.appendChild(c); } });

})();
