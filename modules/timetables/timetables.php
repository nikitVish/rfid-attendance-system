<?php
/**
 * RAD Timetables — DB-backed (permanent fix)
 *
 * Table: {$wpdb->prefix}rad_timetables
 * Columns:
 *   id (PK), classroom_id (varchar/int as string), day_of_week (tinyint 0=Sun .. 6=Sat),
 *   start_time (time), end_time (time), subject (varchar), teacher_id (int),
 *   meta (longtext, serialized), created_at (datetime)
 *
 * Endpoints:
 *   GET  /rad/v2/timetable                -> raw rows (optional filters)
 *   GET  /rad/v2/timetables/list          -> grouped by classroom_id (for UI grid)
 *   POST /rad/v2/timetables               -> save/replace one classroom’s weekly timetable
 */

if (!defined('ABSPATH')) exit;

class RAD_Timetables_DB {
    public static function init() {
        add_action('rest_api_init', [__CLASS__, 'register_routes']);
        // lightweight guard to ensure table is present
        add_action('plugins_loaded', [__CLASS__, 'maybe_create_table']);
    }

    private static function table() {
        global $wpdb;
        return $wpdb->prefix . 'rad_timetables';
    }

    public static function maybe_create_table() {
        global $wpdb;
        $table   = self::table();
        $charset = $wpdb->get_charset_collate();

        // Keep classroom_id varchar to allow both numeric ids and human labels if needed.
        $sql = "CREATE TABLE IF NOT EXISTS `$table` (
            `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
            `classroom_id` VARCHAR(191) NOT NULL,
            `day_of_week` TINYINT(1) NOT NULL DEFAULT 0,         -- 0=Sun..6=Sat
            `start_time` TIME NOT NULL,
            `end_time` TIME NOT NULL,
            `subject` VARCHAR(191) NOT NULL DEFAULT '',
            `teacher_id` INT UNSIGNED NOT NULL DEFAULT 0,
            `meta` LONGTEXT NULL,
            `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (`id`),
            KEY `idx_class_day` (`classroom_id`,`day_of_week`,`start_time`)
        ) $charset;";
        require_once ABSPATH . 'wp-admin/includes/upgrade.php';
        dbDelta($sql);
    }

    public static function register_routes() {
        register_rest_route('rad/v2', '/timetable', [
            'methods'  => 'GET',
            'callback' => [__CLASS__, 'rest_get_rows'],
            'permission_callback' => function () { return current_user_can('read'); },
            'args' => [
                'classroom' => ['type'=>'string',  'required'=>false],
                'day'       => ['type'=>'integer', 'required'=>false], // 0..6
                'limit'     => ['type'=>'integer', 'required'=>false, 'default'=>50],
                'page'      => ['type'=>'integer', 'required'=>false, 'default'=>1],
            ],
        ]);

        register_rest_route('rad/v2', '/timetables/list', [
            'methods'  => 'GET',
            'callback' => [__CLASS__, 'rest_list_grouped'],
            'permission_callback' => function () { return current_user_can('read'); },
        ]);

        register_rest_route('rad/v2', '/timetables', [
            'methods'  => 'POST',
            'callback' => [__CLASS__, 'rest_save_classroom'],
            'permission_callback' => function () { return current_user_can('edit_posts'); },
            'args' => [
                // Prefer classroom_id; keep classroom for backward compatibility
                'classroom_id'        => ['type'=>'string',  'required'=>false],
                'classroom'           => ['type'=>'string',  'required'=>false],
                'days'                => ['type'=>'object',  'required'=>true],
                'apply_monday_to_all' => ['type'=>'boolean', 'required'=>false],
            ],
        ]);
    }

    /* ----------------------------- Helpers ----------------------------- */

    private static function day_to_index($key) {
        // Accept "Mon", "Monday", 1..7 (Mon..Sun), 0..6 (Sun..Sat)
        if (is_numeric($key)) {
            $n = intval($key);
            if ($n >= 1 && $n <= 7) return $n % 7; // Mon=1->1 ... Sun=7->0
            if ($n >= 0 && $n <= 6) return $n;     // Sun=0..Sat=6
            return 0;
        }
        $k = strtolower(substr(trim((string)$key), 0, 3));
        $map = ['sun'=>0,'mon'=>1,'tue'=>2,'wed'=>3,'thu'=>4,'fri'=>5,'sat'=>6];
        return isset($map[$k]) ? $map[$k] : 0;
    }

    private static function index_to_day($i) {
        $map = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
        return $map[$i % 7];
    }

    private static function norm_time($hhmm) {
        // Normalize to HH:MM
        $hhmm = trim((string)$hhmm);
        if ($hhmm === '') return '12:00';
        if (strpos($hhmm, ':') === false) {
            $h = substr($hhmm, 0, 2);
            $m = substr($hhmm, 2, 2);
            if ($m === '') $m = '00';
            return sprintf('%02d:%02d', intval($h), intval($m));
        }
        list($h, $m) = array_pad(explode(':', $hhmm, 2), 2, '00');
        return sprintf('%02d:%02d', intval($h), intval($m));
    }

    private static function maybe_unserialize_meta($meta) {
        if (is_array($meta)) return $meta;
        if (is_string($meta) && $meta !== '' && function_exists('is_serialized') && is_serialized($meta)) {
            $u = @maybe_unserialize($meta);
            return is_array($u) ? $u : [];
        }
        return [];
    }

    /* ----------------------------- GET raw ----------------------------- */

    public static function rest_get_rows(WP_REST_Request $req) {
        global $wpdb;
        $table = self::table();

        $limit = max(1, min(500, intval($req->get_param('limit') ?: 50)));
        $page  = max(1, intval($req->get_param('page') ?: 1));
        $off   = ($page - 1) * $limit;

        $where = '1=1';
        $args  = [];

        if ($req->get_param('classroom')) {
            $where .= ' AND classroom_id = %s';
            $args[] = sanitize_text_field($req->get_param('classroom'));
        }
        if ($req->get_param('day') !== null) {
            $where .= ' AND day_of_week = %d';
            $args[] = intval($req->get_param('day'));
        }

        $sql = "SELECT SQL_CALC_FOUND_ROWS id, classroom_id, day_of_week, start_time, end_time, subject, teacher_id, meta, created_at
                FROM $table
                WHERE $where
                ORDER BY classroom_id, day_of_week, start_time
                LIMIT %d OFFSET %d";

        $args[] = $limit;
        $args[] = $off;

        $rows  = $wpdb->get_results($wpdb->prepare($sql, $args), ARRAY_A) ?: [];
        $total = intval($wpdb->get_var("SELECT FOUND_ROWS()"));

        return rest_ensure_response([
            'ok'    => true,
            'rows'  => $rows,
            'total' => $total,
            'page'  => $page,
            'limit' => $limit
        ]);
    }

    /* ----------------------------- GET grouped ----------------------------- */

    public static function rest_list_grouped() {
        global $wpdb;
        $table = self::table();

        $rows = $wpdb->get_results("
            SELECT classroom_id, day_of_week, start_time, end_time, subject, teacher_id, meta
            FROM $table
            ORDER BY classroom_id, day_of_week, start_time
        ", ARRAY_A) ?: [];

        // Build: [classroom_id => [Day => [{...}]]]
        $grouped = [];
        foreach ($rows as $r) {
            $cls  = (string)$r['classroom_id'];
            $day  = self::index_to_day(intval($r['day_of_week']));
            $meta = self::maybe_unserialize_meta($r['meta']);
            $teacher_name = isset($meta['teacher_name']) ? $meta['teacher_name'] : '';

            if (!isset($grouped[$cls])) $grouped[$cls] = [];
            if (!isset($grouped[$cls][$day])) $grouped[$cls][$day] = [];

            $grouped[$cls][$day][] = [
                'teacher'      => intval($r['teacher_id']),
                'teacher_name' => $teacher_name,
                'subject'      => $r['subject'],
                'start'        => substr($r['start_time'], 0, 5),
                'end'          => substr($r['end_time'], 0, 5),
            ];
        }

        // Convert associative grouped into rows[] for frontend compatibility
        $out = [];
        foreach ($grouped as $classroomId => $days) {
            $out[] = [
                'classroom' => (string)$classroomId, // keep id as string
                'days'      => $days,
            ];
        }

        return rest_ensure_response(['ok' => true, 'rows' => $out]);
    }

    /* ----------------------------- POST save ----------------------------- */

    public static function rest_save_classroom(WP_REST_Request $req) {
        global $wpdb;
        $table = self::table();

        // Prefer classroom_id (exact key). Fallback to classroom for older UIs.
        $cls_from_id   = $req->get_param('classroom_id');
        $cls_from_name = $req->get_param('classroom');

        if ($cls_from_id !== null && $cls_from_id !== '') {
            $classroom = trim((string)$cls_from_id);
        } elseif ($cls_from_name !== null && trim((string)$cls_from_name) !== '') {
            $classroom = trim((string)$cls_from_name);
        } else {
            return new WP_Error('bad_request', 'Valid classroom_id or classroom is required.', ['status' => 400]);
        }

        $days = $req->get_param('days');
        if (!is_array($days)) {
            return new WP_Error('bad_request', 'Days payload must be an object.', ['status' => 400]);
        }

        // Optional: apply Monday to all (server-side mirror of UI behavior)
        if ($req->get_param('apply_monday_to_all')) {
            $monday = isset($days['Monday']) ? $days['Monday'] : (isset($days['Mon']) ? $days['Mon'] : []);
            if ($monday) {
                foreach (['Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'] as $d) {
                    $days[$d] = $monday;
                }
            }
        }

        // Transaction (best effort)
        $wpdb->query('START TRANSACTION');

        // Remove previous periods for this classroom_id
        $wpdb->delete($table, ['classroom_id' => $classroom]);

        // Insert new periods
        foreach ($days as $dayKey => $periods) {
            $dow = self::day_to_index($dayKey);
            if (!is_array($periods)) continue;

            foreach ($periods as $p) {
                $teacher_id = isset($p['teacher']) ? intval($p['teacher']) : (isset($p['teacher_id']) ? intval($p['teacher_id']) : 0);
                $subject    = isset($p['subject']) ? sanitize_text_field($p['subject']) : '';
                $start      = self::norm_time(isset($p['start']) ? $p['start'] : '');
                $end        = self::norm_time(isset($p['end']) ? $p['end'] : '');
                $meta       = [];

                // Retain teacher_name if provided (helps grid UI)
                if (!empty($p['teacher_name'])) {
                    $meta['teacher_name'] = sanitize_text_field($p['teacher_name']);
                }

                $wpdb->insert($table, [
                    'classroom_id' => $classroom,
                    'day_of_week'  => $dow,
                    'start_time'   => $start . ':00',
                    'end_time'     => $end . ':00',
                    'subject'      => $subject,
                    'teacher_id'   => $teacher_id,
                    'meta'         => !empty($meta) ? maybe_serialize($meta) : null,
                    'created_at'   => current_time('mysql'),
                ]);
            }
        }

        $wpdb->query('COMMIT');

        return rest_ensure_response(['ok' => true, 'message' => 'Timetable saved']);
    }
}

RAD_Timetables_DB::init();
