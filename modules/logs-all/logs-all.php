<?php
// modules/logs-all/logs-all.php
if (! defined('ABSPATH')) exit;

class RAD_LogsAll_Module {
    public static function init() {
        add_action('rest_api_init', [__CLASS__, 'register_routes']);
        add_action('admin_enqueue_scripts', [__CLASS__, 'enqueue_assets']);

        // ✅ Dedicated AJAX actions for All Logs (separate from Staff Logs)
        add_action('wp_ajax_rad_all_update_remark', [__CLASS__, 'ajax_update_remark']);
        add_action('wp_ajax_nopriv_rad_all_update_remark', [__CLASS__, 'ajax_update_remark']);
    }


    public static function register_routes() {
        register_rest_route('rad/v2', '/logs/all', array(
            array(
                'methods' => 'GET',
                'callback' => [__CLASS__, 'get_all_logs'],
                'permission_callback' => function(){ return current_user_can('read'); }
            )
        ));

        register_rest_route('rad/v2', '/logs/delete', array(
            array(
                'methods' => 'POST',
                'callback' => [__CLASS__, 'delete_logs'],
                'permission_callback' => function(){ return current_user_can('read'); }
            )
        ));
    }

    /** ---------- AJAX save remark for All Logs + sync to Staff Logs store ---------- */
    public static function ajax_update_remark() {
        // Allow front-end saves too. If logged in, require at least 'read' cap.
        // If not logged in, still allow (since you wanted simple front-end saving).
        if (is_user_logged_in() && !current_user_can('read')) {
            wp_send_json_error(['error'=>'no_permission']);
        }

        global $wpdb;
        $table = $wpdb->prefix . 'rad_logs';

        $id      = isset($_POST['id']) ? intval($_POST['id']) : 0;
        $remarks = isset($_POST['remarks']) ? sanitize_text_field($_POST['remarks']) : '';

        if ($id <= 0) wp_send_json_error(['error'=>'invalid_id']);

        // 1) Update DB row
        $upd = $wpdb->update($table, ['remarks'=>$remarks], ['id'=>$id], ['%s'], ['%d']);
        if ($upd === false) wp_send_json_error(['error'=>'db_update_failed', 'db'=>$wpdb->last_error]);

        // 2) Best-effort sync into Staff Logs option store
        $row = $wpdb->get_row($wpdb->prepare("SELECT id, uid, device_id, scan_time FROM $table WHERE id=%d", $id), ARRAY_A);

        if ($row && !empty($row['scan_time'])) {
            $tz   = wp_timezone();
            try {
                $scanDT   = new DateTimeImmutable($row['scan_time'], $tz);
                $dateYmd  = $scanDT->format('Y-m-d');
                $dateLab  = $scanDT->format('n/j/Y'); // Staff view format
                $uid      = (string)($row['uid'] ?? '');

                // Resolve classroom via devices/classrooms maps (best-effort)
                list($device_to_room, $device_to_class) = self::device_room_maps();
                $device = (string)($row['device_id'] ?? '');
                $classroom = '';
                if ($device && isset($device_to_class[$device])) $classroom = (string)$device_to_class[$device];

                // Find matching timetable slot and get its start time (time_from label)
                $time_from_label = self::find_time_from_label_for_scan($dateYmd, $scanDT, $classroom, $uid);

                if ($uid !== '' && $classroom !== '' && $time_from_label !== '') {
                    $key = $dateLab . '|' . $uid . '|' . $classroom . '|' . $time_from_label;
                    $store = get_option('rad_stafflog_remarks', []);
                    if (!is_array($store)) $store = [];
                    $store[$key] = $remarks;
                    update_option('rad_stafflog_remarks', $store);
                }
            } catch (\Throwable $e) {
                // ignore sync errors silently; DB update is already done
            }
        }

        wp_send_json_success(['ok'=>true, 'id'=>$id, 'remarks'=>$remarks]);
    }

