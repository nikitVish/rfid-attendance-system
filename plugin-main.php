<?php
/**
 * Plugin Name: RFID Attendance Manager (Modular)
 * Description: Modular loader for RFID Attendance System.
 * Version: 1.2.0
 */

if (!defined('ABSPATH')) exit;

define('RAD_PLUGIN_DIR', plugin_dir_path(__FILE__));
define('RAD_PLUGIN_URL', plugin_dir_url(__FILE__));
define('RAD_MODULES_DIR', RAD_PLUGIN_DIR . 'modules/');

require_once RAD_PLUGIN_DIR . 'activation-tables.php'; // activation DB SQL

/* ------------------------------------------------------------------------
 * Activation
 * --------------------------------------------------------------------- */
register_activation_hook(__FILE__, 'rad_plugin_activate');
function rad_plugin_activate(){
    rad_activate_tables();

    // If modules need activation hooks, call them here:
    foreach (glob(RAD_MODULES_DIR . '*', GLOB_ONLYDIR) as $m) {
        $f = $m . '/' . basename($m) . '-activate.php';
        if (file_exists($f)) include_once $f;
    }
}

/* ------------------------------------------------------------------------
 * Module loading (top-level + one-level nested folders)
 * --------------------------------------------------------------------- */
add_action('plugins_loaded', 'rad_load_modules');
function rad_load_modules(){
    // Top-level bootstraps: modules/<name>/<name>.php
    foreach (glob(RAD_MODULES_DIR . '*', GLOB_ONLYDIR) as $moddir) {
        $bootstrap = $moddir . '/' . basename($moddir) . '.php';
        if (file_exists($bootstrap)) require_once $bootstrap;
    }

    // Defensive: ensure Rooms module is loaded even if autoloader missed it
    $rooms_boot = RAD_MODULES_DIR . 'rooms/rooms.php';
    if (file_exists($rooms_boot)) {
        require_once $rooms_boot;
    }

    // Nested sub-modules: modules/<name>/<sub>/<sub>.php (one level deep)
    foreach (glob(RAD_MODULES_DIR . '*', GLOB_ONLYDIR) as $moddir) {
        $subdirs = glob($moddir . '/*', GLOB_ONLYDIR);
        if ($subdirs) {
            foreach ($subdirs as $sub) {
                $sub_boot = $sub . '/' . basename($sub) . '.php';
                if (file_exists($sub_boot)) {
                    require_once $sub_boot;
                }
            }
        }
    }
}

/* ------------------------------------------------------------------------
 * REST auth: allow plugin session to pass capability checks in REST
 * --------------------------------------------------------------------- */
add_filter('rest_authentication_errors', 'rad_rest_allow_plugin_session', 10);
function rad_rest_allow_plugin_session($result) {
    if ($result instanceof WP_Error) return $result;

    // If a WP user is logged in already, let normal flow continue.
    if (is_user_logged_in()) return $result;

    // The login module provides get_valid_session(); ensure it's loaded
    if (!class_exists('RAD_Login_Module')) {
        $login_boot = RAD_MODULES_DIR . 'login/login.php';
        if (file_exists($login_boot)) require_once $login_boot;
    }
    if (!class_exists('RAD_Login_Module')) return $result;

    $sess = RAD_Login_Module::get_valid_session();
    if (!$sess) return $result;

    // Build a lightweight WP_User-like object
    $fake = new WP_User();
    $fake->ID = 0;
    $fake->user_login  = !empty($sess['name']) ? $sess['name'] : ('teacher_'.$sess['id']);
    $fake->display_name = !empty($sess['name']) ? $sess['name'] : $fake->user_login;
    $fake->roles = array();
    $role = isset($sess['role']) ? $sess['role'] : 'staff';
    $role_slug = strtolower($role);
    $fake->roles[] = $role_slug;

    // Minimal capability set used by modules
    $allcaps = array(
        'read'           => true,
        'edit_posts'     => true,
        'publish_posts'  => true,
    );

    // Elevate if admin
    if (in_array($role_slug, array('admin','administrator'))) {
        $allcaps['manage_options']   = true;
        $allcaps['edit_others_posts'] = true;
    }

    $fake->caps    = $allcaps;
    $fake->allcaps = $allcaps;

    // Set global current user
    global $current_user;
    $current_user = $fake;
    wp_set_current_user(0);

    return null;
}

