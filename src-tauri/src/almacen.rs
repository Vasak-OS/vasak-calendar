//! El calendario, tal como ya está sincronizado en el sistema.
//!
//! ── De dónde sale lo que se ve ──────────────────────────────────────────────
//!
//! `vasak-accounts-sync` mantiene una base cifrada con los calendarios de todas
//! las cuentas y la actualiza solo, en segundo plano. Esta ventana la lee por el
//! bus de sesión —`ar.net.vasak.os.AccountsStore`— y **no espera a la red**: el
//! mes aparece al abrir, y las repeticiones ya vienen expandidas.
//!
//! Lo nuevo se avisa con la señal `Changed("calendar", …)`, que se pasa a la
//! ventana como el evento [`EVENTO`]; el botón «Actualizar» le pide al
//! sincronizador una vuelta ya, con `RequestSync`.
//!
//! La primera lectura puede abrir el diálogo de `vasak-permissions`
//! (`store.calendar`): por eso las llamadas no tienen tope de tiempo.

use serde::{Deserialize, Serialize};

use crate::caldav::{Calendario, Event};
use crate::comandos::{EventInCalendar, LecturaDeCuenta};

const SERVICIO: &str = "ar.net.vasak.os.AccountsSync";
const RUTA: &str = "/ar/net/vasak/os/AccountsStore";
const INTERFAZ: &str = "ar.net.vasak.os.AccountsStore";

/// El aviso a la ventana de que cambió lo guardado del calendario.
pub const EVENTO: &str = "calendario-cambio";

/// Cuántas ocurrencias se piden por página: el máximo que acepta el almacén.
const PAGINA: u32 = 1000;

/// Cuántas páginas se leen como mucho para un rango. Seis semanas con más de
/// diez mil eventos no es una agenda, es un error; se muestra lo que entró y
/// se avisa.
const MAX_PAGINAS: usize = 10;

/// Un calendario como lo lista el almacén.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct CalendarioGuardado {
    pub id: String,
    #[serde(default)]
    pub account_id: String,
    pub display_name: String,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub components: Vec<String>,
}

/// Una vez de un evento, como la da `ListOccurrences`.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct OcurrenciaGuardada {
    pub event_id: String,
    #[serde(default)]
    pub occurrence_id: String,
    pub calendar_id: String,
    pub title: String,
    pub start: String,
    pub end: String,
    #[serde(default)]
    pub all_day: bool,
    #[serde(default)]
    pub color: Option<String>,
    /// Si el evento es de una serie. Las versiones del almacén que no lo
    /// mandan lo dejan en `false`: se pierde el ícono, no el evento.
    #[serde(default)]
    pub recurring: bool,
    #[serde(default)]
    pub shown_once: bool,
}

#[derive(Debug, Clone, Deserialize)]
struct PaginaDeOcurrencias {
    items: Vec<OcurrenciaGuardada>,
    #[serde(default)]
    next_cursor: Option<String>,
    #[serde(default)]
    truncated: bool,
}

/// Lo que se lee del almacén para un rango: igual que lo de una cuenta, pero
/// de todas juntas.
#[derive(Debug, Clone, Serialize, Default, PartialEq, Eq)]
pub struct LecturaDelAlmacen {
    #[serde(flatten)]
    pub lectura: LecturaDeCuenta,
    /// Si el almacén tiene algún calendario. Sin ninguno, la ventana lee como
    /// antes, cuenta por cuenta: el área todavía no se encendió o la primera
    /// vuelta no terminó.
    pub disponible: bool,
}

async fn conectar() -> Result<zbus::Connection, String> {
    zbus::Connection::session()
        .await
        .map_err(|e| format!("no se pudo contactar al almacén del sistema: {e}"))
}

async fn llamar<A>(metodo: &str, argumentos: &A) -> Result<String, String>
where
    A: serde::ser::Serialize + zbus::zvariant::DynamicType,
{
    conectar()
        .await?
        .call_method(Some(SERVICIO), RUTA, Some(INTERFAZ), metodo, argumentos)
        .await
        .map_err(|e| format!("{metodo}: {e}"))?
        .body()
        .deserialize()
        .map_err(|e| format!("respuesta inválida de {metodo}: {e}"))
}

