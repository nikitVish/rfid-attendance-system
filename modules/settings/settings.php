<?php
// modules/settings/settings.php
if (! defined('ABSPATH')) exit;

class RAD_Settings_Module {
    public static function init(){
        add_action('init', [__CLASS__, 'ensure_table']);
        add_action('rest_api_init', [__CLASS__, 'register_routes']);
        add_action('admin_enqueue_scripts', [__CLASS__, 'enqueue_assets']);
    }

    /**
     * Ensure table for storing permissions:
     * columns:
     *  id, role (nullable), user_id (nullable), permission_key, allowed (tinyint), created_at
     */
    public static function ensure_table(){
        global $wpdb;
        $table = $wpdb->prefix . 'rad_permissions';
        $charset_collate = $wpdb->get_charset_collate();

        $exists = $wpdb->get_var( $wpdb->prepare("SHOW TABLES LIKE %s", $table) );
        if ($exists !== $table) {
            $sql = "CREATE TABLE {$table} (
                id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
                role VARCHAR(120) DEFAULT NULL,
                user_id BIGINT DEFAULT NULL,
                permission_key VARCHAR(120) NOT NULL,
                allowed TINYINT(1) DEFAULT 1,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (id),
                KEY role_idx (role),
                KEY user_idx (user_id)
            ) {$charset_collate};";
            require_once ABSPATH . 'wp-admin/includes/upgrade.php';
            dbDelta($sql);
        }
    }

    public static function register_routes(){
        // get list of available permissions (static)
        register_rest_route('rad/v2', '/permissions/keys', [
            'methods' => 'GET',
            'callback' => [__CLASS__, 'get_permission_keys'],
            'permission_callback' => function(){ return self::session_allowed_any() || current_user_can('manage_options'); }
        ]);

        // get permissions for role or user
        register_rest_route('rad/v2', '/permissions', [
            [
                'methods' => 'GET',
                'callback' => [__CLASS__, 'get_permissions'],
                // allow plugin session (role-based) to read permissions or WP admin
                'permission_callback' => function(){ return self::session_allowed_any() || current_user_can('manage_options'); }
            ],
            [
                'methods' => 'PUT',
                'callback' => [__CLASS__, 'save_permissions'],
                // allow WP admin OR plugin-admin (robust check)
                'permission_callback' => function(){ return self::session_allowed_admin_or_wp(); }
            ],
        ]);

        // helper endpoints: list roles and list users (members)
        register_rest_route('rad/v2', '/roles', [
            'methods' => 'GET',
            'callback' => [__CLASS__, 'list_roles'],
            'permission_callback' => function(){ return self::session_allowed_any() || current_user_can('manage_options'); }
        ]);
        register_rest_route('rad/v2', '/admin-users', [
            'methods' => 'GET',
            'callback' => [__CLASS__, 'list_users'],
            'permission_callback' => function(){ return self::session_allowed_any() || current_user_can('manage_options'); }
        ]);
    }

    /** Return static list of permission keys (used for grid) */
    public static function get_permission_keys($req){
        // you can expand the keys here if needed
        $keys = [
            'CreateUser','ReadUser','UpdateUser','DeleteUser',
            'CreateRoom','ReadRoom','UpdateRoom','DeleteRoom',
            'CreateClassroom','ReadClassroom','UpdateClassroom','DeleteClassroom',
            'CreateDevice','ReadDevice','UpdateDevice','DeleteDevice',
            'CreateTimetable','ReadTimetable','UpdateTimetable','DeleteTimetable',
            'CreateLogs','ReadLogs','UpdateLogs','DeleteLogs'
        ];
        return rest_ensure_response(['ok'=>true,'rows'=>$keys]);
    }

    /**
     * GET /permissions?role=ROLE  OR /permissions?user_id=ID
     * returns allowed permission keys
     */
    public static function get_permissions($req){
        global $wpdb;
        $role = $req->get_param('role');
        $user_id = $req->get_param('user_id');

        $table = $wpdb->prefix . 'rad_permissions';

        if ($user_id) {
            $rows = $wpdb->get_col($wpdb->prepare("SELECT permission_key FROM {$table} WHERE user_id=%d AND allowed=1", intval($user_id)));
            if (!is_array($rows)) $rows = [];
            return rest_ensure_response(['ok'=>true,'rows'=>$rows, 'target'=>'user', 'id'=>intval($user_id)]);
        } else if ($role) {
            $rows = $wpdb->get_col($wpdb->prepare("SELECT permission_key FROM {$table} WHERE role=%s AND user_id IS NULL AND allowed=1", sanitize_text_field($role)));
            if (!is_array($rows)) $rows = [];
            return rest_ensure_response(['ok'=>true,'rows'=>$rows, 'target'=>'role', 'role'=>$role]);
        } else {
            // Returning empty if no target specified
            return rest_ensure_response(['ok'=>true,'rows'=>[]]);
        }
    }

    /**
     * PUT /permissions
     * body: { role: 'Manager' } or { user_id: 12 } and permissions: ['ReadUser','ReadRoom'...]
     * This will replace permission entries for that role OR that user.
     */
    public static function save_permissions($req){
        global $wpdb;
        $params = $req->get_json_params();
        if (!is_array($params)) return new WP_Error('invalid_json','Invalid JSON body', ['status'=>400]);

        $role = isset($params['role']) ? sanitize_text_field($params['role']) : null;
        $user_id = isset($params['user_id']) ? intval($params['user_id']) : null;
        $perms = isset($params['permissions']) && is_array($params['permissions']) ? $params['permissions'] : [];

        if (empty($role) && empty($user_id)) return new WP_Error('missing_target','role or user_id required', ['status'=>400]);

        $table = $wpdb->prefix . 'rad_permissions';

        // Delete existing entries for this role OR user
        if ($user_id) {
            $wpdb->delete($table, array('user_id' => $user_id));
        } else {
            // role-level: remove rows where role matches and user_id IS NULL
            $wpdb->query($wpdb->prepare("DELETE FROM {$table} WHERE role=%s AND user_id IS NULL", $role));
        }

        // insert new rows
        $now = current_time('mysql');
        foreach ($perms as $p) {
            $pkey = sanitize_text_field($p);
            $wpdb->insert($table, array(
                'role' => $user_id ? null : $role,
                'user_id' => $user_id ? $user_id : null,
                'permission_key' => $pkey,
                'allowed' => 1,
                'created_at' => $now
            ), array('%s','%d','%s','%d','%s'));
        }

        return rest_ensure_response(['ok'=>true,'saved_for' => ($user_id ? 'user' : 'role'), 'id' => ($user_id ?: $role)]);
    }

    /**
     * List roles available on the site
     */
    public static function list_roles($req){
        if (! function_exists('wp_roles')) return rest_ensure_response(['ok'=>true,'rows'=>[]]);
        $roles_obj = wp_roles();
        $roles = [];
        if ($roles_obj && property_exists($roles_obj, 'roles')) {
            foreach ($roles_obj->roles as $slug => $data) {
                // friendly label
                $label = isset($data['name']) ? $data['name'] : ucfirst($slug);
                $roles[] = ['slug'=>$slug,'label'=>$label];
            }
        }
        // Ensure we include at least Admin/Manager/Staff variants commonly used
        $preferred = ['administrator'=>'Admin','manager'=>'Manager','staff'=>'Staff'];
        foreach ($preferred as $s=>$l) {
            $found = false;
            foreach ($roles as $r) if ($r['slug'] === $s) $found = true;
            if (! $found) $roles[] = ['slug'=>$s,'label'=>$l];
        }
        return rest_ensure_response(['ok'=>true,'rows'=>$roles]);
    }

    /**
     * List plugin members (teachers) for custom dropdown.
     * Returns id + name + phone + role from rad_teachers table.
     */
    public static function list_users($req){
        global $wpdb;
        $table = $wpdb->prefix . 'rad_teachers';
        $rows = $wpdb->get_results("SELECT id, name, phone, role FROM {$table} ORDER BY name ASC LIMIT 1000", ARRAY_A);
        $out = [];
        foreach ($rows as $r) {
            $out[] = ['id'=>intval($r['id']), 'display_name' => ($r['name'] ?: $r['phone']), 'phone' => $r['phone'], 'role' => $r['role']];
        }
        return rest_ensure_response(['ok'=>true, 'rows' => $out]);
    }

    public static function enqueue_assets($hook){
        if ($hook !== 'toplevel_page_rad-dashboard') return;
        $base = RAD_PLUGIN_URL . 'modules/settings/';
        wp_register_script('rad-settings-js', $base . 'admin.js', array(), '1.0', true);
        wp_register_style('rad-settings-css', $base . 'admin.css', array(), '1.0');
        wp_enqueue_script('rad-settings-js');
        wp_enqueue_style('rad-settings-css');
    }

    /* -------------------
       Helper: Check plugin session & role
       ------------------- */
    private static function session_allowed_any(){
        // any logged-in plugin session can call read endpoints
        if (class_exists('RAD_Login_Module') && method_exists('RAD_Login_Module','get_valid_session')) {
            $s = RAD_Login_Module::get_valid_session();
            return ($s !== null);
        }
        return false;
    }

    private static function session_allowed_admin(){
        // only Admin-like plugin users can change/save permissions
        if (class_exists('RAD_Login_Module') && method_exists('RAD_Login_Module','get_valid_session')) {
            $s = RAD_Login_Module::get_valid_session();
            if (!$s) return false;
            $role = isset($s['role']) ? strtolower($s['role']) : '';
            // Accept many variants
            return in_array($role, array_map('strtolower', ['Admin','administrator','Manager']));
        }
        return false;
    }

    private static function session_allowed_admin_or_wp(){
        // Permit if WP user has manage_options OR plugin session is admin
        if (current_user_can('manage_options')) return true;
        if (self::session_allowed_admin()) return true;
        return false;
    }
}

RAD_Settings_Module::init();