    /** helper: map devices -> room/classroom */
    private static function device_room_maps() {
        global $wpdb;
        $devices_table    = $wpdb->prefix . 'rad_devices';
        $classrooms_table = $wpdb->prefix . 'rad_classrooms';

        $device_to_room = [];
        $device_to_class = [];

        $exists = $wpdb->get_var( $wpdb->prepare("SHOW TABLES LIKE %s", $devices_table) );
        if ($exists === $devices_table) {
            $devs = $wpdb->get_results("SELECT device_id, classroom, room_no FROM {$devices_table}", ARRAY_A);
            foreach ($devs as $d) {
                $k = trim((string)$d['device_id']);
                if ($k !== '') {
                    if (!empty($d['room_no']))   $device_to_room[$k]  = $d['room_no'];
                    if (!empty($d['classroom'])) $device_to_class[$k] = $d['classroom'];
                }
            }
        }
        $exists_c = $wpdb->get_var( $wpdb->prepare("SHOW TABLES LIKE %s", $classrooms_table) );
        if ($exists_c === $classrooms_table) {
            $cls = $wpdb->get_results("SELECT device_id, classroom, room_no FROM {$classrooms_table}", ARRAY_A);
            foreach ($cls as $c) {
                $k = trim((string)$c['device_id']);
                if ($k !== '') {
                    if (!empty($c['room_no']))   $device_to_room[$k]  = $c['room_no'];
                    if (!empty($c['classroom'])) $device_to_class[$k] = $c['classroom'];
                }
            }
        }
        return [$device_to_room, $device_to_class];
    }

