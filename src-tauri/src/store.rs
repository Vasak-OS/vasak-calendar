//! El calendario, tal como ya está sincronizado en el sistema.
//!
//! ── De dónde sale lo que se ve ──────────────────────────────────────────────
//!
//! `vasak-accounts-sync` mantiene una base cifrada con los calendarios de todas
//! las cuentas y la actualiza solo, en segundo plano. Esta ventana la lee por el
//! bus de sesión —`ar.net.vasak.os.AccountsStore`— y **no espera a la red**: el
//! mes aparece al abrir, y las repeticiones ya vienen expandidas.
//!
//! Todo pasa por `tauri-plugin-vsk-store`, que comprueba que el dueño del
//! nombre del sincronizador sea el de verdad antes de creerle nada, pasa a la
//! ventana los avisos de lo nuevo y del estado, y atiende «Actualizar». Acá
//! queda sólo lo propio del calendario: qué se pide y cómo se convierte en lo
//! que dibuja la cuadrícula.

use serde::{Deserialize, Serialize};

use tauri_plugin_vsk_store::StoreClient;

use crate::caldav::{Calendario, Event};
use crate::comandos::{EventInCalendar, LecturaDeCuenta};

/// Cuántas ocurrencias se piden por página: el máximo que acepta el almacén.
const PAGE_SIZE: u32 = 1000;

/// Cuántas páginas se leen como mucho para un rango. Seis semanas con más de
/// diez mil eventos no es una agenda, es un error; se muestra lo que entró y
/// se avisa.
const MAX_PAGES: usize = 10;

/// El aviso de que alguna serie no se pudo expandir del todo en el rango.
const TRUNCATED_WARNING: &str = "hay eventos que no se pudieron expandir del todo";

/// Lo que devuelve [`read_events`] cuando la persona le negó al almacén el
/// permiso de leer el calendario. **No se traduce**: es una marca que mira la
/// ventana para pintar el estado de «sin permiso» con su botón, y el texto lo
/// pone ella en el idioma de la sesión (`src/tools/store-permission.ts`). Una
/// frase traducida acá saldría en el idioma con el que se compiló el programa,
/// no en el de quien mira, y obligaría a la ventana a reconocerla por su texto.
pub const STORE_PERMISSION_DENIED: &str = "store-permission-denied";

/// Si el almacén contestó que la persona no dio permiso.
///
/// Se mira sobre el error tipado y no sobre su texto, porque el `Display` de
/// [`tauri_plugin_vsk_store::Error::Store`] es sólo el mensaje y **no** lleva el
/// nombre del error de D-Bus: `e.to_string()` perdería el `AccessDenied`.
///
/// Es distinto del fail-closed del cliente del plugin —que el dueño del nombre
/// no sea el sincronizador de verdad ([`tauri_plugin_vsk_store::Error::Impostor`])
/// o que no haya nadie en el bus ([`tauri_plugin_vsk_store::Error::NotRunning`])—:
/// ahí no hubo ninguna decisión que olvidar y volver a pedir no haría nada, así
/// que la ventana lee cuenta por cuenta. Un «no» explícito, en cambio, no se
/// esquiva yendo al servidor: eso pediría `account.calendar`, que entrega la
/// credencial y es más que lo que la persona acaba de negar.
pub(crate) fn denied(error: &tauri_plugin_vsk_store::Error) -> bool {
    matches!(
        error,
        tauri_plugin_vsk_store::Error::Store { name: Some(name), .. }
            if name == "org.freedesktop.DBus.Error.AccessDenied"
                || name == "org.freedesktop.DBus.Error.AuthFailed"
    )
}

/// El error de una lectura del almacén, como String para la ventana: la marca
/// [`STORE_PERMISSION_DENIED`] cuando fue un «no» de la persona, y el texto del
/// error para cualquier otra cosa —el servicio caído, un impostor en el
/// nombre—, que la ventana trata como almacén no disponible y resuelve leyendo
/// cuenta por cuenta.
fn describe(error: tauri_plugin_vsk_store::Error) -> String {
    if denied(&error) {
        STORE_PERMISSION_DENIED.to_string()
    } else {
        error.to_string()
    }
}

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
    /// El `COLOR` propio del evento (RFC 7986 §5.9), distinto del de su
    /// calendario. Un almacén que no lo manda lo deja en `None`.
    #[serde(default)]
    pub event_color: Option<String>,
    /// Las `CATEGORIES` del evento. Un almacén que no las manda las deja vacías.
    #[serde(default)]
    pub categories: Vec<String>,
    /// Si el evento es de una serie. Las versiones del almacén que no lo
    /// mandan lo dejan en `false`: se pierde el ícono, no el evento.
    #[serde(default)]
    pub recurring: bool,
    #[serde(default)]
    pub shown_once: bool,
    /// El ETag del objeto guardado, para pasarlo como `if_match` al editar.
    /// **Vacío** en un objeto recién creado local sin confirmar: así la ventana
    /// sabe que todavía no se puede editar. Un almacén de antes de A2 no lo
    /// manda y queda vacío, con lo que editar sigue en pausa, como estaba.
    #[serde(default)]
    pub etag: String,
    /// El estado de sincronización del objeto: `synced`, `pending` o `conflict`.
    /// Un almacén viejo que no lo manda se toma como `synced`: sin badge, como
    /// antes.
    #[serde(default = "sync_state_default")]
    pub sync_state: String,
}

/// Lo que vale `sync_state` cuando el almacén no lo manda: un objeto que viaja
/// sin estado es uno ya sincronizado, que no lleva ninguna marca.
fn sync_state_default() -> String {
    "synced".to_string()
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
        event_color: o.event_color,
        categories: o.categories,
        etag: o.etag,
        sync_state: o.sync_state,
    }
}

/// Los calendarios y los eventos de todas las cuentas en `[desde, hasta)`, por
/// el cliente comprobado del plugin.
pub async fn read_events(
    store: &StoreClient,
    desde: &str,
    hasta: &str,
) -> Result<StoreReading, String> {
    let json = store
        .call_json("ListCalendars", &())
        .await
        .map_err(describe)?;
    read_pages(&json, |cursor| async move {
        store
            .call_json(
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
            .map_err(describe)
    })
    .await
}

/// Lo que hace [`read_events`] con lo que contesta el almacén, sin el bus: la lista
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

/// Lo que contesta el almacén tras crear o editar un evento: el id global del
/// objeto escrito, `cuenta/id`. Es lo que la ventana usa para volver a leerlo.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct WriteResult {
    pub event_id: String,
}

/// Crea o edita un evento en el almacén, por el cliente comprobado del plugin.
///
/// `if_match` vacío **crea**: el `payload` no lleva `id`, el sincronizador genera
/// el `UID` y encola sin precondición. Con un ETag **edita** el evento cuyo `id`
/// local va en el `payload`, con ese ETag de precondición (edición conservadora:
/// se parte del crudo guardado y se toca sólo lo que el parche nombra).
///
/// El `payload` es el parche JSON que arma la ventana: `summary`/`description`/
/// `location` de texto (ausente no toca, `null` saca, un valor fija) y
/// `start`/`end` como `{"value": "...", "params": ["..."]}`. No se interpreta
/// acá: viaja tal cual, y un parche mal formado lo rechaza el sincronizador con
/// su motivo, que llega como el error de cualquier otra llamada.
pub async fn put_event(
    store: &StoreClient,
    account_id: &str,
    calendar_id: &str,
    payload: &str,
    if_match: &str,
) -> Result<WriteResult, String> {
    let json = store
        .call_json("PutEvent", &(account_id, calendar_id, payload, if_match))
        .await
        .map_err(describe)?;
    serde_json::from_str(&json)
        .map_err(|e| format!("no se pudo leer la respuesta de PutEvent: {e}"))
}

