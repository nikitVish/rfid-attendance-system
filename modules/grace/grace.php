<?php
/**
 * RAD Add Grace Module (Enhanced)
 * Adds new field: Window Open Time (minutes)
 */
if (!defined('ABSPATH')) exit;

class RAD_Grace_Module {
    public static function init() {
        add_action('rest_api_init', [__CLASS__, 'register_routes']);
        add_action('admin_enqueue_scripts', [__CLASS__, 'enqueue_assets']);
    }

    public static function register_routes() {
        register_rest_route('rad/v2', '/grace', [
            [
                'methods'  => 'GET',
                'callback' => [__CLASS__, 'api_get_grace'],
                'permission_callback' => function() { return current_user_can('manage_options'); }
            ],
            [
                'methods'  => 'POST',
                'callback' => [__CLASS__, 'api_save_grace'],
                'permission_callback' => function() { return current_user_can('manage_options'); }
            ]
        ]);
    }

    public static function api_get_grace($request) {
        $row = get_option('rad_grace_settings', []);
        $duration = isset($row['duration']) ? intval($row['duration']) : 0;
        $unit = isset($row['unit']) ? sanitize_text_field($row['unit']) : 'minute';
        $window = isset($row['window_minutes']) ? intval($row['window_minutes']) : '';

        return rest_ensure_response([
            'ok' => true,
            'row' => [
                'duration' => $duration,
                'unit' => $unit,
                'window_minutes' => $window
            ]
        ]);
    }

    public static function api_save_grace($request) {
        $body = $request->get_json_params();
        $duration = isset($body['duration']) ? intval($body['duration']) : 0;
        $unit = isset($body['unit']) ? sanitize_text_field($body['unit']) : 'minute';
        $window = isset($body['window_minutes']) ? intval($body['window_minutes']) : 0;

        $data = [
            'duration' => $duration,
            'unit' => $unit,
            'window_minutes' => $window
        ];
        update_option('rad_grace_settings', $data);

        return rest_ensure_response(['ok' => true, 'saved' => $data]);
    }

    public static function enqueue_assets($hook) {
        if ($hook !== 'toplevel_page_rad-dashboard') return;
        $base = plugin_dir_url(__FILE__);
        wp_register_script('rad-grace-js', $base . 'admin.js', [], '1.1.0', true);
        wp_register_style('rad-grace-css', $base . 'admin.css', [], '1.1.0');
    }
}
RAD_Grace_Module::init();
