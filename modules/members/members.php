<?php
// modules/members/members.php
if (! defined('ABSPATH')) exit;

class RAD_Members_Module {
    public static function init(){
        add_action('rest_api_init', [__CLASS__, 'register_routes']);
        add_action('admin_enqueue_scripts', [__CLASS__, 'enqueue_assets']);
    }

    public static function register_routes(){
        // List & Create
        register_rest_route('rad/v2', '/teachers', [
            [
                'methods' => 'GET',
                'callback' => [__CLASS__, 'get_teachers'],
                'permission_callback' => function(){ return current_user_can('read'); }
            ],
            [
                'methods' => 'POST',
                'callback' => [__CLASS__, 'add_teacher'],
                'permission_callback' => function(){ return current_user_can('read'); }
            ]
        ]);

        // Update (PUT) and Delete routes for specific teacher id
        register_rest_route('rad/v2', '/teachers/(?P<id>\d+)', [
            [
                'methods' => 'PUT',
                'callback' => [__CLASS__, 'update_teacher'],
                'permission_callback' => function(){ return current_user_can('read'); }
            ],
            [
                'methods' => 'DELETE',
                'callback' => [__CLASS__, 'delete_teacher'],
                'permission_callback' => function(){ return current_user_can('read'); }
            ]
        ]);
    }

    /* -------------------------
       GET: list teachers
       ------------------------- */
    public static function get_teachers($req){
        global $wpdb;
        $rows = $wpdb->get_results("SELECT * FROM {$wpdb->prefix}rad_teachers ORDER BY id DESC LIMIT 1000", ARRAY_A);
        foreach ($rows as &$r) {
            $r['meta'] = self::get_meta('teachers', $r['id']);
            // ensure uid and password_hash are returned in meta in usable form (don't reveal plain password)
            if (isset($r['meta']['password_hash'])) {
                // keep hash if needed; optionally remove for security:
                // unset($r['meta']['password_hash']);
            }
        }
        return rest_ensure_response(['ok'=>true,'rows'=>$rows]);
    }

    /* -------------------------
       POST: create teacher
       ------------------------- */
    public static function add_teacher($req){
        global $wpdb;

        $params = $req->get_json_params();
        if (!is_array($params)) return new WP_Error('invalid_json','Invalid or missing JSON body', array('status'=>400));

        $name = isset($params['name']) ? sanitize_text_field($params['name']) : '';
        $department = isset($params['department']) ? sanitize_text_field($params['department']) : '';
        $phone = isset($params['phone']) ? sanitize_text_field($params['phone']) : '';
        $role = isset($params['role']) ? sanitize_text_field($params['role']) : 'Staff';
        $uid = isset($params['uid']) ? sanitize_text_field($params['uid']) : '';
        $password = isset($params['password']) ? $params['password'] : '';

        if (empty($name)) return new WP_Error('missing_field','Name is required', array('status'=>400));
        if (empty($department)) return new WP_Error('missing_field','Department is required', array('status'=>400));
        if (empty($phone) || !preg_match('/^[0-9]{6,15}$/', $phone)) return new WP_Error('invalid_phone','Phone is required and must be numeric (6-15 digits)', array('status'=>400));
        if (!in_array($role, array('Staff','Manager','Admin'))) return new WP_Error('invalid_role','Invalid role', array('status'=>400));
        if (empty($uid)) return new WP_Error('missing_uid','RFID UUID is required', array('status'=>400));
        if (empty($password) || strlen($password) < 4) return new WP_Error('invalid_password','Password is required (min 4 chars)', array('status'=>400));

        // check uid uniqueness (match both serialized and non-serialized stored values)
        $table = $wpdb->prefix . 'rad_entity_meta';
        $serialized = maybe_serialize($uid);
        $plain = $uid;

        $sql = "
            SELECT entity_id FROM {$table}
            WHERE entity_type = %s
              AND field_key = %s
              AND ( meta_value = %s OR meta_value = %s )
            LIMIT 1
        ";
        $exist = $wpdb->get_row( $wpdb->prepare($sql, 'teachers', 'uid', $serialized, $plain), ARRAY_A );
        if ($exist) return new WP_Error('uid_exists','This UID is already assigned to another teacher', array('status'=>409));

        $inserted = $wpdb->insert($wpdb->prefix . 'rad_teachers', array(
            'name' => $name,
            'phone' => $phone,
            'email' => '',
            'role' => $role,
            'department' => $department,
            'created_at' => current_time('mysql')
        ));
        $tid = $wpdb->insert_id;
        if (! $tid) return new WP_Error('db_error','Unable to create teacher', array('status'=>500));

        // insert meta rows (uid + password_hash) via robust upsert (keeps single row)
        self::upsert_meta('teachers', $tid, 'uid', $uid);
        $hash = wp_hash_password($password);
        self::upsert_meta('teachers', $tid, 'password_hash', $hash);

        return rest_ensure_response(array('ok'=>true,'teacher_id'=>$tid));
    }

