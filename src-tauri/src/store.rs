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
//! ventana como el evento [`CHANGED_EVENT`]; el botón «Actualizar» le pide al
//! sincronizador una vuelta ya, con `RequestSync`.
//!
//! La primera lectura puede abrir el diálogo de `vasak-permissions`
//! (`store.calendar`): por eso las llamadas no tienen tope de tiempo.

use serde::{Deserialize, Serialize};

use vasak_accounts_store_client::trusted_sync_owner;

use crate::caldav::{Calendario, Event};
use crate::comandos::{EventInCalendar, LecturaDeCuenta};

const SERVICE: &str = "ar.net.vasak.os.AccountsSync";
const PATH: &str = "/ar/net/vasak/os/AccountsStore";
const INTERFACE: &str = "ar.net.vasak.os.AccountsStore";

/// El aviso a la ventana de que cambió lo guardado del calendario.
pub const CHANGED_EVENT: &str = "calendar-changed";

/// El aviso a la ventana de que cambió el estado de la sincronización.
pub const STATUS_EVENT: &str = "calendar-sync-status";

/// Cuánto se juntan los avisos seguidos antes de pasarlos a la ventana.
const SETTLE: std::time::Duration = std::time::Duration::from_millis(500);

/// Cuántas ocurrencias se piden por página: el máximo que acepta el almacén.
const PAGE_SIZE: u32 = 1000;

/// Cuántas páginas se leen como mucho para un rango. Seis semanas con más de
/// diez mil eventos no es una agenda, es un error; se muestra lo que entró y
/// se avisa.
const MAX_PAGES: usize = 10;

/// El aviso de que alguna serie no se pudo expandir del todo en el rango.
const TRUNCATED_WARNING: &str = "hay eventos que no se pudieron expandir del todo";

