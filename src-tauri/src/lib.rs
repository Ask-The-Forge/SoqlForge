//! SoqlForge — Tauri entrypoint.
//!
//! All Salesforce work goes through the `sf` CLI; this layer is intentionally
//! thin (spawn subprocess, parse JSON, return typed struct). Business logic
//! lives in the React/TypeScript frontend.

pub mod cli;
pub mod commands;
pub mod error;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // Auto-update is desktop-only. The frontend drives the actual
            // check/download via the updater JS API; this just wires the plugin.
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;

            // Load persisted CLI settings (if any) at startup so the user's
            // path override and timeout survive a relaunch.
            commands::settings::load_persisted(app.handle());

            // Work out where `sf` can be found while the window is still
            // painting — on macOS that involves spawning a login shell, and
            // it's latency the first query shouldn't have to pay.
            cli::warm_path_cache();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::orgs::list_orgs,
            commands::query::run_soql,
            commands::query::cancel_run,
            commands::schema::describe_object,
            commands::schema::list_objects,
            commands::settings::get_cli_settings,
            commands::settings::set_cli_settings,
            commands::settings::get_ai_settings,
            commands::settings::set_ai_settings,
            commands::ai::ai_generate_soql,
            commands::export::save_csv,
            commands::update::update_record,
            commands::delete::delete_record,
            commands::org_manage::org_login_web,
            commands::org_manage::org_logout,
            commands::org_manage::org_set_default,
            commands::org_manage::org_set_alias,
            commands::org_manage::org_open,
            commands::org_manage::org_delete_scratch,
            commands::packages::list_packages,
            commands::packages::list_package_versions,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