/// Borra un evento del almacén, por el cliente comprobado del plugin.
///
/// `if_match` vacío borra sin precondición; con un ETag, sólo si el recurso no
/// cambió desde él. El almacén marca la fila y encola el borrado hacia el
/// servidor; la señal `Changed` del área sale sola, y con ella la ventana relee.
pub async fn delete_event(
    store: &StoreClient,
    account_id: &str,
    event_id: &str,
    if_match: &str,
) -> Result<(), String> {
    store
        .call_json("DeleteEvent", &(account_id, event_id, if_match))
        .await
        .map_err(describe)?;
    Ok(())
}

// ── Las tareas: listar, crear, editar y borrar ─────────────────────────────

/// Una tarea (`VTODO`) tal como la lista `ListTasks` del almacén.
///
/// Los nombres son los de `TaskItem` en
/// `vasak-accounts/sync/src/store/calendar_read.rs`, tal cual: Tauri no los
/// convierte y uno que no coincide llega como `undefined` sin ningún error. El
/// `etag` y el `sync_state` los sumó A-TASKDTO; un almacén de antes no los manda
/// y quedan en sus valores por omisión —`etag` vacío (editar en pausa) y
/// `sync_state` en `synced` (sin badge)—, igual que con los eventos.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct StoredTask {
    pub task_id: String,
    pub calendar_id: String,
    pub title: String,
    #[serde(default)]
    pub due: Option<String>,
    #[serde(default)]
    pub all_day: bool,
    /// `needs-action`, `in-process`, `completed`, `cancelled`, o vacío.
    #[serde(default)]
    pub status: String,
    /// De 1 (la más alta) a 9, o nada.
    #[serde(default)]
    pub priority: Option<i64>,
    #[serde(default)]
    pub completed: Option<String>,
    /// Si la tarea está terminada: con esto se dibuja la casilla marcada.
    #[serde(default)]
    pub done: bool,
    #[serde(default)]
    pub color: Option<String>,
    /// El ETag del objeto guardado, para pasarlo como `if_match` al editar o
    /// completar. **Vacío** en una tarea recién creada local sin confirmar: así
    /// la ventana sabe que todavía no se puede editar.
    #[serde(default)]
    pub etag: String,
    /// El estado de sincronización: `synced`, `pending` o `conflict`.
    #[serde(default = "sync_state_default")]
    pub sync_state: String,
}

#[derive(Debug, Clone, Deserialize)]
struct TaskPage {
    items: Vec<StoredTask>,
    #[serde(default)]
    next_cursor: Option<String>,
}

/// Lo que se lee del almacén para las tareas: las listas de tareas y lo que hay
/// en ellas, con `available` para que la ventana sepa si el almacén ya tiene
/// algo que mostrar.
#[derive(Debug, Clone, Serialize, Default, PartialEq, Eq)]
pub struct TaskReading {
    /// Las listas donde se pueden guardar tareas, para el selector del formulario.
    pub calendars: Vec<Calendario>,
    pub tasks: Vec<StoredTask>,
    /// Lo que impidió leer algo. Vacío si salió todo bien.
    pub notices: Vec<String>,
    /// Si el almacén tiene alguna lista de tareas. Sin ninguna, la ventana no
    /// muestra nada: el área todavía no se encendió o la primera vuelta no
    /// terminó.
    pub available: bool,
}

/// Las listas de tareas del almacén. Una lista que sólo guarda eventos no va: no
/// se puede crear una tarea en ella. Una que no dice qué guarda entra, como con
/// los eventos: descartarla dejaría a la persona sin dónde crear una tarea sin
/// decir por qué.
pub fn task_calendars_from(guardados: Vec<StoredCalendar>) -> Vec<Calendario> {
    guardados
        .into_iter()
        .filter(|c| c.components.is_empty() || c.components.iter().any(|x| x == "VTODO"))
        .map(|c| Calendario {
            url: c.id,
            nombre: c.display_name,
            color: c.color,
        })
        .collect()
}

/// Las listas de tareas y sus tareas, de todas las cuentas, por el cliente
/// comprobado del plugin. `include_completed` decide si entran las ya
/// terminadas.
pub async fn read_tasks(
    store: &StoreClient,
    include_completed: bool,
) -> Result<TaskReading, String> {
    let json = store
        .call_json("ListCalendars", &())
        .await
        .map_err(describe)?;
    read_task_pages(&json, |cursor| async move {
        store
            .call_json(
                "ListTasks",
                &(
                    Vec::<String>::new(),
                    include_completed,
                    cursor.as_str(),
                    PAGE_SIZE,
                ),
            )
            .await
            .map_err(describe)
    })
    .await
}

/// Lo que hace [`read_tasks`] con lo que contesta el almacén, sin el bus: la
/// lista de calendarios ya leída, y `pagina` que pide una página de tareas por
/// su cursor.
async fn read_task_pages<F, Fut>(
    calendarios_json: &str,
    mut pagina: F,
) -> Result<TaskReading, String>
where
    F: FnMut(String) -> Fut,
    Fut: std::future::Future<Output = Result<String, String>>,
{
    let guardados: Vec<StoredCalendar> = serde_json::from_str(calendarios_json)
        .map_err(|e| format!("no se pudieron leer los calendarios: {e}"))?;
    let calendars = task_calendars_from(guardados);
    if calendars.is_empty() {
        return Ok(TaskReading::default());
    }

    let mut reading = TaskReading {
        calendars,
        ..Default::default()
    };
    let mut cursor = String::new();
    for _ in 0..MAX_PAGES {
        let json = pagina(cursor.clone()).await?;
        let pagina: TaskPage = serde_json::from_str(&json)
            .map_err(|e| format!("no se pudieron leer las tareas: {e}"))?;
        reading.tasks.extend(pagina.items);
        match pagina.next_cursor {
            Some(siguiente) if !siguiente.is_empty() => cursor = siguiente,
            _ => {
                reading.available = true;
                return Ok(reading);
            }
        }
    }
    reading
        .notices
        .push("hay más tareas de las que se pueden mostrar".into());
    reading.available = true;
    Ok(reading)
}

/// Lo que contesta el almacén tras crear o editar una tarea: el id global del
/// objeto escrito, `cuenta/id`.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct TaskWriteResult {
    pub task_id: String,
}

/// Crea o edita una tarea en el almacén, por el cliente comprobado del plugin.
///
/// `if_match` vacío **crea**: el `payload` no lleva `id`, el sincronizador genera
/// el `UID` y encola sin precondición. Con un ETag **edita** la tarea cuyo `id`
/// local va en el `payload`, con ese ETag de precondición. Completar una tarea es
/// un caso de editar: el parche fija `status` en `COMPLETED` y `percent_complete`
/// en 100.
///
/// El `payload` es el parche JSON que arma la ventana: `summary`/`description` de
/// texto, `due` como `{"value": "...", "params": ["..."]}`, `status`,
/// `percent_complete` y `priority` (ver `TaskPatch` en el servicio). No se
/// interpreta acá: viaja tal cual, y un parche mal formado lo rechaza el
/// sincronizador con su motivo.
pub async fn put_task(
    store: &StoreClient,
    account_id: &str,
    calendar_id: &str,
    payload: &str,
    if_match: &str,
) -> Result<TaskWriteResult, String> {
    let json = store
        .call_json("PutTask", &(account_id, calendar_id, payload, if_match))
        .await
        .map_err(describe)?;
    serde_json::from_str(&json).map_err(|e| format!("no se pudo leer la respuesta de PutTask: {e}"))
}