/* ------------------------------------------------------------------------
 * Shared helpers (used by both wp-admin page and front-end shortcode)
 * --------------------------------------------------------------------- */
function rad_get_session_user_like() {
    // Prefer real WP user if present
    if (is_user_logged_in()) {
        $u = wp_get_current_user();
        return [
            'id'   => (int)$u->ID,
            'name' => $u->display_name ?: $u->user_login,
            'role' => (!empty($u->roles) && is_array($u->roles)) ? $u->roles[0] : 'staff',
        ];
    }

    // Fall back to plugin session
    if (!class_exists('RAD_Login_Module')) {
        $login_boot = RAD_MODULES_DIR . 'login/login.php';
        if (file_exists($login_boot)) require_once $login_boot;
    }
    $s = class_exists('RAD_Login_Module') ? RAD_Login_Module::get_valid_session() : null;
    if ($s) {
        return [
            'id'   => (int)$s['id'],
            'name' => !empty($s['name']) ? $s['name'] : (!empty($s['phone']) ? $s['phone'] : 'User'),
            'role' => strtolower($s['role'] ?? 'staff'),
        ];
    }
    return null;
}

function rad_render_dashboard_shell($display_name) {
    // Prints the same HTML shell and sidebar (includes Analytics)
    ?>
    <div class="wrap rad-admin-wrap" style="padding:0;">
      <div class="rad-admin-topbar">
        <h1 style="margin:0;">RFID Dashboard</h1>



        <div>Logged in as: <?php echo esc_html($display_name); ?></div>
      </div>

      <div class="rad-admin-body" style="display:flex; gap:20px; padding:20px;">
        <aside class="rad-sidebar" style="width:260px;">
          <div class="rad-sidebar-card">
            <nav>
              <ul style="list-style:none; margin:0; padding:0;">
                <li><a href="#overview" class="rad-side-link">Overview</a></li>

                <li style="margin-top:12px; font-weight:700; color:#374151;">Members</li>
                <li><a href="#members/add" class="rad-side-link">Add Member</a></li>
                <li><a href="#members/all" class="rad-side-link">All Members</a></li>

                <li style="margin-top:12px; font-weight:700; color:#374151;">Logs</li>
                <li><a href="#logs/staff" class="rad-side-link">Staff Logs</a></li>
                <li><a href="#logs/all" class="rad-side-link">All Logs</a></li>

                <li style="margin-top:12px; font-weight:700; color:#374151;">Management</li>
                <li><a href="#timetables/all" class="rad-side-link">All Time Tables</a></li>
                <li><a href="#timetables/add" class="rad-side-link">Add Time Table</a></li>
                <li><a href="#devices" class="rad-side-link">Devices</a></li>

                <!-- NEW: Analytics -->
                <li style="margin-top:12px; font-weight:700; color:#374151;">Analytics</li>
                <li><a href="#analytics/teachers" class="rad-side-link">Teacher Analytics</a></li>

                <li style="margin-top:12px; font-weight:700; color:#374151;">Grace Time Management</li>
                <li><a href="#grace/add" class="rad-side-link">Add Grace</a></li>

                <li style="margin-top:12px; font-weight:700; color:#374151;">Rooms</li>
                <li><a href="#rooms/all" class="rad-side-link">All Rooms</a></li>

                <li style="margin-top:12px; font-weight:700; color:#374151;">Classrooms</li>
                <li><a href="#classrooms/all" class="rad-side-link">All Classrooms</a></li>

                <li style="margin-top:12px; font-weight:700; color:#374151;">Settings</li>
                <li><a href="#settings/permissions" class="rad-side-link">Permissions</a></li>

                <li style="margin-top:12px;"><a href="#fields" class="rad-side-link">Fields</a></li>
              </ul>
            </nav>
          </div>
        </aside>

        <main class="rad-content" style="flex:1;">
          <div id="rad-root-content"></div>
        </main>
      </div>
    </div>
    <?php
}

