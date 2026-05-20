<?php
// modules/rooms/rooms.php
if (! defined('ABSPATH')) exit;

class RAD_Rooms_Module {
    public static function init(){
        add_action('init', [__CLASS__, 'ensure_table']);
        add_action('rest_api_init', [__CLASS__, 'register_routes']);
        add_action('admin_enqueue_scripts', [__CLASS__, 'enqueue_assets']);
    }

    /**
     * Ensure rad_rooms table exists and has expected columns.
     * This makes module backward-compatible with older DB schemas.
     */
    public static function ensure_table(){
        global $wpdb;
        $table = $wpdb->prefix . 'rad_rooms';
        $charset_collate = $wpdb->get_charset_collate();

        $exists = $wpdb->get_var( $wpdb->prepare("SHOW TABLES LIKE %s", $table) );
        if ($exists !== $table) {
            // create with recommended schema
            $sql = "CREATE TABLE {$table} (
                id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
                room_no VARCHAR(120) NOT NULL,
                label VARCHAR(200) DEFAULT '',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (id)
            ) {$charset_collate};";
            require_once ABSPATH . 'wp-admin/includes/upgrade.php';
            dbDelta($sql);
            return;
        }

        // if table exists, ensure essential columns exist (best-effort)
        $cols = $wpdb->get_results("SHOW COLUMNS FROM {$table}", ARRAY_A);
        $fields = array_map(function($c){ return $c['Field']; }, $cols);
        $alter = [];
        if (!in_array('room_no', $fields)) $alter[] = "ADD COLUMN room_no VARCHAR(120) NOT NULL";
        if (!in_array('label', $fields)) $alter[] = "ADD COLUMN label VARCHAR(200) DEFAULT ''";
        if (!in_array('created_at', $fields)) $alter[] = "ADD COLUMN created_at DATETIME DEFAULT CURRENT_TIMESTAMP";
        if (!empty($alter)) {
            $sql = "ALTER TABLE {$table} " . implode(', ', $alter);
            $wpdb->query($sql);
        }
    }

    public static function register_routes(){
        register_rest_route('rad/v2','/rooms', [
            [
                'methods' => 'GET',
                'callback' => [__CLASS__, 'get_rooms'],
                'permission_callback' => function(){ return current_user_can('read'); }
            ],
            [
                'methods' => 'POST',
                'callback' => [__CLASS__, 'create_room'],
                'permission_callback' => function(){ return current_user_can('read'); }
            ],
        ]);

        register_rest_route('rad/v2','/rooms/(?P<id>\d+)', [
            [
                'methods' => 'PUT',
                'callback' => [__CLASS__, 'update_room'],
                'permission_callback' => function(){ return current_user_can('read'); }
            ],
            [
                'methods' => 'DELETE',
                'callback' => [__CLASS__, 'delete_room'],
                'permission_callback' => function(){ return current_user_can('read'); }
            ]
        ]);

        // ping endpoint (optional quick check)
        register_rest_route('rad/v2','/rooms/ping', [
            'methods' => 'GET',
            'callback' => function(){ return rest_ensure_response(['ok'=>true,'msg'=>'rooms ok']); },
            'permission_callback' => function(){ return true; }
        ]);
    }

    /**
     * Returns rooms with device_id and classroom where possible.
     *
     * Strategy:
     * 1) LEFT JOIN rad_classrooms on room_no (primary source for device/classroom)
     * 2) If device_id still empty, try mapping from rad_devices by room_no (fallback)
     */
    public static function get_rooms($req){
        global $wpdb;

        $rooms_table = $wpdb->prefix . 'rad_rooms';
        $class_table = $wpdb->prefix . 'rad_classrooms';
        $devices_table = $wpdb->prefix . 'rad_devices';

        // If rooms table missing, return empty rows
        $exists = $wpdb->get_var( $wpdb->prepare("SHOW TABLES LIKE %s", $rooms_table) );
        if ($exists !== $rooms_table) {
            return rest_ensure_response(['ok'=>true,'rows'=>[]]);
        }

        // Primary query: left join classrooms to pull device_id & classroom
        $sql = "
            SELECT
                r.id AS id,
                COALESCE(r.room_no, '') AS room_no,
                COALESCE(r.label, '') AS label,
                COALESCE(c.device_id, '') AS device_id,
                COALESCE(c.classroom, '') AS classroom
            FROM {$rooms_table} AS r
            LEFT JOIN {$class_table} AS c
                ON (TRIM(c.room_no) <> '' AND TRIM(c.room_no) = TRIM(r.room_no))
            ORDER BY r.id DESC
        ";

        $rows = $wpdb->get_results($sql, ARRAY_A);
        if (!is_array($rows)) $rows = [];

        // fallback lookup from devices table if needed
        $needs_lookup = false;
        foreach ($rows as $row) {
            if (empty($row['device_id'])) { $needs_lookup = true; break; }
        }

        if ($needs_lookup) {
            $dev_map = [];
            $dev_exists = $wpdb->get_var( $wpdb->prepare("SHOW TABLES LIKE %s", $devices_table) );
            if ($dev_exists === $devices_table) {
                $devs = $wpdb->get_results("SELECT device_id, classroom, room_no FROM {$devices_table}", ARRAY_A);
                foreach ($devs as $d) {
                    $k = trim($d['room_no']);
                    if ($k === '') continue;
                    $dev_map[$k] = [
                        'device_id' => isset($d['device_id']) ? $d['device_id'] : '',
                        'classroom' => isset($d['classroom']) ? $d['classroom'] : ''
                    ];
                }
            }

            foreach ($rows as &$r) {
                if (empty($r['device_id'])) {
                    $k = trim($r['room_no']);
                    if ($k !== '' && isset($dev_map[$k])) {
                        if (empty($r['device_id'])) $r['device_id'] = $dev_map[$k]['device_id'];
                        if (empty($r['classroom'])) $r['classroom'] = $dev_map[$k]['classroom'];
                    }
                }
            }
            unset($r);
        }

        return rest_ensure_response(['ok'=>true,'rows'=>$rows]);
    }

    /**
     * Create a room — but build INSERT dynamically based on existing columns, to avoid errors
     * on older schemas that might lack 'label' etc.
     */
    public static function create_room($req){
        global $wpdb;
        $params = $req->get_json_params();
        if (!is_array($params)) return new WP_Error('invalid_json','Invalid JSON body', ['status'=>400]);

        $room_no = isset($params['room_no']) ? sanitize_text_field($params['room_no']) : '';
        $label = isset($params['label']) ? sanitize_text_field($params['label']) : '';

        if (empty($room_no)) return new WP_Error('missing_field','Room No required', ['status'=>400]);

        $table = $wpdb->prefix . 'rad_rooms';

        // determine available columns
        $cols = $wpdb->get_results("SHOW COLUMNS FROM {$table}", ARRAY_A);
        $fields = array_map(function($c){ return $c['Field']; }, $cols);

        // prepare insert array only for columns that exist
        $insert = [];
        $format = [];
        if (in_array('room_no', $fields)) { $insert['room_no'] = $room_no; $format[] = '%s'; }
        if (in_array('label', $fields)) { $insert['label'] = $label; $format[] = '%s'; }
        if (in_array('created_at', $fields) && !isset($insert['created_at'])) { $insert['created_at'] = current_time('mysql'); $format[] = '%s'; }

        // final safety: if room_no column not present, error
        if (!in_array('room_no', $fields)) return new WP_Error('schema_missing','room_no column missing in DB', ['status'=>500]);

        $inserted = $wpdb->insert($table, $insert, $format);

        if ($inserted === false) {
            return new WP_Error('db_error','Unable to create room', ['status'=>500,'db_error'=>$wpdb->last_error]);
        }

        return rest_ensure_response(['ok'=>true,'room_id'=>$wpdb->insert_id]);
    }

    public static function update_room($req){
        global $wpdb;
        $id = intval($req->get_param('id'));
        $params = $req->get_json_params();
        if ($id <= 0 || !is_array($params)) return new WP_Error('invalid','Invalid data', ['status'=>400]);

        $table = $wpdb->prefix . 'rad_rooms';
        $cols = $wpdb->get_results("SHOW COLUMNS FROM {$table}", ARRAY_A);
        $fields = array_map(function($c){ return $c['Field']; }, $cols);

        $data = [];
        $format = [];
        if (isset($params['room_no']) && in_array('room_no', $fields)) { $data['room_no'] = sanitize_text_field($params['room_no']); $format[] = '%s'; }
        if (isset($params['label']) && in_array('label', $fields)) { $data['label'] = sanitize_text_field($params['label']); $format[] = '%s'; }

        if (empty($data)) return new WP_Error('no_fields','No fields to update', ['status'=>400]);

        $updated = $wpdb->update($table, $data, ['id'=>$id], $format, ['%d']);
        if ($updated === false) return new WP_Error('db_error','Unable to update room', ['status'=>500,'db_error'=>$wpdb->last_error]);

        return rest_ensure_response(['ok'=>true,'updated_id'=>$id]);
    }

    public static function delete_room($req){
        global $wpdb;
        $id = intval($req->get_param('id'));
        if ($id <= 0) return new WP_Error('invalid_id','Invalid id', ['status'=>400]);

        $table = $wpdb->prefix . 'rad_rooms';
        $wpdb->delete($table, ['id'=>$id], ['%d']);
        return rest_ensure_response(['ok'=>true,'deleted_id'=>$id]);
    }

    public static function enqueue_assets($hook){
        if ($hook !== 'toplevel_page_rad-dashboard') return;
        $base = RAD_PLUGIN_URL . 'modules/rooms/';
        wp_register_script('rad-rooms-js', $base . 'admin.js', [], '1.0', true);
        wp_register_style('rad-rooms-css', $base . 'admin.css', [], '1.0');
        wp_enqueue_script('rad-rooms-js');
        wp_enqueue_style('rad-rooms-css');
    }
}

RAD_Rooms_Module::init();