/// Borra una tarea del almacén, por el cliente comprobado del plugin.
///
/// `if_match` vacío borra sin precondición; con un ETag, sólo si el recurso no
/// cambió desde él. El almacén marca la fila y encola el borrado; la señal
/// `Changed` del área sale sola, y con ella la ventana relee.
pub async fn delete_task(
    store: &StoreClient,
    account_id: &str,
    task_id: &str,
    if_match: &str,
) -> Result<(), String> {
    store
        .call_json("DeleteTask", &(account_id, task_id, if_match))
        .await
        .map_err(describe)?;
    Ok(())
}

/// El área del calendario, como la nombran `ListConflicts`/`GetConflict`/
/// `ResolveConflict` del almacén. Siempre la misma desde esta aplicación: es la
/// de calendario, no la de contactos. Las tareas son objetos del calendario, así
/// que su conflicto se lista y se resuelve por acá, igual que el de un evento.
pub const CALENDAR_AREA: &str = "calendar";

/// Mi versión pisa a la del servidor.
pub const CHOICE_KEEP_LOCAL: &str = "keep_local";
/// Adopto la versión del servidor y descarto la mía.
pub const CHOICE_TAKE_SERVER: &str = "take_server";

/// Un objeto en conflicto, para la lista: lo mínimo para dibujar la fila. Los
/// nombres son los de `ConflictItem` en
/// `vasak-accounts/sync/src/store/conflict_read.rs`.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct ConflictSummary {
    /// El id local del objeto, el mismo que toman `GetConflict` y `GetEvent`.
    pub id: String,
    /// Qué cambio local chocó: `put` (creación o edición) o `delete` (borrado).
    pub op: String,
    /// El título del evento, para la fila. Vacío si no se pudo resolver.
    pub summary: String,
    /// Si ya se trajo la copia del servidor para comparar; con `false`,
    /// `GetConflict` dirá que la copia del servidor no está disponible.
    pub has_server_copy: bool,
}

#[derive(Debug, Clone, Deserialize)]
struct ConflictList {
    items: Vec<ConflictSummary>,
}

/// La comparación «la mía / la del servidor» de un objeto en conflicto. Los
/// nombres son los de `ConflictDetail` en el servicio.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct ConflictComparison {
    pub id: String,
    pub op: String,
    /// El crudo local sin confirmar. **Ausente** si el cambio local es un
    /// borrado: no hay versión local que mostrar, «la mía» es borrarlo.
    #[serde(default)]
    pub local: Option<String>,
    /// El crudo de la versión del servidor, si ya se trajo. **Ausente** mientras
    /// no esté: entonces `server_unavailable` es `true`.
    #[serde(default)]
    pub server: Option<String>,
    /// El ETag de la versión del servidor, si hay copia.
    #[serde(default)]
    pub server_etag: Option<String>,
    /// Si todavía no hay copia del servidor con qué comparar: la ventana muestra
    /// «copia del servidor no disponible» en vez de fallar.
    #[serde(default)]
    pub server_unavailable: bool,
}

/// Si una elección de resolución de conflicto es una de las dos válidas. Se
/// comprueba acá, antes de tocar el bus: una elección inventada no tiene que
/// llegar al almacén.
pub fn is_valid_choice(choice: &str) -> bool {
    choice == CHOICE_KEEP_LOCAL || choice == CHOICE_TAKE_SERVER
}

/// Los objetos del calendario de una cuenta que chocaron con el servidor y
/// esperan que la persona los resuelva, por el cliente comprobado del plugin.
pub async fn list_conflicts(
    store: &StoreClient,
    account_id: &str,
) -> Result<Vec<ConflictSummary>, String> {
    let json = store
        .call_json("ListConflicts", &(account_id, CALENDAR_AREA))
        .await
        .map_err(describe)?;
    let list: ConflictList = serde_json::from_str(&json)
        .map_err(|e| format!("no se pudieron leer los conflictos: {e}"))?;
    Ok(list.items)
}

/// La comparación de un objeto en conflicto por su id local, para la vista de
/// «mantener la mía / tomar la del servidor». `None` si ese id ya no está en
/// conflicto (el almacén contesta `null`).
pub async fn get_conflict(
    store: &StoreClient,
    account_id: &str,
    id: &str,
) -> Result<Option<ConflictComparison>, String> {
    let json = store
        .call_json("GetConflict", &(account_id, CALENDAR_AREA, id))
        .await
        .map_err(describe)?;
    serde_json::from_str(&json).map_err(|e| format!("no se pudo leer el conflicto: {e}"))
}

