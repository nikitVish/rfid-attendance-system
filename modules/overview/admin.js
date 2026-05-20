// modules/overview/admin.js
(function(){
  window.RadOverview = window.RadOverview || {};

  // tiny helpers
  function el(tag, cls, txt){
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt !== undefined) e.textContent = txt;
    return e;
  }
  function q(sel, root){ return (root || document).querySelector(sel); }
  function safeText(s){ return s === null || s === undefined ? '' : String(s); }

  async function apiGet(path){
    var url = (window.radConfig && window.radConfig.root ? window.radConfig.root : '') + path;
    var res = await fetch(url, {
      method:'GET',
      credentials:'same-origin',
      headers:{ 'X-WP-Nonce': (window.radConfig && window.radConfig.nonce) || '' }
    });
    if (!res.ok) {
      var txt = await res.text();
      throw new Error(txt || ('HTTP ' + res.status));
    }
    return res.json();
  }

  // Load ALL staff logs for a date range by paging through /logs/staff
  async function loadStaffLogsRange(fromISO, toISO){
    var all = [];
    var page = 1, per = 100; // safe upper bound
    while (true) {
      var url = '/logs/staff?from=' + encodeURIComponent(fromISO) +
                '&to='   + encodeURIComponent(toISO)   +
                '&page=' + page + '&per_page=' + per;
      var j = await apiGet(url);
      var rows = (j && j.rows) ? j.rows : [];
      all = all.concat(rows);
      var total = j && j.total ? j.total : rows.length;
      if (all.length >= total || rows.length === 0) break;
      page++;
    }
    return all;
  }

  // Derive counts from /logs/staff rows
  function buildCounts(rows){
    var counts = {
      total_active_staff: 0, // filled separately from /teachers
      on_time: 0,
      early_arrival: 0,
      late_arrival: 0,
      early_exit: 0,
      late_exit: 0,
      absent: 0
    };
    rows.forEach(function(r){
      var es = (r.entry_status || '').toLowerCase();
      var xs = (r.exit_status  || '').toLowerCase();

      if (es === 'on time') counts.on_time++;
      else if (es === 'early entry') counts.early_arrival++;
      else if (es === 'late entry')  counts.late_arrival++;

      if (xs === 'early exit') counts.early_exit++;
      else if (xs === 'late exit') counts.late_exit++;

      // Absent period = no taps for both ends
      if (es === 'no tap' && xs === 'no tap') counts.absent++;
    });
    return counts;
  }

  // Render
  window.RadOverview.render = async function(container){
    container = container || document.getElementById('rad-root-content');
    container.innerHTML = '';

    // Greeting card
    var greetCard = el('div','rad-panel rad-overview-greet');
    var left = el('div','rad-greet-left');
    var icon = el('div','rad-greet-icon');
    icon.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 12c2.761 0 5-2.239 5-5s-2.239-5-5-5-5 2.239-5 5 2.239 5 5 5z" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 20c0-2.761 4.477-5 8-5s8 2.239 8 5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    left.appendChild(icon);
    var h = el('div','rad-greet-title');
    var uname = (window.radConfig && window.radConfig.currentUser) ? window.radConfig.currentUser : '';
    var roleTag = (window.radConfig && window.radConfig.currentUserRole) ? window.radConfig.currentUserRole.toUpperCase() : '';
    var title = el('div','rad-greet-name', 'Hello, ' + safeText(uname));
    var subt = el('div','rad-greet-sub','Let\'s oversee and empower your organization!');
    h.appendChild(title); h.appendChild(subt); left.appendChild(h);
    var right = el('div','rad-greet-right');
    var badge = el('span','rad-role-badge', roleTag || 'USER');
    right.appendChild(badge);
    greetCard.appendChild(left); greetCard.appendChild(right);
    container.appendChild(greetCard);

    // Analytics wrapper
    var analyticsWrap = el('div','rad-panel rad-overview-analytics');
    var headerRow = el('div','rad-overview-header');

    // ---- Date range picker (FROM / TO + Apply) ----
    var rangeWrap = el('div','rad-range-wrap');
    var fromInp = el('input','rad-date'); fromInp.type='date';
    var toInp   = el('input','rad-date'); toInp.type='date';
    var today = new Date().toLocaleDateString('en-CA');
    fromInp.value = today; toInp.value = today;
    var applyBtn = el('button','rad-btn rad-apply','Apply');

    // Title at left, date range at right
    var headerTitle = el('h3', null, 'Logs Summary');
    headerRow.appendChild(headerTitle);
    rangeWrap.appendChild(fromInp);
    rangeWrap.appendChild(toInp);
    rangeWrap.appendChild(applyBtn);
    headerRow.appendChild(rangeWrap);

    analyticsWrap.appendChild(headerRow);

    var cardsGrid = el('div','rad-overview-cards');
    analyticsWrap.appendChild(cardsGrid);
    container.appendChild(analyticsWrap);

    // bottom summary
    var summaryWrap = el('div','rad-panel rad-overview-summary');
    var summaryInner = el('div','rad-summary-inner');
    summaryWrap.appendChild(summaryInner);
    var summaryRow = el('div','rad-summary-row');
    var pill1 = el('div','rad-summary-pill'); pill1.appendChild(el('div','rad-summary-value','0')); pill1.appendChild(el('div','rad-summary-label','Total Staff'));
    var pill2 = el('div','rad-summary-pill'); pill2.appendChild(el('div','rad-summary-value','0')); pill2.appendChild(el('div','rad-summary-label','Admins'));
    var pill3 = el('div','rad-summary-pill'); pill3.appendChild(el('div','rad-summary-value','0')); pill3.appendChild(el('div','rad-summary-label','Managers'));
    summaryRow.appendChild(pill1); summaryRow.appendChild(pill2); summaryRow.appendChild(pill3);
    var btnWrap = el('div','rad-summary-btn-wrap');
    var addBtn = el('button','rad-btn rad-add-staff','+ Add Staff');
    addBtn.type = 'button';
    addBtn.addEventListener('click', function(){ location.hash = '#members/add'; });
    btnWrap.appendChild(addBtn);
    summaryInner.appendChild(summaryRow);
    summaryInner.appendChild(btnWrap);
    container.appendChild(summaryWrap);

    // loading state for cards
    cardsGrid.innerHTML = '<div class="rad-loading">Loading...</div>';

    // helper to actually load + render cards for a given range
    async function loadAndRender(){
      try {
        var f = fromInp.value || today;
        var t = toInp.value   || today;

        // teachers for totals
        // teachers for totals
var teachers = await apiGet('/teachers');

var staffCount   = 0; // exclude admin & manager
var adminCount   = 0;
var managerCount = 0;

if (teachers && Array.isArray(teachers.rows)) {
  teachers.rows.forEach(function(tt){
    var r = (tt.role || '').toLowerCase().trim();
    if (r === 'admin' || r === 'administrator') {
      adminCount++;
    } else if (r === 'manager') {
      managerCount++;
    } else {
      staffCount++; // everything else is a normal staff
    }
  });
}

var totalStaff = staffCount;

        // staff logs (range)
        var rows = await loadStaffLogsRange(f, t);
        var counts = buildCounts(rows);
        counts.total_active_staff = totalStaff;

        // Render the 7 cards like before
        cardsGrid.innerHTML = '';
        var map = [
          ['Total Staff','total_active_staff','rad-blue','person'],
          ['On Time','on_time','rad-green','clock'],
          ['Early Arrival','early_arrival','rad-teal','clock'],
          ['Late Arrival','late_arrival','rad-orange','clock'],
          ['Early Exit','early_exit','rad-gold','exit'],
          ['Late Exit','late_exit','rad-red','exit'],
          ['Absent','absent','rad-gray','absent']
        ];

        map.forEach(function(m){
          var label = m[0], key = m[1], cls = m[2];
          var val = safeText(counts[key] !== undefined ? counts[key] : 0);
          var card = el('div','rad-card rad-analytics-card ' + cls);

          var leftc = el('div','rad-analytics-left');
          leftc.appendChild(el('div','rad-analytics-label', label));
          leftc.appendChild(el('div','rad-analytics-value', val));
          card.appendChild(leftc);

          var rightc = el('div','rad-analytics-icon');
          var svg = '';
          if (m[3] === 'person') {
            svg = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M12 12c2.761 0 5-2.239 5-5s-2.239-5-5-5-5 2.239-5 5 2.239 5 5 5z" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 20c0-2.761 4.477-5 8-5s8 2.239 8 5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
          } else if (m[3] === 'clock') {
            svg = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.6"/><path d="M12 7v6l4 2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
          } else if (m[3] === 'exit') {
            svg = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M10 17l5-5-5-5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M19 12H5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
          } else {
            svg = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="7" r="4" stroke="currentColor" stroke-width="1.6"/></svg>';
          }
          rightc.innerHTML = svg;
          card.appendChild(rightc);

          cardsGrid.appendChild(card);
        });

        // summary pills
        pill1.querySelector('.rad-summary-value').textContent = String(totalStaff || 0);
        pill2.querySelector('.rad-summary-value').textContent = String(adminCount || 0);
        pill3.querySelector('.rad-summary-value').textContent = String(managerCount || 0);

        // header title text with range
        var fmt = function(s){
          try { return new Date(s).toLocaleDateString(undefined, { year:'numeric', month:'short', day:'numeric' }); }
          catch(e){ return s; }
        };
        headerTitle.textContent = 'Logs Summary — ' + fmt(f) + (f!==t ? (' to ' + fmt(t)) : '');

      } catch (err) {
        cardsGrid.innerHTML = '<div class="rad-loading error">Error loading analytics: ' + (err && err.message ? err.message : '') + '</div>';
      }
    }

    // Initial load
    await loadAndRender();

    // Re-load on Apply
    applyBtn.addEventListener('click', loadAndRender);
  };
})();