/// Un calendario como lo lista el almacén.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct StoredCalendar {
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
pub struct StoredOccurrence {
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
struct OccurrencePage {
    items: Vec<StoredOccurrence>,
    #[serde(default)]
    next_cursor: Option<String>,
    #[serde(default)]
    truncated: bool,
}

/// Lo que se lee del almacén para un rango: igual que lo de una cuenta, pero
/// de todas juntas.
#[derive(Debug, Clone, Serialize, Default, PartialEq, Eq)]
pub struct StoreReading {
    #[serde(flatten)]
    pub reading: LecturaDeCuenta,
    /// Si el almacén tiene algún calendario. Sin ninguno, la ventana lee como
    /// antes, cuenta por cuenta: el área todavía no se encendió o la primera
    /// vuelta no terminó.
    pub available: bool,
}

async fn connect() -> Result<zbus::Connection, String> {
    zbus::Connection::session()
        .await
        .map_err(|e| format!("no se pudo contactar al almacén del sistema: {e}"))
}

/// Conecta al bus y comprueba, **una vez por conexión**, que quien tiene el
/// nombre del almacén sea de verdad el servicio instalado —no un proceso de la
/// sesión que tomó el nombre mientras el servicio no estaba—. Devuelve el nombre
/// único ya verificado: las llamadas van dirigidas a él, así un cambio de dueño
/// posterior no las redirige a un impostor. Si no se puede confiar, falla cerrado
/// y la lectura cae al camino de error de siempre. Ver `vasak-accounts#77`.
async fn connect_verified() -> Result<(zbus::Connection, String), String> {
    let conexion = connect().await?;
    let dueno = trusted_sync_owner(&conexion)
        .await
        .map_err(|e| format!("no se pudo confiar en el almacén del sistema: {e}"))?;
    Ok((conexion, dueno))
}

async fn call<A>(metodo: &str, argumentos: &A) -> Result<String, String>
where
    A: serde::ser::Serialize + zbus::zvariant::DynamicType,
{
    let (conexion, dueno) = connect_verified().await?;
    conexion
        .call_method(
            Some(dueno.as_str()),
            PATH,
            Some(INTERFACE),
            metodo,
            argumentos,
        )
        .await
        .map_err(|e| format!("{metodo}: {e}"))?
        .body()
        .deserialize()
        .map_err(|e| format!("respuesta inválida de {metodo}: {e}"))
}

/// Los calendarios de eventos del almacén. Las listas que sólo tienen tareas
/// no van: no tienen nada que dibujar en la cuadrícula.
pub fn calendars_from(guardados: Vec<StoredCalendar>) -> Vec<Calendario> {
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
pub fn event_from(o: StoredOccurrence) -> EventInCalendar {
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
pub async fn read_events(desde: &str, hasta: &str) -> Result<StoreReading, String> {
    let json = call("ListCalendars", &()).await?;
    read_pages(&json, |cursor| async move {
        call(
            "ListOccurrences",
            &(
                desde,
                hasta,
                Vec::<String>::new(),
                cursor.as_str(),
                PAGE_SIZE,
            ),
        )
        .await
    })
    .await
}

/// Lo que hace [`eventos`] con lo que contesta el almacén, sin el bus: la lista
/// de calendarios ya leída, y `pagina` que pide una página por su cursor.
async fn read_pages<F, Fut>(calendarios_json: &str, mut pagina: F) -> Result<StoreReading, String>
where
    F: FnMut(String) -> Fut,
    Fut: std::future::Future<Output = Result<String, String>>,
{
    let guardados: Vec<StoredCalendar> = serde_json::from_str(calendarios_json)
        .map_err(|e| format!("no se pudieron leer los calendarios: {e}"))?;
    let calendarios = calendars_from(guardados);
    if calendarios.is_empty() {
        return Ok(StoreReading::default());
    }

    let mut reading = LecturaDeCuenta {
        calendarios,
        ..Default::default()
    };
    let mut cursor = String::new();
    for _ in 0..MAX_PAGES {
        let json = pagina(cursor.clone()).await?;
        let pagina: OccurrencePage = serde_json::from_str(&json)
            .map_err(|e| format!("no se pudieron leer los eventos: {e}"))?;
        // Una vez, aunque lo digan varias páginas: el almacén lo vuelve a
        // calcular en cada una, y el mismo aviso diez veces arriba del mes no
        // dice nada más que una.
        if pagina.truncated && !reading.fallos.iter().any(|f| f == TRUNCATED_WARNING) {
            reading.fallos.push(TRUNCATED_WARNING.into());
        }
        reading
            .eventos
            .extend(pagina.items.into_iter().map(event_from));
        match pagina.next_cursor {
            Some(siguiente) if !siguiente.is_empty() => cursor = siguiente,
            _ => {
                return Ok(StoreReading {
                    reading,
                    available: true,
                })
            }
        }
    }
    reading
        .fallos
        .push("hay más eventos en este rango de los que se pueden mostrar".into());
    Ok(StoreReading {
        reading,
        available: true,
    })
}

/// Una cuenta a la que no se le pudo pedir una vuelta, y por qué. La ventana
/// lo dice al lado de la cuenta: un «Actualizar» que no hizo nada y no lo dice
/// se lee como que no había nada nuevo.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SyncRequestFailure {
    pub account_id: String,
    /// `denied` (sin permiso), `too_soon` (se pidió hace un momento),
    /// `unavailable` (el sincronizador no está) o `failed`.
    pub reason: &'static str,
}

/// Por qué no se aceptó un pedido, a partir del nombre del error de D-Bus.
pub fn failure_reason(error_name: Option<&str>) -> &'static str {
    match error_name {
        Some("org.freedesktop.DBus.Error.AccessDenied") => "denied",
        Some("org.freedesktop.DBus.Error.LimitsExceeded") => "too_soon",
        Some("org.freedesktop.DBus.Error.ServiceUnknown")
        | Some("org.freedesktop.DBus.Error.NameHasNoOwner")
        | Some("org.freedesktop.DBus.Error.UnknownObject")
        | Some("org.freedesktop.DBus.Error.UnknownMethod") => "unavailable",
        _ => "failed",
    }
}

/// El nombre de un error de D-Bus, si lo tiene.
fn error_name(error: &zbus::Error) -> Option<String> {
    match error {
        zbus::Error::MethodError(name, _, _) => Some(name.to_string()),
        zbus::Error::FDO(e) => Some(zbus::DBusError::name(e.as_ref()).to_string()),
        _ => None,
    }
}

/// Le pide al sincronizador una vuelta ya de unas cuentas: el botón
/// «Actualizar». No espera a que termine: lo nuevo se avisa con [`CHANGED_EVENT`]
/// y el estado con [`STATUS_EVENT`]. Devuelve las cuentas a las que no se les
/// pudo pedir; un fallo de una no frena a las demás.
pub async fn request_sync(account_ids: &[String]) -> Vec<SyncRequestFailure> {
    let (conexion, dueno) = match connect_verified().await {
        Ok(verificada) => verificada,
        Err(e) => {
            eprintln!("[calendario] no se pudo pedir una vuelta: {e}");
            return account_ids
                .iter()
                .map(|id| SyncRequestFailure {
                    account_id: id.clone(),
                    reason: "unavailable",
                })
                .collect();
        }
    };
    let mut failures = Vec::new();
    for id in account_ids {
        if let Err(e) = conexion
            .call_method(
                Some(dueno.as_str()),
                PATH,
                Some(INTERFACE),
                "RequestSync",
                &(id.as_str(),),
            )
            .await
        {
            let reason = failure_reason(error_name(&e).as_deref());
            eprintln!("[calendario] no se pudo pedir una vuelta de una cuenta ({reason})");
            failures.push(SyncRequestFailure {
                account_id: id.clone(),
                reason,
            });
        }
    }
    failures
}

/// El estado de la sincronización del calendario de una cuenta, como lo da
/// `GetStatus`.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct AccountSyncStatus {
    pub account_id: String,
    /// `off`, `pending`, `syncing`, `synced`, `unavailable` o `failed`.
    pub state: String,
    /// Qué pasó, si falló o no está disponible. Lo escribe el almacén.
    pub detail: String,
    /// Cuándo terminó la última vuelta buena (RFC 3339), si hubo.
    pub last_synced_at: Option<String>,
}

/// El estado del área `area` de cada cuenta, de la respuesta de `GetStatus`.
/// Las cuentas sin esa área no aparecen.
pub fn statuses_from(json: &str, area: &str) -> Result<Vec<AccountSyncStatus>, String> {
    let value: serde_json::Value = serde_json::from_str(json)
        .map_err(|e| format!("no se pudo leer el estado del almacén: {e}"))?;
    let accounts = value
        .get("accounts")
        .and_then(|a| a.as_array())
        .cloned()
        .unwrap_or_default();
    let text =
        |v: &serde_json::Value, k: &str| v.get(k).and_then(|x| x.as_str()).map(str::to_string);
    Ok(accounts
        .iter()
        .filter_map(|account| {
            let shown = account.get(area)?;
            Some(AccountSyncStatus {
                account_id: text(account, "account_id")?,
                state: text(shown, "state").unwrap_or_else(|| "off".into()),
                detail: text(shown, "detail").unwrap_or_default(),
                last_synced_at: text(shown, "last_synced_at"),
            })
        })
        .collect())
}

