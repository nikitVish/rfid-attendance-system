<?php
// modules/login/login.php
if (! defined('ABSPATH')) exit;

class RAD_Login_Module {
    public static function init(){
        add_action('rest_api_init', [__CLASS__, 'register_routes']);
        add_action('init', [__CLASS__, 'register_shortcode']);
        add_action('wp_enqueue_scripts', [__CLASS__, 'enqueue_front_assets']);
    }

    public static function register_routes(){
        register_rest_route('rad/v2', '/login', [
            'methods' => 'POST',
            'callback' => [__CLASS__, 'api_login'],
            'permission_callback' => '__return_true'
        ]);
        register_rest_route('rad/v2', '/logout', [
            'methods' => 'POST',
            'callback' => [__CLASS__, 'api_logout'],
            'permission_callback' => '__return_true'
        ]);
        register_rest_route('rad/v2', '/session', [
            'methods' => 'GET',
            'callback' => [__CLASS__, 'api_session'],
            'permission_callback' => '__return_true'
        ]);
    }

    public static function api_login($req){
        global $wpdb;
        $params = $req->get_json_params();
        if (!is_array($params)) return new WP_Error('invalid_json','Invalid JSON', ['status'=>400]);

        $phone = isset($params['phone']) ? trim($params['phone']) : '';
        $password = isset($params['password']) ? trim($params['password']) : '';
        $captcha_answer = isset($params['captcha_answer']) ? intval($params['captcha_answer']) : null;
        $captcha_expected = isset($params['captcha_expected']) ? intval($params['captcha_expected']) : null;

        if ($phone === '' || $password === '' || $captcha_answer === null || $captcha_expected === null) {
            return new WP_Error('missing_fields', 'phone, password and captcha required', ['status'=>400]);
        }

        if ($captcha_answer !== $captcha_expected) {
            return new WP_Error('captcha_failed', 'Captcha incorrect', ['status'=>400]);
        }

        $table = $wpdb->prefix . 'rad_teachers';
        $teacher = $wpdb->get_row($wpdb->prepare("SELECT * FROM {$table} WHERE phone=%s LIMIT 1", $phone), ARRAY_A);
        if (! $teacher) {
            return new WP_Error('invalid_credentials','Invalid credentials', ['status'=>401]);
        }

        $meta_table = $wpdb->prefix . 'rad_entity_meta';
        $row = $wpdb->get_row($wpdb->prepare("SELECT meta_value FROM {$meta_table} WHERE entity_type=%s AND entity_id=%d AND field_key=%s LIMIT 1",
            'teachers', intval($teacher['id']), 'password_hash'), ARRAY_A);
        $hash = $row ? maybe_unserialize($row['meta_value']) : '';

        if (empty($hash) || !wp_check_password($password, $hash)) {
            return new WP_Error('invalid_credentials','Invalid credentials', ['status'=>401]);
        }

        // create stateless token cookie (payload|expire|sig)
        $expire = time() + (2 * 60 * 60); // 2 hours
        $payload = intval($teacher['id']) . '|' . intval($expire);
        $sig = hash_hmac('sha256', $payload, wp_salt());
        $token = base64_encode($payload . '|' . $sig);

        $secure = is_ssl();
        $path = COOKIEPATH ?: '/';
        setcookie('rad_session', $token, $expire, $path, COOKIE_DOMAIN ?: '', $secure, true);
        $_COOKIE['rad_session'] = $token;

        return rest_ensure_response([
            'ok'=>true,
            'user'=>[
                'id'=>intval($teacher['id']),
                'name'=>$teacher['name'],
                'phone'=>$teacher['phone'],
                'role'=>$teacher['role']
            ],
            'token_expires' => $expire
        ]);
    }

    public static function api_logout($req){
        $path = COOKIEPATH ?: '/';
        setcookie('rad_session', '', time()-3600, $path, COOKIE_DOMAIN ?: '', is_ssl(), true);
        unset($_COOKIE['rad_session']);
        return rest_ensure_response(['ok'=>true]);
    }

