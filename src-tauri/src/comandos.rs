//! Lo que la ventana le puede pedir al programa.
//!
//! Tres cosas: qué cuentas tienen calendarios, y qué eventos hay en un rango.
//! Nada más — esta versión **lee**; crear eventos viene después.
//!
//! ── Por qué un fallo no tira todo ───────────────────────────────────────────
//!
//! Alguien puede tener tres calendarios y que uno esté roto: el servidor lo
//! devuelve en la lista pero después no lo sirve, o una cuenta de las dos
//! conectadas venció. Si un fallo cortara la carga, el mes aparecería vacío y la
//! persona no tendría forma de saber que sus otros dos calendarios sí andaban.
//! Así que se devuelve lo que se pudo leer **junto con** lo que falló, y la
//! ventana muestra las dos cosas.

use chrono::{DateTime, Utc};
use serde::Serialize;

use crate::caldav::{self, Calendario, Evento};
use crate::cuentas::{self, CuentaConCalendario};

/// Un evento y de qué calendario salió.
///
/// El calendario va pegado al evento porque es lo que le da color en la
/// cuadrícula: sin eso, dos reuniones del mismo día se ven idénticas aunque una
/// sea del trabajo y la otra de casa.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct EventoEnCalendario {
    #[serde(flatten)]
    pub evento: Evento,
    pub calendario: String,
    pub color: Option<String>,
}

/// Lo que se pudo leer de una cuenta, y lo que no.
#[derive(Debug, Clone, Serialize, Default, PartialEq, Eq)]
pub struct LecturaDeCuenta {
    pub calendarios: Vec<Calendario>,
    pub eventos: Vec<EventoEnCalendario>,
    /// Los calendarios que no se pudieron leer, con el motivo. Vacío si salió
    /// todo bien.
    pub fallos: Vec<String>,
}

/// Las cuentas conectadas que tienen calendarios.
///
/// No pide permiso: son metadatos y el servicio ya acota lo que devuelve a quien
/// pregunta. El diálogo aparece al leer los eventos, que es cuando hace falta la
/// credencial.
#[tauri::command]
pub async fn listar_cuentas() -> Result<Vec<CuentaConCalendario>, String> {
    cuentas::cuentas().await
}

/// Los eventos de una cuenta entre dos momentos.
///
/// `desde` y `hasta` llegan en ISO 8601 desde la ventana, que es quien sabe qué
/// mes está mirando y en qué zona horaria vive la persona.
#[tauri::command]
pub async fn eventos_de_la_cuenta(
    account_id: String,
    desde: String,
    hasta: String,
) -> Result<LecturaDeCuenta, String> {
    let (desde, hasta) = rango(&desde, &hasta)?;

    let credencial = cuentas::credencial_de(&account_id).await?;
    let calendarios = caldav::calendarios(&credencial).await?;

    let mut lectura = LecturaDeCuenta {
        calendarios: calendarios.clone(),
        ..Default::default()
    };

    for calendario in &calendarios {
        match caldav::eventos(&credencial, &calendario.url, desde, hasta).await {
            Ok(eventos) => lectura.eventos.extend(eventos.into_iter().map(|evento| {
                EventoEnCalendario {
                    evento,
                    calendario: calendario.url.clone(),
                    color: calendario.color.clone(),
                }
            })),
            // Nombre y motivo: «falló un calendario» no le dice a nadie cuál de
            // los suyos le falta.
            Err(e) => lectura.fallos.push(format!("{}: {e}", calendario.nombre)),
        }
    }

    Ok(lectura)
}

