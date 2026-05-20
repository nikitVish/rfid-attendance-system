// public/js/rad-login.js
(function(){
  if (typeof window.radLoginConfig === 'undefined') window.radLoginConfig = { root: '/wp-json/rad/v2', nonce: '' };

  function el(tag, cls, txt){ var e=document.createElement(tag); if (cls) e.className = cls; if (txt!==undefined) e.textContent = txt; return e; }
  function q(sel, root){ return (root||document).querySelector(sel); }

  function apiPost(path, body){
    var url = (window.radLoginConfig.root || '/wp-json/rad/v2') + path;
    return fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'X-WP-Nonce': window.radLoginConfig.nonce || ''
      },
      body: JSON.stringify(body)
    }).then(function(res){
      return res.text().then(function(txt){
        try { var j = txt ? JSON.parse(txt) : {}; if (!res.ok) throw j; return j; } catch(e){ if (!res.ok) throw new Error(txt||res.status); return txt; }
      });
    });
  }

  function apiGet(path){
    var url = (window.radLoginConfig.root || '/wp-json/rad/v2') + path;
    return fetch(url, { credentials:'same-origin', headers:{ 'X-WP-Nonce': window.radLoginConfig.nonce || '' } }).then(function(res){
      return res.text().then(function(txt){
        try { var j = txt ? JSON.parse(txt) : {}; if (!res.ok) throw j; return j; } catch(e){ if (!res.ok) throw new Error(txt||res.status); return txt; }
      });
    });
  }

  function randomCaptcha(){
    var a = Math.floor(Math.random()*9)+1;
    var b = Math.floor(Math.random()*9)+1;
    return { a: a, b: b, expected: a + b, text: a + ' + ' + b + ' = ?' };
  }

  function renderLogin(root){
    root.innerHTML = '';
    var panel = el('div','rad-panel rad-login-box');
    var h = el('h2', null, 'Login to Attendance Manager');
    panel.appendChild(h);

    var form = el('form', 'rad-form');
    // phone
    form.appendChild(el('label', null, 'Mobile Number'));
    var phone = el('input','rad-input'); phone.type='text'; phone.placeholder='Enter mobile number';
    form.appendChild(phone);
    // password
    form.appendChild(el('label', null, 'Password'));
    var pw = el('input','rad-input'); pw.type='password'; pw.placeholder='Password';
    form.appendChild(pw);
    // captcha area
    form.appendChild(el('label', null, 'Captcha: Solve the addition'));
    var capWrap = el('div', 'rad-captcha');
    var captchaText = el('div','rad-captcha-text','');
    var captchaInput = el('input','rad-input'); captchaInput.type='text'; captchaInput.placeholder='Answer';
    capWrap.appendChild(captchaText); capWrap.appendChild(captchaInput);
    form.appendChild(capWrap);

    // message / submit
    var msg = el('div','rad-message',''); form.appendChild(msg);
    var submit = el('button','rad-btn','Login'); submit.type='submit'; form.appendChild(submit);

    panel.appendChild(form);
    root.appendChild(panel);

    var captcha = randomCaptcha();
    captchaText.textContent = captcha.text;

    form.addEventListener('submit', async function(e){
      e.preventDefault();
      msg.textContent = '';
      var ph = phone.value.trim();
      var pwv = pw.value;
      var ans = captchaInput.value.trim();
      if (!ph) { msg.textContent = 'Mobile number required'; return; }
      if (!pwv) { msg.textContent = 'Password required'; return; }
      if (!ans) { msg.textContent = 'Captcha answer required'; return; }
      submit.disabled = true; submit.textContent = 'Logging in...';
      try {
        var payload = { phone: ph, password: pwv, captcha_answer: parseInt(ans,10), captcha_expected: captcha.expected };
        var res = await apiPost('/auth/login', payload);
        if (res && res.ok) {
          msg.style.color = '#16a34a';
          msg.textContent = 'Login successful — redirecting to dashboard...';
          // redirect to plugin dashboard page
          var redirect = window.location.origin + '/wp-admin/admin.php?page=rad-dashboard';
          setTimeout(function(){ window.location.href = redirect; }, 800);
        } else {
          throw new Error((res && res.message) ? res.message : 'Login failed');
        }
      } catch(err){
        msg.style.color = '#b91c1c';
        msg.textContent = 'Login failed: ' + (err.message || err);
        // regenerate captcha for next try
        captcha = randomCaptcha();
        captchaText.textContent = captcha.text;
        captchaInput.value = '';
      } finally {
        submit.disabled = false; submit.textContent = 'Login';
      }
    });
  }

  // On DOM ready, render into #rad-login-root if present
  document.addEventListener('DOMContentLoaded', function(){
    var root = document.getElementById('rad-login-root');
    if (!root) return;
    renderLogin(root);
  });

})();
