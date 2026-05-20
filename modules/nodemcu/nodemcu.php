<?php
// modules/devices/nodemcu-compat.php
// Robust NodeMCU endpoint: dynamically adapts to rad_logs table columns before inserting.
// Place at: wp-content/plugins/rfid-attendance/modules/devices/nodemcu-compat.php

if ( ! defined( 'ABSPATH' ) ) exit;

if ( ! class_exists( 'RAD_NodeMCU_Compat' ) ) {

class RAD_NodeMCU_Compat {

    public static function init() {
        if ( defined('WP_DEBUG') && WP_DEBUG ) {
            error_log('RAD_NodeMCU_Compat: init called');
        }
        add_action( 'rest_api_init', array( __CLASS__, 'register_routes' ) );
    }

    public static function register_routes() {
    $args = array(
        array(
            'methods'  => WP_REST_Server::READABLE,
            'callback' => array( __CLASS__, 'handle_request' ),
            'permission_callback' => '__return_true'
        ),
        array(
            'methods'  => WP_REST_Server::CREATABLE,
            'callback' => array( __CLASS__, 'handle_request' ),
            'permission_callback' => '__return_true'
        ),
    );

    // Full UID + device route for v1 and v2
    register_rest_route( 'rad/v1', '/nodemcu/log/teacher/(?P<uid>[^/]+)/(?P<device>[^/]+)', $args );
    register_rest_route( 'rad/v2', '/nodemcu/log/teacher/(?P<uid>[^/]+)/(?P<device>[^/]+)', $args );

    // UID-only variant (device via query param) for v1 and v2
    register_rest_route( 'rad/v1', '/nodemcu/log/teacher/(?P<uid>[^/]+)', $args );
    register_rest_route( 'rad/v2', '/nodemcu/log/teacher/(?P<uid>[^/]+)', $args );
}


    /**
     * Handler: accepts GET or POST and writes a log row.
     */
    public static function handle_request( $request ) {
        global $wpdb;

        if ( defined('WP_DEBUG') && WP_DEBUG ) error_log('RAD_NodeMCU_Compat: handle_request invoked');

        // collect params (route, query, body)
        $uid = $request->get_param('uid');
        $device = $request->get_param('device') ?: $request->get_param('device_id') ?: '';
        $room = '';
        $remarks = '';

        if ( $request->get_method() === 'POST' ) {
            $body = $request->get_json_params();
            if ( is_array($body) ) {
                if ( empty($uid) && isset($body['uid']) ) $uid = $body['uid'];
                if ( empty($device) && (isset($body['device']) || isset($body['device_id'])) ) {
                    $device = isset($body['device']) ? $body['device'] : $body['device_id'];
                }
                $room = isset($body['room']) ? $body['room'] : (isset($body['location']) ? $body['location'] : '');
                $remarks = isset($body['remarks']) ? $body['remarks'] : '';
            }
        } else {
            $room = $request->get_param('room') ?: '';
            $remarks = $request->get_param('remarks') ?: '';
        }

        // sanitize
        $uid = is_string($uid) ? sanitize_text_field($uid) : '';
        $device = is_string($device) ? sanitize_text_field($device) : '';
        $room = is_string($room) ? sanitize_text_field($room) : '';
        $remarks = is_string($remarks) ? sanitize_text_field($remarks) : '';

        if ( empty($uid) ) {
            if ( defined('WP_DEBUG') && WP_DEBUG ) error_log('RAD_NodeMCU_Compat: missing uid');
            return new WP_REST_Response( array('ok'=>false,'message'=>'missing uid'), 400 );
        }

        if ( empty($device) ) $device = 'unknown';
        $uid = strtoupper( $uid );

        //
        // NEW: prefer client-sent epoch 'ts' if provided and valid.
        // Accept ts from query (?ts=...) or POST body { "ts": 169xxx }
        //
        $ts_param = null;
        // try query / route / request param
        $raw_ts = $request->get_param('ts');
        if ( $raw_ts === null ) {
            // try GET/POST array explicitly
            if ( isset($_GET['ts']) ) $raw_ts = $_GET['ts'];
            elseif ( isset($_POST['ts']) ) $raw_ts = $_POST['ts'];
            else {
                $body = $request->get_json_params();
                if ( is_array($body) && isset($body['ts']) ) $raw_ts = $body['ts'];
            }
        }

        if ( $raw_ts !== null ) {
            // normalize to integer if possible
            if ( is_numeric($raw_ts) ) {
                $ts_param = intval($raw_ts);
            } else {
                // attempt to parse string numeric
                $raw_ts = trim((string)$raw_ts);
                if ( ctype_digit($raw_ts) ) $ts_param = intval($raw_ts);
            }
        }

        // Validate ts_param: require reasonable epoch (>= 1600000000 (2020))
        $scan_time = current_time('mysql'); // default fallback
        if ( $ts_param && $ts_param >= 1600000000 && $ts_param <= ( time() + 86400 ) ) {
            // Convert epoch to WP-local time using site's GMT offset
            $gmt_offset_hours = floatval( get_option('gmt_offset', 0) );
            $offset_seconds = intval( $gmt_offset_hours * 3600 );
            // gmdate + offset to get local time representation
            $scan_time = gmdate( 'Y-m-d H:i:s', intval($ts_param) + $offset_seconds );
            if ( defined('WP_DEBUG') && WP_DEBUG ) {
                error_log("RAD_NodeMCU_Compat: using client ts={$ts_param} adjusted scan_time={$scan_time}");
            }
        } else {
            if ( defined('WP_DEBUG') && WP_DEBUG ) {
                if ( $ts_param ) error_log("RAD_NodeMCU_Compat: client ts invalid/out-of-range: {$ts_param} — using server time");
                else error_log("RAD_NodeMCU_Compat: client ts not provided — using server time");
            }
            $scan_time = current_time('mysql');
        }

        // detect which columns exist in logs table
        $logs_table = $wpdb->prefix . 'rad_logs';
        // check table exists
        $exists = $wpdb->get_var( $wpdb->prepare("SHOW TABLES LIKE %s", $logs_table) );
        if ( $exists !== $logs_table ) {
            if ( defined('WP_DEBUG') && WP_DEBUG ) error_log("RAD_NodeMCU_Compat: logs table {$logs_table} not found");
            return new WP_REST_Response( array('ok'=>false,'message'=>'rad_logs_table_missing','table'=>$logs_table), 500 );
        }

        $cols = $wpdb->get_results( "SHOW COLUMNS FROM {$logs_table}", ARRAY_A );
        $present = array();
        foreach ($cols as $c) {
            $present[] = $c['Field'];
        }

        // Build insert payload only for columns present
        $insert_data = array();
        $insert_formats = array();

        // Common columns most installs will have:
        if ( in_array('uid', $present) ) {
            $insert_data['uid'] = $uid; $insert_formats[] = '%s';
        }
        if ( in_array('device_id', $present) ) {
            $insert_data['device_id'] = $device; $insert_formats[] = '%s';
        } elseif ( in_array('device', $present) ) {
            // fallback to older schema that used "device"
            $insert_data['device'] = $device; $insert_formats[] = '%s';
        }

        // scan_time / tap_time / created_at: use $scan_time computed above
        if ( in_array('scan_time', $present) ) {
            $insert_data['scan_time'] = $scan_time; $insert_formats[] = '%s';
        } elseif ( in_array('tap_time', $present) ) {
            $insert_data['tap_time'] = $scan_time; $insert_formats[] = '%s';
        } elseif ( in_array('created_at', $present) ) {
            $insert_data['created_at'] = $scan_time; $insert_formats[] = '%s';
        }

        // optional columns
        if ( in_array('room', $present) ) {
            $insert_data['room'] = $room; $insert_formats[] = '%s';
        }
        if ( in_array('remarks', $present) ) {
            $insert_data['remarks'] = $remarks; $insert_formats[] = '%s';
        }
        if ( in_array('meta', $present) ) {
            // store device in meta if present as placeholder
            $insert_data['meta'] = maybe_serialize(array('device'=>$device));
            $insert_formats[] = '%s';
        }

        // If none of the columns we expect exist, bail with helpful message
        if ( empty($insert_data) ) {
            if ( defined('WP_DEBUG') && WP_DEBUG ) error_log('RAD_NodeMCU_Compat: no suitable columns found in ' . $logs_table);
            return new WP_REST_Response(array('ok'=>false,'message'=>'no_suitable_columns_found','table'=>$logs_table,'present'=>$present), 500);
        }

        // do insert
        $res = $wpdb->insert( $logs_table, $insert_data, $insert_formats );

        if ( $res === false ) {
            $last_err = isset($wpdb->last_error) ? $wpdb->last_error : '';
            if ( defined('WP_DEBUG') && WP_DEBUG ) {
                error_log('RAD_NodeMCU_Compat: DB insert failed: ' . $last_err . ' -- attempted columns: ' . implode(',', array_keys($insert_data)) );
            }
            return new WP_REST_Response( array('ok'=>false,'message'=>'db_insert_failed','db_error'=>$last_err), 500 );
        }

        $log_id = intval( $wpdb->insert_id );

        // attempt to resolve teacher id from entity_meta if present
        $teacher_id = null;
        $entity_meta_table = $wpdb->prefix . 'rad_entity_meta';
        $table_exists_meta = $wpdb->get_var( $wpdb->prepare("SHOW TABLES LIKE %s", $entity_meta_table) );
        if ( $table_exists_meta === $entity_meta_table ) {
            $teacher_id = $wpdb->get_var(
                $wpdb->prepare(
                    "SELECT entity_id FROM {$entity_meta_table} WHERE entity_type=%s AND field_key=%s AND meta_value = %s LIMIT 1",
                    'teachers',
                    'uid',
                    $uid
                )
            );
            $teacher_id = $teacher_id ? intval($teacher_id) : null;
        }

        if ( defined('WP_DEBUG') && WP_DEBUG ) {
            error_log('RAD_NodeMCU_Compat: inserted log_id=' . $log_id . ' uid=' . $uid . ' device=' . $device . ' scan_time=' . $scan_time );
        }

        return rest_ensure_response( array(
            'ok' => true,
            'log_id' => $log_id,
            'uid' => $uid,
            'device_id' => $device,
            'scan_time' => $scan_time,
            'teacher_id' => $teacher_id
        ) );
    }

} // class

} // if class exists

// init
RAD_NodeMCU_Compat::init();