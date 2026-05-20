<?php
// modules/classrooms/classrooms.php
if (! defined('ABSPATH')) exit;

class RAD_Classrooms_Module {
    public static function init(){
        add_action('init', [__CLASS__, 'ensure_table']);
        add_action('rest_api_init', [__CLASS__, 'register_routes']);
        add_action('admin_enqueue_scripts', [__CLASS__, 'enqueue_assets']);
    }

    public static function ensure_table(){
        global $wpdb;
        $table = $wpdb->prefix . 'rad_classrooms';
        $charset_collate = $wpdb->get_charset_collate();

        $exists = $wpdb->get_var( $wpdb->prepare("SHOW TABLES LIKE %s", $table) );
        if ($exists !== $table) {
            $sql = "CREATE TABLE {$table} (
                id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
                classroom VARCHAR(120) NOT NULL,
                department VARCHAR(120) DEFAULT '',
                room_no VARCHAR(60) DEFAULT '',
                device_id VARCHAR(120) DEFAULT '',
                device_name VARCHAR(200) DEFAULT '',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (id),
                UNIQUE KEY classroom_unique (classroom)
            ) {$charset_collate};";
            require_once ABSPATH . 'wp-admin/includes/upgrade.php';
            dbDelta($sql);
        } else {
            // best-effort: add missing columns
            $cols = $wpdb->get_results("SHOW COLUMNS FROM {$table}", ARRAY_A);
            $fields = array_map(function($c){ return $c['Field']; }, $cols);
            $to_add = [];
            if (!in_array('department', $fields)) $to_add[] = "ADD COLUMN department VARCHAR(120) DEFAULT ''";
            if (!in_array('room_no', $fields)) $to_add[] = "ADD COLUMN room_no VARCHAR(60) DEFAULT ''";
            if (!in_array('device_id', $fields)) $to_add[] = "ADD COLUMN device_id VARCHAR(120) DEFAULT ''";
            if (!in_array('device_name', $fields)) $to_add[] = "ADD COLUMN device_name VARCHAR(200) DEFAULT ''";
            if (!empty($to_add)) {
                $sql = "ALTER TABLE {$table} " . implode(', ', $to_add);
                $wpdb->query($sql);
            }
        }
    }

    public static function register_routes(){
        register_rest_route('rad/v2','/classrooms', [
            [
                'methods' => 'GET',
                'callback' => [__CLASS__, 'get_classrooms'],
                'permission_callback' => function(){ return current_user_can('read'); }
            ],
            [
                'methods' => 'POST',
                'callback' => [__CLASS__, 'create_classroom'],
                'permission_callback' => function(){ return current_user_can('read'); }
            ],
        ]);

        register_rest_route('rad/v2','/classrooms/(?P<id>\d+)', [
            [
                'methods' => 'PUT',
                'callback' => [__CLASS__, 'update_classroom'],
                'permission_callback' => function(){ return current_user_can('read'); }
            ],
            [
                'methods' => 'DELETE',
                'callback' => [__CLASS__, 'delete_classroom'],
                'permission_callback' => function(){ return current_user_can('read'); }
            ]
        ]);

        // departments endpoint: gather distinct department values from members (teachers) table(s)
        register_rest_route('rad/v2','/departments', [
            'methods' => 'GET',
            'callback' => [__CLASS__, 'get_departments'],
            'permission_callback' => function(){ return current_user_can('read'); }
        ]);
    }

    public static function get_classrooms($req){
        global $wpdb;
        $table = $wpdb->prefix . 'rad_classrooms';
        $exists = $wpdb->get_var( $wpdb->prepare("SHOW TABLES LIKE %s", $table) );
        if ($exists !== $table) return rest_ensure_response(['ok'=>true,'rows'=>[]]);

        $rows = $wpdb->get_results("SELECT * FROM {$table} ORDER BY id DESC", ARRAY_A);
        if (!is_array($rows)) $rows = [];
        return rest_ensure_response(['ok'=>true,'rows'=>$rows]);
    }

    public static function create_classroom($req){
        global $wpdb;
        $params = $req->get_json_params();
        if (!is_array($params)) return new WP_Error('invalid_json','Invalid JSON body', ['status'=>400]);

        $classroom = isset($params['classroom']) ? sanitize_text_field($params['classroom']) : '';
        $department = isset($params['department']) ? sanitize_text_field($params['department']) : '';
        $room_no = isset($params['room_no']) ? sanitize_text_field($params['room_no']) : '';
        $device_id = isset($params['device_id']) ? sanitize_text_field($params['device_id']) : '';
        $device_name = isset($params['device_name']) ? sanitize_text_field($params['device_name']) : '';

        if (empty($classroom)) return new WP_Error('missing_classroom','Classroom required', ['status'=>400]);

        $table = $wpdb->prefix . 'rad_classrooms';
        $existing = $wpdb->get_var($wpdb->prepare("SELECT id FROM {$table} WHERE classroom=%s LIMIT 1", $classroom));
        if ($existing) return new WP_Error('exists','Classroom already exists', ['status'=>409,'existing_id'=>intval($existing)]);

        // ensure device not already assigned
        if (!empty($device_id)) {
            $used = $wpdb->get_var($wpdb->prepare("SELECT id FROM {$table} WHERE device_id=%s LIMIT 1", $device_id));
            if ($used) return new WP_Error('device_used','Device already assigned to another classroom', ['status'=>409]);
        }

        $inserted = $wpdb->insert($table, [
            'classroom' => $classroom,
            'department' => $department,
            'room_no' => $room_no,
            'device_id' => $device_id,
            'device_name' => $device_name,
            'created_at' => current_time('mysql')
        ], ['%s','%s','%s','%s','%s','%s']);

        if ($inserted === false) {
            return new WP_Error('db_error','Unable to create classroom', ['status'=>500,'db_error'=>$wpdb->last_error]);
        }

        return rest_ensure_response(['ok'=>true,'classroom_id'=>$wpdb->insert_id]);
    }

    public static function update_classroom($req){
        global $wpdb;
        $id = intval($req->get_param('id'));
        $params = $req->get_json_params();
        if ($id <= 0 || !is_array($params)) return new WP_Error('invalid','Invalid data', ['status'=>400]);

        $classroom = isset($params['classroom']) ? sanitize_text_field($params['classroom']) : '';
        $department = isset($params['department']) ? sanitize_text_field($params['department']) : '';
        $room_no = isset($params['room_no']) ? sanitize_text_field($params['room_no']) : '';
        $device_id = isset($params['device_id']) ? sanitize_text_field($params['device_id']) : '';
        $device_name = isset($params['device_name']) ? sanitize_text_field($params['device_name']) : '';

        $table = $wpdb->prefix . 'rad_classrooms';
        $exists = $wpdb->get_var($wpdb->prepare("SELECT COUNT(*) FROM {$table} WHERE id=%d", $id));
        if (!$exists) return new WP_Error('not_found','Not found', ['status'=>404]);

        // ensure device not used by other
        if (!empty($device_id)) {
            $used = $wpdb->get_var($wpdb->prepare("SELECT id FROM {$table} WHERE device_id=%s AND id != %d LIMIT 1", $device_id, $id));
            if ($used) return new WP_Error('device_used','Device already assigned to another classroom', ['status'=>409]);
        }

        $updated = $wpdb->update($table, [
            'classroom' => $classroom,
            'department' => $department,
            'room_no' => $room_no,
            'device_id' => $device_id,
            'device_name' => $device_name
        ], ['id' => $id], ['%s','%s','%s','%s','%s'], ['%d']);

        if ($updated === false) return new WP_Error('db_error','Unable to update', ['status'=>500, 'db_error'=>$wpdb->last_error]);

        return rest_ensure_response(['ok'=>true,'updated_id'=>$id]);
    }

    public static function delete_classroom($req){
        global $wpdb;
        $id = intval($req->get_param('id'));
        if ($id <= 0) return new WP_Error('invalid_id','Invalid id', ['status'=>400]);

        $table = $wpdb->prefix . 'rad_classrooms';
        $exists = $wpdb->get_var($wpdb->prepare("SELECT COUNT(*) FROM {$table} WHERE id=%d", $id));
        if (!$exists) return new WP_Error('not_found','Not found', ['status'=>404]);

        $wpdb->delete($table, ['id'=>$id], ['%d']);
        return rest_ensure_response(['ok'=>true,'deleted_id'=>$id]);
    }

    /**
     * Return distinct departments gathered from your members (teachers) table.
     * Prioritises the plugin table: {$wpdb->prefix}rad_teachers
     * Falls back to a few other common table names if needed.
     */
    public static function get_departments($req){
        global $wpdb;
        $prefix = $wpdb->prefix;

        $candidates = [];

        // first preference: rad_teachers table (your Members module uses this)
        $teachers_table = $prefix . 'rad_teachers';
        $exists = $wpdb->get_var( $wpdb->prepare("SHOW TABLES LIKE %s", $teachers_table) );
        if ($exists === $teachers_table) {
            // select distinct non-empty departments
            $rows = $wpdb->get_col("SELECT DISTINCT department FROM {$teachers_table} WHERE department IS NOT NULL AND TRIM(department) != ''");
            if (!empty($rows)) $candidates = array_merge($candidates, $rows);
        }

        // additional fallback tables (if your site used a different table)
        $other_tables = [
            $prefix . 'rad_members',
            $prefix . 'members',
            $prefix . 'wpey_rad_members',
            $prefix . 'wp_rad_members'
        ];
        foreach ($other_tables as $t) {
            $exists = $wpdb->get_var( $wpdb->prepare("SHOW TABLES LIKE %s", $t) );
            if ($exists === $t) {
                // check if column 'department' exists
                $cols = $wpdb->get_results("SHOW COLUMNS FROM {$t}", ARRAY_A);
                $colnames = array_map(function($c){ return $c['Field']; }, $cols);
                if (in_array('department', $colnames)) {
                    $rows = $wpdb->get_col("SELECT DISTINCT department FROM {$t} WHERE department IS NOT NULL AND TRIM(department) != ''");
                    if (!empty($rows)) $candidates = array_merge($candidates, $rows);
                } elseif (in_array('dept', $colnames)) {
                    $rows = $wpdb->get_col("SELECT DISTINCT dept FROM {$t} WHERE dept IS NOT NULL AND TRIM(dept) != ''");
                    if (!empty($rows)) $candidates = array_merge($candidates, $rows);
                }
            }
        }

        // sanitize, unique, trim and sort
        $candidates = array_filter(array_map('trim', $candidates), function($v){ return $v !== ''; });
        $candidates = array_values(array_unique($candidates));
        sort($candidates, SORT_STRING | SORT_FLAG_CASE);

        return rest_ensure_response(['ok'=>true,'rows'=>$candidates]);
    }

    public static function enqueue_assets($hook){
        if ($hook !== 'toplevel_page_rad-dashboard') return;
        $base = RAD_PLUGIN_URL . 'modules/classrooms/';
        wp_register_script('rad-classrooms-js', $base . 'admin.js', [], '1.0', true);
        wp_register_style('rad-classrooms-css', $base . 'admin.css', [], '1.0');
        wp_enqueue_script('rad-classrooms-js');
        wp_enqueue_style('rad-classrooms-css');
    }
}

RAD_Classrooms_Module::init();
