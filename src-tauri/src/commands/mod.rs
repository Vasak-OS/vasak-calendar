//! Comandos cuyo análisis de cobertura se excluye.
//!
//! Este módulo (`commands/`) existe para alojar el pegamento con GTK/WebKit que
//! no se puede ejercitar sin un display ni un WebKit reales. El flujo de Sonar
//! del taller excluye `**/commands/*.rs` de la cobertura, igual que los `.vue`.
//! Convive con `comandos.rs`, que sí se mide.

pub mod webkit;
