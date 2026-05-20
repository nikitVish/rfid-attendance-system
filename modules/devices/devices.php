<?php
// modules/devices/devices.php
if (! defined('ABSPATH')) exit;

class RAD_Devices_Module {
    public static function init(){
        add_action('init', [__CLASS__, 'ensure_table']);
        add_action('rest_api_init', [__CLASS__, 'register_routes']);
        add_action('admin_enqueue_scripts', [__CLASS__, 'enqueue_assets']);

        // After REST responses, check if classrooms/rooms/devices endpoints were touched — if yes, resync
        add_filter('rest_post_dispatch', [__CLASS__, 'maybe_sync_after_rest'], 10, 3);
    }

    public static function ensure_table(){
        global $wpdb;
        $table = $wpdb->prefix . 'rad_devices';
        $charset_collate = $wpdb->get_charset_collate();

        $exists = $wpdb->get_var( $wpdb->prepare("SHOW TABLES LIKE %s", $table) );
        if ($exists !== $table) {
            $sql = "CREATE TABLE {$table} (
                id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
                device_id VARCHAR(120) NOT NULL,
                label VARCHAR(200) DEFAULT '',
                classroom VARCHAR(120) DEFAULT '',
                room_no VARCHAR(60) DEFAULT '',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (id),
                UNIQUE KEY device_id_unique (device_id)
            ) {$charset_collate};";
            require_once ABSPATH . 'wp-admin/includes/upgrade.php';
            dbDelta($sql);
        } else {
            // ensure essential columns exist (best-effort)
            $cols = $wpdb->get_results("SHOW COLUMNS FROM {$table}", ARRAY_A);
            $fields = array_map(function($c){ return $c['Field']; }, $cols);
            $to_add = [];
            if (!in_array('device_id', $fields)) $to_add[] = "ADD COLUMN device_id VARCHAR(120) NOT NULL";
            if (!in_array('label', $fields)) $to_add[] = "ADD COLUMN label VARCHAR(200) DEFAULT ''";
            if (!in_array('classroom', $fields)) $to_add[] = "ADD COLUMN classroom VARCHAR(120) DEFAULT ''";
            if (!in_array('room_no', $fields)) $to_add[] = "ADD COLUMN room_no VARCHAR(60) DEFAULT ''";
            if (!empty($to_add)) {
                $sql = "ALTER TABLE {$table} " . implode(', ', $to_add);
                $wpdb->query($sql);
            }
        }
    }

    public static function register_routes(){
        register_rest_route('rad/v2','/devices', [
            [
                'methods' => 'GET',
                'callback' => [__CLASS__, 'get_devices'],
                'permission_callback' => function(){ return current_user_can('read'); }
            ],
            [
                'methods' => 'POST',
                'callback' => [__CLASS__, 'create_device'],
                'permission_callback' => function(){ return current_user_can('read'); }
            ],
        ]);

        register_rest_route('rad/v2','/devices/(?P<id>\d+)', [
            [
                'methods' => 'PUT',
                'callback' => [__CLASS__, 'update_device'],
                'permission_callback' => function(){ return current_user_can('read'); }
            ],
            [
                'methods' => 'DELETE',
                'callback' => [__CLASS__, 'delete_device'],
                'permission_callback' => function(){ return current_user_can('read'); }
            ]
        ]);

        register_rest_route('rad/v2','/devices/sync-locations', [
            'methods' => 'POST',
            'callback' => [__CLASS__, 'sync_locations_endpoint'],
            'permission_callback' => function(){ return current_user_can('read'); }
        ]);
    }

    public static function get_devices($req){
        global $wpdb;
        $table = $wpdb->prefix . 'rad_devices';
        $exists = $wpdb->get_var( $wpdb->prepare("SHOW TABLES LIKE %s", $table) );
        if ($exists !== $table) return rest_ensure_response(['ok'=>true,'rows'=>[]]);

        $rows = $wpdb->get_results("SELECT * FROM {$table} ORDER BY id DESC", ARRAY_A);
        if (!is_array($rows)) $rows = [];
        return rest_ensure_response(['ok'=>true,'rows'=>$rows]);
    }

    public static function create_device($req){
        global $wpdb;
        $params = $req->get_json_params();
        if (!is_array($params)) return new WP_Error('invalid_json','Invalid JSON body', ['status'=>400]);

        $device_id = isset($params['device_id']) ? sanitize_text_field($params['device_id']) : '';
        // device name comes in param 'device_name' from UI; we store in 'label' column for compatibility
        $device_name = isset($params['device_name']) ? sanitize_text_field($params['device_name']) : '';

        if (empty($device_id)) return new WP_Error('missing_device','Device ID required', ['status'=>400]);

        $table = $wpdb->prefix . 'rad_devices';
        $existing = $wpdb->get_var($wpdb->prepare("SELECT id FROM {$table} WHERE device_id=%s LIMIT 1", $device_id));
        if ($existing) return new WP_Error('exists','Device ID already exists', ['status'=>409,'existing_id'=>intval($existing)]);

        $inserted = $wpdb->insert($table, [
            'device_id' => $device_id,
            'label' => $device_name,
            'created_at' => current_time('mysql')
        ], ['%s','%s','%s']);

        if ($inserted === false) {
            return new WP_Error('db_error','Unable to create device', ['status'=>500,'db_error'=>$wpdb->last_error]);
        }

        // run sync to pick up classroom/room from classrooms table
        self::sync_locations();

        return rest_ensure_response(['ok'=>true,'device_id'=>$wpdb->insert_id]);
    }

    public static function update_device($req){
        global $wpdb;
        $id = intval($req->get_param('id'));
        $params = $req->get_json_params();
        if ($id <= 0 || !is_array($params)) return new WP_Error('invalid','Invalid data', ['status'=>400]);

        $device_id = isset($params['device_id']) ? sanitize_text_field($params['device_id']) : '';
        $device_name = isset($params['device_name']) ? sanitize_text_field($params['device_name']) : '';

        $table = $wpdb->prefix . 'rad_devices';
        $exists = $wpdb->get_var($wpdb->prepare("SELECT COUNT(*) FROM {$table} WHERE id=%d", $id));
        if (!$exists) return new WP_Error('not_found','Not found', ['status'=>404]);

        if (!empty($device_id)) {
            $used = $wpdb->get_var($wpdb->prepare("SELECT id FROM {$table} WHERE device_id=%s AND id != %d LIMIT 1", $device_id, $id));
            if ($used) return new WP_Error('device_used','Device ID already used by another entry', ['status'=>409]);
        }

        $updated = $wpdb->update($table, [
            'device_id' => $device_id,
            'label' => $device_name
        ], ['id' => $id], ['%s','%s'], ['%d']);

        if ($updated === false) return new WP_Error('db_error','Unable to update', ['status'=>500, 'db_error'=>$wpdb->last_error]);

        // sync locations (in case device_id changed)
        self::sync_locations();

        return rest_ensure_response(['ok'=>true,'updated_id'=>$id]);
    }

    public static function delete_device($req){
        global $wpdb;
        $id = intval($req->get_param('id'));
        if ($id <= 0) return new WP_Error('invalid_id','Invalid id', ['status'=>400]);

        $table = $wpdb->prefix . 'rad_devices';
        $exists = $wpdb->get_var($wpdb->prepare("SELECT COUNT(*) FROM {$table} WHERE id=%d", $id));
        if (!$exists) return new WP_Error('not_found','Not found', ['status'=>404]);

        $wpdb->delete($table, ['id'=>$id], ['%d']);
        return rest_ensure_response(['ok'=>true,'deleted_id'=>$id]);
    }

    /**
     * Sync device locations from rad_classrooms:
     * device_id in rad_classrooms -> updates devices.classroom and devices.room_no
     */
    public static function sync_locations(){
        global $wpdb;
        $devices_table = $wpdb->prefix . 'rad_devices';
        $class_table = $wpdb->prefix . 'rad_classrooms';

        $exists = $wpdb->get_var( $wpdb->prepare("SHOW TABLES LIKE %s", $class_table) );
        if ($exists !== $class_table) return false;

        $rows = $wpdb->get_results("SELECT device_id, classroom, room_no FROM {$class_table} WHERE device_id IS NOT NULL AND TRIM(device_id) != ''", ARRAY_A);
        $map = [];
        foreach ($rows as $r) {
            $did = trim($r['device_id']);
            if ($did === '') continue;
            $map[$did] = [
                'classroom' => isset($r['classroom']) ? $r['classroom'] : '',
                'room_no' => isset($r['room_no']) ? $r['room_no'] : ''
            ];
        }

        // update mapped devices
        foreach ($map as $device_id => $vals) {
            $wpdb->update($devices_table,
                ['classroom' => $vals['classroom'], 'room_no' => $vals['room_no']],
                ['device_id' => $device_id],
                ['%s','%s'],
                ['%s']
            );
        }

        // clear classroom/room_no for devices not present in map
        if (!empty($map)) {
            $device_ids = array_keys($map);
            $placeholders = implode(',', array_fill(0, count($device_ids), '%s'));
            $prepared = $wpdb->prepare("UPDATE {$devices_table} SET classroom = '', room_no = '' WHERE device_id NOT IN ($placeholders)", $device_ids);
            $wpdb->query($prepared);
        } else {
            $wpdb->query("UPDATE {$devices_table} SET classroom = '', room_no = ''");
        }

        return true;
    }

    public static function sync_locations_endpoint($req){
        $ok = self::sync_locations();
        if ($ok) return rest_ensure_response(['ok'=>true,'synced'=>true]);
        return new WP_Error('sync_failed','Sync failed or no classrooms table found', ['status'=>500]);
    }

    public static function enqueue_assets($hook){
        if ($hook !== 'toplevel_page_rad-dashboard') return;
        $base = RAD_PLUGIN_URL . 'modules/devices/';
        wp_register_script('rad-devices-js', $base . 'admin.js', [], '1.0', true);
        wp_register_style('rad-devices-css', $base . 'admin.css', [], '1.0');
        wp_enqueue_script('rad-devices-js');
        wp_enqueue_style('rad-devices-css');

        // one-time PHP sync on admin page render
        add_action('admin_footer', function(){
            RAD_Devices_Module::sync_locations();
        });
    }

    /**
     * Filter that runs after every REST response dispatch.
     * If the route looks like it changed classrooms/rooms/devices, run sync.
     */
    public static function maybe_sync_after_rest($result, $server, $request) {
        // $request may be WP_REST_Request object
        if (! $request instanceof WP_REST_Request) return $result;

        $route = $request->get_route(); // e.g. /wp-json/rad/v2/classrooms/123
        if (! $route) return $result;

        // If API touched classrooms/rooms/devices, trigger sync (covers create/update/delete)
        if (preg_match('#/rad/v[0-9]+/(classrooms|rooms|devices)(/|$)#', $route)) {
            // best-effort: run sync in background
            try {
                self::sync_locations();
            } catch (Exception $e) {
                if (defined('WP_DEBUG') && WP_DEBUG) error_log('RAD Devices sync failed after REST: ' . $e->getMessage());
            }
        }

        return $result;
    }
}

RAD_Devices_Module::init();