/* ------------------------------------------------------------------------
 * WP-ADMIN page (toplevel) — uses the same shell
 * --------------------------------------------------------------------- */
add_action('admin_menu', function() {
    add_menu_page(
        'RFID Dashboard',
        'RFID Dashboard',
        'read',
        'rad-dashboard',
        'rad_admin_page',
        'dashicons-id',
        26
    );
});

function rad_admin_page() {
    // Allow both WP users and plugin-session users to view the shell
    $u = rad_get_session_user_like();
    if (!$u) {
        echo '<div style="padding:40px;text-align:center;">';
        echo '<h2>Access Restricted</h2>';
        echo '<p>Please login from the front-end login page to access the Attendance Manager.</p>';
        echo '<p><a href="'.esc_url(site_url('/rad-dashboard')).'" class="button button-primary">Go to Login Page</a></p>';
        echo '</div>';
        return;
    }

    rad_render_dashboard_shell($u['name']);
}

// Enqueue main SPA bundle and localize radConfig for the wp-admin page
add_action('admin_enqueue_scripts', function($hook) {
    if ($hook !== 'toplevel_page_rad-dashboard') return;

    wp_enqueue_style('rad-style', RAD_PLUGIN_URL . 'public/css/rad-style.css', array(), '1.2.0');
    wp_enqueue_script('rad-bundle', RAD_PLUGIN_URL . 'public/js/rad-app.js', array(), '1.2.0', true);

    $u = rad_get_session_user_like();
    wp_localize_script('rad-bundle', 'radConfig', array(
        'root'             => rest_url('rad/v2'),
        'nonce'            => wp_create_nonce('wp_rest'),
        'currentUser'      => $u ? $u['name'] : '',
        'currentUserRole'  => $u ? $u['role'] : '',
        'pluginUrl'        => RAD_PLUGIN_URL
    ));
});

/* ------------------------------------------------------------------------
 * FRONT-END dashboard via shortcode [rad_dashboard]
 * Works for plugin-session login and normal WP login.
 * --------------------------------------------------------------------- */
add_shortcode('rad_dashboard', function () {
    $u = rad_get_session_user_like();
    if (!$u) {
        return '<div style="padding:40px;text-align:center"><h2>Access Restricted</h2><p>Please log in first.</p></div>';
    }

    ob_start();
    rad_render_dashboard_shell($u['name']);
    return ob_get_clean();
});

// Enqueue assets for the front-end page that contains [rad_dashboard]
add_action('wp_enqueue_scripts', function () {
    if (!is_singular()) return;
    global $post;
    if (!$post) return;

    if (has_shortcode($post->post_content, 'rad_dashboard')) {
        wp_enqueue_style('rad-style', RAD_PLUGIN_URL . 'public/css/rad-style.css', array(), '1.2.0');
        wp_enqueue_script('rad-bundle', RAD_PLUGIN_URL . 'public/js/rad-app.js', array(), '1.2.0', true);

        $u = rad_get_session_user_like();
        wp_localize_script('rad-bundle', 'radConfig', array(
            'root'             => rest_url('rad/v2'),
            'nonce'            => wp_create_nonce('wp_rest'),
            'currentUser'      => $u ? $u['name'] : '',
            'currentUserRole'  => $u ? $u['role'] : '',
            'pluginUrl'        => RAD_PLUGIN_URL
        ));
    }
});