/// El estado de la sincronización del calendario de cada cuenta.
pub async fn sync_status() -> Result<Vec<AccountSyncStatus>, String> {
    let json = call("GetStatus", &()).await?;
    statuses_from(&json, "calendar")
}

/// Pasa a la ventana cada `Changed("calendar", …)` del almacén.
pub fn watch(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        // En bucle: el bus se puede cortar, y con un solo intento la ventana
        // dejaría de enterarse de lo nuevo hasta que se la cierre.
        loop {
            if let Err(e) = follow(&app).await {
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
fn change_rule() -> Result<zbus::MatchRule<'static>, String> {
    Ok(zbus::MatchRule::builder()
        .msg_type(zbus::message::Type::Signal)
        // Sólo del dueño del nombre del sincronizador y de su objeto: cualquier
        // proceso de la sesión puede emitir una señal con esta interfaz, y cada
        // una hace releer el mes.
        .sender(SERVICE)
        .and_then(|r| r.path(PATH))
        .and_then(|r| r.interface(INTERFACE))
        .and_then(|r| r.member("Changed"))
        .and_then(|r| r.arg(0, "calendar"))
        .map_err(|e| format!("no se pudo armar el filtro del almacén: {e}"))?
        .build())
}

/// La señal de que cambió el estado de alguna base: `StatusChanged`, sin
/// argumentos, también sólo del sincronizador y de su objeto.
fn status_rule() -> Result<zbus::MatchRule<'static>, String> {
    Ok(zbus::MatchRule::builder()
        .msg_type(zbus::message::Type::Signal)
        .sender(SERVICE)
        .and_then(|r| r.path(PATH))
        .and_then(|r| r.interface(INTERFACE))
        .and_then(|r| r.member("StatusChanged"))
        .map_err(|e| format!("no se pudo armar el filtro del estado: {e}"))?
        .build())
}

/// Qué avisó el almacén.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Notice {
    Changed,
    Status,
}

/// Qué eventos recibe la ventana por una ráfaga de avisos: uno de cada clase
/// que llegó, nunca uno por aviso. Un `StatusChanged` solo no relee el mes, y un
/// `Changed` solo no relee el estado.
fn events_for(burst: &[Notice]) -> Vec<&'static str> {
    let mut events = Vec::new();
    if burst.contains(&Notice::Changed) {
        events.push(CHANGED_EVENT);
    }
    if burst.contains(&Notice::Status) {
        events.push(STATUS_EVENT);
    }
    events
}

