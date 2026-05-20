<?php
if (!defined('ABSPATH')) exit;

/**
 * Admin page: All Timetables (grid + Edit modal)
 * Enqueues modules/timetables/all/admin.js and admin.css
 */
class RAD_Timetables_All_Page {
    public static function init() {
        add_action('admin_menu', [__CLASS__, 'menu']);
        add_action('admin_enqueue_scripts', [__CLASS__, 'assets']);
    }

    public static function menu() {
        add_submenu_page(
            'rad-root',                 // parent slug (your main plugin menu slug)
            'Timetables',               // page title
            'Timetables',               // menu title
            'read',                     // capability
            'rad-timetables-all',       // menu slug
            [__CLASS__, 'render']
        );
    }

    public static function assets($hook) {
        if (strpos($hook, 'rad-timetables-all') === false) return;

        $base = plugins_url('', __FILE__);
        // css
        wp_enqueue_style('rad-tt-all-css', plugins_url('admin.css', __FILE__), [], '1.0.0');
        // js
        wp_enqueue_script('rad-tt-all-js', plugins_url('admin.js', __FILE__), [], '1.0.0', true);

        // Localize REST root + nonce for fetch()
        wp_localize_script('rad-tt-all-js', 'radConfig', [
            'root'  => esc_url_raw( rest_url('rad/v2') ),
            'nonce' => wp_create_nonce('wp_rest')
        ]);
    }

    public static function render() {
        echo '<div class="wrap"><h1>Classroom Timetables</h1>';
        echo '<div id="rad-root-content"></div>';
        echo '<script>window.RadTimetablesAll && RadTimetablesAll.render(document.getElementById("rad-root-content"));</script>';
        echo '</div>';
    }
}

RAD_Timetables_All_Page::init();
