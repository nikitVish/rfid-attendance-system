// modules/settings/admin.js
(function(){
  window.RadSettings = window.RadSettings || {};

  // helpers
  function el(t, c, txt){ var e=document.createElement(t); if(c) e.className=c; if(txt!==undefined) e.textContent=txt; return e; }
  function q(sel, root){ return (root||document).querySelector(sel); }
  function apiFetch(path, opts){
    var url = (window.radConfig && window.radConfig.root ? window.radConfig.root : '') + path;
    opts = opts || {};
    opts.credentials = 'same-origin';
    opts.headers = opts.headers || {};
    opts.headers['X-WP-Nonce'] = (window.radConfig && window.radConfig.nonce) || '';
    return fetch(url, opts).then(function(res){
      return res.text().then(function(txt){
        var ok = res.ok;
        try { var j = txt ? JSON.parse(txt) : {}; if (!ok) throw j; return j; } catch(e){ if (!ok) throw new Error(txt || (e.message||e)); return txt; }
      });
    });
  }

  // tiny UI helpers
  function createPill(text, active){
    var p = el('button','rad-pill', text);
    p.type = 'button';
    if (active) p.classList.add('active');
    return p;
  }
  function createChip(key, label, checked){
    var c = el('div','perm-chip');
    var cb = el('input'); cb.type = 'checkbox'; cb.className = 'perm-checkbox'; cb.value = key; cb.checked = !!checked;
    var lab = el('div','perm-label', label);
    c.appendChild(cb); c.appendChild(lab);
    if (checked) c.classList.add('checked');
    cb.addEventListener('change', function(){ c.classList.toggle('checked', cb.checked); updateSelectedCount(); });
    return c;
  }

  function ensureToasts(){
    if (document.getElementById('rad-toasts')) return;
    var c = el('div','rad-toasts'); c.id = 'rad-toasts'; document.body.appendChild(c);
  }
  function showToast(msg, type){
    ensureToasts();
    var c = document.getElementById('rad-toasts');
    var t = el('div','rad-toast ' + (type||'info'), msg);
    c.appendChild(t);
    setTimeout(function(){ t.style.opacity = 0; t.style.transform = 'translateY(-8px)'; }, 3000);
    setTimeout(function(){ try { t.remove(); } catch(e){} }, 3600);
  }

  // main render method exposed to rad-app.js (RadSettings.renderPermissions)
  window.RadSettings.renderPermissions = async function(container){
    container = container || document.getElementById('rad-root-content');
    container.innerHTML = '';

    // Top card
    var card = el('div','rad-panel rad-perm-panel');
    var header = el('div','perm-header');
    var h = el('h2',null,'Role Permissions');
    var desc = el('div','perm-desc','Configure access permissions for different user roles in your system.');
    header.appendChild(h); header.appendChild(desc);

    // top-right: selected count badge
    var badge = el('div','perm-badge','0 Selected');
    header.appendChild(badge);
    card.appendChild(header);

    // Role pills area
    var pillsWrap = el('div','perm-pills');
    // will fill roles dynamically
    card.appendChild(pillsWrap);

    // Controls row: select all + presets + custom user select + save button
    var controls = el('div','perm-controls');

    var leftControls = el('div','perm-controls-left');
    var selectAllLabel = el('label','perm-select-all');
    var selectAllCheckbox = el('input'); selectAllCheckbox.type = 'checkbox'; selectAllCheckbox.id = 'perm_select_all';
    selectAllLabel.appendChild(selectAllCheckbox);
    selectAllLabel.appendChild(el('span',null,' Select All Permissions'));
    leftControls.appendChild(selectAllLabel);

    var presetsWrap = el('div','perm-presets');
    presetsWrap.appendChild(el('span','perm-presets-label','Apply Preset:'));
    var pAdmin = createPill('Admin'); var pManager = createPill('Manager'); var pStaff = createPill('Staff');
    presetsWrap.appendChild(pAdmin); presetsWrap.appendChild(pManager); presetsWrap.appendChild(pStaff);
    leftControls.appendChild(presetsWrap);

    controls.appendChild(leftControls);

    var rightControls = el('div','perm-controls-right');
    // custom user select
    var userSelect = el('select','rad-select'); userSelect.style.marginRight = '12px';
    var defaultUserOpt = el('option',null,'-- Custom user (optional) --'); defaultUserOpt.value = ''; userSelect.appendChild(defaultUserOpt);
    rightControls.appendChild(userSelect);

    var saveBtn = el('button','rad-btn rad-save','Save Permissions');
    saveBtn.type = 'button';
    rightControls.appendChild(saveBtn);

    controls.appendChild(rightControls);
    card.appendChild(controls);

    // grid of permission chips
    var grid = el('div','perm-grid');
    card.appendChild(grid);

    // footer: Save button area (also)
    var footer = el('div','perm-footer');
    var footerLeft = el('div',null);
    footer.appendChild(footerLeft);
    var footerRight = el('div',null);
    var saveBtn2 = el('button','rad-btn rad-save','Save Permissions');
    saveBtn2.type = 'button';
    footerRight.appendChild(saveBtn2);
    footer.appendChild(footerRight);
    card.appendChild(footer);

    container.appendChild(card);

    // state
    var state = {
      roles: [],
      perms: [],
      allowed: [], // currently allowed keys for selected target
      selectedRole: null,
      selectedUser: null
    };

    // load static permission keys
    async function loadKeys(){
      try {
        var resp = await apiFetch('/permissions/keys');
        if (resp && resp.rows) state.perms = resp.rows;
      } catch(e){ console.warn('load keys failed', e); state.perms = []; }
    }

    // load roles
    async function loadRoles(){
      try {
        var resp = await apiFetch('/roles');
        if (resp && resp.rows) state.roles = resp.rows;
      } catch(e){
        console.warn('roles load failed', e);
        state.roles = [
          {slug:'administrator', label:'Admin'},
          {slug:'manager', label:'Manager'},
          {slug:'staff', label:'Staff'}
        ];
      }
      renderRolePills();
    }

    function renderRolePills(){
      pillsWrap.innerHTML = '';
      state.roles.forEach(function(r, idx){
        var label = r.label || r.slug || String(r);
        var pill = createPill(label, idx === 0);
        pill.dataset.slug = r.slug || r.label || label;
        pillsWrap.appendChild(pill);
        pill.addEventListener('click', function(){
          // toggle active
          Array.prototype.forEach.call(pillsWrap.querySelectorAll('.rad-pill'), function(p){ p.classList.remove('active'); });
          pill.classList.add('active');
          state.selectedRole = pill.dataset.slug;
          state.selectedUser = null;
          userSelect.value = '';
          loadPermissionsForTarget();
        });
      });
      // default select first role
      if (state.roles.length > 0) {
        state.selectedRole = state.roles[0].slug || state.roles[0].label || state.roles[0];
        Array.prototype.forEach.call(pillsWrap.querySelectorAll('.rad-pill'), function(p){ if (p.dataset.slug === state.selectedRole) p.classList.add('active'); });
      }
    }

    // load users for custom dropdown
    async function loadUsers(){
      try {
        var resp = await apiFetch('/admin-users');
        if (resp && resp.rows) {
          // populate select
          userSelect.innerHTML = '';
          var def = el('option',null,'-- Custom user (optional) --'); def.value=''; userSelect.appendChild(def);
          resp.rows.forEach(function(u){
            // label shows name (phone) if available
            var label = (u.display_name || u.user_login || ('User '+u.id));
            if (u.phone) label += ' (' + u.phone + ')';
            var opt = el('option',null, label );
            opt.value = u.id;
            userSelect.appendChild(opt);
          });
        }
      } catch(e){ console.warn('users load failed', e); }
    }

    // load permissions for currently selected role or user
    async function loadPermissionsForTarget(){
      grid.innerHTML = '<div class="perm-loading">Loading permissions…</div>';
      var query = '';
      if (state.selectedUser) query = '?user_id=' + encodeURIComponent(state.selectedUser);
      else if (state.selectedRole) query = '?role=' + encodeURIComponent(state.selectedRole);
      try {
        var resp = await apiFetch('/permissions' + query);
        state.allowed = (resp && resp.rows) ? resp.rows : [];
      } catch(e){ console.warn('load perms failed', e); state.allowed = []; }
      renderGrid();
      updateSelectedCount();
    }

    // render grid chips
    function renderGrid(){
      grid.innerHTML = '';
      if (!state.perms || state.perms.length === 0) {
        grid.innerHTML = '<div style="padding:16px;color:#6b7280;">No permissions defined.</div>';
        return;
      }
      state.perms.forEach(function(k){
        var checked = state.allowed.indexOf(k) !== -1;
        var chip = createChip(k, k.replace(/([A-Z])/g, ' $1').trim(), checked);
        chip.dataset.key = k;
        grid.appendChild(chip);
      });

      // wire selectAll checkbox
      var boxes = grid.querySelectorAll('.perm-checkbox');
      selectAllCheckbox.checked = Array.from(boxes).every(function(b){ return b.checked; }) && boxes.length>0;
      selectAllCheckbox.indeterminate = Array.from(boxes).some(b=>b.checked) && !selectAllCheckbox.checked;
    }

    // update selected count badge
    function updateSelectedCount(){
      var boxes = grid.querySelectorAll('.perm-checkbox');
      var selected = Array.prototype.filter.call(boxes, b=>b.checked).length;
      badge.textContent = selected + ' Selected';
      // update selectAll state
      selectAllCheckbox.checked = boxes.length > 0 && selected === boxes.length;
      selectAllCheckbox.indeterminate = selected > 0 && selected < boxes.length;
    }

    // apply preset utils
    var PRESETS = {
      'Admin': state.perms.slice(), // admin = all
      'Manager': state.perms.filter(k => k.indexOf('Read') === 0 || k.indexOf('Create') === 0 || k.indexOf('Update') === 0),
      'Staff': state.perms.filter(k => k.indexOf('Read') === 0)
    };

    // event wiring
    selectAllCheckbox.addEventListener('change', function(){
      var boxes = grid.querySelectorAll('.perm-checkbox');
      Array.prototype.forEach.call(boxes, function(b){ b.checked = selectAllCheckbox.checked; b.dispatchEvent(new Event('change')); });
      updateSelectedCount();
    });

    pAdmin.addEventListener('click', function(){ applyPreset('Admin'); });
    pManager.addEventListener('click', function(){ applyPreset('Manager'); });
    pStaff.addEventListener('click', function(){ applyPreset('Staff'); });

    function applyPreset(name){
      var keys = PRESETS[name] || [];
      var boxes = grid.querySelectorAll('.perm-checkbox');
      Array.prototype.forEach.call(boxes, function(b){
        b.checked = keys.indexOf(b.value) !== -1;
        b.dispatchEvent(new Event('change'));
      });
      updateSelectedCount();
      showToast('Applied preset: ' + name, 'success');
    }

    // user select change -> load perms for that user (and clear role active)
    userSelect.addEventListener('change', function(){
      var val = userSelect.value;
      if (val) {
        state.selectedUser = val;
        // visually remove role active
        Array.prototype.forEach.call(pillsWrap.querySelectorAll('.rad-pill'), function(p){ p.classList.remove('active'); });
      } else {
        // re-select first role
        if (state.roles && state.roles.length) {
          state.selectedRole = state.roles[0].slug || state.roles[0].label || state.roles[0];
          Array.prototype.forEach.call(pillsWrap.querySelectorAll('.rad-pill'), function(p){ p.classList.toggle('active', p.dataset.slug === state.selectedRole); });
        }
        state.selectedUser = null;
      }
      loadPermissionsForTarget();
    });

    // Save handlers (both save buttons share)
    async function savePermissions(){
      var boxes = grid.querySelectorAll('.perm-checkbox');
      var selectedKeys = Array.prototype.filter.call(boxes, b => b.checked).map(b => b.value);
      var payload = { permissions: selectedKeys };
      if (state.selectedUser) payload.user_id = parseInt(state.selectedUser, 10);
      else payload.role = state.selectedRole;

      saveBtn.disabled = true; saveBtn2.disabled = true;
      saveBtn.textContent = 'Saving...'; saveBtn2.textContent = 'Saving...';
      try {
        var resp = await apiFetch('/permissions', { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload) });
        showToast('Permissions saved', 'success');

        // NEW: inline confirmation message (small visual confirmation)
        showInlineConfirmation(selectedKeys.length, state.selectedUser, state.selectedRole);

        // update badge and local state (reflect saved)
        state.allowed = selectedKeys.slice();
        updateSelectedCount();
      } catch(e){ console.error('save failed', e); showToast('Save failed: ' + (e.message||e), 'error'); }
      finally { saveBtn.disabled=false; saveBtn2.disabled=false; saveBtn.textContent='Save Permissions'; saveBtn2.textContent='Save Permissions'; }
    }
    saveBtn.addEventListener('click', savePermissions);
    saveBtn2.addEventListener('click', savePermissions);

    // Inline confirmation implementation
    function showInlineConfirmation(count, userId, roleSlug){
      // remove existing confirm if present
      var existing = footerLeft.querySelector('.perm-saved-confirm');
      if (existing) {
        try { existing.remove(); } catch(e){}
      }

      var targetLabel = '';
      if (userId) {
        // find option text
        var opt = userSelect.querySelector('option[value="'+ userId +'"]');
        targetLabel = opt ? opt.textContent : ('User #' + userId);
      } else {
        // find role friendly label
        var r = (state.roles || []).find(function(rr){ return (rr.slug || rr.label) === roleSlug || rr.slug === roleSlug; });
        targetLabel = r ? (r.label || r.slug || roleSlug) : roleSlug;
      }

      var msg = el('div','perm-saved-confirm', 'Saved ' + count + ' permission' + (count===1?'':'s') + ' for ' + targetLabel + '.');
      footerLeft.appendChild(msg);

      // animate in
      setTimeout(function(){ msg.style.opacity = 1; msg.style.transform = 'translateY(0)'; }, 16);

      // fade out after 4s
      setTimeout(function(){
        msg.style.opacity = 0;
        msg.style.transform = 'translateY(-8px)';
        setTimeout(function(){ try { msg.remove(); } catch(e){} }, 420);
      }, 4500);
    }

    // initial loads
    await loadKeys();
    await loadRoles();
    await loadUsers();
    await loadPermissionsForTarget();

    // helper: recalc presets (since state.perms loaded async)
    PRESETS['Admin'] = state.perms.slice();
    PRESETS['Manager'] = state.perms.filter(k => k.indexOf('Read') === 0 || k.indexOf('Create') === 0 || k.indexOf('Update') === 0);
    PRESETS['Staff'] = state.perms.filter(k => k.indexOf('Read') === 0);

    // small accessibility: toggle check on chip label click
    grid.addEventListener('click', function(e){
      var chip = e.target.closest('.perm-chip');
      if (!chip) return;
      var cb = chip.querySelector('.perm-checkbox');
      if (cb) { cb.checked = !cb.checked; cb.dispatchEvent(new Event('change')); updateSelectedCount(); }
    });

  };

  // small toast container init
  document.addEventListener('DOMContentLoaded', function(){ if (!document.getElementById('rad-toasts')) { var c = el('div'); c.id='rad-toasts'; c.className='rad-toasts'; document.body.appendChild(c); } });

})();
