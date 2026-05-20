<?php 
if (!defined('ABSPATH')) exit;

class RAD_Logs_Staff_Module {

    public static function init() {
        add_action('rest_api_init', [__CLASS__, 'register_routes']);

        // Support BOTH action names + front users:
        add_action('wp_ajax_rad_staff_update_remark', [__CLASS__, 'ajax_update_remark']);
        add_action('wp_ajax_nopriv_rad_staff_update_remark', [__CLASS__, 'ajax_update_remark_nopriv']);

        // Allow same action name as All Logs for compatibility
        add_action('wp_ajax_rad_update_remark', [__CLASS__, 'ajax_update_remark']);
        add_action('wp_ajax_nopriv_rad_update_remark', [__CLASS__, 'ajax_update_remark_nopriv']);
    }

    public static function register_routes() {
        register_rest_route('rad/v2', '/logs/staff', [
            'methods'  => 'GET',
            'callback' => [__CLASS__, 'rest_staff_logs'],
            'permission_callback' => function () { return current_user_can('read'); },
            'args' => [
                'date'        => ['type'=>'string','required'=>false],
                'from'        => ['type'=>'string','required'=>false],
                'to'          => ['type'=>'string','required'=>false],
                'teacher_id'  => ['type'=>'integer','required'=>false],
                'uid'         => ['type'=>'string','required'=>false],
                'device'      => ['type'=>'string','required'=>false],
                'classroom'   => ['type'=>'string','required'=>false],
                'room'        => ['type'=>'string','required'=>false],
                'department'  => ['type'=>'string','required'=>false],
                'entry_status'=> ['type'=>'string','required'=>false],
                'exit_status' => ['type'=>'string','required'=>false],
                'page'        => ['type'=>'integer','required'=>false,'default'=>1],
                'per_page'    => ['type'=>'integer','required'=>false,'default'=>10],
                'debug'       => ['type'=>'boolean','required'=>false,'default'=>false],
            ]
        ]);
    }

    /* ---------------- Grace / Window ---------------- */
    private static function get_grace_minutes() {
        $row = get_option('rad_grace_settings', []);
        if (is_array($row) && isset($row['duration']) && is_numeric($row['duration'])) {
            return max(0, intval($row['duration']));
        }
        $g = get_option('rad_grace_minutes', '');
        return max(0, is_numeric($g) ? intval($g) : 0);
    }
    private static function get_window_minutes() {
        $row = get_option('rad_grace_settings', []);
        if (is_array($row) && isset($row['window_minutes']) && is_numeric($row['window_minutes'])) {
            return max(0, intval($row['window_minutes']));
        }
        $w = get_option('rad_window_minutes', '');
        return max(0, is_numeric($w) ? intval($w) : 0);
    }

    /* ---------------- Day keys ---------------- */
    private static function day_keys_from_date($date) {
        $tz = wp_timezone();
        $dt = new DateTimeImmutable($date.' 00:00:00', $tz);
        return [ $dt->format('D'), $dt->format('l') ];
    }
    private static function day_names_from_num($n) {
        $short = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
        $long  = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
        if ($n === null) return ['Sun','Sunday'];
        if ($n >= 0 && $n <= 6) return [$short[$n], $long[$n]];
        if ($n >= 1 && $n <= 7) { $i = $n - 1; return [$short[$i], $long[$i]]; }
        return ['Sun','Sunday'];
    }

    /* ---------------- Time helpers ---------------- */
    private static function normalize_time_str($time) {
        $s = trim((string)$time);
        if (preg_match('/\b(am|pm)\b/i', $s))           return $s;
        if (preg_match('/^\d{1,2}:\d{2}:\d{2}$/', $s))  return $s;
        if (preg_match('/^\d{1,2}:\d{2}$/', $s))        return $s . ':00';
        return $s;
    }