    /** helper: read timetables with robust classroom labels */
    private static function read_timetables() {
        global $wpdb;
        $tt_table = $wpdb->prefix . 'rad_timetables';
        $cr_table = $wpdb->prefix . 'rad_classrooms';

        $has_db = $wpdb->get_var($wpdb->prepare(
            "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = %s",
            $tt_table
        ));
        if ($has_db) {
            // Prefer `classroom` column, fallback to `name`
            $classRows = $wpdb->get_results("SELECT id, classroom FROM $cr_table", ARRAY_A);
            if (!$classRows) {
                $classRows = $wpdb->get_results("SELECT id, name AS classroom FROM $cr_table", ARRAY_A) ?: [];
            }
            $classMap  = [];
            foreach ($classRows as $cr) {
                $cid = intval($cr['id']);
                $label = isset($cr['classroom']) ? trim((string)$cr['classroom']) : '';
                $classMap[$cid] = $label !== '' ? $label : ('Class ' . $cid);
            }

            $rows = $wpdb->get_results("
                SELECT classroom_id, day_of_week, start_time, end_time, subject, teacher_id, meta
                FROM $tt_table
                ORDER BY classroom_id ASC, day_of_week ASC, start_time ASC
            ", ARRAY_A) ?: [];

            $byClass = [];
            foreach ($rows as $r) {
                $classId = isset($r['classroom_id']) ? intval($r['classroom_id']) : 0;
                $class   = $classMap[$classId] ?? ($classId ? ('Class ' . $classId) : 'Unknown');

                $dowRaw  = isset($r['day_of_week']) ? intval($r['day_of_week']) : null;
                $short = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
                $long  = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
                if ($dowRaw === null) { $dayShort='Sun'; $dayFull='Sunday'; }
                else { $i = ($dowRaw>=1 && $dowRaw<=7) ? $dowRaw-1 : max(0,min(6,$dowRaw)); $dayShort=$short[$i]; $dayFull=$long[$i]; }

                $row = [
                    'start'        => (string)($r['start_time'] ?? ''),
                    'end'          => (string)($r['end_time']   ?? ''),
                    'subject'      => (string)($r['subject']    ?? ''),
                    'teacher_id'   => intval($r['teacher_id'] ?? 0),
                    'teacher_name' => '',
                ];
                $byClass[$class][$dayShort][] = $row;
                $byClass[$class][$dayFull][]  = $row;
            }
            return $byClass;
        }

        // Option fallback
        $all = get_option('rad_timetables_saved', []);
        $byClass = [];
        if (is_array($all)) {
            foreach ($all as $item) {
                if (!is_array($item)) continue;
                $classroom = $item['classroom'] ?? '';
                $days      = (isset($item['days']) && is_array($item['days'])) ? $item['days'] : [];
                if (!$classroom) continue;
                $byClass[$classroom] = $days;
            }
        }
        return $byClass;
    }

    /** helper: pick best matching period start label ("h:i A") for a scan */
    private static function find_time_from_label_for_scan($dateYmd, DateTimeImmutable $scanDT, $classroom, $uid) {
        $timetables = self::read_timetables();
        if (!$classroom || !isset($timetables[$classroom])) return '';

        $tz = wp_timezone();
        $dayShort = $scanDT->format('D');
        $dayFull  = $scanDT->format('l');

        $periods = [];
        if (isset($timetables[$classroom][$dayShort]) && is_array($timetables[$classroom][$dayShort])) {
            $periods = $timetables[$classroom][$dayShort];
        } elseif (isset($timetables[$classroom][$dayFull]) && is_array($timetables[$classroom][$dayFull])) {
            $periods = $timetables[$classroom][$dayFull];
        } else {
            return '';
        }

        $best = null; $bestDiff = PHP_INT_MAX;
        foreach ($periods as $p) {
            $start = trim((string)($p['start'] ?? ''));
            $end   = trim((string)($p['end']   ?? ''));
            if ($start === '' || $end === '') continue;

            $ns = preg_match('/^\d{1,2}:\d{2}:\d{2}$/', $start) ? $start : (preg_match('/^\d{1,2}:\d{2}$/', $start) ? ($start.=':00') : $start);
            $ne = preg_match('/^\d{1,2}:\d{2}:\d{2}$/', $end)   ? $end   : (preg_match('/^\d{1,2}:\d{2}$/', $end)   ? ($end.=':00')   : $end);
            try {
                $sTs = (new DateTimeImmutable($dateYmd.' '.$ns, $tz))->getTimestamp();
                $eTs = (new DateTimeImmutable($dateYmd.' '.$ne, $tz))->getTimestamp();
            } catch (\Throwable $e) { continue; }
            if ($eTs <= $sTs) continue;

            $scanTs = $scanDT->getTimestamp();
            $d = ($scanTs < $sTs) ? ($sTs - $scanTs) : (($scanTs > $eTs) ? ($scanTs - $eTs) : 0);
            if ($d < $bestDiff) { $bestDiff = $d; $best = $sTs; }
        }

        if ($best === null) return '';
        return wp_date('h:i A', $best, $tz);
    }

    public static function get_all_logs($req) {
        global $wpdb;

        $date = sanitize_text_field($req->get_param('date') ?: '');
        $from = sanitize_text_field($req->get_param('from') ?: '');
        $to   = sanitize_text_field($req->get_param('to') ?: '');
        $uid  = sanitize_text_field($req->get_param('uid') ?: '');
        $device = sanitize_text_field($req->get_param('device') ?: '');
        $teacher_id = intval($req->get_param('teacher_id') ?: 0);
        $classroom_filter = sanitize_text_field($req->get_param('classroom') ?: '');
        $room_filter = sanitize_text_field($req->get_param('room') ?: '');
        $department_filter = sanitize_text_field($req->get_param('department') ?: '');

        if (! $date && ! $from && ! $to) $date = date('Y-m-d');

        $teachers = $wpdb->get_results("SELECT id, name, classroom_id, department FROM {$wpdb->prefix}rad_teachers", ARRAY_A);
        $tid_map = array();
        foreach ($teachers as $t) $tid_map[intval($t['id'])] = $t;

        $meta_rows = $wpdb->get_results($wpdb->prepare("SELECT entity_id, meta_value FROM {$wpdb->prefix}rad_entity_meta WHERE entity_type=%s AND field_key=%s", 'teachers', 'uid'), ARRAY_A);
        $uid_to_teacher = array();
        foreach ($meta_rows as $m) {
            $val = maybe_unserialize($m['meta_value']);
            if (is_array($val)) foreach ($val as $v) $uid_to_teacher[(string)$v] = intval($m['entity_id']);
            else $uid_to_teacher[(string)$val] = intval($m['entity_id']);
        }

        $logs_table = $wpdb->prefix . 'rad_logs';
        $col_check = $wpdb->get_results("SHOW COLUMNS FROM {$logs_table}", ARRAY_A);
        $cols = array_map(function($c){ return $c['Field']; }, $col_check);
        $time_col = in_array('scan_time', $cols, true) ? 'scan_time' : (in_array('tap_time', $cols, true) ? 'tap_time' : (in_array('created_at', $cols, true) ? 'created_at' : 'scan_time'));

        if ($from && $to) {
            $logs = $wpdb->get_results($wpdb->prepare("SELECT * FROM {$logs_table} WHERE DATE({$time_col}) BETWEEN %s AND %s ORDER BY {$time_col} DESC", $from, $to), ARRAY_A);
        } elseif ($date) {
            $logs = $wpdb->get_results($wpdb->prepare("SELECT * FROM {$logs_table} WHERE DATE({$time_col}) = %s ORDER BY {$time_col} DESC", $date), ARRAY_A);
        } elseif ($from) {
            $logs = $wpdb->get_results($wpdb->prepare("SELECT * FROM {$logs_table} WHERE DATE({$time_col}) >= %s ORDER BY {$time_col} DESC", $from), ARRAY_A);
        } else {
            $logs = $wpdb->get_results($wpdb->prepare("SELECT * FROM {$logs_table} ORDER BY {$time_col} DESC LIMIT 1000"), ARRAY_A);
        }

        if (!is_array($logs)) $logs = [];

        // ---------------------------
        // DEDUPE: collapse exact duplicate scans
        // key: uid | scan_time | device_id
        // Keep the row with the smallest id (earliest insert) to preserve stable reference
        // ---------------------------
        $unique = [];
        foreach ($logs as $r) {
            $uid_val = isset($r['uid']) ? trim((string)$r['uid']) : (isset($r['card_uid']) ? trim((string)$r['card_uid']) : '');
            $dev_val = isset($r['device_id']) ? trim((string)$r['device_id']) : (isset($r['device']) ? trim((string)$r['device']) : '');
            $time_val = isset($r[$time_col]) ? trim((string)$r[$time_col]) : '';

            $key = $uid_val . '|' . $time_val . '|' . $dev_val;
            if ($key === '||') {
                // extremely odd row (no uid/device/time) — keep as-is with unique numeric key to avoid collisions
                $key = uniqid('logrow_', true);
            }

            if (!isset($unique[$key])) {
                $unique[$key] = $r;
            } else {
                // keep the row with lower id (older insert) to preserve a single stable id for edits/remarks
                $existing_id = intval($unique[$key]['id'] ?? 0);
                $current_id  = intval($r['id'] ?? 0);
                if ($current_id > 0 && $existing_id > 0 && $current_id < $existing_id) {
                    $unique[$key] = $r;
                }
            }
        }

        // replace logs with deduped set
        $logs = array_values($unique);

        // sort logs by chosen time column DESC (keep newest first)
        usort($logs, function($a, $b) use ($time_col) {
            $ta = isset($a[$time_col]) ? $a[$time_col] : '';
            $tb = isset($b[$time_col]) ? $b[$time_col] : '';
            // compare as strings (ISO-like) — if equal, fallback to id desc
            if ($ta === $tb) {
                $ida = isset($a['id']) ? intval($a['id']) : 0;
                $idb = isset($b['id']) ? intval($b['id']) : 0;
                return $idb <=> $ida;
            }
            return strcmp($tb, $ta);
        });

        if (!is_array($logs)) $logs = [];

        $devices_table = $wpdb->prefix . 'rad_devices';
        $classrooms_table = $wpdb->prefix . 'rad_classrooms';
        $device_map = [];
        $room_map = [];
        $exists = $wpdb->get_var( $wpdb->prepare("SHOW TABLES LIKE %s", $devices_table) );
        if ($exists === $devices_table) {
            $devs = $wpdb->get_results("SELECT device_id, classroom, room_no FROM {$devices_table}", ARRAY_A);
            foreach ($devs as $d) {
                $k = trim($d['device_id']);
                if ($k !== '') $device_map[$k] = $d;
                $rkey = trim($d['room_no']);
                if ($rkey !== '') $room_map[$rkey] = ['device_id'=>$d['device_id'],'classroom'=>$d['classroom'],'room_no'=>$d['room_no']];
            }
        }
        $exists_c = $wpdb->get_var( $wpdb->prepare("SHOW TABLES LIKE %s", $classrooms_table) );
        if ($exists_c === $classrooms_table) {
            $cls = $wpdb->get_results("SELECT device_id, classroom, room_no FROM {$classrooms_table}", ARRAY_A);
            foreach ($cls as $c) {
                $rkey = trim($c['room_no']);
                if ($rkey !== '') $room_map[$rkey] = ['device_id'=>$c['device_id'],'classroom'=>$c['classroom'],'room_no'=>$c['room_no']];
                $k = trim($c['device_id']);
                if ($k !== '') $device_map[$k] = ['device_id'=>$c['device_id'],'classroom'=>$c['classroom'],'room_no'=>$c['room_no']];
            }
        }

        $out = array();
        foreach ($logs as $r) {
            $uid_val = isset($r['uid']) ? (string)$r['uid'] : (isset($r['card_uid']) ? (string)$r['card_uid'] : '');
            $device_val = isset($r['device_id']) ? (string)$r['device_id'] : (isset($r['device']) ? (string)$r['device'] : '');
            $scan_time_val = isset($r[$time_col]) ? $r[$time_col] : '';
            $date_val = $scan_time_val ? date('d-m-Y', strtotime($scan_time_val)) : '';
            $time_only = $scan_time_val ? date('h:i:s A', strtotime($scan_time_val)) : '';

            $tid = isset($uid_to_teacher[$uid_val]) ? $uid_to_teacher[$uid_val] : null;
            $tname = $tid ? ($tid_map[$tid]['name'] ?? '') : '';
            $classroom_from_teacher = $tid ? ($tid_map[$tid]['classroom_id'] ?? '') : '';
            $department = $tid ? ($tid_map[$tid]['department'] ?? '') : '';

            $room_val = '';
            if (isset($r['room']) && trim($r['room']) !== '') {
                $room_val = trim($r['room']);
            } elseif (isset($r['room_no']) && trim($r['room_no']) !== '') {
                $room_val = trim($r['room_no']);
            } elseif (!empty($device_val) && isset($device_map[trim($device_val)]) && !empty($device_map[trim($device_val)]['room_no'])) {
                $room_val = trim($device_map[trim($device_val)]['room_no']);
            }

            $classroom_val = $classroom_from_teacher;
            if (empty($classroom_val) && !empty($device_val) && isset($device_map[trim($device_val)]) && !empty($device_map[trim($device_val)]['classroom'])) {
                $classroom_val = $device_map[trim($device_val)]['classroom'];
            }

            if ($uid && strpos($uid_val, $uid) === false) continue;
            if ($device && strpos($device_val, $device) === false) continue;
            if ($teacher_id && (! $tid || intval($tid) !== $teacher_id)) continue;
            if ($classroom_filter && strcasecmp($classroom_val, $classroom_filter) !== 0) continue;
            if ($room_filter && strcasecmp($room_val, $room_filter) !== 0) continue;
            if ($department_filter && strcasecmp($department, $department_filter) !== 0) continue;

            $out[] = array(
                'id' => $r['id'],
                'uid' => $uid_val,
                'teacher_id' => $tid,
                'teacher_name' => $tname,
                'classroom' => $classroom_val,
                'department' => $department,
                'room' => $room_val,
                'device_id' => $device_val,
                'tap_time' => $time_only,
                'scan_time' => $scan_time_val,
                'date' => $date_val,
                'remarks' => $r['remarks'] ?? ''
            );
        }

        return rest_ensure_response(array('ok' => true, 'mode' => 'all', 'rows' => $out));
    }

    public static function delete_logs($req){
        global $wpdb;
        $body = $req->get_json_params();
        if (!is_array($body) || empty($body['ids']) || !is_array($body['ids'])) {
            return new WP_Error('invalid', 'Provide JSON body with ids array', ['status'=>400]);
        }
        $ids = array_map('intval', $body['ids']);
        $ids = array_filter($ids, function($v){ return $v>0; });
        if (empty($ids)) return new WP_Error('invalid', 'No valid ids', ['status'=>400]);

        $table = $wpdb->prefix . 'rad_logs';
        $placeholders = implode(',', array_fill(0, count($ids), '%d'));
        $sql = "DELETE FROM {$table} WHERE id IN ($placeholders)";
        $prepared = $wpdb->prepare($sql, $ids);
        $res = $wpdb->query($prepared);

        if ($res === false) {
            return new WP_Error('db', 'Delete failed', ['status'=>500, 'db_error'=>$wpdb->last_error]);
        }

        return rest_ensure_response(['ok'=>true, 'deleted'=>intval($res)]);
    }

    public static function enqueue_assets($hook) {
        if ($hook !== 'toplevel_page_rad-dashboard') return;
        $base = RAD_PLUGIN_URL . 'modules/logs-all/';
        wp_register_script('rad-logs-all-js', $base . 'admin.js', array(), '1.0.3', true);
        wp_register_style('rad-logs-all-css', $base . 'admin.css', array(), '1.0.2');
    }
}

RAD_LogsAll_Module::init();
