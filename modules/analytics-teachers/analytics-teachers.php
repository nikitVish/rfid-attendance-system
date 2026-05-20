<?php
/**
 * Module: Teacher Analytics (workload, gaps, CSV export)
 *
 * Added: detect scheduling conflicts (same teacher, same day, same start & end but multiple classroom rows)
 */
if (!defined('ABSPATH')) exit;

class RAD_Analytics_Teachers_Module {
    public static function init() {
        add_action('rest_api_init', [__CLASS__, 'register_routes']);
    }

    public static function register_routes() {
        register_rest_route('rad/v2', '/analytics/teachers', [
            'methods'  => 'GET',
            'callback' => [__CLASS__, 'rest_teachers_analytics'],
            'permission_callback' => function(){ return current_user_can('read'); },
            'args' => [
                'teacher_id'    => ['type'=>'integer','required'=>true],
                'export'        => ['type'=>'string','required'=>false], // include csv export
                'include_empty' => ['type'=>'boolean','required'=>false], // include gaps section in CSV
            ]
        ]);
    }

    private static function day_label($n) {
        $names = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
        return isset($names[$n]) ? $names[$n] : (string)$n;
    }

    private static function today_index_wp() {
        // WP: current_time('timestamp') returns local TS
        $ts = current_time('timestamp');
        // 0 (Sunday) .. 6 (Saturday)
        return intval( gmdate('w', $ts) );
    }

