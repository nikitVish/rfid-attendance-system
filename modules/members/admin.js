// modules/members/admin.js
// Members module: Add/All with Edit/Delete, Search, Filter, Pagination, Modal confirm, Toasts, role gating
(function(){
  window.RadMembers = window.RadMembers || {};

  // helpers
  function getUrl(path){ return (window.radConfig && window.radConfig.root ? window.radConfig.root : '') + path; }
  function jsonHeaders(){ return { 'Content-Type': 'application/json', 'X-WP-Nonce': (window.radConfig && window.radConfig.nonce) || '' }; }
  async function apiGet(path){ const res = await fetch(getUrl(path), { headers:{ 'X-WP-Nonce': (window.radConfig && window.radConfig.nonce) || '' } }); if (!res.ok) throw new Error(await res.text()); return res.json(); }
  async function apiJson(path, body, method='POST'){ const res = await fetch(getUrl(path), { method: method, headers: jsonHeaders(), body: JSON.stringify(body) }); const txt = await res.text(); try { const j = JSON.parse(txt); if (!res.ok) throw new Error(j.message || txt); return j; } catch(e){ throw new Error(txt); } }
  async function apiDelete(path){ const res = await fetch(getUrl(path), { method:'DELETE', headers:{ 'X-WP-Nonce': (window.radConfig && window.radConfig.nonce) || '' } }); const txt = await res.text(); try { const j = JSON.parse(txt); if (!res.ok) throw new Error(j.message || txt); return j; } catch(e){ throw new Error(txt); } }

  // UI helpers: toast
  function ensureToastContainer(){
    if (document.getElementById('rad-toasts')) return;
    const c = document.createElement('div'); c.id = 'rad-toasts'; c.className='rad-toasts'; document.body.appendChild(c);
  }
  function showToast(msg, type){
    ensureToastContainer();
    const c = document.getElementById('rad-toasts');
    const t = document.createElement('div');
    t.className = 'rad-toast ' + (type || 'info');
    t.textContent = msg;
    c.appendChild(t);
    setTimeout(()=> { t.style.opacity = '0'; t.style.transform = 'translateY(-8px)'; }, 3000);
    setTimeout(()=> t.remove(), 3500);
  }

  // modal confirm (returns Promise<boolean>)
  function confirmModal(title, message){
    return new Promise((resolve)=>{ 
      const overlay = document.createElement('div'); overlay.className='rad-modal-overlay';
      const modal = document.createElement('div'); modal.className='rad-modal';
      modal.innerHTML = `<h3>${escapeHtml(title)}</h3><div style="margin-top:8px;color:#374151;">${escapeHtml(message)}</div>
        <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:16px;">
          <button class="rad-btn cancel">Cancel</button>
          <button class="rad-btn danger confirm">Delete</button>
        </div>`;
      overlay.appendChild(modal);
      document.body.appendChild(overlay);
      modal.querySelector('.cancel').onclick = ()=>{ overlay.remove(); resolve(false); };
      modal.querySelector('.confirm').onclick = ()=>{ overlay.remove(); resolve(true); };
    });
  }

  // escape helper
  function escapeHtml(s){ if (!s && s !== 0) return ''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  // role gating: allowed roles for edit/delete
  const EDIT_ROLES = ['Admin','Manager','administrator'];

  // store last loaded members (for client-side search/pagination)
  let MEMBERS_CACHE = [];

  // pagination defaults
  let PAGE_SIZE = 10;
  let CURRENT_PAGE = 1;

  // exposed render
  window.RadMembers.render = async function(container, subpage){
    container = container || document.getElementById('rad-root-content');
    container.innerHTML = '';
    if (subpage === 'add') renderAdd(container);
    else await renderAll(container);
  };

  /* -------------------------
     Add Member UI
     ------------------------- */
  /* -------------------------
   Add Member UI (USB UID Fetch)
   ------------------------- */
function renderAdd(container){
  container.innerHTML = '<h2>Add Member</h2>';
  const panel = document.createElement('div'); panel.className='rad-panel'; container.appendChild(panel);
  const form = document.createElement('form'); form.className='rad-form'; panel.appendChild(form);

  const fields = [
    {label:'Full Name', name:'name', type:'text'},
    {label:'Department', name:'department', type:'text'},
    {label:'Phone Number', name:'phone', type:'text'},
    {label:'Role', name:'role', type:'select', options:['Staff','Manager','Admin']},
    {label:'UUID (RFID)', name:'uid', type:'text'},
    {label:'Password', name:'password', type:'password'}
  ];

  const inputs = {};
  fields.forEach(f=>{
    const L = document.createElement('label'); L.textContent = f.label + ' *'; form.appendChild(L);
    let input;
    if (f.type === 'select'){
      input = document.createElement('select'); input.className='rad-select';
      f.options.forEach(o=>{ const opt=document.createElement('option'); opt.value=o; opt.textContent=o; input.appendChild(opt); });
    } else {
      input = document.createElement('input'); input.type = f.type; input.className='rad-input';
    }
    form.appendChild(input); inputs[f.name] = input;
  });

  // ---------- New: Fetch UID via USB ----------
  const fetchBtn = document.createElement('button');
  fetchBtn.type = 'button';
  fetchBtn.className = 'rad-btn small';
  fetchBtn.textContent = 'Fetch UID (USB Cable)';
  fetchBtn.style.marginTop = '8px';

  const status = document.createElement('div');
  status.style.fontSize = '13px';
  status.style.color = '#374151';
  status.style.marginTop = '6px';

  form.appendChild(fetchBtn);
  form.appendChild(status);

  let serialSession = null;
  const BAUD = 9600;

  async function connectSerial(){
    if (!('serial' in navigator)) {
      status.textContent = '❌ Browser not supported. Use Chrome / Edge on HTTPS or localhost.';
      return;
    }
    try {
      const port = await navigator.serial.requestPort();
      await port.open({ baudRate: BAUD });
      status.textContent = '🔗 Connected — waiting for card...';
      fetchBtn.textContent = 'Stop Reading';
      const decoder = new TextDecoderStream();
      const closed = port.readable.pipeTo(decoder.writable);
      const reader = decoder.readable.getReader();
      serialSession = { port, reader, closed };

      let buffer = '';
      (async function readLoop(){
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value) {
              buffer += value;
              let lines = buffer.split(/\r?\n/);
              buffer = lines.pop();
              for (let line of lines) {
                const clean = line.trim();
                if (clean.length === 0) continue;
                status.textContent = '📥 ' + clean;
                const m = clean.match(/Card UID:\s*([0-9A-Fa-f]+)/) || clean.match(/Detected Card ID:\s*([0-9A-Fa-f]+)/);
                if (m && m[1]) {
                  const uid = m[1].toUpperCase();
                  inputs.uid.value = uid;
                  status.textContent = '✅ UID Captured: ' + uid;
                  // Auto stop after one UID
                  try { await reader.cancel(); } catch(e){}
                  try { await port.close(); } catch(e){}
                  serialSession = null;
                  fetchBtn.textContent = 'Fetch UID (USB Cable)';
                  return;
                }
              }
            }
          }
        } catch (err) {
          console.error('Serial error', err);
          status.textContent = '⚠️ Serial error: ' + (err && err.message ? err.message : String(err));
        } finally {
          try { reader.releaseLock(); } catch(e){}
          try { await closed; } catch(e){}
        }
      })();

    } catch (err) {
      console.error('Serial connect failed', err);
      status.textContent = '❌ Connection failed: ' + (err && err.message ? err.message : String(err));
      serialSession = null;
      fetchBtn.textContent = 'Fetch UID (USB Cable)';
    }
  }

  async function disconnectSerial(){
    if (serialSession) {
      try { await serialSession.reader.cancel(); } catch(e){}
      try { await serialSession.port.close(); } catch(e){}
      serialSession = null;
      fetchBtn.textContent = 'Fetch UID (USB Cable)';
      status.textContent = '⏹️ Disconnected';
    }
  }

  fetchBtn.addEventListener('click', async ()=>{
    if (serialSession) await disconnectSerial();
    else await connectSerial();
  });

  // ---------- Submit ----------
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'rad-btn';
  submit.textContent = 'Add Member';
  form.appendChild(submit);
  const msg = document.createElement('div'); msg.className='rad-message'; form.appendChild(msg);

  form.addEventListener('submit', async (e)=>{
    e.preventDefault();
    msg.textContent=''; msg.style.color='';
    if (!inputs.name.value.trim()){ msg.textContent='Name required'; inputs.name.focus(); return; }
    if (!inputs.department.value.trim()){ msg.textContent='Department required'; inputs.department.focus(); return; }
    if (!/^\d{6,15}$/.test(inputs.phone.value.trim())){ msg.textContent='Phone numeric 6-15 digits'; inputs.phone.focus(); return; }
    if (!inputs.uid.value.trim()){ msg.textContent='UID required'; inputs.uid.focus(); return; }
    if (!inputs.password.value || inputs.password.value.length < 4){ msg.textContent='Password min 4 chars'; inputs.password.focus(); return; }

    submit.disabled=true; submit.textContent='Saving...';
    try {
      const payload = {
        name: inputs.name.value.trim(),
        department: inputs.department.value.trim(),
        phone: inputs.phone.value.trim(),
        role: inputs.role.value,
        uid: inputs.uid.value.trim(),
        password: inputs.password.value
      };
      const res = await apiJson('/teachers', payload, 'POST');
      msg.style.color='#16a34a'; msg.textContent = '✅ Member added (ID: '+ (res.teacher_id || '') +')';
      showToast('Member added', 'success');
      form.reset();
    } catch(err){
      msg.style.color='#b91c1c'; msg.textContent = '❌ '+ (err.message || err);
      showToast('Add failed: '+ (err.message||err), 'error');
    } finally {
      submit.disabled=false; submit.textContent='Add Member';
    }
  });
}


  /* -------------------------
     All Members UI with search/filter/pagination
     ------------------------- */
  async function renderAll(container){
    container.innerHTML = '<h2>All Members</h2>';
    const panel = document.createElement('div'); panel.className='rad-panel'; container.appendChild(panel);

    // Controls: search + role filter + page size
    const ctrl = document.createElement('div'); ctrl.className='rad-controls'; ctrl.style.alignItems='center';
    const search = document.createElement('input'); search.type='search'; search.placeholder='Search name, phone, or UID'; search.className='rad-input rad-search';
    search.style.maxWidth='360px';
    const roleFilter = document.createElement('select'); roleFilter.className='rad-select'; roleFilter.style.maxWidth='140px'; roleFilter.style.marginLeft='8px';
    roleFilter.innerHTML = '<option value="">All roles</option><option>Staff</option><option>Manager</option><option>Admin</option>';
    const sizeSelect = document.createElement('select'); sizeSelect.className='rad-select'; sizeSelect.style.maxWidth='120px'; sizeSelect.style.marginLeft='8px';
    sizeSelect.innerHTML = '<option value="10">10 / page</option><option value="25">25 / page</option><option value="50">50 / page</option>';
    const refresh = document.createElement('button'); refresh.className='rad-btn'; refresh.textContent='Refresh'; refresh.style.marginLeft='8px';
    // Export button added to the right of refresh
    const exportBtn = document.createElement('button'); exportBtn.className='rad-btn'; exportBtn.textContent='Export'; exportBtn.style.marginLeft='8px';

    ctrl.appendChild(search); ctrl.appendChild(roleFilter); ctrl.appendChild(sizeSelect); ctrl.appendChild(refresh); ctrl.appendChild(exportBtn);
    panel.appendChild(ctrl);

    // Table
    const table = document.createElement('table'); table.className='rad-table';
    table.innerHTML = `<thead><tr><th>ID</th><th>Name</th><th>Department</th><th>Phone</th><th>Role</th><th>UID</th><th>Actions</th></tr></thead>`;
    const tbody = document.createElement('tbody'); table.appendChild(tbody); panel.appendChild(table);

    // Pagination controls
    const pager = document.createElement('div'); pager.className='rad-pager'; pager.style.marginTop='12px'; panel.appendChild(pager);

    // load data into cache (used for client filtering/paging)
    async function loadData(){
      try {
        const data = await apiGet('/teachers');
        MEMBERS_CACHE = data.rows || [];
      } catch(err){
        MEMBERS_CACHE = [];
        tbody.innerHTML = `<tr><td colspan="7" style="color:red;">Error loading members: ${escapeHtml(err.message||err)}</td></tr>`;
      }
    }

    // utility: get distinct departments
    function getDistinctDepartments(){
      const s = new Set();
      (MEMBERS_CACHE || []).forEach(r => {
        const d = (r.department||'').trim();
        if (d) s.add(d);
      });
      return Array.from(s).sort();
    }

    // utility: get name options (unique)
    function getDistinctNames(){
      const s = new Set();
      (MEMBERS_CACHE || []).forEach(r => {
        const n = (r.name||'').trim();
        if (n) s.add(n);
      });
      return Array.from(s).sort();
    }

    // render rows based on cache, search, filter, pagination
    function renderRows(){
      const q = (search.value || '').trim().toLowerCase();
      const role = (roleFilter.value || '').trim();
      const filtered = MEMBERS_CACHE.filter(r=>{
        if (role && r.role !== role) return false;
        if (!q) return true;
        const uid = (r.meta && (r.meta.uid||'') ) || '';
        return (r.name || '').toLowerCase().includes(q) || (r.phone || '').toLowerCase().includes(q) || String(uid).toLowerCase().includes(q);
      });

      // pagination
      PAGE_SIZE = parseInt(sizeSelect.value || '10', 10);
      const total = filtered.length;
      const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
      if (CURRENT_PAGE > pages) CURRENT_PAGE = pages;
      const start = (CURRENT_PAGE - 1) * PAGE_SIZE;
      const paged = filtered.slice(start, start + PAGE_SIZE);

      tbody.innerHTML = '';
      if (!paged.length){
        tbody.innerHTML = '<tr><td colspan="7">No Members Found</td></tr>';
      } else {
        paged.forEach(r=>{
          const tr = document.createElement('tr');
          const uid = (r.meta && r.meta.uid) ? r.meta.uid : '';
          tr.innerHTML = `
            <td>${r.id}</td>
            <td>${escapeHtml(r.name||'')}</td>
            <td>${escapeHtml(r.department||'')}</td>
            <td>${escapeHtml(r.phone||'')}</td>
            <td>${escapeHtml(r.role||'')}</td>
            <td>${escapeHtml(uid)}</td>
            <td class="rad-actions-cell"></td>
          `;
          tbody.appendChild(tr);

          // actions: show only for allowed roles
          const actionsCell = tr.querySelector('.rad-actions-cell');
          const currentRole = (window.radConfig && window.radConfig.currentUserRole) || '';
          if (EDIT_ROLES.indexOf(currentRole) !== -1) {
            const edit = document.createElement('button'); edit.className='rad-btn small edit'; edit.textContent='Edit'; edit.dataset.id = r.id;
            const del = document.createElement('button'); del.className='rad-btn small danger delete'; del.textContent='Delete'; del.dataset.id = r.id;
            actionsCell.appendChild(edit); actionsCell.appendChild(del);
            edit.addEventListener('click', ()=> openEditModal(r.id));
            del.addEventListener('click', ()=> doDelete(r.id, tr));
          } else {
            actionsCell.innerHTML = '<span style="color:#6b7280;font-size:13px;">No actions</span>';
          }
        });
      }

      renderPager(total, pages);
    }

    // pager renderer
    function renderPager(total, pages){
      pager.innerHTML = '';
      const info = document.createElement('div'); info.textContent = `Total: ${total} — Page ${CURRENT_PAGE} / ${pages}`; info.style.display='inline-block'; info.style.marginRight='12px';
      pager.appendChild(info);

      const first = createPagerBtn('<<', ()=>{ if (CURRENT_PAGE>1) { CURRENT_PAGE=1; renderRows(); } });
      const prev = createPagerBtn('<', ()=>{ if (CURRENT_PAGE>1) { CURRENT_PAGE--; renderRows(); } });
      const next = createPagerBtn('>', ()=>{ if (CURRENT_PAGE < pages) { CURRENT_PAGE++; renderRows(); } });
      const last = createPagerBtn('>>', ()=>{ if (CURRENT_PAGE < pages) { CURRENT_PAGE = pages; renderRows(); } });
      pager.appendChild(first); pager.appendChild(prev);

      // numeric buttons (limit to neighbor range)
      const maxButtons = 7;
      let start = Math.max(1, CURRENT_PAGE - Math.floor(maxButtons/2));
      let end = Math.min(pages, start + maxButtons - 1);
      if (end - start < maxButtons - 1) start = Math.max(1, end - maxButtons + 1);
      for (let p = start; p <= end; p++){
        const b = createPagerBtn(String(p), ()=>{ if (CURRENT_PAGE !== p) { CURRENT_PAGE = p; renderRows(); } }, p === CURRENT_PAGE);
        pager.appendChild(b);
      }

      pager.appendChild(next); pager.appendChild(last);
    }

    function createPagerBtn(label, cb, active){
      const b = document.createElement('button'); b.className = 'rad-btn small'; b.textContent = label;
      if (active) { b.style.background = '#eef2ff'; b.style.color = '#3730a3'; }
      b.style.marginLeft = '6px';
      b.onclick = cb;
      return b;
    }

    // delete workflow using modal confirm
    async function doDelete(id, rowEl){
      const ok = await confirmModal('Confirm delete', 'Are you sure you want to delete this member? This cannot be undone.');
      if (!ok) return;
      try {
        await apiDelete('/teachers/' + encodeURIComponent(id));
        showToast('Deleted member ' + id, 'success');
        // remove from cache & re-render
        MEMBERS_CACHE = MEMBERS_CACHE.filter(m => String(m.id) !== String(id));
        renderRows();
      } catch(err){
        showToast('Delete failed: ' + (err.message || err), 'error');
      }
    }

    // Export CSV (current filtered set)
    function exportCsv(){
      const q = (search.value || '').trim().toLowerCase();
      const role = (roleFilter.value || '').trim();
      const filtered = MEMBERS_CACHE.filter(r=>{
        if (role && r.role !== role) return false;
        if (!q) return true;
        const uid = (r.meta && (r.meta.uid||'') ) || '';
        return (r.name || '').toLowerCase().includes(q) || (r.phone || '').toLowerCase().includes(q) || String(uid).toLowerCase().includes(q);
      });
      const rows = filtered.map(r => {
        return [
          r.id,
          r.name || '',
          r.department || '',
          r.phone || '',
          r.role || '',
          (r.meta && r.meta.uid) ? r.meta.uid : ''
        ];
      });

      // CSV header as per required sequence
      const header = ['ID','Name','Department','Phone','Role','UID'];
      const csv = [header].concat(rows).map(row => row.map(cell => {
        if (cell === null || cell === undefined) return '';
        const s = String(cell).replace(/"/g,'""');
        return `"${s}"`;
      }).join(',')).join('\r\n');

      const blob = new Blob([csv], { type:'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = 'members_export.csv'; document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    }

    // edit modal: name and department fields are dropdowns (populated from cache)
    async function openEditModal(id){
      // pick record from cache
      const teacher = (MEMBERS_CACHE || []).find(x => String(x.id) === String(id));
      if (!teacher) { showToast('Member not found', 'error'); return; }

      // build options
      const nameOptions = getDistinctNames();
      const deptOptions = getDistinctDepartments();

      const overlay = document.createElement('div'); overlay.className='rad-modal-overlay';
      const modal = document.createElement('div'); modal.className='rad-modal';
      // build name select options
      let nameHtml = `<select class="rad-select" data-field="name">`;
      nameHtml += `<option value="">-- Select Name --</option>`;
      nameOptions.forEach(n => {
        nameHtml += `<option value="${escapeHtml(n)}" ${teacher.name===n ? 'selected' : ''}>${escapeHtml(n)}</option>`;
      });
      nameHtml += `</select>`;

      // build dept select options
      let deptHtml = `<select class="rad-select" data-field="department">`;
      deptHtml += `<option value="">-- Select Department --</option>`;
      deptOptions.forEach(d => {
        deptHtml += `<option value="${escapeHtml(d)}" ${teacher.department===d ? 'selected' : ''}>${escapeHtml(d)}</option>`;
      });
      // also allow current department even if not in list
      if (teacher.department && !deptOptions.includes(teacher.department)) {
        deptHtml += `<option value="${escapeHtml(teacher.department)}" selected>${escapeHtml(teacher.department)}</option>`;
      }
      deptHtml += `</select>`;

      modal.innerHTML = `
        <h3>Edit Member</h3>
        <label>Name</label>${nameHtml}
        <label>Department</label>${deptHtml}
        <label>Phone</label><input class="rad-input" data-field="phone" value="${escapeHtml(teacher.phone||'')}">
        <label>Role</label>
        <select class="rad-select" data-field="role">
          <option ${teacher.role==='Staff'?'selected':''}>Staff</option>
          <option ${teacher.role==='Manager'?'selected':''}>Manager</option>
          <option ${teacher.role==='Admin'?'selected':''}>Admin</option>
        </select>
        <label>UID</label><input class="rad-input" data-field="uid" value="${escapeHtml((teacher.meta && teacher.meta.uid)?teacher.meta.uid:'')}">
        <label>New Password <small>(leave blank to keep)</small></label><input class="rad-input" data-field="password" type="password" value="">
        <div class="rad-modal-actions">
          <button class="rad-btn save">Save</button>
          <button class="rad-btn cancel">Cancel</button>
        </div>
      `;
      overlay.appendChild(modal);
      document.body.appendChild(overlay);

      modal.querySelector('.cancel').onclick = ()=> overlay.remove();
      modal.querySelector('.save').onclick = async ()=>{
        const payload = {};
        const nameEl = modal.querySelector('[data-field="name"]');
        const deptEl = modal.querySelector('[data-field="department"]');
        const phoneEl = modal.querySelector('[data-field="phone"]');
        const roleEl = modal.querySelector('[data-field="role"]');
        const uidEl = modal.querySelector('[data-field="uid"]');
        const pwEl = modal.querySelector('[data-field="password"]');

        // only include fields if non-empty or password provided
        if (nameEl && nameEl.value.trim() !== '') payload.name = nameEl.value.trim();
        if (deptEl && deptEl.value.trim() !== '') payload.department = deptEl.value.trim();
        if (phoneEl && phoneEl.value.trim() !== '') payload.phone = phoneEl.value.trim();
        if (roleEl && roleEl.value.trim() !== '') payload.role = roleEl.value.trim();
        if (uidEl && uidEl.value.trim() !== '') payload.uid = uidEl.value.trim();
        if (pwEl && pwEl.value.trim() !== '') payload.password = pwEl.value;

        if (payload.phone && !/^\d{6,15}$/.test(payload.phone)) { showToast('Phone invalid', 'warn'); return; }

        try {
          await apiJson('/teachers/' + encodeURIComponent(id), payload, 'PUT');
          showToast('Member updated', 'success');
          overlay.remove();
          // refresh cache and table
          await loadData();
          renderRows();
        } catch(err){
          showToast('Update failed: ' + (err.message || err), 'error');
        }
      };
    }

    // wire search/filter/pager events
    search.addEventListener('input', ()=> { CURRENT_PAGE = 1; renderRows(); });
    roleFilter.addEventListener('change', ()=> { CURRENT_PAGE = 1; renderRows(); });
    sizeSelect.addEventListener('change', ()=> { CURRENT_PAGE = 1; renderRows(); });
    refresh.addEventListener('click', async ()=> { await loadData(); showToast('Refreshed', 'info'); renderRows(); });
    exportBtn.addEventListener('click', exportCsv);

    // initial load
    CURRENT_PAGE = 1;
    await loadData();
    renderRows();
  }

  // ensure toast container exists on load
  document.addEventListener('DOMContentLoaded', ()=> ensureToastContainer());

})();