async fn follow(app: &tauri::AppHandle) -> Result<(), String> {
    use futures_util::StreamExt;
    use tauri::Emitter;

    let conexion = connect().await?;
    let changes = zbus::MessageStream::for_match_rule(change_rule()?, &conexion, None)
        .await
        .map_err(|e| format!("no se pudo escuchar al almacén: {e}"))?
        .map(|m| m.map(|_| Notice::Changed));
    let statuses = zbus::MessageStream::for_match_rule(status_rule()?, &conexion, None)
        .await
        .map_err(|e| format!("no se pudo escuchar el estado del almacén: {e}"))?
        .map(|m| m.map(|_| Notice::Status));
    let mut avisos = futures_util::stream::select(changes, statuses);
    while let Some(aviso) = avisos.next().await {
        let Ok(first) = aviso else {
            continue;
        };
        // Una vuelta escribe de a lotes y avisa por cada uno: los seguidos se
        // juntan, y la ventana recibe un aviso de cada clase.
        tokio::time::sleep(SETTLE).await;
        let mut seen = vec![first];
        while let Some(Some(next)) = futures_util::FutureExt::now_or_never(avisos.next()) {
            if let Ok(kind) = next {
                seen.push(kind);
            }
        }
        for event in events_for(&seen) {
            let _ = app.emit(event, ());
        }
    }
    Err("el bus de sesión cerró la conexión".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::sync::{Mutex, MutexGuard, OnceLock};

    const BUS_ADDRESS_VAR: &str = "DBUS_SESSION_BUS_ADDRESS";

    /// Varias pruebas tocan `DBUS_SESSION_BUS_ADDRESS` para apuntar `connect()` a
    /// un bus de mentira o de prueba. Como las pruebas corren en paralelo en el
    /// mismo proceso y la variable es del proceso entero, se serializan con este
    /// candado: sin él, una pisaría la dirección de la otra. Se recupera de un
    /// envenenamiento porque lo único que protege es una variable de entorno.
    fn env_lock() -> MutexGuard<'static, ()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Un calendario tal como lo serializa `CalendarItem` en
    /// `vasak-accounts/sync/src/store/calendar_read.rs`.
    fn calendar_json(id: &str, nombre: &str, components: &[&str]) -> serde_json::Value {
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
    fn old_occurrence(event_id: &str) -> serde_json::Value {
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
    fn new_occurrence(event_id: &str, recurring: bool, shown_once: bool) -> serde_json::Value {
        let mut o = old_occurrence(event_id);
        o["recurring"] = recurring.into();
        o["shown_once"] = shown_once.into();
        o
    }

    fn page_json(items: Vec<serde_json::Value>, next: Option<&str>, truncated: bool) -> String {
        serde_json::json!({ "items": items, "next_cursor": next, "truncated": truncated })
            .to_string()
    }

    fn guardado(id: &str, components: &[&str]) -> StoredCalendar {
        StoredCalendar {
            id: id.into(),
            account_id: "google".into(),
            display_name: format!("cal {id}"),
            color: Some("#FF0000".into()),
            components: components.iter().map(|c| c.to_string()).collect(),
        }
    }

    /// Las páginas que contestaría el almacén, y los cursores con que se las
    /// pidió. Sin bus: `leer` recibe la función que pide.
    fn read_with(
        calendarios: &serde_json::Value,
        paginas: Vec<Result<String, String>>,
    ) -> (Result<StoreReading, String>, Vec<String>) {
        let pedidas = RefCell::new(Vec::new());
        let restantes = RefCell::new(paginas.into_iter());
        let resultado =
            tauri::async_runtime::block_on(read_pages(&calendarios.to_string(), |cursor| {
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
        let calendarios = calendars_from(vec![
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
        assert_eq!(calendars_from(vec![guardado("google/1", &[])]).len(), 1);
    }

    #[test]
    fn el_calendario_guardado_llega_con_los_nombres_de_la_ventana() {
        let calendario = calendars_from(vec![guardado("google/7", &["VEVENT"])]).remove(0);
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
        let ocurrencia: StoredOccurrence =
            serde_json::from_value(new_occurrence("google/42", true, true)).unwrap();
        let evento = event_from(ocurrencia);
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
        let ocurrencia: StoredOccurrence =
            serde_json::from_value(old_occurrence("google/42")).unwrap();
        assert!(!ocurrencia.recurring);
        assert!(!ocurrencia.shown_once);
    }

    /// `ListCalendars` contesta una lista de `CalendarItem`, con `color` que
    /// puede ser `null`.
    #[test]
    fn la_lista_de_calendarios_del_almacen_se_lee() {
        let mut sin_color = calendar_json("google/2", "Feriados", &["VEVENT"]);
        sin_color["color"] = serde_json::Value::Null;
        let json = serde_json::json!([
            calendar_json("google/1", "Personal", &["VEVENT"]),
            sin_color
        ]);
        let guardados: Vec<StoredCalendar> = serde_json::from_value(json).unwrap();
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
        let reading = StoreReading {
            reading: LecturaDeCuenta {
                calendarios: calendars_from(vec![guardado("google/1", &["VEVENT"])]),
                eventos: vec![event_from(
                    serde_json::from_value(new_occurrence("google/42", true, false)).unwrap(),
                )],
                fallos: vec!["algo".into()],
            },
            available: true,
        };
        let json = serde_json::to_value(&reading).unwrap();
        let mut claves: Vec<_> = json.as_object().unwrap().keys().cloned().collect();
        claves.sort();
        assert_eq!(claves, ["available", "calendarios", "eventos", "fallos"]);
        assert_eq!(json["available"], true);

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
        let solo_tareas = serde_json::json!([calendar_json("google/2", "Tareas", &["VTODO"])]);
        let (reading, pedidas) = read_with(&solo_tareas, vec![]);
        assert_eq!(reading.unwrap(), StoreReading::default());
        assert!(pedidas.is_empty(), "pidió ocurrencias: {pedidas:?}");
    }

    #[test]
    fn las_paginas_se_siguen_por_su_cursor_hasta_el_final() {
        let calendarios = serde_json::json!([calendar_json("google/1", "Personal", &["VEVENT"])]);
        let (reading, pedidas) = read_with(
            &calendarios,
            vec![
                Ok(page_json(
                    vec![new_occurrence("google/1", false, false)],
                    Some("c1"),
                    false,
                )),
                Ok(page_json(
                    vec![new_occurrence("google/2", false, false)],
                    Some("c2"),
                    false,
                )),
                // El final es `next_cursor == null`, no una página vacía.
                Ok(page_json(
                    vec![new_occurrence("google/3", false, false)],
                    None,
                    false,
                )),
            ],
        );
        let reading = reading.unwrap();
        assert_eq!(pedidas, ["", "c1", "c2"]);
        let uids: Vec<_> = reading
            .reading
            .eventos
            .iter()
            .map(|e| e.event.uid.as_str())
            .collect();
        assert_eq!(uids, ["google/1", "google/2", "google/3"]);
        assert!(reading.available);
        assert!(reading.reading.fallos.is_empty());
        assert_eq!(reading.reading.calendarios.len(), 1);
    }

    /// Un cursor vacío también es el final: si se lo siguiera, se volvería a
    /// pedir la primera página para siempre.
    #[test]
    fn un_cursor_vacio_es_el_final() {
        let calendarios = serde_json::json!([calendar_json("google/1", "Personal", &[])]);
        let (reading, pedidas) =
            read_with(&calendarios, vec![Ok(page_json(vec![], Some(""), false))]);
        assert!(reading.unwrap().available);
        assert_eq!(pedidas, [""]);
    }

    /// Lo que el almacén no pudo expandir se dice: si no, las semanas que
    /// faltan parecen libres.
    /// El almacén vuelve a decir `truncated` en cada página; el aviso tiene
    /// que salir una sola vez arriba del mes.
    #[test]
    fn el_aviso_de_recorte_sale_una_sola_vez_aunque_lo_digan_varias_paginas() {
        let calendarios = serde_json::json!([calendar_json("google/1", "Personal", &[])]);
        let (reading, _) = read_with(
            &calendarios,
            vec![
                Ok(page_json(vec![old_occurrence("google/1")], Some("b"), true)),
                Ok(page_json(vec![old_occurrence("google/1")], Some("c"), true)),
                Ok(page_json(vec![old_occurrence("google/1")], None, true)),
            ],
        );
        assert_eq!(
            reading.unwrap().reading.fallos,
            vec![TRUNCATED_WARNING.to_string()]
        );
    }

    #[test]
    fn una_pagina_cortada_se_avisa() {
        let calendarios = serde_json::json!([calendar_json("google/1", "Personal", &[])]);
        let (reading, _) = read_with(
            &calendarios,
            vec![Ok(page_json(vec![old_occurrence("google/1")], None, true))],
        );
        let reading = reading.unwrap();
        assert_eq!(reading.reading.eventos.len(), 1);
        assert_eq!(reading.reading.fallos.len(), 1);
        assert!(
            reading.reading.fallos[0].contains("expandir"),
            "{:?}",
            reading.reading.fallos
        );
    }

    /// Un almacén que nunca termina de dar páginas no cuelga la ventana: se
    /// muestra lo que entró y se avisa que falta.
    #[test]
    fn un_cursor_que_no_termina_se_corta_y_se_avisa() {
        let calendarios = serde_json::json!([calendar_json("google/1", "Personal", &[])]);
        let infinitas = (0..MAX_PAGES + 5)
            .map(|i| {
                Ok(page_json(
                    vec![old_occurrence(&format!("google/{i}"))],
                    Some(&format!("c{i}")),
                    false,
                ))
            })
            .collect();
        let (reading, pedidas) = read_with(&calendarios, infinitas);
        let reading = reading.unwrap();
        assert_eq!(pedidas.len(), MAX_PAGES);
        assert_eq!(reading.reading.eventos.len(), MAX_PAGES);
        assert!(reading.available);
        assert!(
            reading
                .reading
                .fallos
                .iter()
                .any(|f| f.contains("más eventos")),
            "{:?}",
            reading.reading.fallos
        );
    }

    /// Un fallo a mitad de camino no se disfraza de mes vacío: la ventana lo
    /// toma como almacén caído y lee cuenta por cuenta.
    #[test]
    fn una_pagina_que_falla_o_no_se_entiende_es_un_error() {
        let calendarios = serde_json::json!([calendar_json("google/1", "Personal", &[])]);
        let (reading, _) = read_with(
            &calendarios,
            vec![
                Ok(page_json(vec![], Some("c1"), false)),
                Err("ListOccurrences: sin permiso".into()),
            ],
        );
        assert_eq!(reading.unwrap_err(), "ListOccurrences: sin permiso");

        let (reading, _) = read_with(&calendarios, vec![Ok("{\"items\": 3}".into())]);
        assert!(reading.unwrap_err().contains("eventos"));

        let (reading, pedidas) = read_with(&serde_json::json!({"no": "es lista"}), vec![]);
        assert!(reading.unwrap_err().contains("calendarios"));
        assert!(pedidas.is_empty());
    }

    // ── Qué avisos despiertan a la ventana ─────────────────────────────────

    /// Sólo `Changed("calendar", …)` de la interfaz del almacén: un lote de
    /// correo o de contactos no relee el mes.
    #[test]
    fn solo_los_cambios_del_calendario_despiertan_a_la_ventana() {
        let regla = change_rule().unwrap().to_string();
        for parte in [
            "type='signal'",
            "interface='ar.net.vasak.os.AccountsStore'",
            "member='Changed'",
            "arg0='calendar'",
        ] {
            assert!(regla.contains(parte), "falta {parte} en {regla}");
        }
    }

    /// Cualquier proceso de la sesión puede emitir una señal con la interfaz
    /// del almacén: sólo cuenta la del dueño del nombre del sincronizador, y
    /// desde su objeto.
    #[test]
    fn solo_cuenta_el_changed_del_sincronizador_y_de_su_objeto() {
        let regla = change_rule().unwrap().to_string();
        for parte in [
            "sender='ar.net.vasak.os.AccountsSync'",
            "path='/ar/net/vasak/os/AccountsStore'",
        ] {
            assert!(regla.contains(parte), "falta {parte} en {regla}");
        }
    }

    /// El área de esta ventana en `GetStatus`, y otra que no tiene que mirar.
    const AREA: &str = "calendar";
    const OTHER_AREA: &str = "email";
    /// Los eventos que escucha la ventana (`src/composables`, `src/views`).
    const EXPECTED_CHANGED_EVENT: &str = "calendar-changed";
    const EXPECTED_STATUS_EVENT: &str = "calendar-sync-status";

    // ── El estado de la sincronización ─────────────────────────────────────

    /// La respuesta de `GetStatus` como la arma `visible_status` en
    /// `vasak-accounts/sync/src/store_api.rs`: con permiso sobre el área van
    /// `detail` y `last_synced_at`; sin permiso, sólo `state`.
    fn status_json() -> String {
        let mut con_permiso = serde_json::json!({
            "account_id": "google",
            "state": "ready",
            "detail": "",
            "size_bytes": 10,
        });
        con_permiso[AREA] = serde_json::json!({
            "state": "synced",
            "detail": "",
            "last_synced_at": "2026-10-13T17:05:00Z",
        });
        con_permiso[OTHER_AREA] = serde_json::json!({ "state": "failed" });
        let mut fallida = serde_json::json!({ "account_id": "nube", "state": "ready" });
        fallida[AREA] = serde_json::json!({
            "state": "failed",
            "detail": "el servidor rechazó la clave",
            "last_synced_at": null,
        });
        let mut de_otra_area = serde_json::json!({ "account_id": "otra", "state": "ready" });
        de_otra_area[OTHER_AREA] = serde_json::json!({ "state": "syncing" });
        let mut sin_permiso = serde_json::json!({ "account_id": "ajena", "state": "ready" });
        sin_permiso[AREA] = serde_json::json!({ "state": "pending" });
        serde_json::json!({
            "keyring": "unlocked",
            "accounts": [con_permiso, fallida, de_otra_area, sin_permiso],
        })
        .to_string()
    }

    fn estado(id: &str, state: &str, detail: &str, last: Option<&str>) -> AccountSyncStatus {
        AccountSyncStatus {
            account_id: id.into(),
            state: state.into(),
            detail: detail.into(),
            last_synced_at: last.map(str::to_string),
        }
    }

    #[test]
    fn el_estado_de_cada_cuenta_sale_de_su_area() {
        assert_eq!(
            statuses_from(&status_json(), AREA).unwrap(),
            vec![
                estado("google", "synced", "", Some("2026-10-13T17:05:00Z")),
                estado("nube", "failed", "el servidor rechazó la clave", None),
                // Sin permiso sobre el área el almacén manda sólo el estado: se
                // muestra igual, sin detalle ni hora.
                estado("ajena", "pending", "", None),
            ]
        );
    }

    /// Una cuenta que no tiene esta área —sólo otra— no tiene nada que decir
    /// acá: si apareciera, se le mostraría el estado de otra área.
    #[test]
    fn una_cuenta_sin_esta_area_no_aparece() {
        let ids: Vec<_> = statuses_from(&status_json(), AREA)
            .unwrap()
            .into_iter()
            .map(|s| s.account_id)
            .collect();
        assert!(!ids.contains(&"otra".to_string()), "{ids:?}");
        // Y de la que tiene las dos, el estado es el de esta área.
        let google = statuses_from(&status_json(), AREA).unwrap().remove(0);
        assert_eq!(google.state, "synced");
    }

    #[test]
    fn un_area_sin_estado_se_lee_apagada() {
        let mut cuenta = serde_json::json!({ "account_id": "google" });
        cuenta[AREA] = serde_json::json!({});
        let json = serde_json::json!({ "accounts": [cuenta] }).to_string();
        assert_eq!(
            statuses_from(&json, AREA).unwrap(),
            vec![estado("google", "off", "", None)]
        );
    }

    #[test]
    fn una_cuenta_sin_id_no_se_muestra() {
        let mut cuenta = serde_json::json!({ "state": "ready" });
        cuenta[AREA] = serde_json::json!({ "state": "synced" });
        let json = serde_json::json!({ "accounts": [cuenta] }).to_string();
        assert_eq!(statuses_from(&json, AREA).unwrap(), vec![]);
    }

    #[test]
    fn una_respuesta_que_no_es_json_es_un_error() {
        assert!(statuses_from("no es json", AREA).is_err());
    }

    /// Un almacén que todavía no tiene cuentas, o que contesta otra cosa en
    /// `accounts`, es ningún estado: no es un error que haya que mostrar.
    #[test]
    fn una_respuesta_sin_cuentas_no_tiene_estados() {
        assert_eq!(
            statuses_from(r#"{"keyring":"locked"}"#, AREA).unwrap(),
            vec![]
        );
        assert_eq!(statuses_from(r#"{"accounts":3}"#, AREA).unwrap(), vec![]);
        assert_eq!(statuses_from("[]", AREA).unwrap(), vec![]);
    }

    /// Lo que viaja a la ventana tiene que tener **exactamente** los nombres
    /// que lee `src/tools/sync-status.ts`: Tauri no los convierte.
    #[test]
    fn el_estado_y_los_rechazos_llegan_con_los_nombres_de_la_ventana() {
        let json =
            serde_json::to_value(estado("google", "synced", "", Some("2026-10-13T17:05:00Z")))
                .unwrap();
        let mut claves: Vec<_> = json.as_object().unwrap().keys().cloned().collect();
        claves.sort();
        assert_eq!(claves, ["account_id", "detail", "last_synced_at", "state"]);
        // Sin hora, `null`: el tipo de la ventana es `string | null`.
        let sin_hora = serde_json::to_value(estado("google", "pending", "", None)).unwrap();
        assert!(sin_hora["last_synced_at"].is_null());

        let rechazo = serde_json::to_value(SyncRequestFailure {
            account_id: "google".into(),
            reason: "denied",
        })
        .unwrap();
        assert_eq!(
            rechazo,
            serde_json::json!({ "account_id": "google", "reason": "denied" })
        );
    }

    // ── Lo que «Actualizar» no pudo pedir ──────────────────────────────────

    #[test]
    fn cada_rechazo_del_almacen_tiene_su_motivo() {
        for (nombre, motivo) in [
            ("org.freedesktop.DBus.Error.AccessDenied", "denied"),
            ("org.freedesktop.DBus.Error.LimitsExceeded", "too_soon"),
            ("org.freedesktop.DBus.Error.ServiceUnknown", "unavailable"),
            ("org.freedesktop.DBus.Error.NameHasNoOwner", "unavailable"),
            ("org.freedesktop.DBus.Error.UnknownObject", "unavailable"),
            ("org.freedesktop.DBus.Error.UnknownMethod", "unavailable"),
            ("org.freedesktop.DBus.Error.Failed", "failed"),
            ("ar.net.vasak.os.Error.Otro", "failed"),
        ] {
            assert_eq!(failure_reason(Some(nombre)), motivo, "{nombre}");
        }
        // Un error que no es de D-Bus —se cortó la conexión— también falló.
        assert_eq!(failure_reason(None), "failed");
    }

    /// Una respuesta de error de verdad, como la que llega por el bus. Así es
    /// como `call_method` devuelve el `LimitsExceeded` del almacén: un
    /// `MethodError`, no un `FDO`.
    fn error_reply(nombre: &str) -> zbus::Error {
        let pedido = zbus::Message::method_call(PATH, "RequestSync")
            .unwrap()
            .build(&("google",))
            .unwrap();
        let respuesta = zbus::Message::error(&pedido.header(), nombre)
            .unwrap()
            .build(&("una por cuenta cada minuto",))
            .unwrap();
        zbus::Error::from(respuesta)
    }

    #[test]
    fn el_motivo_sale_del_nombre_de_la_respuesta_de_error() {
        let limite = error_reply("org.freedesktop.DBus.Error.LimitsExceeded");
        assert!(matches!(limite, zbus::Error::MethodError(..)), "{limite:?}");
        assert_eq!(failure_reason(error_name(&limite).as_deref()), "too_soon");

        let sin_permiso = error_reply("org.freedesktop.DBus.Error.AccessDenied");
        assert_eq!(
            failure_reason(error_name(&sin_permiso).as_deref()),
            "denied"
        );

        // El mismo error ya convertido a `fdo::Error` da el mismo motivo.
        let fdo = zbus::Error::from(zbus::fdo::Error::AccessDenied("no".into()));
        assert!(matches!(fdo, zbus::Error::FDO(_)), "{fdo:?}");
        assert_eq!(failure_reason(error_name(&fdo).as_deref()), "denied");

        assert_eq!(error_name(&zbus::Error::InvalidReply), None);
    }

    /// Sin bus de sesión no se le pudo pedir nada a nadie: cada cuenta pedida
    /// vuelve como sin servicio, y la ventana lo dice al lado de cada una.
    #[test]
    fn sin_bus_cada_cuenta_pedida_queda_sin_servicio() {
        let _guard = env_lock();
        let _address = BusAddressGuard::point_to("unix:path=/nonexistent/vasak-qa/bus");
        let ids = vec!["google".to_string(), "nube".to_string()];
        let fallos = tauri::async_runtime::block_on(request_sync(&ids));
        assert_eq!(
            fallos,
            vec![
                SyncRequestFailure {
                    account_id: "google".into(),
                    reason: "unavailable",
                },
                SyncRequestFailure {
                    account_id: "nube".into(),
                    reason: "unavailable",
                },
            ]
        );
    }

    // ── El aviso del estado ────────────────────────────────────────────────

    /// `StatusChanged` también sólo del sincronizador y de su objeto: si no,
    /// cualquier proceso de la sesión haría releer el estado a voluntad.
    #[test]
    fn solo_cuenta_el_status_changed_del_sincronizador_y_de_su_objeto() {
        let regla = status_rule().unwrap().to_string();
        for parte in [
            "type='signal'",
            "sender='ar.net.vasak.os.AccountsSync'",
            "path='/ar/net/vasak/os/AccountsStore'",
            "interface='ar.net.vasak.os.AccountsStore'",
            "member='StatusChanged'",
        ] {
            assert!(regla.contains(parte), "falta {parte} en {regla}");
        }
    }

    /// Una vuelta escribe de a lotes y avisa por cada uno: la ventana recibe
    /// un solo aviso por ráfaga, no uno por lote.
    #[test]
    fn una_rafaga_de_cambios_avisa_una_sola_vez() {
        assert_eq!(
            events_for(&[Notice::Changed, Notice::Changed, Notice::Changed]),
            [CHANGED_EVENT]
        );
    }

    /// Un cambio de estado solo no relee lo guardado, y un cambio de lo
    /// guardado solo no relee el estado.
    #[test]
    fn cada_clase_de_aviso_despierta_solo_lo_suyo() {
        assert_eq!(
            events_for(&[Notice::Status, Notice::Status]),
            [STATUS_EVENT]
        );
        assert_eq!(events_for(&[Notice::Changed]), [CHANGED_EVENT]);
    }

    #[test]
    fn una_rafaga_mixta_avisa_una_vez_de_cada_clase() {
        assert_eq!(
            events_for(&[
                Notice::Status,
                Notice::Changed,
                Notice::Status,
                Notice::Changed
            ]),
            [CHANGED_EVENT, STATUS_EVENT]
        );
        assert!(events_for(&[]).is_empty());
    }

    #[test]
    fn los_avisos_a_la_ventana_tienen_los_nombres_que_escucha() {
        assert_eq!(CHANGED_EVENT, EXPECTED_CHANGED_EVENT);
        assert_eq!(STATUS_EVENT, EXPECTED_STATUS_EVENT);
    }

    // ── El dueño del almacén se comprueba antes de confiar ───────────────────
    //
    // El almacén vive en el bus de **sesión**, donde cualquier proceso del
    // usuario puede tomar el nombre `ar.net.vasak.os.AccountsSync` mientras el
    // servicio no está y hacerse pasar por él. Estas pruebas levantan un
    // `dbus-daemon` de verdad, hacen que el propio proceso de prueba —cuyo
    // `/proc/<pid>/exe` es el runner de cargo, no `/usr/bin/vasak-accounts-sync`—
    // tome el nombre, y comprueban que la lectura **falla cerrado** en vez de
    // confiar en el impostor. Sin el cableado de `connect_verified`, `call`
    // llamaría al impostor y el error no sería el de «no se pudo confiar», así
    // que estas pruebas fallan sin el cambio. Espejan el patrón de las de bus
    // real del crate (`vasak-accounts`, store-client/tests/real_bus.rs, #83).
    //
    // Si no hay `dbus-daemon` en el equipo, se avisan y no corren: el CI instala
    // el paquete `dbus` para que sí lo hagan.

    use std::io::{BufRead, BufReader};
    use std::path::PathBuf;
    use std::process::{Child, Command, Stdio};

    /// Un `dbus-daemon` de sesión sólo para la prueba. Se mata al salir del
    /// alcance y se lleva su archivo de configuración.
    struct TestBus {
        child: Child,
        address: String,
        config: PathBuf,
    }

    impl TestBus {
        /// Levanta el bus, o `None` si no hay `dbus-daemon` en el equipo.
        fn launch() -> Option<Self> {
            let config = std::env::temp_dir().join(format!(
                "vasak-calendar-store-bus-{}-{}.conf",
                std::process::id(),
                fastish_id()
            ));
            std::fs::write(
                &config,
                r#"<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-BUS Bus Configuration 1.0//EN" "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <listen>unix:tmpdir=/tmp</listen>
  <policy context="default">
    <allow own="*"/>
    <allow send_destination="*"/>
    <allow receive_sender="*"/>
  </policy>
</busconfig>
"#,
            )
            .ok()?;

            let mut child = Command::new("dbus-daemon")
                .arg(format!("--config-file={}", config.display()))
                .arg("--print-address")
                .arg("--nofork")
                .stdout(Stdio::piped())
                .spawn()
                .map_err(|_| {
                    let _ = std::fs::remove_file(&config);
                })
                .ok()?;

            let stdout = child.stdout.take()?;
            let mut address = String::new();
            if BufReader::new(stdout).read_line(&mut address).is_err() || address.trim().is_empty()
            {
                let _ = child.kill();
                let _ = std::fs::remove_file(&config);
                return None;
            }

            Some(TestBus {
                child,
                address: address.trim().to_owned(),
                config,
            })
        }

        fn address(&self) -> &str {
            &self.address
        }
    }

    impl Drop for TestBus {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
            let _ = std::fs::remove_file(&self.config);
        }
    }

    /// Un identificador barato y único por proceso, para el nombre del archivo
    /// de configuración del bus.
    fn fastish_id() -> u64 {
        use std::time::{SystemTime, UNIX_EPOCH};
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0)
    }

    /// Restaura `DBUS_SESSION_BUS_ADDRESS` a lo que tenía al salir del alcance,
    /// pase lo que pase en la prueba.
    struct BusAddressGuard {
        previous: Option<std::ffi::OsString>,
    }

    impl BusAddressGuard {
        /// Apunta `connect()` al bus de prueba y recuerda el valor anterior.
        fn point_to(address: &str) -> Self {
            let previous = std::env::var_os(BUS_ADDRESS_VAR);
            std::env::set_var(BUS_ADDRESS_VAR, address);
            Self { previous }
        }
    }

    impl Drop for BusAddressGuard {
        fn drop(&mut self) {
            match self.previous.take() {
                Some(valor) => std::env::set_var(BUS_ADDRESS_VAR, valor),
                None => std::env::remove_var(BUS_ADDRESS_VAR),
            }
        }
    }

    /// Un impostor que toma el nombre del sincronizador en el bus de prueba
    /// —el propio proceso de prueba— hace que la lectura **falle cerrado**: ni
    /// `connect_verified` ni `call` confían en él, y el error es el de «no se
    /// pudo confiar», no el de un método desconocido. Sin el cambio, `call`
    /// llamaría al impostor y el error sería otro: esta prueba falla sin él.
    // `env_lock` es un `std::sync::Mutex` —lo comparte con la prueba síncrona
    // `sin_bus_…`, que corre con `block_on`— y acá se sostiene a través de los
    // `.await` del bus a propósito: serializa la variable de entorno del proceso
    // durante toda la prueba. No protege ningún dato compartido entre tareas, así
    // que sostenerlo cruzando un `.await` no arriesga nada.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn un_impostor_en_el_bus_hace_fallar_cerrada_la_lectura() {
        let _guard = env_lock();
        let Some(bus) = TestBus::launch() else {
            eprintln!("sin dbus-daemon: se omite la prueba de bus real");
            return;
        };
        let _address = BusAddressGuard::point_to(bus.address());

        // El proceso de prueba toma el nombre del servicio: es el impostor. Su
        // `exe` es el runner de cargo, no `/usr/bin/vasak-accounts-sync`. La
        // conexión se mantiene viva mientras dure la comprobación.
        let impostor = connect().await.expect("conectar el impostor al bus");
        impostor
            .request_name(SERVICE)
            .await
            .expect("el impostor toma el nombre en el bus de prueba");

        let verificada = connect_verified().await;
        let error = verificada.expect_err("el impostor no tiene que ser de confianza");
        assert!(error.contains("confiar"), "{error}");

        // Y la lectura de verdad, por el mismo camino, también falla cerrado: no
        // es un error de método del impostor, es el de que no se pudo confiar.
        let lectura = call("GetStatus", &()).await;
        let error = lectura.expect_err("no se lee del impostor");
        assert!(error.contains("confiar"), "{error}");
    }

    /// Un nombre sin dueño —el servicio no está— también hace fallar cerrado:
    /// no hay en quién confiar.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn sin_dueno_del_nombre_la_lectura_falla_cerrada() {
        let _guard = env_lock();
        let Some(bus) = TestBus::launch() else {
            eprintln!("sin dbus-daemon: se omite la prueba de bus real");
            return;
        };
        let _address = BusAddressGuard::point_to(bus.address());

        // Nadie toma el nombre en este bus: no hay dueño que verificar.
        let verificada = connect_verified().await;
        assert!(verificada
            .expect_err("sin dueño no hay en quién confiar")
            .contains("confiar"));

        // Y una lectura de verdad por el mismo camino tampoco confía en nadie.
        let lectura = call("GetStatus", &()).await;
        assert!(lectura
            .expect_err("sin dueño no se lee")
            .contains("confiar"));

        // `request_sync` también cae cerrado: cada cuenta pedida vuelve como sin
        // servicio, porque `connect_verified` no pudo dar un dueño de confianza.
        let fallos = request_sync(&["google".to_string()]).await;
        assert_eq!(
            fallos,
            vec![SyncRequestFailure {
                account_id: "google".into(),
                reason: "unavailable",
            }]
        );
    }
}