    public static function rest_teachers_analytics($request) {
        global $wpdb;
        $teacher_id    = intval($request->get_param('teacher_id'));
        $want_csv      = strtolower($request->get_param('export') ?? '') === 'csv';
        $include_empty = filter_var($request->get_param('include_empty'), FILTER_VALIDATE_BOOLEAN);

        if ($teacher_id <= 0) {
            return new WP_Error('bad_request', 'teacher_id required', ['status'=>400]);
        }

        $tt  = $wpdb->prefix.'rad_timetables';
        $cls = $wpdb->prefix.'rad_classrooms';

        $has_classrooms = ($wpdb->get_var($wpdb->prepare(
            "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = %s",
            $cls
        )) > 0);

        // --- Canonical school slots (Mon–Sat only) ---
        // Distinct period timings used anywhere in the school during Mon–Sat
        $slot_rows = $wpdb->get_results("
            SELECT DISTINCT start_time, end_time
            FROM $tt
            WHERE day_of_week BETWEEN 1 AND 6
            ORDER BY start_time ASC
        ", ARRAY_A) ?: [];

        $slots = [];
        foreach ($slot_rows as $sr) {
            $s = trim($sr['start_time'] ?? '');
            $e = trim($sr['end_time'] ?? '');
            if ($s === '' || $e === '' || $s === $e) continue;
            $slots[] = [
                'raw_start' => $s,
                'raw_end'   => $e,
                'label'     => date('h:i A', strtotime($s)) . ' to ' . date('h:i A', strtotime($e)),
            ];
        }

        // Teacher rows
        $rows = $wpdb->get_results($wpdb->prepare("
            SELECT id, classroom_id, day_of_week, start_time, end_time, subject, teacher_id, meta, created_at
            FROM $tt
            WHERE teacher_id = %d
            ORDER BY day_of_week ASC, start_time ASC
        ", $teacher_id), ARRAY_A) ?: [];

        // classroom names (optional)
        $classNames = [];
        if ($has_classrooms && $rows) {
            $classroomIds = array_unique(array_map(fn($r)=>intval($r['classroom_id']), $rows));
            if ($classroomIds) {
                $in = implode(',', array_map('intval',$classroomIds));
                $cl = $wpdb->get_results("SELECT id, name FROM $cls WHERE id IN ($in)", ARRAY_A) ?: [];
                foreach ($cl as $c) $classNames[intval($c['id'])] = $c['name'];
            }
        }

        // Build per-day buckets (0..6)
        $days = [];
        for ($d=0;$d<7;$d++) $days[$d] = [];
        foreach ($rows as $r) {
            $d = intval($r['day_of_week']);
            $days[$d][] = $r;
        }

        $outDays = [];
        $daily_totals = array_fill(0,7,0);
        $daily_gaps   = array_fill(0,7,0);
        $weekly_total = 0;
        $weekly_gaps  = 0;

        // Helper for quick lookup: slot key "HH:MM:SS|HH:MM:SS"
        $slot_keys = array_map(function($sl){ return $sl['raw_start'].'|'.$sl['raw_end']; }, $slots);

        foreach ($days as $di => $list) {
            // sort by start_time (24h)
            usort($list, fn($a,$b)=>strcmp($a['start_time'],$b['start_time']));

            // periods this teacher actually has on day $di
            $periods = [];
            $has_key = []; // set of slot keys teacher covers today

            foreach ($list as $r) {
                $key = $r['start_time'].'|'.$r['end_time'];
                $has_key[$key] = true;
                $periods[] = [
                    'id'           => intval($r['id']),
                    'classroom_id' => intval($r['classroom_id']),
                    'classroom'    => $classNames[intval($r['classroom_id'])] ?? ('Class ' . $r['classroom_id']),
                    'subject'      => (string)$r['subject'],
                    'time_from'    => date('h:i A', strtotime($r['start_time'])),
                    'time_to'      => date('h:i A', strtotime($r['end_time'])),
                    'raw_start'    => $r['start_time'],
                    'raw_end'      => $r['end_time'],
                    'day'          => self::day_label($di),
                ];
            }

            // Gaps = every canonical slot not present in has_key (Mon–Sat logic)
            $gaps = [];
            if ($di >= 1 && $di <= 6) {
                foreach ($slots as $sl) {
                    $k = $sl['raw_start'].'|'.$sl['raw_end'];
                    if (!isset($has_key[$k])) {
                        $fromTS = strtotime($sl['raw_start']);
                        $toTS   = strtotime($sl['raw_end']);
                        $gaps[] = [
                            'from'       => date('h:i A', $fromTS),
                            'to'         => date('h:i A', $toTS),
                            'raw_from'   => $sl['raw_start'],
                            'raw_to'     => $sl['raw_end'],
                            'length_min' => intval(round(($toTS-$fromTS)/60)),
                            'day'        => self::day_label($di),
                        ];
                    }
                }
            }

            // --- Conflict detection: same start+end with more than 1 row
            $conflicts = [];
            // group by key
            $grouped = [];
            foreach ($list as $r) {
                $k = $r['start_time'].'|'.$r['end_time'];
                if (!isset($grouped[$k])) $grouped[$k] = [];
                $grouped[$k][] = $r;
            }
            foreach ($grouped as $k => $rowsGroup) {
                if (count($rowsGroup) > 1) {
                    // build conflict entry
                    $parts = [];
                    foreach ($rowsGroup as $rg) {
                        $parts[] = [
                            'timetable_id' => intval($rg['id']),
                            'classroom_id' => intval($rg['classroom_id']),
                            'classroom'    => $classNames[intval($rg['classroom_id'])] ?? ('Class ' . $rg['classroom_id']),
                            'subject'      => (string)$rg['subject'],
                            'start_time'   => $rg['start_time'],
                            'end_time'     => $rg['end_time'],
                        ];
                    }
                    // push conflict record with start/end & involved entries
                    list($sraw,$eraw) = explode('|',$k) + ['', ''];
                    $conflicts[] = [
                        'raw_start' => $sraw,
                        'raw_end'   => $eraw,
                        'from'      => date('h:i A', strtotime($sraw)),
                        'to'        => date('h:i A', strtotime($eraw)),
                        'day'       => self::day_label($di),
                        'involved'  => $parts,
                    ];
                }
            }

            $daily_totals[$di] = count($periods);
            $daily_gaps[$di]   = count($gaps);

            // Weekly sums: Mon–Sat only
            if ($di >= 1 && $di <= 6) {
                $weekly_total += $daily_totals[$di];
                $weekly_gaps  += $daily_gaps[$di];
            }

            $outDays[] = [
                'day_index' => $di,
                'day'       => self::day_label($di),
                'periods'   => $periods,
                'gaps'      => $gaps,
                'conflicts' => $conflicts, // <-- new: conflicts per day
                'total'     => $daily_totals[$di],
                'gaps_total'=> $daily_gaps[$di],
            ];
        }

        // teacher header
        $t_table = $wpdb->prefix.'rad_teachers';
        $teacher = $wpdb->get_row($wpdb->prepare(
            "SELECT id, name, department FROM $t_table WHERE id=%d", $teacher_id
        ), ARRAY_A);
        if (!$teacher) $teacher = ['id'=>$teacher_id,'name'=>'Teacher #'.$teacher_id,'department'=>''];

        $today = self::today_index_wp();

        // CSV export (keeps same structure; gaps section uses canonical gaps)
        if ($want_csv) {
            $csv = fopen('php://temp','w+');
            fputcsv($csv, ['Teacher Analytics']);
            fputcsv($csv, ['Teacher', $teacher['name'] ?? '', 'Department', $teacher['department'] ?? '']);
            fputcsv($csv, []);
            fputcsv($csv, ['Day','Classroom','Subject','Start','End']);

            foreach ($outDays as $d) {
                foreach ($d['periods'] as $p) {
                    fputcsv($csv, [$d['day'],$p['classroom'],$p['subject'],$p['time_from'],$p['time_to']]);
                }
                if ($include_empty && !empty($d['gaps'])) {
                    fputcsv($csv, []); fputcsv($csv,['Gaps']);
                    fputcsv($csv, ['From','To','Length(min)']);
                    foreach ($d['gaps'] as $g) {
                        fputcsv($csv, [$g['from'],$g['to'],$g['length_min']]);
                    }
                }
                if (!empty($d['conflicts'])) {
                    fputcsv($csv, []);
                    fputcsv($csv, ['Conflicts detected:']);
                    foreach ($d['conflicts'] as $c) {
                        $involvedTxt = array_map(fn($x)=>($x['classroom'].' ('.$x['subject'].')'), $c['involved']);
                        fputcsv($csv, ['Conflict', $c['from'].' - '.$c['to'], implode(' ; ', $involvedTxt)]);
                    }
                }
                fputcsv($csv, ['Daily total = '.$d['total']]);
                if ($include_empty) fputcsv($csv, ['Gaps total = '.$d['gaps_total']]);
                fputcsv($csv, []);
            }
            fputcsv($csv, ['Weekly total (Mon–Sat) = '.$weekly_total]);
            if ($include_empty) fputcsv($csv, ['Weekly gaps (Mon–Sat) = '.$weekly_gaps]);

            rewind($csv);
            $out = stream_get_contents($csv);
            fclose($csv);

            nocache_headers();
            header('Content-Type: text/csv; charset=utf-8');
            header('Content-Disposition: attachment; filename="teacher-analytics-'.$teacher_id.'.csv"');
            echo $out; exit;
        }

        // normal JSON - keep previous keys plus days now include conflicts
        return rest_ensure_response([
            'ok' => true,
            'teacher' => [
                'id' => $teacher['id'],
                'name' => $teacher['name'],
                'department' => $teacher['department'],
            ],
            'slots'         => $slots,          // canonical headers for FE
            'days'          => $outDays,
            'daily_totals'  => array_values($daily_totals),
            'daily_gaps'    => array_values($daily_gaps),
            'weekly_total'  => $weekly_total,   // Mon–Sat only
            'weekly_gaps'   => $weekly_gaps,    // Mon–Sat only
            'today_index'   => $today,
            'today_total'   => ($today === 0 ? 0 : $daily_totals[$today]),
            'today_gaps'    => ($today === 0 ? 0 : $daily_gaps[$today]),
        ]);
    }
}

RAD_Analytics_Teachers_Module::init();
