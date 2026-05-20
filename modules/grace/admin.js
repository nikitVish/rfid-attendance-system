(function(){
  window.RadGrace = window.RadGrace || {};

  function el(tag, cls, text){ let e=document.createElement(tag); if(cls)e.className=cls; if(text!==undefined)e.textContent=text; return e; }
  function q(sel,root){ return (root||document).querySelector(sel); }

  async function api(path, method='GET', data){
    const base = (window.radConfig && radConfig.root)? radConfig.root : '';
    const res = await fetch(base+path, {
      method,
      headers: {
        'Content-Type':'application/json',
        'X-WP-Nonce': (window.radConfig && radConfig.nonce) || ''
      },
      credentials:'same-origin',
      body: method==='POST'? JSON.stringify(data):undefined
    });
    const txt = await res.text();
    try{ return JSON.parse(txt); }catch(e){ console.warn('bad JSON',txt); return null; }
  }

  function showToast(msg,ok){
    const t=el('div','gr-toast '+(ok?'ok':'err'),msg);
    document.body.appendChild(t);
    setTimeout(()=>t.classList.add('show'),50);
    setTimeout(()=>{t.classList.remove('show');setTimeout(()=>t.remove(),250);},2000);
  }

  window.RadGrace.render = async function(container){
    container = container || document.getElementById('rad-root-content');
    container.innerHTML='';

    const panel = el('div','gr-panel');
    panel.appendChild(el('h2','gr-title','Grace Settings'));

    // grace duration
    const durLabel = el('label',null,'Grace Time (minutes)');
    const durInput = el('input','gr-input'); durInput.type='number'; durInput.min='0'; durInput.placeholder='e.g. 2';
    panel.appendChild(durLabel); panel.appendChild(durInput);

    // window open time
    const winLabel = el('label',null,'Window Open Time (minutes)');
    const winInput = el('input','gr-input'); winInput.type='number'; winInput.min='0'; winInput.placeholder='(optional)';
    panel.appendChild(winLabel); panel.appendChild(winInput);

    // info text
    const info = el('div','gr-hint','Entry/Exit taps will be accepted within ±Window minutes. On-time is within ±Grace minutes.');
    panel.appendChild(info);

    // save button
    const saveBtn = el('button','gr-save-btn','Save Settings');
    panel.appendChild(saveBtn);

    container.appendChild(panel);

    // load data
    try{
      const j = await api('/grace');
      if(j && j.ok && j.row){
        durInput.value = j.row.duration || '';
        winInput.value = (j.row.window_minutes !== undefined && j.row.window_minutes !== null && j.row.window_minutes !== 0) ? j.row.window_minutes : '';
      }
    }catch(e){ console.warn(e); }

    saveBtn.addEventListener('click', async()=>{
      const dur = parseInt(durInput.value)||0;
      const win = winInput.value===''?0:parseInt(winInput.value)||0;

      saveBtn.disabled=true; saveBtn.textContent='Saving...';
      const res = await api('/grace','POST',{ duration:dur, unit:'minute', window_minutes:win });
      if(res && res.ok) showToast('Saved successfully',true);
      else showToast('Save failed',false);
      saveBtn.disabled=false; saveBtn.textContent='Save Settings';
    });
  };
})();