/// Resuelve un conflicto: `keep_local` deja que mi versión pise a la del
/// servidor, `take_server` adopta la del servidor. Una elección que no es
/// ninguna de las dos se rechaza antes de tocar el bus. Tras resolver, el
/// almacén avisa con `Changed` y la ventana relee.
pub async fn resolve_conflict(
    store: &StoreClient,
    account_id: &str,
    id: &str,
    choice: &str,
) -> Result<(), String> {
    if !is_valid_choice(choice) {
        return Err(format!(
            "«{choice}» no es una forma de resolver el conflicto"
        ));
    }
    store
        .call_json("ResolveConflict", &(account_id, CALENDAR_AREA, id, choice))
        .await
        .map_err(describe)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

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

    /// La misma, del almacén nuevo: suma `recurring`, `shown_once`, el `etag` y
    /// el `sync_state` que trajo A2.
    fn new_occurrence(event_id: &str, recurring: bool, shown_once: bool) -> serde_json::Value {
        let mut o = old_occurrence(event_id);
        o["recurring"] = recurring.into();
        o["shown_once"] = shown_once.into();
        o["etag"] = "\"etag-1\"".into();
        o["sync_state"] = "pending".into();
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
        // El ETag y el estado de sincronización se hilan hasta la ventana: son
        // lo que enciende editar y el badge de «sin sincronizar».
        assert_eq!(evento.etag, "\"etag-1\"");
        assert_eq!(evento.sync_state, "pending");
    }

    /// El color propio del evento y sus categorías llegan hasta la ventana; un
    /// almacén que no los manda las deja en `None` y vacías.
    #[test]
    fn el_evento_guardado_lleva_su_color_y_sus_categorias() {
        let mut json = new_occurrence("google/42", false, false);
        json["event_color"] = "#33AAFF".into();
        json["categories"] = serde_json::json!(["Trabajo", "Casa"]);
        let evento = event_from(serde_json::from_value(json).unwrap());
        assert_eq!(evento.event_color.as_deref(), Some("#33AAFF"));
        assert_eq!(evento.categories, vec!["Trabajo", "Casa"]);

        let viejo = event_from(serde_json::from_value(old_occurrence("google/42")).unwrap());
        assert_eq!(viejo.event_color, None);
        assert!(viejo.categories.is_empty());
    }

    /// Con un almacén de antes de `recurring` y `shown_once`, el evento se ve
    /// igual: se pierde el ícono de la serie, no el evento. El `etag` queda
    /// vacío y el `sync_state` en `synced`, así que editar sigue en pausa y no
    /// aparece ningún badge, como estaba.
    #[test]
    fn un_almacen_viejo_sin_recurring_ni_shown_once_se_lee_igual() {
        let ocurrencia: StoredOccurrence =
            serde_json::from_value(old_occurrence("google/42")).unwrap();
        assert!(!ocurrencia.recurring);
        assert!(!ocurrencia.shown_once);
        assert_eq!(ocurrencia.etag, "");
        assert_eq!(ocurrencia.sync_state, "synced");
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
                "categories",
                "color",
                "end",
                "etag",
                "event_color",
                "recurring",
                "shown_once",
                "start",
                "sync_state",
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

    // ── El «no» del almacén, distinto del fail-closed del dueño ────────────

    use tauri_plugin_vsk_store::Error as StoreError;

    fn dbus_error(name: &str) -> StoreError {
        StoreError::Store {
            name: Some(name.into()),
            message: "sin permiso".into(),
        }
    }

    /// Un `AccessDenied` (o `AuthFailed`) del almacén es un «no» de la persona;
    /// cualquier otra cosa —el servicio caído, un impostor en el nombre— no lo
    /// es, y la ventana la resuelve leyendo cuenta por cuenta.
    #[test]
    fn un_no_del_almacen_se_distingue_del_fail_closed() {
        assert!(denied(&dbus_error(
            "org.freedesktop.DBus.Error.AccessDenied"
        )));
        assert!(denied(&dbus_error("org.freedesktop.DBus.Error.AuthFailed")));
        // El fail-closed del cliente del plugin no es un «no» que se pueda
        // olvidar: no hubo decisión, y re-pedir no haría nada.
        assert!(!denied(&StoreError::Impostor));
        assert!(!denied(&StoreError::NotRunning));
        assert!(!denied(&dbus_error(
            "org.freedesktop.DBus.Error.ServiceUnknown"
        )));
    }

    /// Sólo el «no» explícito se convierte en la marca que pinta el estado de
    /// «sin permiso»; lo demás viaja con su texto para que la ventana lea cuenta
    /// por cuenta. El texto del error no lleva el nombre de D-Bus —el `Display`
    /// de `Store` es sólo el mensaje—, así que mirarlo a él no alcanzaría.
    #[test]
    fn solo_el_no_explicito_se_vuelve_la_marca() {
        assert_eq!(
            describe(dbus_error("org.freedesktop.DBus.Error.AccessDenied")),
            STORE_PERMISSION_DENIED
        );
        // El impostor no es un «no»: viaja con su texto, no con la marca.
        let impostor = describe(StoreError::Impostor);
        assert_ne!(impostor, STORE_PERMISSION_DENIED);
        assert_eq!(impostor, StoreError::Impostor.to_string());
    }

    // ── Por el cliente comprobado del plugin ───────────────────────────────

    use crate::test_bus::{self, Calls, PrivateBus};

    /// El almacén de mentira en el bus privado: anota cada pedido con sus
    /// argumentos y contesta las páginas por su cursor.
    #[derive(Clone, Default)]
    struct FakeStore {
        calendars: String,
        pages: Vec<String>,
        /// Lo que contesta `PutEvent`. Por omisión, un id global cualquiera.
        put_reply: String,
        /// Si `PutEvent`/`DeleteEvent` deben fallar con un error de D-Bus en vez
        /// de contestar: para probar que el error viaja a la ventana.
        fail_write: bool,
        /// Lo que contesta `ListConflicts`: `{items:[…]}`.
        conflicts: String,
        /// Lo que contesta `GetConflict`: la comparación, o `null`.
        conflict_detail: String,
        /// Las páginas que contesta `ListTasks`, por su cursor.
        task_pages: Vec<String>,
        /// Lo que contesta `PutTask`. Por omisión, un id global cualquiera.
        put_task_reply: String,
        calls: Calls,
    }

    #[zbus::interface(name = "ar.net.vasak.os.AccountsStore")]
    impl FakeStore {
        fn list_calendars(&self) -> String {
            self.calls.push("ListCalendars".into());
            self.calendars.clone()
        }

        fn put_event(
            &self,
            account_id: String,
            calendar_id: String,
            payload: String,
            if_match: String,
        ) -> zbus::fdo::Result<String> {
            self.calls.push(format!(
                "PutEvent {account_id} {calendar_id} {payload:?} {if_match:?}"
            ));
            if self.fail_write {
                return Err(zbus::fdo::Error::InvalidArgs("la fecha no sirve".into()));
            }
            Ok(self.put_reply.clone())
        }

        fn delete_event(
            &self,
            account_id: String,
            event_id: String,
            if_match: String,
        ) -> zbus::fdo::Result<String> {
            self.calls
                .push(format!("DeleteEvent {account_id} {event_id} {if_match:?}"));
            if self.fail_write {
                return Err(zbus::fdo::Error::AccessDenied("sin permiso".into()));
            }
            Ok("{}".to_string())
        }

        fn list_conflicts(&self, account_id: String, area: String) -> zbus::fdo::Result<String> {
            self.calls
                .push(format!("ListConflicts {account_id} {area}"));
            if self.fail_write {
                return Err(zbus::fdo::Error::AccessDenied("sin permiso".into()));
            }
            Ok(self.conflicts.clone())
        }

        fn get_conflict(
            &self,
            account_id: String,
            area: String,
            id: String,
        ) -> zbus::fdo::Result<String> {
            self.calls
                .push(format!("GetConflict {account_id} {area} {id}"));
            if self.fail_write {
                return Err(zbus::fdo::Error::AccessDenied("sin permiso".into()));
            }
            Ok(self.conflict_detail.clone())
        }

        fn resolve_conflict(
            &self,
            account_id: String,
            area: String,
            id: String,
            choice: String,
        ) -> zbus::fdo::Result<String> {
            self.calls
                .push(format!("ResolveConflict {account_id} {area} {id} {choice}"));
            if self.fail_write {
                return Err(zbus::fdo::Error::AccessDenied("sin permiso".into()));
            }
            Ok("{}".to_string())
        }

        fn list_occurrences(
            &self,
            from: String,
            to: String,
            calendar_ids: Vec<String>,
            cursor: String,
            limit: u32,
        ) -> String {
            self.calls.push(format!(
                "ListOccurrences {from} {to} {calendar_ids:?} {cursor:?} {limit}"
            ));
            let index: usize = if cursor.is_empty() {
                0
            } else {
                cursor.parse().unwrap()
            };
            self.pages[index].clone()
        }

        fn list_tasks(
            &self,
            calendar_ids: Vec<String>,
            include_completed: bool,
            cursor: String,
            limit: u32,
        ) -> String {
            self.calls.push(format!(
                "ListTasks {calendar_ids:?} {include_completed} {cursor:?} {limit}"
            ));
            let index: usize = if cursor.is_empty() {
                0
            } else {
                cursor.parse().unwrap()
            };
            self.task_pages[index].clone()
        }

        fn put_task(
            &self,
            account_id: String,
            calendar_id: String,
            payload: String,
            if_match: String,
        ) -> zbus::fdo::Result<String> {
            self.calls.push(format!(
                "PutTask {account_id} {calendar_id} {payload:?} {if_match:?}"
            ));
            if self.fail_write {
                return Err(zbus::fdo::Error::InvalidArgs("la fecha no sirve".into()));
            }
            Ok(self.put_task_reply.clone())
        }

        fn delete_task(
            &self,
            account_id: String,
            task_id: String,
            if_match: String,
        ) -> zbus::fdo::Result<String> {
            self.calls
                .push(format!("DeleteTask {account_id} {task_id} {if_match:?}"));
            if self.fail_write {
                return Err(zbus::fdo::Error::AccessDenied("sin permiso".into()));
            }
            Ok("{}".to_string())
        }
    }

    fn fake_store() -> FakeStore {
        FakeStore {
            calendars: serde_json::json!([calendar_json("google/1", "Personal", &["VEVENT"])])
                .to_string(),
            pages: vec![
                page_json(
                    vec![new_occurrence("google/1", false, false)],
                    Some("1"),
                    false,
                ),
                page_json(vec![new_occurrence("google/2", true, false)], None, false),
            ],
            ..Default::default()
        }
    }

    const DESDE: &str = "2026-09-01T03:00:00Z";
    const HASTA: &str = "2026-10-01T03:00:00Z";

    /// El mes sale del sincronizador comprobado, con el rango que pidió la
    /// ventana, todas las cuentas, cada página por su cursor y el tamaño de
    /// página que acepta el almacén.
    #[tokio::test]
    async fn el_mes_se_lee_del_almacen_por_el_cliente_del_plugin() {
        let _turno = test_bus::exclusive();
        let bus = PrivateBus::start();
        let store = fake_store();
        let calls = store.calls.clone();
        let _servicio = bus.serve(tauri_plugin_vsk_store::client::PATH, store).await;

        let reading = read_events(&test_bus::client(true), DESDE, HASTA)
            .await
            .unwrap();

        assert!(reading.available);
        let uids: Vec<_> = reading
            .reading
            .eventos
            .iter()
            .map(|e| e.event.uid.as_str())
            .collect();
        assert_eq!(uids, ["google/1", "google/2"]);
        assert_eq!(reading.reading.calendarios.len(), 1);
        assert_eq!(
            calls.taken(),
            [
                "ListCalendars".to_string(),
                format!("ListOccurrences {DESDE} {HASTA} [] \"\" {PAGE_SIZE}"),
                format!("ListOccurrences {DESDE} {HASTA} [] \"1\" {PAGE_SIZE}"),
            ]
        );
    }

    /// Si el dueño del nombre no es el sincronizador de verdad, no se le pide
    /// nada y la lectura falla: la ventana lee cuenta por cuenta, en vez de
    /// dibujar un mes que inventó otro programa.
    #[tokio::test]
    async fn a_un_impostor_no_se_le_pide_el_mes() {
        let _turno = test_bus::exclusive();
        let bus = PrivateBus::start();
        let store = fake_store();
        let calls = store.calls.clone();
        let _impostor = bus.serve(tauri_plugin_vsk_store::client::PATH, store).await;

        let error = read_events(&test_bus::client(false), DESDE, HASTA)
            .await
            .unwrap_err();

        assert_eq!(error, tauri_plugin_vsk_store::Error::Impostor.to_string());
        assert!(calls.taken().is_empty(), "{:?}", calls.taken());
    }

    /// Sin sincronizador en el bus la lectura falla, no se queda esperando ni
    /// devuelve un mes vacío.
    #[tokio::test]
    async fn sin_sincronizador_la_lectura_falla() {
        let _turno = test_bus::exclusive();
        let _bus = PrivateBus::start();

        let error = read_events(&test_bus::client(true), DESDE, HASTA)
            .await
            .unwrap_err();

        assert_eq!(error, tauri_plugin_vsk_store::Error::NotRunning.to_string());
    }

    // ── La escritura: crear, editar y borrar ───────────────────────────────

    fn write_store(put_reply: &str, fail_write: bool) -> FakeStore {
        FakeStore {
            put_reply: put_reply.to_string(),
            fail_write,
            ..Default::default()
        }
    }

    /// Crear va con `if_match` vacío y sin `id` en el payload, al sincronizador
    /// comprobado, y devuelve el id global del evento nuevo.
    #[tokio::test]
    async fn crear_un_evento_va_sin_etag_y_devuelve_el_id() {
        let _turno = test_bus::exclusive();
        let bus = PrivateBus::start();
        let store = write_store(r#"{"event_id":"google/42"}"#, false);
        let calls = store.calls.clone();
        let _servicio = bus.serve(tauri_plugin_vsk_store::client::PATH, store).await;

        let payload = r#"{"summary":"Reunión"}"#;
        let result = put_event(&test_bus::client(true), "google", "1", payload, "")
            .await
            .unwrap();

        assert_eq!(
            result,
            WriteResult {
                event_id: "google/42".into()
            }
        );
        assert_eq!(
            calls.taken(),
            [format!("PutEvent google 1 {payload:?} \"\"")]
        );
    }

    /// Editar va con el ETag como `if_match`; el payload (que lleva el `id`
    /// local) viaja tal cual.
    #[tokio::test]
    async fn editar_un_evento_va_con_el_etag() {
        let _turno = test_bus::exclusive();
        let bus = PrivateBus::start();
        let store = write_store(r#"{"event_id":"google/42"}"#, false);
        let calls = store.calls.clone();
        let _servicio = bus.serve(tauri_plugin_vsk_store::client::PATH, store).await;

        let payload = r#"{"id":42,"summary":"Otro título"}"#;
        put_event(
            &test_bus::client(true),
            "google",
            "1",
            payload,
            "\"etag-1\"",
        )
        .await
        .unwrap();

        assert_eq!(
            calls.taken(),
            [format!("PutEvent google 1 {payload:?} \"\\\"etag-1\\\"\"")]
        );
    }

    /// Borrar va al sincronizador comprobado con el id local y el `if_match`.
    #[tokio::test]
    async fn borrar_un_evento_llega_al_sincronizador() {
        let _turno = test_bus::exclusive();
        let bus = PrivateBus::start();
        let store = write_store("", false);
        let calls = store.calls.clone();
        let _servicio = bus.serve(tauri_plugin_vsk_store::client::PATH, store).await;

        delete_event(&test_bus::client(true), "google", "42", "")
            .await
            .unwrap();

        assert_eq!(calls.taken(), [r#"DeleteEvent google 42 """#.to_string()]);
    }

    /// Un `PutEvent` que falla —una fecha que no es iCalendar— no entra en
    /// pánico: el error del sincronizador viaja a la ventana como texto.
    #[tokio::test]
    async fn un_put_que_falla_devuelve_el_error() {
        let _turno = test_bus::exclusive();
        let bus = PrivateBus::start();
        let store = write_store("", true);
        let _servicio = bus.serve(tauri_plugin_vsk_store::client::PATH, store).await;

        let error = put_event(&test_bus::client(true), "google", "1", "{}", "")
            .await
            .unwrap_err();
        assert!(!error.is_empty(), "el error no puede ser vacío");
    }

    /// Un «no» de la persona al borrar se vuelve la misma marca que en la
    /// lectura, para que la ventana pinte el estado de «sin permiso».
    #[tokio::test]
    async fn un_no_al_borrar_se_vuelve_la_marca() {
        let _turno = test_bus::exclusive();
        let bus = PrivateBus::start();
        let store = write_store("", true);
        let _servicio = bus.serve(tauri_plugin_vsk_store::client::PATH, store).await;

        let error = delete_event(&test_bus::client(true), "google", "42", "")
            .await
            .unwrap_err();
        assert_eq!(error, STORE_PERMISSION_DENIED);
    }

    /// Una respuesta de `PutEvent` que no se entiende es un error, no un pánico.
    #[tokio::test]
    async fn una_respuesta_de_put_que_no_se_entiende_es_un_error() {
        let _turno = test_bus::exclusive();
        let bus = PrivateBus::start();
        let store = write_store("no es json", false);
        let _servicio = bus.serve(tauri_plugin_vsk_store::client::PATH, store).await;

        let error = put_event(&test_bus::client(true), "google", "1", "{}", "")
            .await
            .unwrap_err();
        assert!(error.contains("PutEvent"), "{error}");
    }

    /// A un impostor en el nombre no se le escribe nada: la escritura falla sin
    /// tocar el almacén de mentira.
    #[tokio::test]
    async fn a_un_impostor_no_se_le_escribe() {
        let _turno = test_bus::exclusive();
        let bus = PrivateBus::start();
        let store = write_store(r#"{"event_id":"x/1"}"#, false);
        let calls = store.calls.clone();
        let _impostor = bus.serve(tauri_plugin_vsk_store::client::PATH, store).await;

        let error = put_event(&test_bus::client(false), "google", "1", "{}", "")
            .await
            .unwrap_err();
        assert_eq!(error, tauri_plugin_vsk_store::Error::Impostor.to_string());
        assert!(calls.taken().is_empty(), "{:?}", calls.taken());
    }

    // ── Los conflictos: listar, comparar y resolver ────────────────────────

    /// Sólo las dos elecciones conocidas valen; cualquier otra cosa, no. Así una
    /// elección inventada no llega al almacén.
    #[test]
    fn solo_las_dos_elecciones_conocidas_valen() {
        assert!(is_valid_choice(CHOICE_KEEP_LOCAL));
        assert!(is_valid_choice(CHOICE_TAKE_SERVER));
        assert!(!is_valid_choice(""));
        assert!(!is_valid_choice("keep"));
        assert!(!is_valid_choice("KEEP_LOCAL"));
    }

    /// La comparación se lee con los nombres del servicio, y lo que falta queda
    /// en sus valores por omisión: sin copia del servidor, `server` es `None` y
    /// `server_unavailable` es `true`.
    #[test]
    fn la_comparacion_sin_copia_del_servidor_se_lee() {
        let json = r#"{"id":"42","op":"put","local":"BEGIN:VEVENT","server":null,
                       "server_etag":null,"server_unavailable":true}"#;
        let detalle: ConflictComparison = serde_json::from_str(json).unwrap();
        assert_eq!(detalle.id, "42");
        assert_eq!(detalle.op, "put");
        assert_eq!(detalle.local.as_deref(), Some("BEGIN:VEVENT"));
        assert!(detalle.server.is_none());
        assert!(detalle.server_unavailable);
    }

    fn conflict_store(conflicts: &str, detail: &str) -> FakeStore {
        FakeStore {
            conflicts: conflicts.to_string(),
            conflict_detail: detail.to_string(),
            ..Default::default()
        }
    }

    /// La lista sale del sincronizador comprobado, con el área del calendario, y
    /// se desenvuelve de `{items:[…]}`.
    #[tokio::test]
    async fn los_conflictos_se_listan_del_almacen() {
        let _turno = test_bus::exclusive();
        let bus = PrivateBus::start();
        let items = r#"{"items":[{"id":"42","op":"put","summary":"Reunión","has_server_copy":true},
                                 {"id":"7","op":"delete","summary":"","has_server_copy":false}]}"#;
        let store = conflict_store(items, "null");
        let calls = store.calls.clone();
        let _servicio = bus.serve(tauri_plugin_vsk_store::client::PATH, store).await;

        let conflictos = list_conflicts(&test_bus::client(true), "google")
            .await
            .unwrap();

        assert_eq!(conflictos.len(), 2);
        assert_eq!(conflictos[0].id, "42");
        assert_eq!(conflictos[0].op, "put");
        assert!(conflictos[0].has_server_copy);
        assert!(!conflictos[1].has_server_copy);
        assert_eq!(calls.taken(), ["ListConflicts google calendar".to_string()]);
    }

    /// `GetConflict` que contesta `null` —el id ya no está en conflicto— es
    /// `None`, no un error.
    #[tokio::test]
    async fn un_conflicto_que_ya_no_esta_es_none() {
        let _turno = test_bus::exclusive();
        let bus = PrivateBus::start();
        let store = conflict_store("{\"items\":[]}", "null");
        let _servicio = bus.serve(tauri_plugin_vsk_store::client::PATH, store).await;

        let detalle = get_conflict(&test_bus::client(true), "google", "42")
            .await
            .unwrap();
        assert!(detalle.is_none());
    }

    /// La comparación de un conflicto sale del sincronizador comprobado, con el
    /// área y el id, y se lee con los nombres del servicio.
    #[tokio::test]
    async fn la_comparacion_de_un_conflicto_se_lee_del_almacen() {
        let _turno = test_bus::exclusive();
        let bus = PrivateBus::start();
        let detail = r#"{"id":"42","op":"put","local":"LOCAL","server":"SERVER",
                        "server_etag":"\"srv\"","server_unavailable":false}"#;
        let store = conflict_store("{\"items\":[]}", detail);
        let calls = store.calls.clone();
        let _servicio = bus.serve(tauri_plugin_vsk_store::client::PATH, store).await;

        let detalle = get_conflict(&test_bus::client(true), "google", "42")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(detalle.local.as_deref(), Some("LOCAL"));
        assert_eq!(detalle.server.as_deref(), Some("SERVER"));
        assert!(!detalle.server_unavailable);
        assert_eq!(
            calls.taken(),
            ["GetConflict google calendar 42".to_string()]
        );
    }

    /// Resolver con una elección válida llega al sincronizador comprobado con el
    /// área, el id y la elección.
    #[tokio::test]
    async fn resolver_un_conflicto_llega_al_sincronizador() {
        let _turno = test_bus::exclusive();
        let bus = PrivateBus::start();
        let store = conflict_store("{\"items\":[]}", "null");
        let calls = store.calls.clone();
        let _servicio = bus.serve(tauri_plugin_vsk_store::client::PATH, store).await;

        resolve_conflict(&test_bus::client(true), "google", "42", CHOICE_KEEP_LOCAL)
            .await
            .unwrap();
        resolve_conflict(&test_bus::client(true), "google", "7", CHOICE_TAKE_SERVER)
            .await
            .unwrap();

        assert_eq!(
            calls.taken(),
            [
                "ResolveConflict google calendar 42 keep_local".to_string(),
                "ResolveConflict google calendar 7 take_server".to_string(),
            ]
        );
    }

    /// Una elección inventada se rechaza antes de tocar el bus: no se le pide
    /// nada al almacén.
    #[tokio::test]
    async fn una_eleccion_invalida_no_toca_el_bus() {
        let _turno = test_bus::exclusive();
        let bus = PrivateBus::start();
        let store = conflict_store("{\"items\":[]}", "null");
        let calls = store.calls.clone();
        let _servicio = bus.serve(tauri_plugin_vsk_store::client::PATH, store).await;

        let error = resolve_conflict(&test_bus::client(true), "google", "42", "pisar")
            .await
            .unwrap_err();
        assert!(error.contains("pisar"), "{error}");
        assert!(calls.taken().is_empty(), "{:?}", calls.taken());
    }

    /// Un «no» de la persona al listar conflictos se vuelve la misma marca que
    /// en la lectura del mes, para que la ventana pinte el estado de «sin
    /// permiso».
    #[tokio::test]
    async fn un_no_al_listar_conflictos_se_vuelve_la_marca() {
        let _turno = test_bus::exclusive();
        let bus = PrivateBus::start();
        let mut store = conflict_store("{\"items\":[]}", "null");
        store.fail_write = true;
        let _servicio = bus.serve(tauri_plugin_vsk_store::client::PATH, store).await;

        let error = list_conflicts(&test_bus::client(true), "google")
            .await
            .unwrap_err();
        assert_eq!(error, STORE_PERMISSION_DENIED);
    }

    /// A un impostor en el nombre no se le pide ni la lista de conflictos.
    #[tokio::test]
    async fn a_un_impostor_no_se_le_listan_conflictos() {
        let _turno = test_bus::exclusive();
        let bus = PrivateBus::start();
        let store = conflict_store("{\"items\":[]}", "null");
        let calls = store.calls.clone();
        let _impostor = bus.serve(tauri_plugin_vsk_store::client::PATH, store).await;

        let error = list_conflicts(&test_bus::client(false), "google")
            .await
            .unwrap_err();
        assert_eq!(error, tauri_plugin_vsk_store::Error::Impostor.to_string());
        assert!(calls.taken().is_empty(), "{:?}", calls.taken());
    }

    // ── Las tareas: listar, crear, editar y borrar ─────────────────────────

    /// Una tarea como la serializa `TaskItem` en el servicio, con el `etag` y el
    /// `sync_state` que trajo A-TASKDTO.
    fn task_json(task_id: &str, done: bool) -> serde_json::Value {
        serde_json::json!({
            "task_id": task_id,
            "calendar_id": "google/1",
            "title": "Comprar pan",
            "due": "2026-09-20T00:00:00Z",
            "all_day": true,
            "status": if done { "completed" } else { "needs-action" },
            "priority": 5,
            "completed": null,
            "done": done,
            "color": "#3366FF",
            "etag": "\"etag-1\"",
            "sync_state": "pending",
        })
    }

    fn task_page_json(items: Vec<serde_json::Value>, next: Option<&str>) -> String {
        serde_json::json!({ "items": items, "next_cursor": next }).to_string()
    }

    /// Las páginas de tareas que contestaría el almacén, y los cursores con que
    /// se las pidió. Sin bus.
    fn read_tasks_with(
        calendarios: &serde_json::Value,
        paginas: Vec<Result<String, String>>,
    ) -> (Result<TaskReading, String>, Vec<String>) {
        let pedidas = RefCell::new(Vec::new());
        let restantes = RefCell::new(paginas.into_iter());
        let resultado =
            tauri::async_runtime::block_on(read_task_pages(&calendarios.to_string(), |cursor| {
                pedidas.borrow_mut().push(cursor);
                let siguiente = restantes
                    .borrow_mut()
                    .next()
                    .unwrap_or_else(|| Err("se pidió una página de más".into()));
                async move { siguiente }
            }));
        (resultado, pedidas.into_inner())
    }

    /// Sólo las listas que pueden guardar tareas van al selector del formulario:
    /// una de sólo eventos no, una que no dice qué guarda sí.
    #[test]
    fn solo_las_listas_de_tareas_van_al_selector() {
        let calendarios = task_calendars_from(vec![
            guardado("google/1", &["VEVENT"]),
            guardado("google/2", &["VTODO"]),
            guardado("google/3", &["VTODO", "VEVENT"]),
            guardado("google/4", &[]),
        ]);
        let urls: Vec<_> = calendarios.iter().map(|c| c.url.as_str()).collect();
        assert_eq!(urls, ["google/2", "google/3", "google/4"]);
    }

    /// Un almacén viejo que no manda `etag` ni `sync_state` se lee igual: el
    /// `etag` queda vacío (editar en pausa) y el estado en `synced` (sin badge).
    #[test]
    fn una_tarea_de_un_almacen_viejo_se_lee_igual() {
        let vieja = serde_json::json!({
            "task_id": "google/7",
            "calendar_id": "google/1",
            "title": "Algo",
            "all_day": false,
            "status": "needs-action",
            "done": false,
        });
        let tarea: StoredTask = serde_json::from_value(vieja).unwrap();
        assert_eq!(tarea.etag, "");
        assert_eq!(tarea.sync_state, "synced");
        assert_eq!(tarea.due, None);
        assert_eq!(tarea.priority, None);
    }

    /// Lo que viaja a la ventana tiene que tener **exactamente** los nombres que
    /// lee la ventana: Tauri no los convierte, y uno que no coincide llega como
    /// `undefined` sin ningún error.
    #[test]
    fn la_lectura_de_tareas_llega_con_los_nombres_de_la_ventana() {
        let tarea: StoredTask = serde_json::from_value(task_json("google/42", false)).unwrap();
        let reading = TaskReading {
            calendars: task_calendars_from(vec![guardado("google/1", &["VTODO"])]),
            tasks: vec![tarea],
            notices: vec!["algo".into()],
            available: true,
        };
        let json = serde_json::to_value(&reading).unwrap();
        let mut claves: Vec<_> = json.as_object().unwrap().keys().cloned().collect();
        claves.sort();
        assert_eq!(claves, ["available", "calendars", "notices", "tasks"]);

        let mut de_la_tarea: Vec<_> = json["tasks"][0]
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect();
        de_la_tarea.sort();
        assert_eq!(
            de_la_tarea,
            [
                "all_day",
                "calendar_id",
                "color",
                "completed",
                "done",
                "due",
                "etag",
                "priority",
                "status",
                "sync_state",
                "task_id",
                "title"
            ]
        );
    }

    /// Sin listas de tareas el almacén no sirve todavía y no se piden tareas.
    #[test]
    fn sin_listas_de_tareas_no_se_piden_tareas() {
        let solo_eventos = serde_json::json!([calendar_json("google/1", "Personal", &["VEVENT"])]);
        let (reading, pedidas) = read_tasks_with(&solo_eventos, vec![]);
        assert_eq!(reading.unwrap(), TaskReading::default());
        assert!(pedidas.is_empty(), "pidió tareas: {pedidas:?}");
    }

    #[test]
    fn las_paginas_de_tareas_se_siguen_por_su_cursor() {
        let calendarios = serde_json::json!([calendar_json("google/1", "Tareas", &["VTODO"])]);
        let (reading, pedidas) = read_tasks_with(
            &calendarios,
            vec![
                Ok(task_page_json(
                    vec![task_json("google/1", false)],
                    Some("c1"),
                )),
                Ok(task_page_json(vec![task_json("google/2", true)], None)),
            ],
        );
        let reading = reading.unwrap();
        assert_eq!(pedidas, ["", "c1"]);
        let ids: Vec<_> = reading.tasks.iter().map(|t| t.task_id.as_str()).collect();
        assert_eq!(ids, ["google/1", "google/2"]);
        assert!(reading.available);
        assert_eq!(reading.calendars.len(), 1);
    }

    /// Un cursor que no termina no cuelga la ventana: se muestra lo que entró y
    /// se avisa.
    #[test]
    fn un_cursor_de_tareas_que_no_termina_se_corta_y_se_avisa() {
        let calendarios = serde_json::json!([calendar_json("google/1", "Tareas", &["VTODO"])]);
        let infinitas = (0..MAX_PAGES + 3)
            .map(|i| {
                Ok(task_page_json(
                    vec![task_json("google/1", false)],
                    Some(&format!("c{i}")),
                ))
            })
            .collect();
        let (reading, pedidas) = read_tasks_with(&calendarios, infinitas);
        let reading = reading.unwrap();
        assert_eq!(pedidas.len(), MAX_PAGES);
        assert!(reading.available);
        assert!(reading.notices.iter().any(|n| n.contains("más tareas")));
    }

    /// Una página de tareas que no se entiende es un error, no un pánico.
    #[test]
    fn una_pagina_de_tareas_que_no_se_entiende_es_un_error() {
        let calendarios = serde_json::json!([calendar_json("google/1", "Tareas", &["VTODO"])]);
        let (reading, _) = read_tasks_with(&calendarios, vec![Ok("{\"items\": 3}".into())]);
        assert!(reading.unwrap_err().contains("tareas"));
    }

    fn task_store() -> FakeStore {
        FakeStore {
            calendars: serde_json::json!([calendar_json("google/1", "Tareas", &["VTODO"])])
                .to_string(),
            task_pages: vec![
                task_page_json(vec![task_json("google/1", false)], Some("1")),
                task_page_json(vec![task_json("google/2", true)], None),
            ],
            ..Default::default()
        }
    }

    /// Las tareas salen del sincronizador comprobado, con todas las listas y el
    /// tamaño de página que acepta el almacén; `include_completed` viaja tal cual.
    #[tokio::test]
    async fn las_tareas_se_leen_del_almacen_por_el_cliente_del_plugin() {
        let _turno = test_bus::exclusive();
        let bus = PrivateBus::start();
        let store = task_store();
        let calls = store.calls.clone();
        let _servicio = bus.serve(tauri_plugin_vsk_store::client::PATH, store).await;

        let reading = read_tasks(&test_bus::client(true), true).await.unwrap();

        assert!(reading.available);
        let ids: Vec<_> = reading.tasks.iter().map(|t| t.task_id.as_str()).collect();
        assert_eq!(ids, ["google/1", "google/2"]);
        assert_eq!(
            calls.taken(),
            [
                "ListCalendars".to_string(),
                format!("ListTasks [] true \"\" {PAGE_SIZE}"),
                format!("ListTasks [] true \"1\" {PAGE_SIZE}"),
            ]
        );
    }

    /// A un impostor en el nombre no se le piden las tareas.
    #[tokio::test]
    async fn a_un_impostor_no_se_le_piden_tareas() {
        let _turno = test_bus::exclusive();
        let bus = PrivateBus::start();
        let store = task_store();
        let calls = store.calls.clone();
        let _impostor = bus.serve(tauri_plugin_vsk_store::client::PATH, store).await;

        let error = read_tasks(&test_bus::client(false), false)
            .await
            .unwrap_err();
        assert_eq!(error, tauri_plugin_vsk_store::Error::Impostor.to_string());
        assert!(calls.taken().is_empty(), "{:?}", calls.taken());
    }

    /// Crear una tarea va con `if_match` vacío y devuelve el id global nuevo.
    #[tokio::test]
    async fn crear_una_tarea_va_sin_etag_y_devuelve_el_id() {
        let _turno = test_bus::exclusive();
        let bus = PrivateBus::start();
        let mut store = write_store("", false);
        store.put_task_reply = r#"{"task_id":"google/42"}"#.to_string();
        let calls = store.calls.clone();
        let _servicio = bus.serve(tauri_plugin_vsk_store::client::PATH, store).await;

        let payload = r#"{"summary":"Comprar pan"}"#;
        let result = put_task(&test_bus::client(true), "google", "1", payload, "")
            .await
            .unwrap();

        assert_eq!(
            result,
            TaskWriteResult {
                task_id: "google/42".into()
            }
        );
        assert_eq!(
            calls.taken(),
            [format!("PutTask google 1 {payload:?} \"\"")]
        );
    }

    /// Completar una tarea es editar con el ETag: el parche fija el estado y el
    /// porcentaje, y el ETag va de precondición.
    #[tokio::test]
    async fn completar_una_tarea_va_con_el_etag() {
        let _turno = test_bus::exclusive();
        let bus = PrivateBus::start();
        let mut store = write_store("", false);
        store.put_task_reply = r#"{"task_id":"google/42"}"#.to_string();
        let calls = store.calls.clone();
        let _servicio = bus.serve(tauri_plugin_vsk_store::client::PATH, store).await;

        let payload = r#"{"id":42,"status":"COMPLETED","percent_complete":100}"#;
        put_task(
            &test_bus::client(true),
            "google",
            "1",
            payload,
            "\"etag-1\"",
        )
        .await
        .unwrap();

        assert_eq!(
            calls.taken(),
            [format!("PutTask google 1 {payload:?} \"\\\"etag-1\\\"\"")]
        );
    }

    /// Borrar una tarea llega al sincronizador comprobado con el id local y el
    /// `if_match`.
    #[tokio::test]
    async fn borrar_una_tarea_llega_al_sincronizador() {
        let _turno = test_bus::exclusive();
        let bus = PrivateBus::start();
        let store = write_store("", false);
        let calls = store.calls.clone();
        let _servicio = bus.serve(tauri_plugin_vsk_store::client::PATH, store).await;

        delete_task(&test_bus::client(true), "google", "42", "\"etag-1\"")
            .await
            .unwrap();

        assert_eq!(
            calls.taken(),
            [r#"DeleteTask google 42 "\"etag-1\"""#.to_string()]
        );
    }

    /// Un «no» de la persona al borrar una tarea se vuelve la misma marca que en
    /// la lectura, para que la ventana pinte el estado de «sin permiso».
    #[tokio::test]
    async fn un_no_al_borrar_una_tarea_se_vuelve_la_marca() {
        let _turno = test_bus::exclusive();
        let bus = PrivateBus::start();
        let store = write_store("", true);
        let _servicio = bus.serve(tauri_plugin_vsk_store::client::PATH, store).await;

        let error = delete_task(&test_bus::client(true), "google", "42", "")
            .await
            .unwrap_err();
        assert_eq!(error, STORE_PERMISSION_DENIED);
    }

    /// Una respuesta de `PutTask` que no se entiende es un error, no un pánico.
    #[tokio::test]
    async fn una_respuesta_de_put_task_que_no_se_entiende_es_un_error() {
        let _turno = test_bus::exclusive();
        let bus = PrivateBus::start();
        let mut store = write_store("", false);
        store.put_task_reply = "no es json".into();
        let _servicio = bus.serve(tauri_plugin_vsk_store::client::PATH, store).await;

        let error = put_task(&test_bus::client(true), "google", "1", "{}", "")
            .await
            .unwrap_err();
        assert!(error.contains("PutTask"), "{error}");
    }
}
