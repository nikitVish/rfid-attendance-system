<?php
// modules/overview/overview.php
if (! defined('ABSPATH')) exit;

class RAD_Overview_Module {
    public static function init(){
        add_action('rest_api_init', [__CLASS__, 'register_routes']);
        add_action('admin_enqueue_scripts', [__CLASS__, 'enqueue_assets']);
    }

    public static function register_routes(){
        register_rest_route('rad/v2', '/analytics/cards', [
            'methods' => 'GET',
            'callback' => [__CLASS__, 'analytics_cards'],
            'permission_callback' => function(){ return current_user_can('read'); }
        ]);
    }

    // Reuse your existing analytics logic
    public static function analytics_cards($req){
        if (function_exists('rad_api_analytics_cards')) {
            return rad_api_analytics_cards($req);
        }
        return rest_ensure_response(['ok' => true, 'counts' => []]);
    }

    public static function enqueue_assets($hook){
        if ($hook !== 'toplevel_page_rad-dashboard') return;
        $base = RAD_PLUGIN_URL . 'modules/overview/';
        wp_register_script('rad-overview-js', $base . 'admin.js', ['jquery'], '1.0', true);
        wp_register_style('rad-overview-css', $base . 'admin.css', [], '1.0');

        // Let the JS loader handle dynamic loading,
        // but if you ever want to preload manually, uncomment below:
        // wp_enqueue_script('rad-overview-js');
        // wp_enqueue_style('rad-overview-css');
    }
}

RAD_Overview_Module::init();
