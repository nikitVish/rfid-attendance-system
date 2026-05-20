// timetables/add/admin.js
// Fixes:
// - "Apply Monday's schedule to all days" now copies ONLY meaningful periods (no 12:00→12:00 placeholders) to every day.
// - Default active tab is *today* (Mon start-of-week mapping), not always Monday.

(function(){
  window.RadTimetablesAdd = window.RadTimetablesAdd || {};

  function el(tag, cls, txt){ var e=document.createElement(tag); if(cls) e.className=cls; if(txt!==undefined) e.textContent=txt; return e; }
  function q(sel, root){ return (root || document).querySelector(sel); }
  function qa(sel, root){ return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function pad2(n){ return String(n).padStart(2,'0'); }
  function hhmmTo12(hhmm){
    if(!hhmm) return '';
    var p = String(hhmm).split(':'); var hh = parseInt(p[0],10)||0; var mm = pad2((p[1]||'00').slice(0,2));
    var ap = hh >= 12 ? 'PM' : 'AM'; var h12 = hh % 12; if(h12===0) h12=12;
    return pad2(h12) + ':' + mm + ' ' + ap;
  }
  function to24FromSpinner(h,m,ap){
    var hh = parseInt(h,10) || 12; var mmv = pad2(parseInt(m,10)||0); ap = (ap||'AM').toUpperCase();
    if(ap==='PM' && hh<12) hh += 12;
    if(ap==='AM' && hh===12) hh = 0;
    return pad2(hh)+':'+mmv;
  }
  function from24ToSpinnerVals(hhmm){
    var p = String(hhmm||'12:00').split(':'); var hh = parseInt(p[0],10)||0; var mm = pad2(p[1] ? p[1].slice(0,2) : 0);
    var ap = hh >= 12 ? 'PM' : 'AM'; var hh12 = hh % 12; if(hh12===0) hh12 = 12;
    return {h: pad2(hh12), m: mm, ap: ap};
  }

  // helpers for "meaningful" rows (skip placeholders like 12:00-12:00 with no content)
  function normTime(hhmm){
    if(!hhmm) return '';
    var p = String(hhmm).split(':');
    var h = parseInt(p[0],10); if(isNaN(h)) return '';
    var m = parseInt(p[1]||'0',10); if(isNaN(m)) m = 0;
    return pad2(h)+':'+pad2(m);
  }
  function isMeaningful(row){
    if(!row) return false;
    var s = normTime(row.start), e = normTime(row.end);
    var hasTime = s && e && s!==e;
    var hasContent = (row.subject && row.subject.trim()) || (row.teacher && String(row.teacher).trim());
    return !!(hasTime || hasContent);
  }

  // toast (small)
  function showToast(msg, time){
    time = time || 1200;
    var existing = document.querySelector('.rt-toast'); if(existing) existing.remove();
    var t = el('div','rt-toast', msg); document.body.appendChild(t);
    requestAnimationFrame(()=> t.classList.add('show'));
    setTimeout(()=>{ t.classList.remove('show'); setTimeout(()=>t.remove(),220); }, time);
  }

  // Time spinner control: returns element with get24/set24/onChange
  function createTimeSpinner(initial24){
    var root = el('div','rt-time-spinner');
    var hour = el('select','rt-time-hour'); for(var i=1;i<=12;i++){ var o=el('option'); o.value=pad2(i); o.textContent=pad2(i); hour.appendChild(o); }
    var colon = el('span','rt-time-colon',':');
    var minute = el('select','rt-time-minute'); for(var j=0;j<60;j++){ var om=el('option'); om.value=pad2(j); om.textContent=pad2(j); minute.appendChild(om); }
    var ap = el('select','rt-time-ampm'); ['AM','PM'].forEach(function(x){ var o=el('option'); o.value=x; o.textContent=x; ap.appendChild(o); });

    root.appendChild(hour); root.appendChild(colon); root.appendChild(minute); root.appendChild(ap);

    if(initial24){ var v = from24ToSpinnerVals(initial24); hour.value=v.h; minute.value=v.m; ap.value=v.ap; }

    root.get24 = function(){ return to24FromSpinner(hour.value, minute.value, ap.value); };
    root.set24 = function(hhmm){ var v = from24ToSpinnerVals(hhmm || '12:00'); hour.value=v.h; minute.value=v.m; ap.value=v.ap; };
    root.onChange = function(cb){ [hour,minute,ap].forEach(function(x){ x.addEventListener('change', cb); }); };
    return root;
  }

  // Period component factory
  function createPeriod(idx, data, teachers, callbacks){
    callbacks = callbacks || {};
    var root = el('div','rt-period');
    var head = el('div','rt-period-head');
    var title = el('div','rt-period-title','Period ' + (idx+1));
    var toggleWrap = el('div','rt-toggle-wrap');
    var toggle = el('button','rt-toggle','▾'); toggle.type='button';
    toggleWrap.appendChild(toggle);
    head.appendChild(title); head.appendChild(toggleWrap);
    root.appendChild(head);

    var body = el('div','rt-period-body');
    // Teacher
    body.appendChild(el('label',null,'Teacher'));
    var sel = el('select','rad-select rt-teacher'); sel.appendChild(new Option('Select a teacher',''));
    (teachers||[]).forEach(function(t){ sel.appendChild(new Option(t.name || ('#'+t.id), t.id)); });
    if(data && data.teacher) sel.value = data.teacher;
    body.appendChild(sel);

    // Subject
    body.appendChild(el('label',null,'Subject'));
    var subj = el('input','rad-input rt-subject'); subj.type='text'; subj.placeholder='Enter subject'; subj.value = (data && data.subject) ? data.subject : '';
    body.appendChild(subj);

    // Times
    var timesRow = el('div','rt-times-row');
    var scol = el('div','rt-times-col'); scol.appendChild(el('label',null,'Start Time'));
    var spinnerStart = createTimeSpinner((data && data.start) ? data.start : '12:00'); scol.appendChild(spinnerStart);
    var ecol = el('div','rt-times-col'); ecol.appendChild(el('label',null,'End Time'));
    var spinnerEnd = createTimeSpinner((data && data.end) ? data.end : '12:00'); ecol.appendChild(spinnerEnd);
    timesRow.appendChild(scol); timesRow.appendChild(ecol);
    body.appendChild(timesRow);

    var rm = el('button','rad-btn ghost rt-remove','Remove Period'); rm.type='button';
    body.appendChild(rm);

    root.appendChild(body);

    function setOpen(v){ if(v){ body.classList.add('open'); toggle.textContent='▴'; } else { body.classList.remove('open'); toggle.textContent='▾'; } }
    setOpen(false);

    function updateTitle(i){
      title.textContent = 'Period ' + (i+1) + ' (' + hhmmTo12(spinnerStart.get24()) + ' - ' + hhmmTo12(spinnerEnd.get24()) + ')';
    }
    updateTitle(idx);

    toggle.addEventListener('click', function(e){ e.stopPropagation(); setOpen(!body.classList.contains('open')); });
    head.addEventListener('click', function(){ setOpen(!body.classList.contains('open')); });

    function notify(){
      updateTitle(idx);
      if(callbacks.onChange) callbacks.onChange();
    }
    sel.addEventListener('change', notify); subj.addEventListener('input', notify);
    spinnerStart.onChange(function(){ notify(); });
    spinnerEnd.onChange(function(){
      notify();
      if(callbacks.getNextSetter){
        var setNext = callbacks.getNextSetter();
        if(setNext){
          var thisEnd = spinnerEnd.get24();
          var curNext = setNext('get');
          if(!curNext || curNext === '12:00') setNext('set', thisEnd);
        }
      }
    });

    rm.addEventListener('click', function(e){ e.preventDefault(); e.stopPropagation(); if(callbacks.onRemove) callbacks.onRemove(); });

    return {
      el: root,
      updateIndex: function(i){ idx = i; updateTitle(i); },
      getValue: function(){ return { teacher: sel.value||'', subject: subj.value||'', start: spinnerStart.get24(), end: spinnerEnd.get24() }; },
      setValue: function(d){ if(!d) return; if(d.teacher) sel.value = d.teacher; if(d.subject!==undefined) subj.value = d.subject; if(d.start) spinnerStart.set24(d.start); if(d.end) spinnerEnd.set24(d.end); updateTitle(idx); },
      getNextStartSetter: function(){ return function(op,val){ if(op==='get'){ return spinnerStart.get24(); } if(op==='set'){ spinnerStart.set24(val); updateTitle(idx); if(callbacks.onChange) callbacks.onChange(); return true; } }; }
    };
  }

  // Main rendering
  window.RadTimetablesAdd.render = function(container){
    container = container || document.getElementById('rad-root-content');
    container.innerHTML = '';

    // header
    var header = el('div','rt-headerbar'); header.appendChild(el('h2',null,'Add Timetable')); header.appendChild(el('div','rt-sub','Create a new classroom schedule'));
    container.appendChild(header);

    var panel = el('div','rt-panel');
    // classroom
    panel.appendChild(el('label',null,'Classroom Name'));
    var classroomSel = el('select','rad-select rt-classroom'); classroomSel.appendChild(new Option('Select a classroom',''));
    panel.appendChild(classroomSel);

    // apply monday
    var applyRow = el('div','rt-apply'); var cb = el('input'); cb.type='checkbox'; cb.id='rt-apply-all';
    var cbLabel = el('label','', 'Apply Monday\'s schedule to all days'); cbLabel.setAttribute('for','rt-apply-all');
    applyRow.appendChild(cb); applyRow.appendChild(cbLabel); panel.appendChild(applyRow);

    // day tabs
    var days = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];

    // Default = TODAY (Mon=0 ... Sun=6)
    var jsDow = (new Date()).getDay(); // 0=Sun..6=Sat
    var todayIndex = (jsDow === 0) ? 6 : (jsDow - 1); // map to Mon=0..Sun=6

    var tabs = el('div','rt-days-tabs'); days.forEach(function(d,i){
      var b = el('button','rt-day-tab', d); b.dataset.day = d; if(i===todayIndex) b.classList.add('active'); tabs.appendChild(b);
    });
    panel.appendChild(tabs);

    var periodsContainer = el('div','rt-periods-container');
    panel.appendChild(periodsContainer);

    var addBar = el('button','rt-add-bar','+ Add Another Period'); addBar.type='button';
    panel.appendChild(addBar);

    var saveWrap = el('div','rt-save-wrap'); var saveBtn = el('button','rad-btn green rt-save','Save Timetable'); saveBtn.type='button';
    saveWrap.appendChild(saveBtn); panel.appendChild(saveWrap);

    container.appendChild(panel);

    // state (start on today)
    var state = { teachers: [], currentDay: days[todayIndex], daysMap: {} };

    function ensureDay(d){
      if(!state.daysMap[d] || !Array.isArray(state.daysMap[d]) || state.daysMap[d].length===0){
        state.daysMap[d] = [{teacher:'', subject:'', start:'12:00', end:'12:00'}];
      }
      return state.daysMap[d];
    }

    function saveCurrentDayFromDOM(){
      var list = qa('.rt-period', periodsContainer);
      var arr = [];
      list.forEach(function(pEl){
        var t = (pEl.querySelector('.rt-teacher') && pEl.querySelector('.rt-teacher').value) || '';
        var s = (pEl.querySelector('.rt-subject') && pEl.querySelector('.rt-subject').value) || '';
        var sp = pEl.querySelectorAll('.rt-time-spinner');
        var st = (sp && sp[0] && typeof sp[0].get24 === 'function') ? sp[0].get24() : '12:00';
        var en = (sp && sp[1] && typeof sp[1].get24 === 'function') ? sp[1].get24() : '12:00';
        arr.push({ teacher: t, subject: s, start: st, end: en });
      });
      for(var i=0;i<arr.length-1;i++){
        if(!arr[i+1].start || arr[i+1].start === '12:00') arr[i+1].start = arr[i].end || '12:00';
      }
      state.daysMap[state.currentDay] = arr;
    }

    function renderFor(day){
      periodsContainer.innerHTML = '';
      var arr = ensureDay(day);
      var comps = [];
      arr.forEach(function(p, idx){
        var comp = createPeriod(idx, p, state.teachers, {
          onRemove: function(){
            saveCurrentDayFromDOM();
            var cur = state.daysMap[state.currentDay] || [];
            cur.splice(idx,1);
            if(cur.length===0) cur.push({teacher:'', subject:'', start:'12:00', end:'12:00'});
            state.daysMap[state.currentDay] = cur;
            renderFor(state.currentDay);
          },
          onChange: function(){ saveCurrentDayFromDOM(); },
          getNextSetter: function(){ return comp && comp.getNextStartSetter ? comp.getNextStartSetter() : null; }
        });
        comps.push(comp);
        periodsContainer.appendChild(comp.el);
      });
      comps.forEach(function(c,i){ c.updateIndex(i); });
    }

    // load aux data (classrooms + teachers)
    (async function loadAux(){
      try {
        // IMPORTANT: value is ALWAYS the numeric classroom id; text is the label
        var cl = await fetch((window.radConfig && radConfig.root?radConfig.root:'') + '/classrooms', { credentials:'same-origin', headers:{ 'X-WP-Nonce': (window.radConfig && radConfig.nonce)||'' } });
        var txt = await cl.text(); try{ cl = JSON.parse(txt); }catch(e){ cl = { rows: [] }; }
        if(cl && Array.isArray(cl.rows)){
          classroomSel.innerHTML = '';
          classroomSel.appendChild(new Option('Select a classroom',''));
          cl.rows.forEach(function(r){
            var label = r.classroom || r.name || ('Class ' + (r.id||''));
            var val = (r.id != null) ? String(r.id) : String(r.classroom || '');
            classroomSel.appendChild(new Option(label, val));
          });
        }
      } catch(e) { console.warn('load classrooms failed', e); }

      try {
        var t = await fetch((window.radConfig && radConfig.root?radConfig.root:'') + '/teachers', { credentials:'same-origin', headers:{ 'X-WP-Nonce': (window.radConfig && radConfig.nonce)||'' } });
        var txt = await t.text(); try{ t = JSON.parse(txt); }catch(e){ t = { rows: [] }; }
        state.teachers = (t && Array.isArray(t.rows)) ? t.rows.map(function(r){ return { id: r.id, name: r.name }; }) : [];
      } catch(e) { console.warn('load teachers failed', e); }

      renderFor(state.currentDay);
    })();

    tabs.addEventListener('click', function(e){
      var b = e.target.closest && e.target.closest('.rt-day-tab');
      if(!b) return;
      saveCurrentDayFromDOM();
      qa('.rt-day-tab', tabs).forEach(function(x){ x.classList.remove('active'); });
      b.classList.add('active');
      state.currentDay = b.dataset.day;
      renderFor(state.currentDay);
      showToast('Saved & switched to ' + state.currentDay);
    });

    addBar.addEventListener('click', function(e){
      e.preventDefault();
      saveCurrentDayFromDOM();
      var list = ensureDay(state.currentDay);
      var last = list[list.length - 1] || { end: '12:00' };
      var newStart = last.end || '12:00';
      list.push({ teacher:'', subject:'', start: newStart, end: '12:00' });
      renderFor(state.currentDay);
      var lastEl = periodsContainer.lastElementChild; if(lastEl){ var t = lastEl.querySelector('.rt-toggle'); if(t) t.click(); }
    });

    // FIXED: Apply Monday to all days — copy only meaningful rows & deep clone
    cb.addEventListener('change', function(){
      saveCurrentDayFromDOM(); // keep current tab synced

      if(cb.checked){
        // Build a clean copy from Monday
        var monRaw = (state.daysMap['Mon'] || []).slice();
        var monClean = monRaw.filter(isMeaningful).map(function(p){
          return { teacher: p.teacher||'', subject: p.subject||'', start: normTime(p.start)||'12:00', end: normTime(p.end)||'12:00' };
        });

        // If Monday is empty after cleaning, just keep a single editable placeholder everywhere
        var replacement = (monClean.length ? monClean : [{teacher:'', subject:'', start:'12:00', end:'12:00'}]);

        ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].forEach(function(d){
          // deep clone to avoid shared references
          state.daysMap[d] = JSON.parse(JSON.stringify(replacement));
        });

        renderFor(state.currentDay);
        showToast('Applied Monday to all days');
      } else {
        showToast('Cleared apply Monday');
      }
    });

    // Save timetable to backend
    document.querySelector('.rt-save').addEventListener('click', async function(e){
      e.preventDefault();
      saveCurrentDayFromDOM();
      Object.keys(state.daysMap).forEach(function(day){
        var arr = state.daysMap[day];
        for(var i=0;i<arr.length-1;i++){
          if(!arr[i+1].start || arr[i+1].start === '12:00') arr[i+1].start = arr[i].end || '12:00';
        }
      });
      if(!classroomSel.value){ alert('Please select a classroom'); classroomSel.focus(); return; }
      var payload = { classroom_id: classroomSel.value, classroom: classroomSel.options[classroomSel.selectedIndex].text, days: {} };
      ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].forEach(function(d){ payload.days[d] = state.daysMap[d] || []; });

      this.disabled = true; this.textContent = 'Saving...';
      try {
        var resp = await fetch((window.radConfig && radConfig.root?radConfig.root:'') + '/timetables', {
          method: 'POST', credentials:'same-origin',
          headers:{ 'Content-Type':'application/json', 'X-WP-Nonce': (window.radConfig && radConfig.nonce)||'' },
          body: JSON.stringify(payload)
        });
        var txt = await resp.text(); var j; try{ j = JSON.parse(txt); }catch(e){ throw new Error('Invalid JSON: '+txt); }
        if(!resp.ok || !j.ok) throw new Error(j.message || JSON.stringify(j));
        showToast('Timetable saved');
      } catch(err){ alert('Save failed: ' + (err.message||err)); }
      finally { this.disabled = false; this.textContent = 'Save Timetable'; }
    });

  };

})();
