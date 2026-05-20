<?php
// modules/auth/auth.php
if (! defined('ABSPATH')) exit;

class RAD_Auth_Module {
    public static function init(){
        add_action('rest_api_init', [__CLASS__, 'register_routes']);
        add_action('init', [__CLASS__, 'maybe_handle_session_cookie']); // optional session checks
    }

    public static function maybe_handle_session_cookie(){
        // nothing required here; this can be used later to bootstrap session info for front-end rendering
    }

    public static function register_routes(){
        // captcha: GET /auth/captcha
        register_rest_route('rad/v2', '/auth/captcha', [
            'methods' => 'GET',
            'callback' => [__CLASS__, 'get_captcha'],
            'permission_callback' => '__return_true'
        ]);

        // login: POST /auth/login
        register_rest_route('rad/v2', '/auth/login', [
            'methods' => 'POST',
            'callback' => [__CLASS__, 'do_login'],
            'permission_callback' => '__return_true'
        ]);

        // logout: POST /auth/logout
        register_rest_route('rad/v2', '/auth/logout', [
            'methods' => 'POST',
            'callback' => [__CLASS__, 'do_logout'],
            'permission_callback' => '__return_true'
        ]);
    }

    /**
     * GET /auth/captcha
     * returns { token, a, b } where a and b are single-digit integers (1-9)
     * server stores transient 'rad_captcha_{token}' => expected_sum for 5 minutes
     */
    public static function get_captcha($req){
        $a = rand(1,9);
        $b = rand(1,9);
        $sum = $a + $b;
        $token = wp_generate_uuid4();
        $key = 'rad_captcha_' . $token;
        set_transient($key, $sum, 5 * MINUTE_IN_SECONDS);
        return rest_ensure_response(['ok'=>true,'token'=>$token,'a'=>$a,'b'=>$b]);
    }