    /* -------------------------
       PUT: update a teacher
       ------------------------- */
    public static function update_teacher($req){
        global $wpdb;
        $id = intval($req->get_param('id'));
        if ($id <= 0) return new WP_Error('invalid_id','Invalid teacher id', array('status'=>400));

        $params = $req->get_json_params();
        if (!is_array($params)) return new WP_Error('invalid_json','Invalid or missing JSON body', array('status'=>400));

        // allowed fields to update
        $allowed = ['name','department','phone','role','uid','password'];
        $data = [];
        foreach ($allowed as $k) {
            if (isset($params[$k])) {
                if ($k === 'phone') $data[$k] = sanitize_text_field($params[$k]);
                else if ($k === 'role') $data[$k] = sanitize_text_field($params[$k]);
                else $data[$k] = sanitize_text_field($params[$k]);
            }
        }
        if (empty($data)) return new WP_Error('no_fields','No updatable fields provided', array('status'=>400));

        // check record exists
        $exists = $wpdb->get_var($wpdb->prepare("SELECT COUNT(*) FROM {$wpdb->prefix}rad_teachers WHERE id=%d", $id));
        if (! $exists) return new WP_Error('not_found','Teacher not found', array('status'=>404));

        // update main table fields (name, department, phone, role)
        $update_fields = [];
        $update_values = [];
        if (isset($data['name'])) { $update_fields[] = 'name=%s'; $update_values[] = $data['name']; }
        if (isset($data['department'])) { $update_fields[] = 'department=%s'; $update_values[] = $data['department']; }
        if (isset($data['phone'])) { $update_fields[] = 'phone=%s'; $update_values[] = $data['phone']; }
        if (isset($data['role']) && in_array($data['role'], array('Staff','Manager','Admin'))) { $update_fields[] = 'role=%s'; $update_values[] = $data['role']; }

        if (! empty($update_fields)) {
            $sql = "UPDATE {$wpdb->prefix}rad_teachers SET " . implode(', ', $update_fields) . " WHERE id=%d";
            $update_values[] = $id;
            $prepared = $wpdb->prepare($sql, $update_values);
            $res = $wpdb->query($prepared);
            if ($res === false) return new WP_Error('db_error','Unable to update teacher', array('status'=>500));
        }

        // handle uid (meta)
        if (isset($data['uid'])) {
            $new_uid = $data['uid'];
            // ensure uid unique (not used by another teacher) — match both serialized and plain meta_value
            $table = $wpdb->prefix . 'rad_entity_meta';
            $serialized = maybe_serialize($new_uid);
            $plain = $new_uid;

            $sql = "
                SELECT entity_id FROM {$table}
                WHERE entity_type = %s
                  AND field_key = %s
                  AND ( meta_value = %s OR meta_value = %s )
                LIMIT 1
            ";
            $existing = $wpdb->get_row( $wpdb->prepare($sql, 'teachers', 'uid', $serialized, $plain), ARRAY_A );
            if ($existing && intval($existing['entity_id']) !== $id) {
                return new WP_Error('uid_exists','This UID is assigned to another teacher', ['status'=>409]);
            }
            self::upsert_meta('teachers', $id, 'uid', $new_uid);
        }

        // handle password update (store hash)
        if (isset($data['password'])) {
            $pw = $params['password'];
            if ($pw && strlen($pw) >= 4) {
                $hash = wp_hash_password($pw);
                self::upsert_meta('teachers', $id, 'password_hash', $hash);
            } else {
                return new WP_Error('invalid_password','Password must be at least 4 characters', ['status'=>400]);
            }
        }

        return rest_ensure_response(['ok'=>true,'teacher_id'=>$id]);
    }

