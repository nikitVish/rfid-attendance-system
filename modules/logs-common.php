<?php
// modules/logs-common.php
if (!defined('ABSPATH')) exit;

/**
 * Shared helpers for Logs modules.
 * Safe to include from multiple places.
 */
if (!class_exists('RAD_Logs_Common')) {
class RAD_Logs_Common {

    /** Table name helpers */
    public static function table($suffix){
        global $wpdb;
        return $wpdb->prefix . 'rad_' . $suffix;
    }

    /**
     * Get site-local Y-m-d and Y-m-d H:i:s ranges respecting WP timezone.
     */
    public static function site_date($date = null){
        $tz = wp_timezone();
        if (empty($date)) {
            // today in site tz
            return wp_date('Y-m-d', time(), $tz);
        }
        // Normalize incoming date (YYYY-MM-DD or any strtotime parsable)
        $ts = is_numeric($date) ? intval($date) : strtotime($date);
        if (!$ts) $ts = time();
        return wp_date('Y-m-d', $ts, $tz);
    }

    public static function site_range_for_date($date){
        $tz = wp_timezone();
        $d = self::site_date($date);
        // 00:00:00 to 23:59:59 in site tz
        $start = DateTime::createFromFormat('Y-m-d H:i:s', $d.' 00:00:00', $tz);
        $end   = DateTime::createFromFormat('Y-m-d H:i:s', $d.' 23:59:59', $tz);
        return array(
            'from' => $start->format('Y-m-d H:i:s'),
            'to'   => $end->format('Y-m-d H:i:s'),
            'day_name' => wp_date('l', $start->getTimestamp(), $tz) // Monday..Sunday
        );
    }

    /**
     * Grace seconds (fallback 300s = 5 min) from DB option/table if present.
     */
    public static function get_grace_seconds(){
        // Try an option first (configure from settings)
        $opt = get_option('rad_grace_seconds');
        if (is_numeric($opt)) return max(0, intval($opt));

        // Optional: rad_grace table (take the first/active)
        global $wpdb;
        $tbl = self::table('grace');
        if ($wpdb->get_var($wpdb->prepare("SHOW TABLES LIKE %s", $tbl)) === $tbl) {
            $sec = $wpdb->get_var("SELECT grace_seconds FROM {$tbl} WHERE is_active=1 ORDER BY id DESC LIMIT 1");
            if (is_numeric($sec)) return max(0, intval($sec));
        }

        return 300; // default 5 minutes
    }

    /**
     * Human-friendly status text.
     */
    public static function status_text($code){
        $map = array(
            'ontime'       => 'On Time',
            'early'        => 'Early Arrival',
            'late'         => 'Late Arrival',
            'exit_early'   => 'Early Exit',
            'exit_late'    => 'Late Exit',
            'unscheduled'  => 'Unscheduled',
        );
        return isset($map[$code]) ? $map[$code] : ucfirst(str_replace('_',' ', (string)$code));
    }

    /**
     * Build teacher maps:
     *  - by_id[id]     => ['id','name','department','classroom','uid', ...]
     *  - by_uid[uid]   => teacher_id
     */
    public static function get_teachers_map(){
        global $wpdb;
        $t_tbl = self::table('teachers');
        $m_tbl = self::table('entity_meta');

        // Teachers
        $teachers = $wpdb->get_results("SELECT id, name, department FROM {$t_tbl}", ARRAY_A);
        $by_id = array();
        foreach ($teachers as $t) {
            $by_id[ intval($t['id']) ] = array(
                'id' => intval($t['id']),
                'name' => $t['name'],
                'department' => $t['department'],
                'classroom' => '', // from meta
                'uid' => '',       // from meta
            );
        }

        // Meta: uid / classroom / room etc
        if ($wpdb->get_var($wpdb->prepare("SHOW TABLES LIKE %s", $m_tbl)) === $m_tbl) {
            $meta = $wpdb->get_results("SELECT entity_id, meta_key, meta_value FROM {$m_tbl}", ARRAY_A);
            foreach ($meta as $m) {
                $eid = intval($m['entity_id']);
                if (!isset($by_id[$eid])) continue;
                $k = $m['meta_key'];
                $v = maybe_unserialize($m['meta_value']);
                if ($k === 'uid') $by_id[$eid]['uid'] = (string)$v;
                if ($k === 'classroom') $by_id[$eid]['classroom'] = (string)$v;
                if ($k === 'room') $by_id[$eid]['room'] = (string)$v;
                if ($k === 'subject') $by_id[$eid]['subject'] = (string)$v;
            }
        }

        $by_uid = array();
        foreach ($by_id as $id => $row) {
            if (!empty($row['uid'])) $by_uid[ (string)$row['uid'] ] = $id;
        }

        return array('by_id' => $by_id, 'by_uid' => $by_uid);
    }

    /**
     * Fetch raw scans between datetime range.
     * Filters: uid, device_id, teacher_id (either on row or via map), classroom
     */
    public static function fetch_raw_logs($from_dt, $to_dt, $filters=array()){
        global $wpdb;
        $l_tbl = self::table('logs');

        $where = array("scan_time BETWEEN %s AND %s");
        $params = array($from_dt, $to_dt);

        if (!empty($filters['device_id'])) {
            $where[] = "device_id = %s";
            $params[] = $filters['device_id'];
        }
        if (!empty($filters['uid'])) {
            $where[] = "uid = %s";
            $params[] = $filters['uid'];
        }
        if (!empty($filters['teacher_id'])) {
            // Either stored in logs (if your table has teacher_id) or we will post-map
            if ($wpdb->get_results("SHOW COLUMNS FROM {$l_tbl} LIKE 'teacher_id'")) {
                $where[] = "teacher_id = %d";
                $params[] = intval($filters['teacher_id']);
            }
        }

        $sql = "SELECT id, uid, device_id, scan_time";
        // include teacher_id if present
        if ($wpdb->get_results("SHOW COLUMNS FROM {$l_tbl} LIKE 'teacher_id'")) {
            $sql .= ", teacher_id";
        }
        $sql .= " FROM {$l_tbl} WHERE " . implode(' AND ', $where) . " ORDER BY scan_time ASC";

        $prepared = call_user_func_array(array($wpdb,'prepare'), array_merge(array($sql), $params));
        $rows = $wpdb->get_results($prepared, ARRAY_A);

        return $rows ?: array();
    }

    /**
     * Load timetable slots for a teacher/day from rad_timetables, if table exists.
     * Returns array of ['time_from'=>'HH:MM','time_to'=>'HH:MM','subject'=>..., 'classroom'=>...]
     */
    public static function get_timetable_slots($teacher_id, $day_name){
        global $wpdb;
        $tbl = self::table('timetables');
        if ($wpdb->get_var($wpdb->prepare("SHOW TABLES LIKE %s", $tbl)) !== $tbl) {
            return array(); // table absent
        }
        $rows = $wpdb->get_results(
            $wpdb->prepare(
                "SELECT classroom, subject, time_from, time_to FROM {$tbl} WHERE teacher_id=%d AND day_of_week=%s ORDER BY time_from ASC",
                intval($teacher_id),
                $day_name
            ), ARRAY_A
        );
        return $rows ?: array();
    }

    /**
     * Decide status of a scan vs optional timetable slots.
     * If no slot matches: 'unscheduled'
     */
    public static function compute_status($scan_ts, $slots, $grace_sec){
        if (empty($slots)) return array('code'=>'unscheduled', 'slot'=>null);

        // scan_ts: 'Y-m-d H:i:s' in site tz
        $st_ts = strtotime($scan_ts);
        foreach ($slots as $slot) {
            // Compare only HH:MM; assume same day
            $from = isset($slot['time_from']) ? $slot['time_from'] : (isset($slot['time_from'])?$slot['time_from']:'00:00');
            $to   = isset($slot['time_to'])   ? $slot['time_to']   : (isset($slot['time_to'])  ?$slot['time_to']  :'00:00');

            $base_day = substr($scan_ts, 0, 10); // Y-m-d
            $from_ts = strtotime($base_day . ' ' . $from . ':00');
            $to_ts   = strtotime($base_day . ' ' . $to   . ':00');

            if ($st_ts >= ($from_ts - $grace_sec) && $st_ts <= ($to_ts + $grace_sec)) {
                // Determine early/ontime/late near the 'from' boundary
                if (abs($st_ts - $from_ts) <= $grace_sec) {
                    return array('code'=>'ontime', 'slot'=>$slot);
                } elseif ($st_ts < $from_ts) {
                    return array('code'=>'early', 'slot'=>$slot);
                } else {
                    return array('code'=>'late', 'slot'=>$slot);
                }
            }
        }
        return array('code'=>'unscheduled', 'slot'=>null);
    }
}}
