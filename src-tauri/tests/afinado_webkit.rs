//! Que el afinado del WebKit siga cableado de punta a punta.
//!
//! El pegamento con GTK/WebKit de `commands/webkit.rs` no se puede ejercitar sin
//! un display ni un WebKit reales, así que no corre GTK: lee el fuente y verifica
//! que las piezas sigan en su lugar. Si alguien saca una palanca, desregistra el
//! comando o borra la llamada del frontend, esto falla.

use std::path::PathBuf;

fn read_source(relative: &str) -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(relative);
    std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("no se pudo leer {}: {e}", path.display()))
}

#[test]
fn el_comando_afina_las_palancas_esperadas() {
    let source = read_source("src/commands/webkit.rs");
    assert!(
        source.contains("pub fn tune_webview"),
        "falta el comando `tune_webview` en commands/webkit.rs"
    );
    assert!(
        source.contains("set_enable_developer_extras(false)"),
        "el afinado tiene que apagar los extras de desarrollo"
    );
    assert!(
        source.contains("set_enable_back_forward_navigation_gestures(false)"),
        "el afinado tiene que apagar los gestos de navegación atrás/adelante"
    );
    assert!(
        source.contains("CacheModel::DocumentViewer"),
        "el afinado tiene que usar el caché de visor de documento"
    );
}

#[test]
fn el_comando_esta_registrado_en_el_handler() {
    let source = read_source("src/lib.rs");
    assert!(
        source.contains("commands::webkit::tune_webview"),
        "`tune_webview` tiene que estar registrado en el generate_handler de lib.rs"
    );
}

#[test]
fn el_frontend_dispara_el_afinado_al_montar() {
    let source = read_source("../src/App.vue");
    assert!(
        source.contains("invoke('tune_webview')"),
        "App.vue tiene que llamar a invoke('tune_webview') al montar"
    );
}