    public static function api_session($req){
        $s = self::get_valid_session();
        if (!$s) return rest_ensure_response(['ok'=>false]);
        return rest_ensure_response(['ok'=>true,'session'=>$s]);
    }

    public static function get_valid_session(){
        global $wpdb;
        if (empty($_COOKIE['rad_session'])) return null;
        $raw = $_COOKIE['rad_session'];
        $decoded = base64_decode($raw, true);
        if (!$decoded) return null;
        $parts = explode('|', $decoded);
        if (count($parts) !== 3) return null;
        list($id, $expire, $sig) = $parts;
        $payload = $id . '|' . $expire;
        $expect = hash_hmac('sha256', $payload, wp_salt());
        if (!hash_equals($expect, $sig)) return null;
        if (intval($expire) < time()) return null;

        $table = $wpdb->prefix . 'rad_teachers';
        $teacher = $wpdb->get_row($wpdb->prepare("SELECT id,name,phone,role FROM {$table} WHERE id=%d LIMIT 1", intval($id)), ARRAY_A);
        if (!$teacher) return null;
        return [
            'id' => intval($teacher['id']),
            'name' => $teacher['name'],
            'phone' => $teacher['phone'],
            'role' => $teacher['role'],
            'expires' => intval($expire)
        ];
    }

    public static function register_shortcode(){
        add_shortcode('rad_dashboard', [__CLASS__, 'shortcode_dashboard']);
    }