/// Los calendarios de eventos del almacén. Las listas que sólo tienen tareas
/// no van: no tienen nada que dibujar en la cuadrícula.
pub fn calendarios_de(guardados: Vec<CalendarioGuardado>) -> Vec<Calendario> {
    guardados
        .into_iter()
        .filter(|c| c.components.is_empty() || c.components.iter().any(|x| x == "VEVENT"))
        .map(|c| Calendario {
            url: c.id,
            nombre: c.display_name,
            color: c.color,
        })
        .collect()
}

/// Un evento de la cuadrícula a partir de una vez guardada.
///
/// El `uid` es el del objeto guardado: es lo que, junto con el comienzo, le da
/// a la cuadrícula una clave única por vez.
pub fn evento_de(o: OcurrenciaGuardada) -> EventInCalendar {
    EventInCalendar {
        event: Event {
            uid: o.event_id,
            title: o.title,
            start: o.start,
            end: o.end,
            all_day: o.all_day,
            recurring: o.recurring,
            shown_once: o.shown_once,
            // El almacén no guarda el nombre de la zona en que se escribió el
            // evento; sin él no se avisa de zonas distintas, que es lo mismo
            // que pasa con los eventos en UTC.
            zone: String::new(),
        },
        calendar: o.calendar_id,
        color: o.color,
    }
}

/// Los calendarios y los eventos de todas las cuentas en `[desde, hasta)`.
pub async fn eventos(desde: &str, hasta: &str) -> Result<LecturaDelAlmacen, String> {
    let json = llamar("ListCalendars", &()).await?;
    leer(&json, |cursor| async move {
        llamar(
            "ListOccurrences",
            &(desde, hasta, Vec::<String>::new(), cursor.as_str(), PAGINA),
        )
        .await
    })
    .await
}

/// Lo que hace [`eventos`] con lo que contesta el almacén, sin el bus: la lista
/// de calendarios ya leída, y `pagina` que pide una página por su cursor.
async fn leer<F, Fut>(calendarios_json: &str, mut pagina: F) -> Result<LecturaDelAlmacen, String>
where
    F: FnMut(String) -> Fut,
    Fut: std::future::Future<Output = Result<String, String>>,
{
    let guardados: Vec<CalendarioGuardado> = serde_json::from_str(calendarios_json)
        .map_err(|e| format!("no se pudieron leer los calendarios: {e}"))?;
    let calendarios = calendarios_de(guardados);
    if calendarios.is_empty() {
        return Ok(LecturaDelAlmacen::default());
    }

    let mut lectura = LecturaDeCuenta {
        calendarios,
        ..Default::default()
    };
    let mut cursor = String::new();
    for _ in 0..MAX_PAGINAS {
        let json = pagina(cursor.clone()).await?;
        let pagina: PaginaDeOcurrencias = serde_json::from_str(&json)
            .map_err(|e| format!("no se pudieron leer los eventos: {e}"))?;
        if pagina.truncated {
            lectura
                .fallos
                .push("hay eventos que no se pudieron expandir del todo".into());
        }
        lectura
            .eventos
            .extend(pagina.items.into_iter().map(evento_de));
        match pagina.next_cursor {
            Some(siguiente) if !siguiente.is_empty() => cursor = siguiente,
            _ => {
                return Ok(LecturaDelAlmacen {
                    lectura,
                    disponible: true,
                })
            }
        }
    }
    lectura
        .fallos
        .push("hay más eventos en este rango de los que se pueden mostrar".into());
    Ok(LecturaDelAlmacen {
        lectura,
        disponible: true,
    })
}