    /* -------------------------
       DELETE: remove teacher and meta
       ------------------------- */
    public static function delete_teacher($req){
        global $wpdb;
        $id = intval($req->get_param('id'));
        if ($id <= 0) return new WP_Error('invalid_id','Invalid teacher id', array('status'=>400));

        // ensure exists
        $exists = $wpdb->get_var($wpdb->prepare("SELECT COUNT(*) FROM {$wpdb->prefix}rad_teachers WHERE id=%d", $id));
        if (! $exists) return new WP_Error('not_found','Teacher not found', array('status'=>404));

        // delete meta rows then teacher
        $wpdb->delete($wpdb->prefix . 'rad_entity_meta', array('entity_type'=>'teachers','entity_id'=>$id));
        $wpdb->delete($wpdb->prefix . 'rad_teachers', array('id'=>$id));

        return rest_ensure_response(['ok'=>true,'deleted_id'=>$id]);
    }

    /* -------------------------
       Helper: get_meta (returns array of meta keys/values)
       ------------------------- */
    private static function get_meta($entity_type, $entity_id){
        global $wpdb;
        $rows = $wpdb->get_results($wpdb->prepare("SELECT field_key, meta_value FROM {$wpdb->prefix}rad_entity_meta WHERE entity_type=%s AND entity_id=%d", $entity_type, $entity_id), ARRAY_A);
        $out = [];
        foreach ($rows as $r) $out[$r['field_key']] = maybe_unserialize($r['meta_value']);
        return $out;
    }

    /* -------------------------
       Helper: upsert_meta
       - inserts or updates a meta row for the entity (field_key unique per entity)
       - deduplicates extra rows if present (updates first, deletes others)
       ------------------------- */
    private static function upsert_meta($entity_type, $entity_id, $field_key, $meta_value){
        global $wpdb;
        $table = $wpdb->prefix . 'rad_entity_meta';

        // Fetch all matching rows for this entity + field_key
        $rows = $wpdb->get_results(
            $wpdb->prepare(
                "SELECT id, meta_value FROM {$table} WHERE entity_type=%s AND entity_id=%d AND field_key=%s ORDER BY id ASC",
                $entity_type, $entity_id, $field_key
            ),
            ARRAY_A
        );

        $now = current_time('mysql');
        $serialized_value = maybe_serialize($meta_value);

        if ($rows && count($rows) >= 1) {
            // Update the first row (canonical)
            $first = $rows[0];
            $wpdb->update(
                $table,
                array('meta_value' => $serialized_value, 'created_at' => $now),
                array('id' => intval($first['id'])),
                array('%s','%s'),
                array('%d')
            );

            // If there are duplicates (more rows), remove them
            if (count($rows) > 1) {
                $ids_to_delete = [];
                for ($i = 1; $i < count($rows); $i++) {
                    $ids_to_delete[] = intval($rows[$i]['id']);
                }
                // Delete duplicates in one query
                if (!empty($ids_to_delete)) {
                    $placeholders = implode(',', array_fill(0, count($ids_to_delete), '%d'));
                    $sql = "DELETE FROM {$table} WHERE id IN ($placeholders)";
                    $wpdb->query( $wpdb->prepare($sql, $ids_to_delete) );
                }
            }
        } else {
            // No existing row: insert new
            $wpdb->insert(
                $table,
                array(
                    'entity_type' => $entity_type,
                    'entity_id' => $entity_id,
                    'field_key' => $field_key,
                    'meta_value' => $serialized_value,
                    'created_at' => $now
                ),
                array('%s','%d','%s','%s','%s')
            );
        }
    }

    /* -------------------------
       Enqueue module assets (register only)
       ------------------------- */
    public static function enqueue_assets($hook){
        if ($hook !== 'toplevel_page_rad-dashboard') return;
        $base = RAD_PLUGIN_URL . 'modules/members/';
        wp_register_script('rad-members-js', $base.'admin.js', [], '1.1', true);
        wp_register_style('rad-members-css', $base.'admin.css', [], '1.1');
    }
}

RAD_Members_Module::init();