    /* ---------------- DB helpers: timetables/devices ---------------- */
    private static function read_timetables() {
        global $wpdb;
        $tt_table = $wpdb->prefix . 'rad_timetables';
        $cr_table = $wpdb->prefix . 'rad_classrooms';

        $has_db = $wpdb->get_var($wpdb->prepare(
            "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = %s",
            $tt_table
        ));

        if ($has_db) {
            // FIX: read the correct classroom name column
            // Try `classroom` first, fallback to `name` if schema differs.
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
                SELECT id, classroom_id, day_of_week, start_time, end_time, subject, teacher_id, meta
                FROM $tt_table
                ORDER BY classroom_id ASC, day_of_week ASC, start_time ASC
            ", ARRAY_A) ?: [];

            $byClass = [];
            foreach ($rows as $r) {
                $classId = isset($r['classroom_id']) ? intval($r['classroom_id']) : 0;
                $class   = $classMap[$classId] ?? ($classId ? ('Class ' . $classId) : 'Unknown');

                $dowRaw  = isset($r['day_of_week']) ? intval($r['day_of_week']) : null;
                list($dayShort, $dayFull) = self::day_names_from_num($dowRaw);

                $start = self::normalize_time_str($r['start_time'] ?? '00:00');
                $end   = self::normalize_time_str($r['end_time']   ?? '00:00');
                $sub   = (string)($r['subject'] ?? '');
                $tid   = isset($r['teacher_id']) ? intval($r['teacher_id']) : 0;

                $teacher_name = '';
                if (!empty($r['meta'])) {
                    $meta = @maybe_unserialize($r['meta']);
                    if (is_array($meta) && !empty($meta['teacher_name'])) $teacher_name = (string)$meta['teacher_name'];
                }

                $row = [
                    'start'        => $start,
                    'end'          => $end,
                    'subject'      => $sub,
                    'teacher'      => $tid ?: $teacher_name,
                    'teacher_id'   => $tid,
                    'teacher_name' => $teacher_name,
                ];

                $byClass[$class][$dayShort][] = $row;
                $byClass[$class][$dayFull][]  = $row;
            }

            $total = 0; foreach ($byClass as $c => $days) $total += array_sum(array_map('count', $days));
            if ($total > 0) return $byClass;
        }

        // Fallback to option store (legacy)
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

    private static function teachers_map() {
        global $wpdb;
        $t_table = $wpdb->prefix . 'rad_teachers';
        $m_table = $wpdb->prefix . 'rad_entity_meta';

        $rows = $wpdb->get_results("
            SELECT t.id, t.name, t.department
            FROM $t_table t
            ORDER BY t.id ASC
        ", ARRAY_A) ?: [];
        if (!$rows) return [];

        $ids = array_map(function($r){ return intval($r['id']); }, $rows);
        if (!$ids) return [];

        $in = implode(',', array_map('intval', $ids));

        $metaRows = $wpdb->get_results("
            SELECT entity_id, meta_value
            FROM $m_table
            WHERE entity_type IN ('teacher','teachers') AND field_key='uid' AND entity_id IN ($in)
        ", ARRAY_A);

        if (!$metaRows) {
            $metaRows = $wpdb->get_results("
                SELECT entity_id, meta_value
                FROM $m_table
                WHERE entity_type IN ('teacher','teachers') AND meta_key='uid' AND entity_id IN ($in)
            ", ARRAY_A) ?: [];
        }

        $uidMap = [];
        foreach ($metaRows as $m) { $uidMap[intval($m['entity_id'])] = (string)$m['meta_value']; }

        $out = [];
        foreach ($rows as $r) {
            $tid = intval($r['id']);
            $out[$tid] = [
                'id'         => $tid,
                'name'       => $r['name'],
                'department' => $r['department'] ?? '',
                'uid'        => $uidMap[$tid] ?? '',
            ];
        }
        return $out;
    }

    /* ------------------ NEW helper: lookup room_no from classrooms table ------------------ */
    private static function classroom_room_no_lookup($classroom_label) {
        global $wpdb;
        $cr_table = $wpdb->prefix . 'rad_classrooms';

        $label = trim((string)$classroom_label);
        if ($label === '') return '';

        // If classroom label is numeric (like an id string), try lookup by id first
        if (ctype_digit($label)) {
            $id = intval($label);
            $row = $wpdb->get_row($wpdb->prepare("SELECT room_no FROM {$cr_table} WHERE id = %d LIMIT 1", $id), ARRAY_A);
            if ($row && !empty($row['room_no'])) return (string)$row['room_no'];
        }

        // Lookup by classroom name (exact match)
        $row = $wpdb->get_row($wpdb->prepare("SELECT room_no FROM {$cr_table} WHERE classroom = %s LIMIT 1", $label), ARRAY_A);
        if ($row && !empty($row['room_no'])) return (string)$row['room_no'];

        // Fallback: try name column if classroom column missing or different schema
        $row = $wpdb->get_row($wpdb->prepare("SELECT room_no FROM {$cr_table} WHERE name = %s LIMIT 1", $label), ARRAY_A);
        if ($row && !empty($row['room_no'])) return (string)$row['room_no'];

        return '';
    }

    /* ---------------- Raw logs for a local day (with remarks) ---------------- */
    private static function read_raw_logs_for_date($date) {
        global $wpdb;
        $table = $wpdb->prefix . 'rad_logs';

        $tz = wp_timezone();
        $start = (new DateTimeImmutable($date.' 00:00:00', $tz))->format('Y-m-d H:i:s');
        $end   = (new DateTimeImmutable($date.' 23:59:59', $tz))->format('Y-m-d H:i:s');

        $sql = $wpdb->prepare("
            SELECT id, uid, device_id, scan_time, remarks
            FROM $table
            WHERE scan_time BETWEEN %s AND %s
            ORDER BY scan_time ASC
        ", $start, $end);

        return $wpdb->get_results($sql, ARRAY_A) ?: [];
    }

    /* ---------------- Match taps to a scheduled period ---------------- */
    private static function match_period_logs($uid, $logs, $startTs, $endTs, $windowMin, $graceMin) {
    $tz = wp_timezone();

    $entryStart = $startTs - ($windowMin * 60);
    $entryEnd   = $startTs + ($windowMin * 60);
    $exitStart  = $endTs   - ($windowMin * 60);
    $exitEnd    = $endTs   + ($windowMin * 60);

    $nowTs = (new DateTimeImmutable('now', $tz))->getTimestamp();

    $entryTap = null;
    $exitTap  = null;

    // STEP 1: find earliest entry tap
    foreach ($logs as $row) {
        if ($row['uid'] !== $uid) continue;

        $t = (new DateTimeImmutable($row['scan_time'], $tz))->getTimestamp();

        if ($t >= $entryStart && $t <= $entryEnd) {
            if ($entryTap === null || $t < strtotime($entryTap['scan_time'])) {
                $entryTap = $row;
            }
        }
    }

    // STEP 2: find exit tap ONLY if entry exists
    // STEP 2: find exit tap

if ($entryTap) {

    $entryTs = (new DateTimeImmutable($entryTap['scan_time'], $tz))->getTimestamp();
    $entryDevice = (string)$entryTap['device_id'];

    foreach ($logs as $row) {
        if ($row['uid'] !== $uid) continue;

        $t = (new DateTimeImmutable($row['scan_time'], $tz))->getTimestamp();

        if (
            $t >= $exitStart &&
            $t <= $exitEnd &&
            $t > $entryTs &&
            (string)$row['device_id'] === $entryDevice &&
            intval($row['id']) !== intval($entryTap['id'])
        ) {
            if ($exitTap === null || $t > strtotime($exitTap['scan_time'])) {
                $exitTap = $row;
            }
        }
    }

} else {

    // exit-only scenario
    foreach ($logs as $row) {
        if ($row['uid'] !== $uid) continue;

        $t = (new DateTimeImmutable($row['scan_time'], $tz))->getTimestamp();

        if ($t >= $exitStart && $t <= $exitEnd) {

            // 🔒 validate device belongs to this classroom
            $dev = (string)$row['device_id'];

            // allow only devices mapped to this timetable classroom
            if (!empty($dev) && isset($devToClass[$dev])) {
                if (strcasecmp($devToClass[$dev], $classroom) !== 0) {
                    continue;
                }
            }

            if ($exitTap === null || $t > strtotime($exitTap['scan_time'])) {
                $exitTap = $row;
            }
        }
    }
}



    $entryDeltaSecs = null;
    $exitDeltaSecs  = null;

    $entryStatus = '';
    $exitStatus  = '';
    $entryTime   = '';
    $exitTime    = '';
    $deviceIn    = '';
    $deviceOut   = '';
    $logsRemark  = '';
    $entryId = null;
    $exitId  = null;

    if ($entryTap) {
        $tapTs = (new DateTimeImmutable($entryTap['scan_time'], $tz))->getTimestamp();
        $entryDeltaSecs = $tapTs - $startTs;

        $entryTime = (new DateTimeImmutable($entryTap['scan_time'], $tz))->format('h:i:s A');
        $deviceIn  = (string)$entryTap['device_id'];
        $logsRemark = isset($entryTap['remarks']) ? (string)$entryTap['remarks'] : '';
        $entryId = intval($entryTap['id']);

        $mins = intval(round($entryDeltaSecs / 60.0));
        if (abs($mins) <= $graceMin)      $entryStatus = 'On Time';
        else if ($mins < -$graceMin)      $entryStatus = 'Early Entry';
        else                               $entryStatus = 'Late Entry';
    } else {
        if ($nowTs > $entryEnd) $entryStatus = 'No Tap';
    }

    if ($exitTap) {
        $tapTs = (new DateTimeImmutable($exitTap['scan_time'], $tz))->getTimestamp();
        $exitDeltaSecs = $tapTs - $endTs;

        $exitTime  = (new DateTimeImmutable($exitTap['scan_time'], $tz))->format('h:i:s A');
        $deviceOut = (string)$exitTap['device_id'];
        if (!$logsRemark && isset($exitTap['remarks'])) {
            $logsRemark = (string)$exitTap['remarks'];
        }
        $exitId = intval($exitTap['id']);

        $mins = intval(round($exitDeltaSecs / 60.0));
        if (abs($mins) <= $graceMin)      $exitStatus = 'On Time';
        else if ($mins < -$graceMin)      $exitStatus = 'Early Exit';
        else                               $exitStatus = 'Late Exit';
    } else {
        if ($nowTs > $exitEnd) $exitStatus = 'No Tap';
    }

    $totalSecs = 0;
    if ($entryTap && $exitTap) {
        $inTs  = (new DateTimeImmutable($entryTap['scan_time'], $tz))->getTimestamp();
        $outTs = (new DateTimeImmutable($exitTap['scan_time'], $tz))->getTimestamp();
        $totalSecs = max(0, $outTs - $inTs);
    }

    return [
        'entry_time'      => $entryTime,
        'entry_status'    => $entryStatus,
        'exit_time'       => $exitTime,
        'exit_status'     => $exitStatus,
        'device_in'       => $deviceIn,
        'device_out'      => $deviceOut,
        'total_secs'      => $totalSecs,
        'entry_delta_secs'=> $entryDeltaSecs,
        'exit_delta_secs' => $exitDeltaSecs,
        'logs_remark'     => $logsRemark,
        'entry_id'        => $entryId,
        'exit_id'         => $exitId,
    ];
}


    /* ---------------- REST: Staff logs ---------------- */
    public static function rest_staff_logs($request) {
        $q_date  = sanitize_text_field($request->get_param('date'));
        $q_from  = sanitize_text_field($request->get_param('from'));
        $q_to    = sanitize_text_field($request->get_param('to'));

        $page  = max(1, intval($request->get_param('page')));
        $per   = max(1, min(100, intval($request->get_param('per_page'))));

        $flt_teacher = intval($request->get_param('teacher_id') ?: 0);
        $flt_uid     = sanitize_text_field($request->get_param('uid') ?: '');
        $flt_device  = sanitize_text_field($request->get_param('device') ?: '');
        $flt_class   = sanitize_text_field($request->get_param('classroom') ?: '');
        $flt_room    = sanitize_text_field($request->get_param('room') ?: '');
        $flt_dept    = sanitize_text_field($request->get_param('department') ?: '');
        $flt_estatus = sanitize_text_field($request->get_param('entry_status') ?: '');
        $flt_xstatus = sanitize_text_field($request->get_param('exit_status')  ?: '');

        // Build date list
        $dates = [];
        $tz = wp_timezone();
        if ($q_from && $q_to) {
            try {
                $start = new DateTimeImmutable($q_from.' 00:00:00', $tz);
                $end   = new DateTimeImmutable($q_to.' 00:00:00', $tz);
                if ($end < $start) $end = $start;
                $maxDays = 31;
                for ($i=0; $i<$maxDays; $i++) {
                    $d = $start->modify("+$i day");
                    $dates[] = $d->format('Y-m-d');
                    if ($d >= $end) break;
                }
            } catch (\Throwable $e) { $dates = []; }
        } elseif ($q_date) {
            $dates[] = $q_date;
        } else {
            $dates[] = current_time('Y-m-d');
        }

        $graceMin  = self::get_grace_minutes();
        $windowMin = self::get_window_minutes();

        $timetables = self::read_timetables();
        $teachers   = self::teachers_map();
        list($devToRoom, $devToClass) = self::device_room_maps();

        if (!$teachers) {
            return rest_ensure_response([
                'ok' => true, 'total' => 0, 'rows' => [],
                'grace_minutes' => $graceMin,
                'window_minutes'=> $windowMin,
                'notice' => 'No teachers found.'
            ]);
        }

        $tidToUid = []; foreach ($teachers as $tid => $t) { $tidToUid[$tid] = $t['uid']; }
        $remarks_store = get_option('rad_stafflog_remarks', []);
        if (!is_array($remarks_store)) $remarks_store = [];

        $rows = [];

        $nowTsGlobal = (new DateTimeImmutable('now', $tz))->getTimestamp();

        foreach ($dates as $date) {
            list($dayKeyShort, $dayKeyFull) = self::day_keys_from_date($date);
            $rawLogs = self::read_raw_logs_for_date($date);

            foreach ($timetables as $classroom => $daysMap) {
                if (!is_array($daysMap)) $daysMap = [];
                $normMap = [];
                foreach ($daysMap as $k => $v) { $normMap[strtolower($k)] = $v; }

                $periods =
                    (isset($normMap[strtolower($dayKeyShort)]) && is_array($normMap[strtolower($dayKeyShort)]))
                        ? $normMap[strtolower($dayKeyShort)]
                        : ((isset($normMap[strtolower($dayKeyFull)]) && is_array($normMap[strtolower($dayKeyFull)]))
                            ? $normMap[strtolower($dayKeyFull)]
                            : []);

                if (!is_array($periods) || empty($periods)) continue;

                foreach ($periods as $p) {
                    $tidRaw = $p['teacher'] ?? ($p['teacher_id'] ?? '');
                    $tid    = intval($tidRaw);
                    if (!$tid) {
                        $nameGuess = '';
                        if (!empty($p['teacher_name'])) $nameGuess = trim((string)$p['teacher_name']);
                        elseif (is_string($tidRaw))     $nameGuess = trim($tidRaw);
                        if ($nameGuess !== '') {
                            foreach ($teachers as $id => $tdata) {
                                if (strcasecmp($tdata['name'] ?? '', $nameGuess) === 0) { $tid = (int)$id; break; }
                            }
                        }
                    }
                    if (!$tid || !isset($teachers[$tid])) continue;

                    $uid = $tidToUid[$tid] ?? '';
                    if (!$uid) continue;

                    $subject = $p['subject'] ?? '';
                    $start   = $p['start']   ?? '00:00';
                    $end     = $p['end']     ?? '00:00';

                    $startStr = self::normalize_time_str($start);
                    $endStr   = self::normalize_time_str($end);

                    try {
                        $startTs = (new DateTimeImmutable($date.' '.$startStr, $tz))->getTimestamp();
                        $endTs   = (new DateTimeImmutable($date.' '.$endStr,   $tz))->getTimestamp();
                    } catch (\Throwable $e) { continue; }
                    if (!$startTs || !$endTs || $endTs <= $startTs) continue;

                    // ===== NEW: skip future periods if entry window hasn't opened yet =====
                    $entryWindowStart = $startTs - ($windowMin * 60);
                    if ($nowTsGlobal < $entryWindowStart) {
                        // This period's entry window has not yet started — do not include this row
                        continue;
                    }
                    // =====================================================================

                    $match = self::match_period_logs($uid, $rawLogs, $startTs, $endTs, $windowMin, $graceMin);

                    // resolve room via devices (prefer entry device)
                    $roomNo = '';
                    $prefDev = $match['device_in'] ?: $match['device_out'];
                    if ($prefDev && isset($devToRoom[$prefDev])) $roomNo = (string)$devToRoom[$prefDev];

                    // NEW: Prefer device->classroom mapping for the row's classroom label.
                    // If a device mapped classroom exists, use it; otherwise fallback to timetable $classroom.
                    $class_from_device = '';
                    if ($prefDev && isset($devToClass[$prefDev]) && trim((string)$devToClass[$prefDev]) !== '') {
                        $class_from_device = (string)$devToClass[$prefDev];
                    }

                    // ---- CRITICAL: Enforce timetable-only rule ----
                    // If teacher tapped on a device mapped to a different classroom than timetable,
                    // ignore those taps for Staff Logs view (treat as "No Tap" when appropriate).
                    if ($class_from_device !== '' && strcasecmp($class_from_device, $classroom) !== 0) {
                        // Determine entry/exit status as "No Tap" only if the respective window has passed.
                        $entryWindowEnd = $startTs + ($windowMin * 60);
                        $exitWindowEnd  = $endTs   + ($windowMin * 60);

                        $forced_entry_status = ($nowTsGlobal > $entryWindowEnd) ? 'No Tap' : '';
                        $forced_exit_status  = ($nowTsGlobal > $exitWindowEnd)  ? 'No Tap' : '';

                        // Overwrite match to indicate no matching taps for timetable classroom
                        $match = [
                            'entry_time'      => '',
                            'entry_status'    => $forced_entry_status,
                            'exit_time'       => '',
                            'exit_status'     => $forced_exit_status,
                            'device_in'       => '',
                            'device_out'      => '',
                            'total_secs'      => 0,
                            'entry_delta_secs'=> null,
                            'exit_delta_secs' => null,
                            'logs_remark'     => '',
                            'entry_id'        => null,
                            'exit_id'         => null,
                        ];
                        // and clear roomNo since device belongs to other class
                        $roomNo = '';
                    }

                    // ---------------- NEW: fallback room lookup ----------------
                    // If no device-derived room number available, try to get room_no for the classroom
                    if (empty($roomNo)) {
                        $f = self::classroom_room_no_lookup($classroom);
                        if ($f !== '') $roomNo = $f;
                    }
                    // ----------------------------------------------------------

                    // final classroom label for this row: prefer timetable classroom for clarity
                    $resolved_classroom = $classroom;

                    $date_label     = (new DateTimeImmutable($date, $tz))->format('d/m/Y');
                    $time_from_lbl  = wp_date('h:i A', $startTs, $tz);
                    $time_to_lbl    = wp_date('h:i A', $endTs,   $tz);

                    $key = $date_label . '|' . $uid . '|' . $classroom . '|' . $time_from_lbl;
                    $stored_remark = isset($remarks_store[$key]) ? (string)$remarks_store[$key] : '';

                    $rows[] = [
                        'uid'               => $uid,
                        'teacher_id'        => $tid,
                        'teacher'           => $teachers[$tid]['name'],
                        'department'        => $teachers[$tid]['department'],
                        // Enforce timetable classroom display
                        'classroom'         => $resolved_classroom,
                        'timetable_classroom'=> $classroom,           // original timetable key (for reference)
                        'room_no'           => $roomNo,
                        'subject'           => $subject,
                        'time_from'         => $time_from_lbl,
                        'time_to'           => $time_to_lbl,
                        'in_time'           => $match['entry_time'],
                        'out_time'          => $match['exit_time'],
                        'entry_status'      => $match['entry_status'],
                        'exit_status'       => $match['exit_status'],
                        'entry_delta'       => $match['entry_delta_secs'],
                        'exit_delta'        => $match['exit_delta_secs'],
                        'device_in'         => $match['device_in'],
                        'device_out'        => $match['device_out'],
                        'date'              => $date_label,
                        'total_secs'        => $match['total_secs'],
                        'remark'            => $stored_remark,
                        'entry_id'          => $match['entry_id'],
                        'exit_id'           => $match['exit_id'],
                    ];
                }
            }
        }

        // Filters
        $rows = array_values(array_filter($rows, function($r) use($flt_teacher,$flt_uid,$flt_device,$flt_class,$flt_room,$flt_dept,$flt_estatus,$flt_xstatus){
            if ($flt_teacher && intval($r['teacher_id']) !== intval($flt_teacher)) return false;
            if ($flt_uid && stripos($r['uid'] ?? '', $flt_uid) === false) return false;
            if ($flt_device) {
                $devIn  = strtolower($r['device_in'] ?? '');
                $devOut = strtolower($r['device_out'] ?? '');
                $q = strtolower($flt_device);
                if (strpos($devIn, $q) === false && strpos($devOut, $q) === false) return false;
            }
            if ($flt_class) {
                // allow matching either resolved (timetable) classroom or original timetable classroom
                if (strcasecmp($r['classroom'] ?? '', $flt_class) !== 0 && strcasecmp($r['timetable_classroom'] ?? '', $flt_class) !== 0) return false;
            }
            if ($flt_room && strcasecmp($r['room_no']   ?? '', $flt_room)   !== 0) return false;
            if ($flt_dept && stripos($r['department'] ?? '', $flt_dept) === false) return false;
            if ($flt_estatus && strcasecmp($r['entry_status'] ?? '', $flt_estatus) !== 0) return false;
            if ($flt_xstatus && strcasecmp($r['exit_status']  ?? '', $flt_xstatus)  !== 0) return false;
            return true;
        }));

        // Sort — latest scheduled rows first (newest date/time at top).
        // We'll compute a timestamp for (date + time_from) and sort DESC.
        usort($rows, function($a, $b){
            $tz = wp_timezone();
            try {
                $da = DateTime::createFromFormat('n/j/Y h:i A', ($a['date'] . ' ' . $a['time_from']), $tz);
                $db = DateTime::createFromFormat('n/j/Y h:i A', ($b['date'] . ' ' . $b['time_from']), $tz);
                $ta = $da ? $da->getTimestamp() : 0;
                $tb = $db ? $db->getTimestamp() : 0;
            } catch (\Throwable $e) {
                $ta = 0; $tb = 0;
            }
            if ($ta !== $tb) return ($tb <=> $ta); // descending: larger ts first
            $c = strcmp($a['classroom'], $b['classroom']); if ($c !== 0) return $c;
            return strcmp($a['time_from'], $b['time_from']);
        });

        $total  = count($rows);
        $offset = ($page - 1) * $per;
        $paged  = array_slice($rows, $offset, $per);

        return rest_ensure_response([
            'ok'             => true,
            'grace_minutes'  => self::get_grace_minutes(),
            'window_minutes' => self::get_window_minutes(),
            'total'          => $total,
            'page'           => $page,
            'per_page'       => $per,
            'rows'           => $paged,
        ]);
    }

    /* ---------------- Helpers for precise All Logs sync (ENTRY ONLY) ---------------- */
    private static function detect_time_col() {
        global $wpdb;
        $table = $wpdb->prefix . 'rad_logs';
        $cols  = $wpdb->get_col("SHOW COLUMNS FROM {$table}", 0);
        if ($cols && is_array($cols)) {
            if (in_array('scan_time', $cols, true))  return 'scan_time';
            if (in_array('tap_time', $cols, true))   return 'tap_time';
            if (in_array('created_at', $cols, true)) return 'created_at';
        }
        return 'scan_time';
    }

    private static function find_period_bounds($classroom, DateTimeImmutable $day, $time_from_label) {
        $timetables = self::read_timetables();
        if (empty($timetables[$classroom])) return [null, null];

        list($dayShort, $dayFull) = [ $day->format('D'), $day->format('l') ];
        $daysMap = $timetables[$classroom];
        $cands = [];
        if (!empty($daysMap[$dayShort]) && is_array($daysMap[$dayShort])) $cands = array_merge($cands, $daysMap[$dayShort]);
        if (!empty($daysMap[$dayFull])  && is_array($daysMap[$dayFull]))  $cands = array_merge($cands, $daysMap[$dayFull]);

        $tz = wp_timezone();
        foreach ($cands as $p) {
            $startStr = self::normalize_time_str($p['start'] ?? '00:00');
            try {
                $startTs = (new DateTimeImmutable($day->format('Y-m-d').' '.$startStr, $tz))->getTimestamp();
            } catch (\Throwable $e) { continue; }
            $label = wp_date('h:i A', $startTs, $tz);
            if (strcasecmp($label, $time_from_label) === 0) {
                $endStr = self::normalize_time_str($p['end'] ?? '00:00');
                try {
                    $endTs = (new DateTimeImmutable($day->format('Y-m-d').' '.$endStr, $tz))->getTimestamp();
                } catch (\Throwable $e) { $endTs = null; }
                return [$startTs, $endTs];
            }
        }
        return [null, null];
    }

    // Update ONLY one entry tap row for this period (no exit update)
    private static function sync_alllogs_remark_precise($date_label, $uid, $classroom, $time_from_label, $remark) {
        global $wpdb;
        if ($uid === '' || $date_label === '') return;

        $tz = wp_timezone();
        $dt = DateTime::createFromFormat('n/j/Y', $date_label, $tz);
        if (!$dt) return;
        $ymd = $dt->format('Y-m-d');
        $day = new DateTimeImmutable($ymd.' 00:00:00', $tz);

        list($startTs, $endTs) = self::find_period_bounds($classroom, $day, $time_from_label);

        $windowMin = self::get_window_minutes();
        if (!$startTs) {
            $guess = DateTime::createFromFormat('n/j/Y h:i A', $date_label.' '.$time_from_label, $tz);
            if ($guess) $startTs = $guess->getTimestamp();
        }
        if (!$startTs) return;

        $timeCol = self::detect_time_col();
        $table   = $wpdb->prefix . 'rad_logs';

        $entryStart = (new DateTimeImmutable('@'.($startTs - ($windowMin * 60))))->setTimezone($tz)->format('Y-m-d H:i:s');
        $entryEnd   = (new DateTimeImmutable('@'.($startTs + ($windowMin * 60))))->setTimezone($tz)->format('Y-m-d H:i:s');

        $entryRowId = $wpdb->get_var( $wpdb->prepare(
            "SELECT id FROM {$table}
             WHERE uid=%s AND {$timeCol} BETWEEN %s AND %s
             ORDER BY {$timeCol} ASC
             LIMIT 1",
            $uid, $entryStart, $entryEnd
        ));
        if ($entryRowId) {
            $wpdb->update($table, ['remarks' => $remark], ['id' => intval($entryRowId)], ['%s'], ['%d']);
        }
    }

    /* ---------------- Save remark ---------------- */
    public static function ajax_update_remark() {
        if (!is_user_logged_in() || !current_user_can('read')) {
            wp_send_json_error(['error'=>'no_permission']);
        }
        self::save_remark_and_respond();
    }

    public static function ajax_update_remark_nopriv() {
        self::save_remark_and_respond();
    }

    private static function save_remark_and_respond() {
        $row_id  = isset($_POST['row_id'])  ? sanitize_text_field($_POST['row_id'])  : '';
        $remark  = isset($_POST['remark'])  ? sanitize_text_field($_POST['remark'])  : '';
        $entryId = isset($_POST['entry_id'])? intval($_POST['entry_id']) : 0;
        $exitId  = isset($_POST['exit_id']) ? intval($_POST['exit_id'])  : 0;

        if ($row_id === '') wp_send_json_error(['error'=>'missing_row_id']);

        // row_id format: "<n/j/Y>|<uid>|<classroom>|<h:i A>"
        $parts = explode('|', $row_id);
        $date_label = isset($parts[0]) ? trim($parts[0]) : '';
        $uid        = isset($parts[1]) ? trim($parts[1]) : '';
        $classroom  = isset($parts[2]) ? trim($parts[2]) : '';
        $time_from  = isset($parts[3]) ? trim($parts[3]) : '';

        // 1) Save for Staff Logs view (only this row)
        $store = get_option('rad_stafflog_remarks', []);
        if (!is_array($store)) $store = [];
        $store[$row_id] = $remark;
        update_option('rad_stafflog_remarks', $store);

        // 2) Update EXACTLY ONE raw scan in All Logs:
        // Prefer the entry tap if available; otherwise fall back to exit tap id.
        global $wpdb;
        $table = $wpdb->prefix . 'rad_logs';
        if ($entryId > 0) {
            $wpdb->update($table, ['remarks'=>$remark], ['id'=>$entryId], ['%s'], ['%d']);
        } elseif ($exitId > 0) {
            $wpdb->update($table, ['remarks'=>$remark], ['id'=>$exitId ], ['%s'], ['%d']);
        } else {
            // No IDs from front-end → fallback: update only entry window (no exit)
            self::sync_alllogs_remark_precise($date_label, $uid, $classroom, $time_from, $remark);
        }

        wp_send_json_success(['ok' => true, 'row_id' => $row_id, 'remark' => $remark, 'entry_id'=>$entryId, 'exit_id'=>$exitId]);
    }
}

RAD_Logs_Staff_Module::init();