    /**
     * POST /auth/login
     * body: { phone, password, captcha_token, captcha_answer }
     *
     * Rate limit: 5 attempts per IP (transient rad_login_attempts_{ip})
     * On success create plugin session token (wp_generate_uuid4), store transient mapping token => teacher_id
     * Set cookie rad_session=<token>; lifetime 15 minutes
     * Return redirect to front-end /rad-dashboard/
     */
    public static function do_login($req){
        global $wpdb;
        $params = $req->get_json_params();
        if (!is_array($params)) return new WP_Error('invalid_json','Invalid JSON', ['status'=>400]);

        $phone = isset($params['phone']) ? sanitize_text_field($params['phone']) : '';
        $password = isset($params['password']) ? $params['password'] : '';
        $captcha_token = isset($params['captcha_token']) ? sanitize_text_field($params['captcha_token']) : '';
        $captcha_answer = isset($params['captcha_answer']) ? intval($params['captcha_answer']) : null;

        if (empty($phone) || empty($password) || empty($captcha_token) || $captcha_answer === null) {
            return new WP_Error('missing_fields','phone, password and captcha required', ['status'=>400]);
        }

        // rate limiting per IP
        $ip = isset($_SERVER['REMOTE_ADDR']) ? preg_replace('/[^0-9a-fA-F:\.]/','', $_SERVER['REMOTE_ADDR']) : 'unknown';
        $attempt_key = 'rad_login_attempts_' . md5($ip);
        $attempts = intval(get_transient($attempt_key) ?: 0);
        if ($attempts >= 5) {
            return new WP_Error('rate_limited','Too many failed login attempts. Try again later.', ['status'=>429]);
        }

        // verify captcha transient
        $cap_key = 'rad_captcha_' . $captcha_token;
        $expected = get_transient($cap_key);
        // remove it to prevent reuse
        delete_transient($cap_key);
        if ($expected === false || intval($expected) !== intval($captcha_answer)) {
            // increment attempts
            set_transient($attempt_key, $attempts + 1, 15 * MINUTE_IN_SECONDS);
            return new WP_Error('invalid_captcha','Captcha invalid', ['status'=>400]);
        }

        // find teacher by phone in rad_teachers (phone stored in rad_teachers table)
        $table = $wpdb->prefix . 'rad_teachers';
        $row = $wpdb->get_row($wpdb->prepare("SELECT * FROM {$table} WHERE phone=%s LIMIT 1", $phone), ARRAY_A);
        if (! $row) {
            // increment attempts
            set_transient($attempt_key, $attempts + 1, 15 * MINUTE_IN_SECONDS);
            return new WP_Error('invalid_credentials','Invalid phone or password', ['status'=>401]);
        }
        $teacher_id = intval($row['id']);

        // get password_hash from entity_meta
        $meta_table = $wpdb->prefix . 'rad_entity_meta';
        $meta = $wpdb->get_row($wpdb->prepare("SELECT meta_value FROM {$meta_table} WHERE entity_type=%s AND entity_id=%d AND field_key=%s LIMIT 1", 'teachers', $teacher_id, 'password_hash'), ARRAY_A);
        if (! $meta || empty($meta['meta_value'])) {
            set_transient($attempt_key, $attempts + 1, 15 * MINUTE_IN_SECONDS);
            return new WP_Error('no_password','Account has no password set', ['status'=>401]);
        }
        $hash = maybe_unserialize($meta['meta_value']);
        // verify password using WP function
        if (! function_exists('wp_check_password')) {
            // fallback - last resort (shouldn't happen)
            $okPw = wp_check_password($password, $hash);
        } else {
            $okPw = wp_check_password($password, $hash);
        }
        if (! $okPw) {
            set_transient($attempt_key, $attempts + 1, 15 * MINUTE_IN_SECONDS);
            return new WP_Error('invalid_credentials','Invalid phone or password', ['status'=>401]);
        }

        // success -> clear attempt counter
        delete_transient($attempt_key);

        // create plugin session token mapping token -> teacher_id (transient)
        $token = wp_generate_uuid4();
        $sess_key = 'rad_session_' . $token;
        // store array with id, role, name
        $sess_data = [
            'teacher_id' => $teacher_id,
            'created_at' => current_time('mysql'),
            'expires' => time() + (2 * HOUR_IN_SECONDS)
        ];
        // 2 HOUR lifetime transient
        set_transient($sess_key, $sess_data, 2 * HOUR_IN_SECONDS);

        // set cookie rad_session
        $cookie_name = 'rad_session';
        $cookie_value = $token;
        $expire = time() + (2 * HOUR_IN_SECONDS);
        $secure = is_ssl();
        // set cookie path on site root; HttpOnly
        setcookie($cookie_name, $cookie_value, $expire, COOKIEPATH ?: '/', COOKIE_DOMAIN ?: '', $secure, true);

        // Calculate friendly name/role
        $name = isset($row['name']) ? $row['name'] : '';
        $role = isset($row['role']) ? $row['role'] : 'Staff';

        // Redirect to frontend dashboard (rad-dashboard page)
        $redirect_to = home_url('/rad-dashboard/');

        return rest_ensure_response([
            'ok' => true,
            'token' => $token,
            'expires' => $sess_data['expires'],
            'teacher_id' => $teacher_id,
            'name' => $name,
            'role' => $role,
            'redirect_to' => $redirect_to
        ]);
    }

    /**
     * POST /auth/logout
     * body: { }  - removes session cookie & transient
     */
    public static function do_logout($req){
        // read cookie
        $cookie = isset($_COOKIE['rad_session']) ? sanitize_text_field($_COOKIE['rad_session']) : '';
        if ($cookie) {
            $sess_key = 'rad_session_' . $cookie;
            delete_transient($sess_key);
            // expire cookie
            setcookie('rad_session', '', time() - HOUR_IN_SECONDS, COOKIEPATH ?: '/', COOKIE_DOMAIN ?: '', is_ssl(), true);
        }
        return rest_ensure_response(['ok'=>true]);
    }

    // helper: validate session token and return session data or false
    public static function get_session_by_token($token){
        if (! $token) return false;
        $sess_key = 'rad_session_' . $token;
        $data = get_transient($sess_key);
        if (! $data) return false;
        if (isset($data['expires']) && time() > intval($data['expires'])) {
            delete_transient($sess_key);
            return false;
        }
        return $data;
    }
}

RAD_Auth_Module::init();