/// Le pide al sincronizador una vuelta ya de unas cuentas: el botón
/// «Actualizar». No espera a que termine: lo nuevo se avisa con [`EVENTO`].
///
/// Un fallo de una cuenta no frena a las demás. El almacén tiene un límite por
/// llamante, y lo que ya está se sigue viendo.
pub async fn pedir_sincronizacion(account_ids: &[String]) {
    let Ok(conexion) = conectar().await else {
        return;
    };
    for id in account_ids {
        if let Err(e) = conexion
            .call_method(
                Some(SERVICIO),
                RUTA,
                Some(INTERFAZ),
                "RequestSync",
                &(id.as_str(),),
            )
            .await
        {
            eprintln!("[calendario] no se pudo pedir una vuelta de «{id}»: {e}");
        }
    }
}

/// Pasa a la ventana cada `Changed("calendar", …)` del almacén.
pub fn escuchar(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        // En bucle: el bus se puede cortar, y con un solo intento la ventana
        // dejaría de enterarse de lo nuevo hasta que se la cierre.
        loop {
            if let Err(e) = seguir(&app).await {
                eprintln!("[calendario] no se pueden recibir avisos del almacén: {e}");
            }
            tokio::time::sleep(std::time::Duration::from_secs(15)).await;
        }
    });
}

/// Qué señales del almacén despiertan a la ventana.
///
/// El bus filtra por el primer argumento: un lote de correo o de contactos no
/// despierta a esta ventana.
fn regla_de_cambios() -> Result<zbus::MatchRule<'static>, String> {
    Ok(zbus::MatchRule::builder()
        .msg_type(zbus::message::Type::Signal)
        .interface(INTERFAZ)
        .and_then(|r| r.member("Changed"))
        .and_then(|r| r.arg(0, "calendar"))
        .map_err(|e| format!("no se pudo armar el filtro del almacén: {e}"))?
        .build())
}

