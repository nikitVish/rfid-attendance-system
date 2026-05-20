// modules/login/login.js
(function(){
  function q(sel){ return document.querySelector(sel); }
  function apiFetch(path, opts){
    var url = (window.radLoginConfig && window.radLoginConfig.root ? window.radLoginConfig.root : '') + path;
    opts = opts || {};
    opts.credentials = 'same-origin';
    opts.headers = opts.headers || {};
    if (window.radLoginConfig && window.radLoginConfig.nonce) opts.headers['X-WP-Nonce'] = window.radLoginConfig.nonce;
    return fetch(url, opts).then(function(res){
      return res.text().then(function(txt){
        var ok = res.ok;
        try {
          var j = txt ? JSON.parse(txt) : {};
          if (!ok) throw j;
          return j;
        } catch(e){
          if (!ok) throw new Error(txt || (e.message||e));
          return txt;
        }
      });
    });
  }

  function generateCaptcha(){
    var a = Math.floor(Math.random()*9) + 1;
    var b = Math.floor(Math.random()*9) + 1;
    return {a:a, b:b, sum: a + b};
  }

  function init(){
    var phoneEl = q('#rad_login_phone');
    var passEl = q('#rad_login_password');
    var captchaBox = q('#rad_captcha_box');
    var captchaAns = q('#rad_captcha_answer');
    var msg = q('#rad_login_msg');
    var btn = q('#rad_login_btn');

    if (!phoneEl || !passEl || !captchaBox || !captchaAns || !btn) return;

    var cap = generateCaptcha();
    captchaBox.textContent = cap.a + '  +  ' + cap.b + '  = ?';
    captchaAns.value = '';

    btn.addEventListener('click', function(){
      msg.textContent = '';
      var phone = phoneEl.value.trim();
      var pw = passEl.value;
      var ans = parseInt(captchaAns.value, 10);

      if (!phone || !pw || isNaN(ans)) {
        msg.textContent = 'Please fill mobile, password and captcha answer';
        return;
      }

      btn.disabled = true; btn.textContent = 'Logging in...';

      var payload = {
        phone: phone,
        password: pw,
        captcha_answer: ans,
        captcha_expected: cap.sum
      };

      apiFetch('/login', { method:'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload) })
      .then(function(res){
        if (res && res.ok) {
          // redirect to the front-end dashboard page (shortcode) — not wp-admin
          var dash = (window.radLoginConfig && window.radLoginConfig.dashboard_page_url) ? window.radLoginConfig.dashboard_page_url : '/dashboard';
          // small timeout to ensure cookie is set
          setTimeout(function(){ window.location = dash; }, 200);
        } else {
          var text = (res && (res.message || (res.data && res.data.message))) ? (res.message || (res.data && res.data.message)) : 'Unknown error';
          msg.textContent = 'Login failed: ' + text;
          // regenerate captcha
          cap = generateCaptcha();
          captchaBox.textContent = cap.a + '  +  ' + cap.b + '  = ?';
          captchaAns.value = '';
        }
      })
      .catch(function(err){
        msg.textContent = 'Login failed: ' + (err.message || err);
        cap = generateCaptcha();
        captchaBox.textContent = cap.a + '  +  ' + cap.b + '  = ?';
        captchaAns.value = '';
      })
      .finally(function(){
        btn.disabled = false; btn.textContent = 'Login';
      });
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