    /**
     * Shortcode: show admin-like layout when plugin session present,
     * otherwise show login form.
     */
    public static function shortcode_dashboard($atts){
        // If session valid, render SPA mount container and full layout (sidebar + topbar)
        $sess = self::get_valid_session();
        if ($sess) {
            // enqueue SPA assets (rad-style + rad-app.js) for front-end
            wp_enqueue_style('rad-style', RAD_PLUGIN_URL . 'public/css/rad-style.css', array(), '1.2.0');
            wp_enqueue_script('rad-bundle', RAD_PLUGIN_URL . 'public/js/rad-app.js', array(), '1.2.0', true);

            // localize radConfig for front-end usage
            $nonce = wp_create_nonce('wp_rest');
            wp_localize_script('rad-bundle', 'radConfig', array(
                'root' => rest_url('rad/v2'),
                'nonce' => $nonce,
                'currentUser' => $sess['name'],
                'currentUserRole' => $sess['role'],
                'pluginUrl' => RAD_PLUGIN_URL
            ));

            // Render admin-like layout (topbar + sidebar + main) so SPA shows sidebar and routes
            ob_start();
            ?>
            <div class="wrap rad-admin-wrap" style="padding:0;">
              <div class="rad-admin-topbar" style="padding:18px 20px; border-bottom:1px solid #e6e6e6;">
                <h1 style="margin:0; display:inline-block;">RFID Dashboard</h1>
                <div style="display:inline-block; float:right; color:#6b7280; margin-top:6px;">
                  Logged in as: <?php echo esc_html($sess['name']); ?>
                </div>
              </div>

              <div class="rad-admin-body" style="display:flex; gap:20px; padding:20px;">
                <aside class="rad-sidebar" style="width:260px;">
                  <div class="rad-sidebar-card" style="background:#fff; border-radius:8px; padding:12px; border:1px solid #e6e6e6;">
                    <nav>
                      <ul style="list-style:none; margin:0; padding:0;">
                        <li><a href="#overview" class="rad-side-link">Overview</a></li>
                        <li style="margin-top:8px; font-weight:700; color:#374151;">Members</li>
                        <li><a href="#members/add" class="rad-side-link">Add Member</a></li>
                        <li><a href="#members/all" class="rad-side-link">All Members</a></li>
                        <li style="margin-top:12px; font-weight:700; color:#374151;">Logs</li>
                        <li><a href="#logs/staff" class="rad-side-link">Staff Logs</a></li>
                        <li><a href="#logs/all" class="rad-side-link">All Logs</a></li>
                        <li style="margin-top:12px; font-weight:700; color:#374151;">Management</li>
                        <li><a href="#timetables/all" class="rad-side-link">All Time Tables</a></li>
                        <li><a href="#timetables/add" class="rad-side-link">Add Time Table</a></li>
                        <li><a href="#devices" class="rad-side-link">Devices</a></li>

                        <li style="margin-top:12px; font-weight:700; color:#374151;">Grace Time Management</li>
                        <li><a href="#grace/add" class="rad-side-link">Add Grace</a></li>

                        <li style="margin-top:12px; font-weight:700; color:#374151;">Rooms</li>
                        <li><a href="#rooms/all" class="rad-side-link">All Rooms</a></li>

                        <li style="margin-top:12px; font-weight:700; color:#374151;">Classrooms</li>
                        <li><a href="#classrooms/all" class="rad-side-link">All Classrooms</a></li>

                        <li style="margin-top:12px; font-weight:700; color:#374151;">Settings</li>
                        <li><a href="#settings/permissions" class="rad-side-link">Permissions</a></li>

                        <li style="margin-top:12px;"><a href="#fields" class="rad-side-link">Fields</a></li>
                      </ul>
                    </nav>
                  </div>
                </aside>

                <main class="rad-content" style="flex:1;">
                  <div style="display:flex;justify-content:flex-end;margin-bottom:8px;">
                    <button id="rad_front_logout_btn" class="rad-btn" style="background:#ef4444;">Logout</button>
                  </div>
                  <div id="rad-root-content"></div>
                </main>
              </div>
            </div>

            <script>
              document.addEventListener("DOMContentLoaded", function(){
                var btn = document.getElementById('rad_front_logout_btn');
                if (!btn) return;
                btn.addEventListener('click', async function(){
                  try {
                    await fetch('<?php echo esc_js(rest_url('rad/v2/logout')); ?>', {
                      method: 'POST',
                      credentials: 'same-origin',
                      headers: { 'X-WP-Nonce': '<?php echo esc_js(wp_create_nonce('wp_rest')); ?>' }
                    });
                    // reload to show login form again
                    location.reload();
                  } catch(e) {
                    alert('Logout failed');
                  }
                });
              });
            </script>
            <?php
            return ob_get_clean();
        }

        // else -> show login form (front-end)
        ob_start();
        ?>
        <div class="rad-login-wrap">
          <div class="rad-panel rad-login-panel">
            <h2>Login to Attendance Manager</h2>

            <label>Mobile Number</label>
            <input id="rad_login_phone" class="rad-input" type="text" placeholder="Mobile number">

            <label>Password</label>
            <input id="rad_login_password" class="rad-input" type="password" placeholder="Password">

            <label>Captcha: Solve the addition</label>
            <div style="display:flex; gap:12px; align-items:center; margin-top:6px;">
              <div id="rad_captcha_box" style="min-width:96px; min-height:72px; display:flex; align-items:center; justify-content:center; font-weight:700; font-size:20px; background:#f7f7f7; border-radius:8px; border:1px solid #e8eef6; padding:8px;"></div>
              <input id="rad_captcha_answer" class="rad-input" type="text" placeholder="Answer" style="flex:1;">
            </div>

            <div id="rad_login_msg" style="margin-top:12px;color:#b91c1c;"></div>

            <button id="rad_login_btn" class="rad-btn" style="margin-top:12px;">Login</button>
          </div>
        </div>
        <?php
        // enqueue login script & style
        wp_enqueue_style('rad-login-css', RAD_PLUGIN_URL . 'modules/login/login.css', array(), '1.0');
        wp_enqueue_script('rad-login-js', RAD_PLUGIN_URL . 'modules/login/login.js', array(), '1.0', true);
        // localize config for login script
        wp_localize_script('rad-login-js', 'radLoginConfig', [
            'root' => rest_url('rad/v2'),
            'nonce' => wp_create_nonce('wp_rest'),
            'dashboard_page_url' => site_url('/dashboard'),
        ]);

        return ob_get_clean();
    }

    public static function enqueue_front_assets(){
        // Not required here; assets enqueued when shortcode renders based on session state.
    }
}

RAD_Login_Module::init();
