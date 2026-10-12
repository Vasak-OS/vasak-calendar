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
    let guardados: Vec<CalendarioGuardado> = serde_json::from_str(&json)
        .map_err(|e| format!("no se pudieron leer los calendarios: {e}"))?;
    let calendarios = calendarios_de(guardados);
    if calendarios.is_empty() {
        return Ok(LecturaDelAlmacen::default());
    }

    let mut lectura = LecturaDeCuenta {
        calendarios,
        ..Default::default()
    };
    let todos: Vec<String> = Vec::new();
    let mut cursor = String::new();
    for _ in 0..MAX_PAGINAS {
        let json = llamar(
            "ListOccurrences",
            &(desde, hasta, todos.clone(), cursor.as_str(), PAGINA),
        )
        .await?;
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

async fn seguir(app: &tauri::AppHandle) -> Result<(), String> {
    use futures_util::StreamExt;
    use tauri::Emitter;

    let conexion = conectar().await?;
    // El bus filtra por el primer argumento: un lote de correo o de contactos
    // no despierta a esta ventana.
    let regla = zbus::MatchRule::builder()
        .msg_type(zbus::message::Type::Signal)
        .interface(INTERFAZ)
        .and_then(|r| r.member("Changed"))
        .and_then(|r| r.arg(0, "calendar"))
        .map_err(|e| format!("no se pudo armar el filtro del almacén: {e}"))?
        .build();
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