async fn seguir(app: &tauri::AppHandle) -> Result<(), String> {
    use futures_util::StreamExt;
    use tauri::Emitter;

    let conexion = conectar().await?;
    let regla = regla_de_cambios()?;
    let mut avisos = zbus::MessageStream::for_match_rule(regla, &conexion, None)
        .await
        .map_err(|e| format!("no se pudo escuchar al almacén: {e}"))?;
    while let Some(aviso) = avisos.next().await {
        if aviso.is_ok() {
            let _ = app.emit(EVENTO, ());
        }
    }
    Err("el bus de sesión cerró la conexión".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    /// Un calendario tal como lo serializa `CalendarItem` en
    /// `vasak-accounts/sync/src/store/calendar_read.rs`.
    fn calendario_json(id: &str, nombre: &str, components: &[&str]) -> serde_json::Value {
        serde_json::json!({
            "id": id,
            "account_id": id.split('/').next().unwrap(),
            "display_name": nombre,
            "color": "#3366FF",
            "components": components,
        })
    }

    /// Una vez de un evento como la serializa `OccurrenceItem`, **la de antes**:
    /// con `floating` y sin `recurring` ni `shown_once`.
    fn ocurrencia_vieja(event_id: &str) -> serde_json::Value {
        serde_json::json!({
            "event_id": event_id,
            "occurrence_id": "0",
            "calendar_id": "google/1",
            "title": "Reunión",
            "start": "2026-09-15T14:00:00Z",
            "end": "2026-09-15T15:00:00Z",
            "all_day": false,
            "floating": false,
            "color": null,
        })
    }

    /// La misma, del almacén nuevo: suma `recurring` y `shown_once`.
    fn ocurrencia_nueva(event_id: &str, recurring: bool, shown_once: bool) -> serde_json::Value {
        let mut o = ocurrencia_vieja(event_id);
        o["recurring"] = recurring.into();
        o["shown_once"] = shown_once.into();
        o
    }

    fn pagina_json(items: Vec<serde_json::Value>, next: Option<&str>, truncated: bool) -> String {
        serde_json::json!({ "items": items, "next_cursor": next, "truncated": truncated })
            .to_string()
    }

    fn guardado(id: &str, components: &[&str]) -> CalendarioGuardado {
        CalendarioGuardado {
            id: id.into(),
            account_id: "google".into(),
            display_name: format!("cal {id}"),
            color: Some("#FF0000".into()),
            components: components.iter().map(|c| c.to_string()).collect(),
        }
    }

    /// Las páginas que contestaría el almacén, y los cursores con que se las
    /// pidió. Sin bus: `leer` recibe la función que pide.
    fn leer_con(
        calendarios: &serde_json::Value,
        paginas: Vec<Result<String, String>>,
    ) -> (Result<LecturaDelAlmacen, String>, Vec<String>) {
        let pedidas = RefCell::new(Vec::new());
        let restantes = RefCell::new(paginas.into_iter());
        let resultado = tauri::async_runtime::block_on(leer(&calendarios.to_string(), |cursor| {
            pedidas.borrow_mut().push(cursor);
            let siguiente = restantes
                .borrow_mut()
                .next()
                .unwrap_or_else(|| Err("se pidió una página de más".into()));
            async move { siguiente }
        }));
        (resultado, pedidas.into_inner())
    }

    // ── Qué calendarios se dibujan ─────────────────────────────────────────

    #[test]
    fn las_listas_de_tareas_no_entran_en_la_cuadricula() {
        let calendarios = calendarios_de(vec![
            guardado("google/1", &["VEVENT"]),
            guardado("google/2", &["VTODO"]),
            guardado("google/3", &["VTODO", "VEVENT"]),
        ]);
        let urls: Vec<_> = calendarios.iter().map(|c| c.url.as_str()).collect();
        assert_eq!(urls, ["google/1", "google/3"]);
    }

    /// Un servidor que no dice qué guarda en un calendario es un calendario de
    /// eventos: descartarlo dejaría el mes vacío sin decir por qué.
    #[test]
    fn un_calendario_que_no_dice_que_guarda_se_dibuja() {
        assert_eq!(calendarios_de(vec![guardado("google/1", &[])]).len(), 1);
    }

    #[test]
    fn el_calendario_guardado_llega_con_los_nombres_de_la_ventana() {
        let calendario = calendarios_de(vec![guardado("google/7", &["VEVENT"])]).remove(0);
        assert_eq!(
            calendario,
            Calendario {
                url: "google/7".into(),
                nombre: "cal google/7".into(),
                color: Some("#FF0000".into()),
            }
        );
    }

    // ── Cómo llega cada evento ─────────────────────────────────────────────

    /// El `calendar` del evento tiene que ser el `url` de su calendario: es lo
    /// que lo ata a su color y a su casilla en el panel de cuentas.
    #[test]
    fn el_evento_guardado_queda_atado_a_su_calendario() {
        let ocurrencia: OcurrenciaGuardada =
            serde_json::from_value(ocurrencia_nueva("google/42", true, true)).unwrap();
        let evento = evento_de(ocurrencia);
        assert_eq!(evento.event.uid, "google/42");
        assert_eq!(evento.calendar, "google/1");
        assert_eq!(evento.event.title, "Reunión");
        assert_eq!(evento.event.start, "2026-09-15T14:00:00Z");
        assert_eq!(evento.event.end, "2026-09-15T15:00:00Z");
        assert!(evento.event.recurring);
        assert!(evento.event.shown_once);
        // El almacén no guarda la zona en que se escribió: vacía, como un
        // evento en UTC, para no avisar de una zona que no se conoce.
        assert_eq!(evento.event.zone, "");
    }

    /// Con un almacén de antes de `recurring` y `shown_once`, el evento se ve
    /// igual: se pierde el ícono de la serie, no el evento.
    #[test]
    fn un_almacen_viejo_sin_recurring_ni_shown_once_se_lee_igual() {
        let ocurrencia: OcurrenciaGuardada =
            serde_json::from_value(ocurrencia_vieja("google/42")).unwrap();
        assert!(!ocurrencia.recurring);
        assert!(!ocurrencia.shown_once);
    }

    /// `ListCalendars` contesta una lista de `CalendarItem`, con `color` que
    /// puede ser `null`.
    #[test]
    fn la_lista_de_calendarios_del_almacen_se_lee() {
        let mut sin_color = calendario_json("google/2", "Feriados", &["VEVENT"]);
        sin_color["color"] = serde_json::Value::Null;
        let json = serde_json::json!([
            calendario_json("google/1", "Personal", &["VEVENT"]),
            sin_color
        ]);
        let guardados: Vec<CalendarioGuardado> = serde_json::from_value(json).unwrap();
        assert_eq!(guardados.len(), 2);
        assert_eq!(guardados[0].display_name, "Personal");
        assert_eq!(guardados[0].components, ["VEVENT"]);
        assert_eq!(guardados[1].color, None);
    }

    /// Lo que viaja a la ventana tiene que tener **exactamente** los nombres que
    /// lee `src/composables/use-calendario.ts` y, por evento, los que lee
    /// `src/tools/mes.ts`: Tauri no los convierte, y uno que no coincide llega
    /// como `undefined` sin ningún error.
    #[test]
    fn la_lectura_del_almacen_llega_aplanada_con_los_nombres_de_la_ventana() {
        let lectura = LecturaDelAlmacen {
            lectura: LecturaDeCuenta {
                calendarios: calendarios_de(vec![guardado("google/1", &["VEVENT"])]),
                eventos: vec![evento_de(
                    serde_json::from_value(ocurrencia_nueva("google/42", true, false)).unwrap(),
                )],
                fallos: vec!["algo".into()],
            },
            disponible: true,
        };
        let json = serde_json::to_value(&lectura).unwrap();
        let mut claves: Vec<_> = json.as_object().unwrap().keys().cloned().collect();
        claves.sort();
        assert_eq!(claves, ["calendarios", "disponible", "eventos", "fallos"]);
        assert_eq!(json["disponible"], true);

        let mut del_evento: Vec<_> = json["eventos"][0]
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect();
        del_evento.sort();
        assert_eq!(
            del_evento,
            [
                "all_day",
                "calendar",
                "color",
                "end",
                "recurring",
                "shown_once",
                "start",
                "title",
                "uid",
                "zone"
            ]
        );
        let mut del_calendario: Vec<_> = json["calendarios"][0]
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect();
        del_calendario.sort();
        assert_eq!(del_calendario, ["color", "nombre", "url"]);
    }

    // ── La lectura de un rango ─────────────────────────────────────────────

    /// Sin calendarios de eventos el almacén no sirve todavía —el área no se
    /// encendió o la primera vuelta no terminó— y la ventana tiene que leer
    /// cuenta por cuenta. Ni siquiera se piden ocurrencias.
    #[test]
    fn sin_calendarios_de_eventos_el_almacen_no_esta_disponible() {
        let solo_tareas = serde_json::json!([calendario_json("google/2", "Tareas", &["VTODO"])]);
        let (lectura, pedidas) = leer_con(&solo_tareas, vec![]);
        assert_eq!(lectura.unwrap(), LecturaDelAlmacen::default());
        assert!(pedidas.is_empty(), "pidió ocurrencias: {pedidas:?}");
    }

    #[test]
    fn las_paginas_se_siguen_por_su_cursor_hasta_el_final() {
        let calendarios = serde_json::json!([calendario_json("google/1", "Personal", &["VEVENT"])]);
        let (lectura, pedidas) = leer_con(
            &calendarios,
            vec![
                Ok(pagina_json(
                    vec![ocurrencia_nueva("google/1", false, false)],
                    Some("c1"),
                    false,
                )),
                Ok(pagina_json(
                    vec![ocurrencia_nueva("google/2", false, false)],
                    Some("c2"),
                    false,
                )),
                // El final es `next_cursor == null`, no una página vacía.
                Ok(pagina_json(
                    vec![ocurrencia_nueva("google/3", false, false)],
                    None,
                    false,
                )),
            ],
        );
        let lectura = lectura.unwrap();
        assert_eq!(pedidas, ["", "c1", "c2"]);
        let uids: Vec<_> = lectura
            .lectura
            .eventos
            .iter()
            .map(|e| e.event.uid.as_str())
            .collect();
        assert_eq!(uids, ["google/1", "google/2", "google/3"]);
        assert!(lectura.disponible);
        assert!(lectura.lectura.fallos.is_empty());
        assert_eq!(lectura.lectura.calendarios.len(), 1);
    }

    /// Un cursor vacío también es el final: si se lo siguiera, se volvería a
    /// pedir la primera página para siempre.
    #[test]
    fn un_cursor_vacio_es_el_final() {
        let calendarios = serde_json::json!([calendario_json("google/1", "Personal", &[])]);
        let (lectura, pedidas) =
            leer_con(&calendarios, vec![Ok(pagina_json(vec![], Some(""), false))]);
        assert!(lectura.unwrap().disponible);
        assert_eq!(pedidas, [""]);
    }

    /// Lo que el almacén no pudo expandir se dice: si no, las semanas que
    /// faltan parecen libres.
    #[test]
    fn una_pagina_cortada_se_avisa() {
        let calendarios = serde_json::json!([calendario_json("google/1", "Personal", &[])]);
        let (lectura, _) = leer_con(
            &calendarios,
            vec![Ok(pagina_json(
                vec![ocurrencia_vieja("google/1")],
                None,
                true,
            ))],
        );
        let lectura = lectura.unwrap();
        assert_eq!(lectura.lectura.eventos.len(), 1);
        assert_eq!(lectura.lectura.fallos.len(), 1);
        assert!(
            lectura.lectura.fallos[0].contains("expandir"),
            "{:?}",
            lectura.lectura.fallos
        );
    }

    /// Un almacén que nunca termina de dar páginas no cuelga la ventana: se
    /// muestra lo que entró y se avisa que falta.
    #[test]
    fn un_cursor_que_no_termina_se_corta_y_se_avisa() {
        let calendarios = serde_json::json!([calendario_json("google/1", "Personal", &[])]);
        let infinitas = (0..MAX_PAGINAS + 5)
            .map(|i| {
                Ok(pagina_json(
                    vec![ocurrencia_vieja(&format!("google/{i}"))],
                    Some(&format!("c{i}")),
                    false,
                ))
            })
            .collect();
        let (lectura, pedidas) = leer_con(&calendarios, infinitas);
        let lectura = lectura.unwrap();
        assert_eq!(pedidas.len(), MAX_PAGINAS);
        assert_eq!(lectura.lectura.eventos.len(), MAX_PAGINAS);
        assert!(lectura.disponible);
        assert!(
            lectura
                .lectura
                .fallos
                .iter()
                .any(|f| f.contains("más eventos")),
            "{:?}",
            lectura.lectura.fallos
        );
    }

    /// Un fallo a mitad de camino no se disfraza de mes vacío: la ventana lo
    /// toma como almacén caído y lee cuenta por cuenta.
    #[test]
    fn una_pagina_que_falla_o_no_se_entiende_es_un_error() {
        let calendarios = serde_json::json!([calendario_json("google/1", "Personal", &[])]);
        let (lectura, _) = leer_con(
            &calendarios,
            vec![
                Ok(pagina_json(vec![], Some("c1"), false)),
                Err("ListOccurrences: sin permiso".into()),
            ],
        );
        assert_eq!(lectura.unwrap_err(), "ListOccurrences: sin permiso");

        let (lectura, _) = leer_con(&calendarios, vec![Ok("{\"items\": 3}".into())]);
        assert!(lectura.unwrap_err().contains("eventos"));

        let (lectura, pedidas) = leer_con(&serde_json::json!({"no": "es lista"}), vec![]);
        assert!(lectura.unwrap_err().contains("calendarios"));
        assert!(pedidas.is_empty());
    }

    // ── Qué avisos despiertan a la ventana ─────────────────────────────────

    /// Sólo `Changed("calendar", …)` de la interfaz del almacén: un lote de
    /// correo o de contactos no relee el mes.
    #[test]
    fn solo_los_cambios_del_calendario_despiertan_a_la_ventana() {
        let regla = regla_de_cambios().unwrap().to_string();
        for parte in [
            "type='signal'",
            "interface='ar.net.vasak.os.AccountsStore'",
            "member='Changed'",
            "arg0='calendar'",
        ] {
            assert!(regla.contains(parte), "falta {parte} en {regla}");
        }
    }
}
