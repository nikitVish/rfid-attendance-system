<?php
if (!defined('ABSPATH')) exit;

/**
 * Admin page: Add Timetable (create/update UI)
 * Enqueues modules/timetables/add/admin.js and admin.css
 */
class RAD_Timetables_Add_Page {
    public static function init() {
        add_action('admin_menu', [__CLASS__, 'menu']);
        add_action('admin_enqueue_scripts', [__CLASS__, 'assets']);
    }

    public static function menu() {
        add_submenu_page(
            'rad-root',
            'Add Timetable',
            'Add Timetable',
            'edit_posts',
            'rad-timetables-add',
            [__CLASS__, 'render']
        );
    }

    public static function assets($hook) {
        if (strpos($hook, 'rad-timetables-add') === false) return;

        // css
        wp_enqueue_style('rad-tt-add-css', plugins_url('admin.css', __FILE__), [], '1.0.0');
        // js
        wp_enqueue_script('rad-tt-add-js', plugins_url('admin.js', __FILE__), [], '1.0.0', true);

        wp_localize_script('rad-tt-add-js', 'radConfig', [
            'root'  => esc_url_raw( rest_url('rad/v2') ),
            'nonce' => wp_create_nonce('wp_rest')
        ]);
    }

    public static function render() {
        echo '<div class="wrap"><h1>Add Timetable</h1>';
        echo '<div id="rad-root-content"></div>';
        echo '<script>window.RadTimetablesAdd && RadTimetablesAdd.render(document.getElementById("rad-root-content"));</script>';
        echo '</div>';
    }
}

RAD_Timetables_Add_Page::init();