/// Lee el rango que mandó la ventana.
///
/// Se valida acá y no más adentro porque un rango dado vuelta —el fin antes que
/// el comienzo— hace que el servidor devuelva vacío sin decir nada, y eso se ve
/// igual que un mes sin eventos.
fn rango(desde: &str, hasta: &str) -> Result<(DateTime<Utc>, DateTime<Utc>), String> {
    let momento = |texto: &str| {
        DateTime::parse_from_rfc3339(texto)
            .map(|m| m.with_timezone(&Utc))
            .map_err(|e| format!("«{texto}» no es una fecha válida: {e}"))
    };

    let desde = momento(desde)?;
    let hasta = momento(hasta)?;
    if hasta <= desde {
        return Err(format!("el rango termina antes de empezar: {desde} → {hasta}"));
    }
    Ok((desde, hasta))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn el_rango_se_lee_en_utc() {
        // La ventana manda la hora local con su desfase; acá tiene que quedar en
        // UTC, que es lo único que entiende un servidor CalDAV.
        let (desde, hasta) = rango("2026-09-01T00:00:00-03:00", "2026-10-01T00:00:00-03:00").unwrap();
        assert_eq!(desde.to_rfc3339(), "2026-09-01T03:00:00+00:00");
        assert_eq!(hasta.to_rfc3339(), "2026-10-01T03:00:00+00:00");
    }

    /// Un rango dado vuelta hace que el servidor devuelva vacío sin decir nada,
    /// y eso se ve igual que un mes sin eventos.
    #[test]
    fn un_rango_dado_vuelta_se_rechaza() {
        let error = rango("2026-10-01T00:00:00Z", "2026-09-01T00:00:00Z").unwrap_err();
        assert!(error.contains("termina antes"), "{error}");

        // Y uno de largo cero tampoco sirve: no puede haber nada adentro.
        assert!(rango("2026-09-01T00:00:00Z", "2026-09-01T00:00:00Z").is_err());
    }

    #[test]
    fn una_fecha_que_no_es_fecha_se_rechaza() {
        for basura in ["", "mañana", "2026-09-01", "01/09/2026"] {
            assert!(rango(basura, "2026-10-01T00:00:00Z").is_err(), "{basura:?}");
        }
    }

    /// El calendario viaja pegado al evento: es lo que le da color en la
    /// cuadrícula, y sin eso dos reuniones del mismo día se ven idénticas aunque
    /// una sea del trabajo y la otra de casa.
    #[test]
    fn el_evento_sale_con_su_calendario() {
        let evento = EventoEnCalendario {
            evento: Evento {
                uid: "a".into(),
                titulo: "Reunión".into(),
                inicio: "2026-09-15T14:00:00+00:00".into(),
                fin: "2026-09-15T15:00:00+00:00".into(),
                todo_el_dia: false,
                se_repite: false,
            },
            calendario: "https://nube.ejemplo.com/dav/calendars/ana/trabajo/".into(),
            color: Some("#FF5733".into()),
        };

        let json = serde_json::to_value(&evento).unwrap();
        // Aplanado: la ventana recibe un objeto y no un evento adentro de otro.
        assert_eq!(json["titulo"], "Reunión");
        assert_eq!(json["color"], "#FF5733");
        assert!(json["calendario"].as_str().unwrap().ends_with("/trabajo/"));
    }

    /// Un calendario roto no puede vaciar el mes: la persona tiene que ver los
    /// que sí andan y enterarse de cuál le falta.
    #[test]
    fn una_lectura_puede_traer_eventos_y_fallos_a_la_vez() {
        let lectura = LecturaDeCuenta {
            calendarios: vec![Calendario {
                url: "https://x/a/".into(),
                nombre: "Personal".into(),
                color: None,
            }],
            eventos: Vec::new(),
            fallos: vec!["Trabajo: el servidor respondió 500".into()],
        };

        let json = serde_json::to_value(&lectura).unwrap();
        assert_eq!(json["fallos"].as_array().unwrap().len(), 1);
        // El nombre del calendario que falló va en el mensaje: «falló un
        // calendario» no le dice a nadie cuál de los suyos le falta.
        assert!(json["fallos"][0].as_str().unwrap().starts_with("Trabajo:"));
    }
}
