//! Leer los eventos de un servidor CalDAV.
//!
//! Dos pasos: preguntar qué calendarios tiene la persona (`PROPFIND` sobre su
//! carpeta) y pedir los eventos de un rango (`REPORT` con una consulta de
//! calendario). El servidor devuelve iCalendar, que se interpreta acá.
//!
//! ── Sobre interpretar iCalendar ─────────────────────────────────────────────
//!
//! Esto es leer lo que escribió alguien más: el evento lo pudo haber creado
//! cualquier programa, y la invitación pudo haberla mandado cualquiera. Por eso
//! esta aplicación corre con la cuenta de la persona y no como root, igual que
//! el bucle de correo — y por eso el parseo tiene topes y no confía en nada.
//!
//! ── Los eventos que se repiten ──────────────────────────────────────────────
//!
//! Por dos caminos, y se toman los dos. Primero se le pide al servidor que los
//! expanda —`<c:expand>` en la consulta, RFC 4791 §9.6.5—, que es lo barato:
//! Nextcloud, Radicale y Google lo hacen, y devuelven una instancia por
//! repetición, cada una con su `RECURRENCE-ID` y sin la regla. Pero no todos
//! lo respetan, y el que no lo respeta **no avisa**: devuelve el evento con su
//! `RRULE`, igual que si no se le hubiera pedido nada. Así que no se le cree
//! al pedido sino a la respuesta: si trae una regla, se expande acá, con
//! [`crate::recurrence`]. Ver [`server_expansion`].
//!
//! ── Qué se le cree al servidor ──────────────────────────────────────────────
//!
//! Lo que contesta lo escribió cualquiera, y esta aplicación lleva la credencial
//! de la cuenta. Por eso **cada dirección que el servidor manda se resuelve
//! contra la de la cuenta y se rechaza si es de otro origen**, y el cliente
//! habla **sólo `https`** y **sin redirecciones**: una dirección ajena se queda
//! con la credencial, y una redirección también. Y lo que llega pasa por los
//! topes de `dav::Limits` antes de armarse: `roxmltree` baja de forma recursiva
//! —un `multistatus` con doscientos mil niveles de anidado **aborta la
//! aplicación**—, y con miles de espacios de nombres o de atributos se traba.
//! Todo eso, y el rechazo de otras direcciones, está en [`crate::dav`].

use std::time::Duration;

use base64::Engine;
use chrono::{DateTime, NaiveDate, NaiveDateTime, Utc};
use reqwest::Url;
use serde::Serialize;

use crate::cuentas::{AuthKind, Credencial};
use crate::dav::{self, DavError, Limits};
use crate::recurrence::{
    duration_of, Component, Expansion, Length, Moment, RDate, Window, MAX_DATES_PER_COMPONENT,
};
use crate::zonas::{Zona, Zonas};

const TIMEOUT: Duration = Duration::from_secs(20);

/// Los topes de esta aplicación, con los mismos números que usa el sincronizador
/// de `vasak-accounts` para las mismas respuestas de DAV.
const LIMITES: Limits = Limits::DEFAULT;

/// Tope de lo que se lee de una respuesta.
///
/// Un calendario de años puede ser grande, pero no ilimitado: sin tope, un
/// servidor que devuelve basura hace crecer la memoria de la ventana sin freno.
/// Es [`Limits::max_body_bytes`], y vive en `dav` porque el tope no es de este
/// protocolo sino de HTTP.
const MAX_CUERPO: usize = Limits::DEFAULT.max_body_bytes;

const NS_DAV: &str = "DAV:";
const NS_CALDAV: &str = "urn:ietf:params:xml:ns:caldav";
const NS_APPLE: &str = "http://apple.com/ns/ical/";

/// Un calendario de la persona.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Calendario {
    pub url: String,
    pub nombre: String,
    /// El color que la persona le puso en su servidor, si le puso alguno.
    pub color: Option<String>,
}

/// Un evento, ya listo para mostrar: una instancia, si es de una serie.
///
/// Los nombres viajan tal cual a la ventana —Tauri no los convierte—, así que
/// cambiar uno acá es cambiarlo en `src/tools/mes.ts`.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Event {
    pub uid: String,
    pub title: String,
    /// Cuándo empieza, en UTC y en ISO 8601. La ventana lo pasa a la hora local.
    pub start: String,
    pub end: String,
    /// Si dura todo el día. Se guarda aparte porque un evento de día completo no
    /// tiene hora, y mostrarle una —la medianoche de alguna zona— lo correría de
    /// día para quien esté en otra.
    pub all_day: bool,
    /// Si es una instancia de una serie.
    pub recurring: bool,
    /// Si es una serie que **no se pudo expandir** y se muestra sólo el día que
    /// empieza. Ver [`crate::recurrence`]: ante una regla que no se entiende no
    /// se inventan fechas, y la ventana lo dice para que las otras semanas no
    /// parezcan libres.
    pub shown_once: bool,
    /// La zona en la que lo escribieron, tal como venía en el archivo.
    ///
    /// Vacía cuando el evento venía en UTC, cuando es de día completo o cuando
    /// no declaraba ninguna. Va como texto y no resuelta porque es para
    /// **mostrar**: la ventana avisa cuando un evento está escrito en una zona
    /// distinta de aquella en la que se está mirando la agenda, y para eso hace
    /// falta el nombre que le puso quien lo escribió.
    ///
    /// Un servidor que expande devuelve las instancias en UTC y sin zona, así
    /// que en ese camino queda vacía.
    pub zone: String,
}

// ---------------------------------------------------------------------------
// Lo que se puede probar sin red
// ---------------------------------------------------------------------------

/// Junta las líneas partidas de un iCalendar.
///
/// El formato corta las líneas largas a 75 octetos y sigue en la siguiente con
/// un espacio o una tabulación adelante. Sin volver a juntarlas, un título largo
/// aparece cortado a la mitad y una fecha partida no se interpreta — y los
/// títulos largos son justamente los que más se cortan.
pub fn unir_lineas(texto: &str) -> Vec<String> {
    let mut lineas: Vec<String> = Vec::new();
    for cruda in texto.split("\r\n").flat_map(|l| l.split('\n')) {
        let cruda = cruda.strip_suffix('\r').unwrap_or(cruda);
        match cruda.strip_prefix([' ', '\t']) {
            Some(continuacion) => {
                if let Some(ultima) = lineas.last_mut() {
                    ultima.push_str(continuacion);
                    continue;
                }
                lineas.push(continuacion.to_string());
            }
            None => lineas.push(cruda.to_string()),
        }
    }
    lineas
}

/// Separa el nombre y sus parámetros del valor.
///
/// Una línea es `NOMBRE;PARAM=X:valor`, y el valor puede tener dos puntos —una
/// URL, por ejemplo— así que se corta por el **primero** que esté fuera de
/// comillas. Cortar por el último partiría `DESCRIPTION:ver https://x` en el
/// lugar equivocado.
pub fn partir_linea(linea: &str) -> Option<(String, Vec<String>, String)> {
    let mut entre_comillas = false;
    let corte = linea.char_indices().find_map(|(i, c)| match c {
        '"' => {
            entre_comillas = !entre_comillas;
            None
        }
        ':' if !entre_comillas => Some(i),
        _ => None,
    })?;

    let (izquierda, derecha) = linea.split_at(corte);
    let valor = derecha[1..].to_string();

    // Los parámetros se separan por `;`, **pero no dentro de comillas**.
    // `CN="Pérez; Ana"` tiene un `;` que no separa.
    let mut partes = Vec::new();
    let mut inicio = 0;
    let mut en_comillas = false;
    for (i, c) in izquierda.char_indices() {
        match c {
            '"' => en_comillas = !en_comillas,
            ';' if !en_comillas => {
                let parte = &izquierda[inicio..i].trim();
                if !parte.is_empty() {
                    partes.push(parte.to_string());
                }
                inicio = i + 1;
            }
            _ => {}
        }
    }
    // El último trozo
    let resto = &izquierda[inicio..].trim();
    if !resto.is_empty() {
        partes.push(resto.to_string());
    }

    if partes.is_empty() {
        return None;
    }

    // El primer elemento es el nombre, el resto son parámetros
    let nombre = partes[0].trim().to_ascii_uppercase().to_string();
    let parametros: Vec<String> = partes[1..]
        .iter()
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .collect();

    Some((nombre, parametros, valor))
}

/// Devuelve el texto de un valor `TEXT`, deshaciendo lo escapado.
///
/// En iCalendar una coma, un punto y coma y un salto de línea van escapados. Sin
/// deshacerlo, un título como «Reunión, con Ana» se muestra con la barra a la
/// vista.
pub fn texto_de(valor: &str) -> String {
    let mut salida = String::with_capacity(valor.len());
    let mut chars = valor.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            salida.push(c);
            continue;
        }
        match chars.next() {
            Some('n') | Some('N') => salida.push('\n'),
            Some(',') => salida.push(','),
            Some(';') => salida.push(';'),
            Some('\\') => salida.push('\\'),
            // Una barra que no escapa nada conocido se deja como está: es un
            // dato de alguien y no hay motivo para tragárselo.
            Some(otro) => {
                salida.push('\\');
                salida.push(otro);
            }
            None => salida.push('\\'),
        }
    }
    // Los caracteres de control (0x00-0x08, 0x0B-0x0C, 0x0E-0x1F, 0x7F)
    // no tienen representación visible y pueden romper la visualización;
    // los filtramos. Permitimos \n (0x0A), \r (0x0D), \t (0x09) que son
    // espacios en blanco legítimos en iCalendar.
    salida
        .chars()
        .filter(|c| {
            let code = *c as u32;
            !matches!(code, 0x00..=0x08 | 0x0B..=0x0C | 0x0E..=0x1F | 0x7F)
        })
        .collect()
}

/// Interpreta una fecha de iCalendar, sin resolverla todavía.
///
/// Cuatro formas, y cada una quiere decir algo distinto:
///
/// - `20260915`, o con `VALUE=DATE` — **todo el día**. No tiene hora, así que no
///   tiene zona: darle una la correría de día para quien esté en otra.
/// - `20260915T140000Z` — **UTC**. Un instante, sin ambigüedad.
/// - `20260915T140000` con `TZID=...` — las dos de la tarde **de esa zona**. Se
///   resuelve con [`crate::zonas`], que es donde está explicado de dónde sale la
///   zona y qué pasa con las dos horas raras del año.
/// - `20260915T140000` a secas — **hora local flotante**: «las dos de donde
///   estés». Se toma la zona de la sesión.
///
/// Sin resolver porque una serie se expande en la hora de pared: ver
/// [`crate::recurrence`].
pub fn moment_of(value: &str, parameters: &[String], zones: &Zonas) -> Option<Moment> {
    let value = value.trim();
    let is_date = parameters
        .iter()
        .any(|p| p.eq_ignore_ascii_case("VALUE=DATE"));

    if is_date || value.len() == 8 {
        return NaiveDate::parse_from_str(value, "%Y%m%d")
            .ok()
            .map(Moment::Date);
    }

    let wall =
        NaiveDateTime::parse_from_str(value.strip_suffix('Z').unwrap_or(value), "%Y%m%dT%H%M%S")
            .ok()?;

    // La `Z` manda sobre cualquier `TZID`: una fecha en UTC ya es un instante, y
    // un `TZID` al lado es un archivo mal escrito, no otra interpretación.
    let zone = if value.ends_with('Z') {
        Zona::Utc
    } else {
        match tzid_de(parameters) {
            Some(tzid) => zones.resolver(tzid),
            None => Zona::Flotante,
        }
    };
    Some(Moment::Time { wall, zone })
}

/// Una lista de fechas de `EXDATE` o `RDATE`, separadas por coma.
///
/// Todas o ninguna: una que no se entiende en la lista puede ser justo la
/// reunión que se suspendió, y seguir sin ella mostraría esa reunión.
fn moments_of(value: &str, parameters: &[String], zones: &Zonas) -> Option<Vec<Moment>> {
    value
        .split(',')
        .map(|item| moment_of(item, parameters, zones))
        .collect()
}

/// Las fechas de un `RDATE`, que además de fechas pueden ser periodos
/// (`VALUE=PERIOD`, RFC 5545 §3.3.9): `inicio/fin` o `inicio/duración`.
fn rdates_of(value: &str, parameters: &[String], zones: &Zonas) -> Option<Vec<RDate>> {
    value
        .split(',')
        .map(|item| match item.split_once('/') {
            None => Some(RDate {
                start: moment_of(item, parameters, zones)?,
                length: None,
            }),
            Some((start, rest)) => {
                let start = moment_of(start, parameters, zones)?;
                let length = if rest.trim_start().starts_with(['P', 'p', '+', '-']) {
                    duration_of(rest)?
                } else {
                    let end = moment_of(rest, parameters, zones)?.to_utc()?;
                    let begin = start.to_utc()?;
                    (end > begin).then(|| Length {
                        days: 0,
                        exact: end - begin,
                    })?
                };
                Some(RDate {
                    start,
                    length: Some(length),
                })
            }
        })
        .collect()
}

/// El `TZID` de los parámetros de una línea, si lo trae, sin comillas.
pub fn tzid_de(parametros: &[String]) -> Option<&str> {
    parametros.iter().find_map(|p| {
        let (nombre, valor) = p.split_once('=')?;
        nombre
            .trim()
            .eq_ignore_ascii_case("TZID")
            .then(|| crate::zonas::sin_comillas(valor.trim()))
    })
}

/// Lee los `VEVENT` de un iCalendar, sin expandir.
///
/// Sólo `VEVENT`: un calendario trae también tareas y notas, y mostrarlas como
/// si fueran eventos llenaría el mes de cosas que no lo son.
///
/// Las zonas se leen **antes** y en una pasada aparte: un `VTIMEZONE` puede
/// venir después del evento que lo usa, y el formato no fija el orden.
pub fn components_of(ical: &str) -> Vec<Component> {
    let zones = crate::zonas::tabla_de(ical);
    let mut components = Vec::new();
    let mut current: Option<Component> = None;
    // Cuántos componentes hay abiertos **dentro** del evento.
    //
    // Un `VEVENT` puede contener otro componente, y el que aparece siempre es
    // `VALARM` —el recordatorio—, que tiene su propio `SUMMARY`: «Recordatorio»,
    // o el texto que le puso el cliente que lo creó. Sin contar la anidación,
    // esa línea pisaba el título del evento, y en la cuadrícula el mes entero
    // aparecía lleno de recordatorios en vez de reuniones.
    let mut nested = 0usize;

    for line in unir_lineas(ical) {
        let Some((name, parameters, value)) = partir_linea(&line) else {
            continue;
        };

        match (name.as_str(), value.trim()) {
            ("BEGIN", "VEVENT") => {
                current = Some(Component::default());
                nested = 0;
                continue;
            }
            ("END", "VEVENT") => {
                if let Some(component) = current.take() {
                    components.push(component);
                }
                nested = 0;
                continue;
            }
            // Cualquier otro componente abierto acá adentro es de otro: se
            // cuenta para saltearlo entero, sin mirar qué trae.
            ("BEGIN", _) if current.is_some() => {
                nested += 1;
                continue;
            }
            ("END", _) if current.is_some() => {
                nested = nested.saturating_sub(1);
                continue;
            }
            _ => {}
        }

        if nested > 0 {
            continue;
        }
        let Some(component) = current.as_mut() else {
            continue;
        };

        match name.as_str() {
            "UID" => component.uid = value,
            "SUMMARY" => component.title = texto_de(&value),
            "DTSTART" => {
                component.start = moment_of(&value, &parameters, &zones);
                // La del comienzo y no la del fin: es la que la persona lee
                // cuando mira a qué hora empieza algo.
                component.zone_name = (!value.trim().ends_with('Z'))
                    .then(|| tzid_de(&parameters))
                    .flatten()
                    .unwrap_or_default()
                    .to_string();
            }
            "DTEND" => component.end = moment_of(&value, &parameters, &zones),
            "DURATION" => component.duration = duration_of(&value),
            "RRULE" => component.rules.push(value),
            "STATUS" => component.cancelled = value.trim().eq_ignore_ascii_case("CANCELLED"),
            "RECURRENCE-ID" => {
                component.recurrence_id = moment_of(&value, &parameters, &zones);
                component.this_and_future = parameters
                    .iter()
                    .any(|p| p.eq_ignore_ascii_case("RANGE=THISANDFUTURE"));
                // Una instancia cambiada que no dice cuál reemplaza no se
                // puede ubicar: se muestra igual —es un dato explícito—, pero
                // sin que tape a ninguna, y sin pasar por principal.
                component.unplaced_override = component.recurrence_id.is_none();
            }
            "EXDATE" => match moments_of(&value, &parameters, &zones) {
                Some(dates) => component.exdates.extend(dates),
                None => component
                    .unreadable
                    .push(format!("EXDATE «{value}» no se entiende")),
            },
            "RDATE" => match rdates_of(&value, &parameters, &zones) {
                Some(dates) => component.rdates.extend(dates),
                None => component
                    .unreadable
                    .push(format!("RDATE «{value}» no se entiende")),
            },
            _ => {}
        }
        // El tope se aplica siempre, haya o no un error anterior: si no, un
        // `EXDATE` roto al principio dejaba crecer la lista sin límite.
        if component.exdates.len() + component.rdates.len() > MAX_DATES_PER_COMPONENT {
            if component.unreadable.is_empty() {
                component.unreadable.push(format!(
                    "tiene más de {MAX_DATES_PER_COMPONENT} fechas sueltas (RDATE, EXDATE)"
                ));
            }
            component.exdates.clear();
            component.rdates.clear();
        }
    }

    components
}

/// Qué hizo el servidor con el `<c:expand>` que se le pidió.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ServerExpansion {
    /// Devolvió las instancias: ninguna regla, y al menos un `RECURRENCE-ID`.
    Honored,
    /// Devolvió al menos un evento con su `RRULE` o su `RDATE`: no expandió, y
    /// esas series se expanden acá.
    Ignored,
    /// No había nada que se repitiera, así que no se sabe.
    NotNeeded,
}

/// Mira la respuesta, y no el pedido, para saber si el servidor expandió.
///
/// Un servidor que no conoce `<c:expand>` no contesta con un error: lo ignora
/// y devuelve el evento con su regla, igual que sin pedirlo. Y uno que expande
/// **quita** la regla y deja un `VEVENT` por instancia, cada uno con su
/// `RECURRENCE-ID`. Así que la regla presente es la señal, y no hace falta
/// saber qué servidor es.
///
/// No hace falta para **mostrar** bien —[`crate::recurrence::expand`] trata
/// igual las dos respuestas—: es para dejar en el diario qué servidores no lo
/// respetan.
pub fn server_expansion(components: &[Component]) -> ServerExpansion {
    let series = components
        .iter()
        .any(|c| c.recurrence_id.is_none() && (!c.rules.is_empty() || !c.rdates.is_empty()));
    if series {
        ServerExpansion::Ignored
    } else if components.iter().any(|c| c.recurrence_id.is_some()) {
        ServerExpansion::Honored
    } else {
        ServerExpansion::NotNeeded
    }
}

/// El cuerpo de la consulta que pide los eventos de un rango.
///
/// Con `expand`, le pide al servidor las instancias ya expandidas en ese mismo
/// rango (RFC 4791 §9.6.5). Sin él, los eventos como están guardados.
pub fn events_query(from: &str, to: &str, expand: bool) -> String {
    let data = if expand {
        format!(r#"<c:calendar-data><c:expand start="{from}" end="{to}"/></c:calendar-data>"#)
    } else {
        "<c:calendar-data/>".to_string()
    };
    format!(
        r#"<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="{NS_CALDAV}">
  <d:prop><d:getetag/>{data}</d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT">
        <c:time-range start="{from}" end="{to}"/>
      </c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>"#
    )
}

/// Si un rechazo del servidor puede ser por el `<c:expand>`, y vale la pena
/// volver a pedir sin él.
///
/// Lo normal es que un servidor que no lo conoce lo ignore, pero el RFC le
/// deja contestar que no lo soporta: `403` con una precondición, o un `400`,
/// `415`, `422` o `501` de los que no leen el cuerpo con cuidado. Un `401`
/// no: es la credencial, y pedir otra vez no la arregla.
pub fn retry_without_expand(status: u16) -> bool {
    matches!(status, 400 | 403 | 415 | 422 | 501)
}

/// El formato de fecha que espera un `time-range`: siempre UTC y sin guiones.
pub fn momento_caldav(momento: DateTime<Utc>) -> String {
    momento.format("%Y%m%dT%H%M%SZ").to_string()
}

/// Lee los calendarios de una respuesta `PROPFIND`.
///
/// **Un XML que no se entiende es un error, no una lista vacía.** Con una lista
/// vacía, una conexión que se cortó o un servidor que devolvió una página de
/// error se ven igual que «esta cuenta no tiene calendarios», y la ventana se
/// queda vacía sin decir por qué.
///
/// Y un `href` **de otro origen se descarta** sin más: es un calendario que no
/// se puede pedir sin mandarle la credencial de la cuenta a otro servidor, y
/// eso no es un error de la cuenta sino algo que el servidor dijo. Los demás se
/// listan, que es lo que importa: un calendario que no se puede pedir no puede
/// tapar a los que sí.
pub fn calendarios_de(xml: &str, base: &Url) -> Result<Vec<Calendario>, DavError> {
    let documento = dav::parse_xml(xml, &LIMITES)?;
    let base = base.clone();

    Ok(documento
        .descendants()
        .filter(|n| n.has_tag_name((NS_DAV, "response")))
        .filter_map(|respuesta| {
            // Sólo las colecciones que de verdad son calendarios: la carpeta
            // también trae cosas que no lo son, y listarlas daría entradas que
            // al abrirlas no tienen nada.
            let es_calendario = respuesta
                .descendants()
                .any(|n| n.has_tag_name((NS_CALDAV, "calendar")));
            if !es_calendario {
                return None;
            }

            let href = respuesta
                .descendants()
                .find(|n| n.has_tag_name((NS_DAV, "href")))?
                .text()?
                .trim();
            // La dirección se **resuelve y se compara**, no se pega: un `href`
            // de otro servidor —o con usuario y contraseña adentro, o de más
            // de 2 KiB— no sale. Antes se resolvía con `Url::join` y nada más,
            // y el `calendario.url` que salía de acá se lo mandaba después la
            // cabecera de autenticación.
            //
            // `resolve_href` sólo puede rechazar por `ForeignOrigin`, así que no
            // hay un motivo que distinguir acá. El aviso lo recibe quien lo ve:
            // si se abre un calendario que no llegó a listarse, `eventos` le
            // contesta el texto fijo de `ForeignOrigin`, que es lo que la
            // ventana muestra en «fallos». No hay diario en esta capa —el
            // diario del sistema es un plugin de Tauri y acá no hay ventana—,
            // y un calendario que no se lista es lo que hay que ver.
            let Ok(url) = dav::resolve_href(&base, href) else {
                return None;
            };
            let url = url.to_string();

            let nombre = respuesta
                .descendants()
                .find(|n| n.has_tag_name((NS_DAV, "displayname")))
                .and_then(|n| n.text())
                .unwrap_or("")
                .trim()
                .to_string();

            let color = respuesta
                .descendants()
                .find(|n| n.has_tag_name((NS_APPLE, "calendar-color")))
                .and_then(|n| n.text())
                .map(|c| c.trim().to_string())
                .filter(|c| !c.is_empty());

            Some(Calendario {
                url,
                // Un calendario sin nombre igual se muestra: es donde puede estar
                // el evento que la persona busca.
                nombre: if nombre.is_empty() {
                    "Calendario".into()
                } else {
                    nombre
                },
                color,
            })
        })
        .collect())
}

/// Saca los bloques de iCalendar de una respuesta `REPORT`.
///
/// Como [`calendarios_de`], un XML que no se entiende es un error y no una lista
/// vacía: sin eventos y sin calendarios a los que pertenecen, la ventana queda en
/// blanco sin decir si no hay nada o si el servidor no se hizo entender.
pub fn ical_de_respuesta(xml: &str) -> Result<Vec<String>, DavError> {
    let documento = dav::parse_xml(xml, &LIMITES)?;
    Ok(documento
        .descendants()
        .filter(|n| n.has_tag_name((NS_CALDAV, "calendar-data")))
        .filter_map(|n| n.text())
        .map(str::to_string)
        .collect())
}

// ---------------------------------------------------------------------------
// La parte que habla por la red
// ---------------------------------------------------------------------------

/// La cabecera `Authorization` que le corresponde a esta cuenta.
///
/// `Basic` para una contraseña y `Bearer` para un token. No es una preferencia:
/// Google contesta 401 a cualquier `Basic`, y un servidor que espera contraseña
/// no entiende un `Bearer`. Cuál va lo decide lo que guardó el servicio de
/// cuentas, no el proveedor — ver `cuentas::AuthKind`.
fn cabecera_de(credencial: &Credencial) -> String {
    match credencial.auth {
        AuthKind::Password => format!(
            "Basic {}",
            base64::engine::general_purpose::STANDARD
                .encode(format!("{}:{}", credencial.usuario, credencial.secreto))
        ),
        AuthKind::Token => format!("Bearer {}", credencial.secreto),
    }
}

/// El cliente HTTP de esta aplicación: sólo `https` y sin redirecciones.
///
/// Va por [`dav::client`] y no en línea, para que las dos cosas que no se
/// negocian —que la credencial no viaje en claro y que no se siga a otro
/// servidor— no puedan quedar afuera si mañana se agrega un cliente nuevo.
/// Antes eran sólo la segunda: `redirect(Policy::none())` estaba, y `https_only`
/// no. Con `http://` en la dirección guardada, la contraseña de la cuenta
/// viajaba en claro por la red.
fn cliente() -> Result<reqwest::Client, String> {
    dav::client(TIMEOUT)
}

/// La respuesta del servidor, con tope y con los estados raros como error.
///
/// Los textos son de [`DavError`], y son **fijos**: sin la dirección del servidor
/// y sin lo que escribió el otro lado. La ventana los muestra a la persona y
/// cualquier programa de la sesión los puede leer del estado, así que no pueden
/// llevar el nombre de la máquina ni los nombres del certificado que dio el
/// otro lado. El detalle va al diario, y acá no hay.
async fn cuerpo_con_tope(mut respuesta: reqwest::Response) -> Result<String, String> {
    let estado = respuesta.status();
    if estado == reqwest::StatusCode::UNAUTHORIZED {
        return Err(DavError::Unauthorized.to_string());
    }
    // Una redirección no se sigue —`dav::client` lo tiene así— y acá es un error
    // y no un estado más: el `3xx` no trae los eventos, y seguirlo mandaría la
    // credencial a donde el servidor dijera.
    if estado.is_redirection() {
        return Err(DavError::Redirect(estado.as_u16()).to_string());
    }
    if !estado.is_success() {
        return Err(DavError::Status(estado.as_u16()).to_string());
    }

    // Por trozos y cortando en el momento, no `bytes()` y después medir.
    //
    // `bytes()` lee la respuesta **entera** antes de devolverla, así que medirla
    // después es enterarte del problema cuando ya pasó: un servidor que manda
    // gigabytes hace crecer la memoria de la ventana hasta donde quiera y el
    // aviso llega —si llega— cuando el equipo ya está pidiendo memoria al
    // sistema. Así se deja de leer en el trozo que cruza el tope, y lo que sigue
    // ni se pide.
    let mut cuerpo = Vec::new();
    while let Some(trozo) = respuesta
        .chunk()
        .await
        .map_err(|e| DavError::network(e.without_url()).to_string())?
    {
        if cuerpo.len() + trozo.len() > MAX_CUERPO {
            return Err(DavError::BodyTooLarge(MAX_CUERPO).to_string());
        }
        cuerpo.extend_from_slice(&trozo);
    }

    Ok(String::from_utf8_lossy(&cuerpo).into_owned())
}

/// La dirección de la cuenta, ya comprobada: `https` y sin usuario y contraseña
/// adentro.
///
/// `cuentas::credencial_desde` mira que empiece con `https://`, que hace falta
/// pero no alcanza: `https://ana:secreto@nube.ejemplo.com/dav/` la pasa y tiene
/// la credencial dentro de la URL. Acá se parsea y se mira de verdad.
fn direccion_de(credencial: &crate::cuentas::Credencial) -> Result<Url, String> {
    dav::parse_account_url(&credencial.home).map_err(|e| e.to_string())
}

/// Los calendarios que hay en la carpeta de la persona.
pub async fn calendarios(
    credencial: &crate::cuentas::Credencial,
) -> Result<Vec<Calendario>, String> {
    let home = direccion_de(credencial)?;

    let cuerpo = format!(
        r#"<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="{NS_CALDAV}" xmlns:a="{NS_APPLE}">
  <d:prop><d:resourcetype/><d:displayname/><a:calendar-color/></d:prop>
</d:propfind>"#
    );

    let respuesta = cliente()?
        .request(metodo("PROPFIND"), home.clone())
        .header("Authorization", cabecera_de(credencial))
        // 1: la carpeta y lo que hay dentro. Con 0 sólo vendría la carpeta, que
        // es justo lo que no interesa.
        .header("Depth", "1")
        .header("Content-Type", "application/xml; charset=utf-8")
        .body(cuerpo)
        .send()
        .await
        .map_err(|e| DavError::network(e.without_url()).to_string())?;

    let xml = cuerpo_con_tope(respuesta).await?;
    // El XML se arma fuera del hilo del bucle de eventos: un `multistatus` de
    // ocho megas tarda lo suyo, y mientras lo ocupe la ventana no atiende nada
    // más. Y si se cae por dentro, vuelve como un documento que no se entiende
    // en vez de llevarse la tarea.
    dav::off_runtime(move || calendarios_de(&xml, &home))
        .await
        .map_err(|e| e.to_string())
}

/// Los eventos de un calendario entre dos momentos, con las series ya
/// expandidas.
///
/// **La dirección se compara con la de la cuenta antes de mandar nada.** Viene
/// de la ventana —o sea, de un proceso de la sesión—, y el `Authorization` va en
/// el mismo pedido: sin esta comprobación, un `calendario` de otro origen se
/// lleva la credencial de la cuenta a otro servidor. `calendarios_de` ya
/// descarta los que no son del mismo origen; esto es para el caso de que se pida
/// uno que no vino de la lista.
///
/// Primero con `<c:expand>`; si el servidor lo rechaza, otra vez sin él. Y
/// expanda o no, la respuesta pasa por [`crate::recurrence::expand`], que deja
/// las instancias que ya vinieron como están y expande las series que no.
pub async fn events(
    credencial: &crate::cuentas::Credencial,
    calendario: &str,
    window: Window,
) -> Result<Expansion, String> {
    let home = direccion_de(credencial)?;
    let pedido = dav::resolve_href(&home, calendario).map_err(|e| e.to_string())?;
    if pedido.origin() != home.origin() {
        return Err(DavError::ForeignOrigin.to_string());
    }

    let (from, to) = (momento_caldav(window.start), momento_caldav(window.end));
    let report = |expand: bool| {
        let body = events_query(&from, &to, expand);
        let pedido = pedido.clone();
        async move {
            cliente()?
                .request(metodo("REPORT"), pedido)
                .header("Authorization", cabecera_de(credencial))
                // 1: los eventos de este calendario. El estándar lo pide para
                // una consulta de calendario, y hay servidores que sin esto
                // devuelven vacío.
                .header("Depth", "1")
                .header("Content-Type", "application/xml; charset=utf-8")
                .body(body)
                .send()
                .await
                .map_err(|e| DavError::network(e.without_url()).to_string())
        }
    };

    let mut notes = Vec::new();
    let mut respuesta = report(true).await?;
    if retry_without_expand(respuesta.status().as_u16()) {
        notes.push(format!(
            "el servidor rechazó <c:expand> con {}; se pide sin expandir",
            respuesta.status().as_u16()
        ));
        respuesta = report(false).await?;
    }

    let xml = cuerpo_con_tope(respuesta).await?;
    let mut expansion = dav::off_runtime(move || -> Result<Expansion, DavError> {
        let mut expansion = Expansion::default();
        let mut ignored = false;
        for block in ical_de_respuesta(&xml)? {
            let components = components_of(&block);
            ignored |= server_expansion(&components) == ServerExpansion::Ignored;
            let part = crate::recurrence::expand(components, &window);
            expansion.events.extend(part.events);
            expansion.notes.extend(part.notes);
        }
        if ignored {
            expansion.notes.insert(
                0,
                "el servidor no expandió las repeticiones; se expanden acá".into(),
            );
        }
        Ok(expansion)
    })
    .await
    .map_err(|e| e.to_string())?;

    notes.append(&mut expansion.notes);
    expansion.notes = notes;
    Ok(expansion)
}

fn metodo(nombre: &str) -> reqwest::Method {
    reqwest::Method::from_bytes(nombre.as_bytes()).expect("es un método válido")
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    /// Un rango que abarca todo lo que usan estas pruebas.
    fn wide_window() -> Window {
        Window {
            start: Utc.with_ymd_and_hms(1990, 1, 1, 0, 0, 0).unwrap(),
            end: Utc.with_ymd_and_hms(2100, 1, 1, 0, 0, 0).unwrap(),
        }
    }

    /// Los eventos de un iCalendar que se ven en el rango, con las series ya
    /// expandidas: lo mismo que hace [`events`] con cada bloque.
    fn events_in(ical: &str, window: &Window) -> Expansion {
        crate::recurrence::expand(components_of(ical), window)
    }

    fn all_events(ical: &str) -> Vec<Event> {
        events_in(ical, &wide_window()).events
    }

    /// Una fecha de iCalendar como instante, y si es de día completo.
    ///
    /// Las dos formas con hora local se trataban como UTC, y eso quería decir que
    /// una reunión de las 14:00 en Buenos Aires se mostraba a las 11:00.
    fn instant_of(
        value: &str,
        parameters: &[String],
        zones: &Zonas,
    ) -> Option<(DateTime<Utc>, bool)> {
        let moment = moment_of(value, parameters, zones)?;
        Some((moment.to_utc()?, moment.is_date()))
    }

    fn credencial(auth: AuthKind) -> Credencial {
        Credencial {
            home: "https://servidor.ejemplo.com/dav/".into(),
            usuario: "ana@ejemplo.com".into(),
            secreto: "el-secreto".into(),
            auth,
        }
    }

    /// Una contraseña va en `Basic`, con el usuario delante.
    #[test]
    fn la_contrasena_viaja_en_basic() {
        let cabecera = cabecera_de(&credencial(AuthKind::Password));

        assert!(cabecera.starts_with("Basic "), "{cabecera}");
        // Y con el usuario adentro, que es lo que distingue a `Basic` de mandar
        // el secreto solo.
        let codificado =
            base64::engine::general_purpose::STANDARD.encode("ana@ejemplo.com:el-secreto");
        assert_eq!(cabecera, format!("Basic {codificado}"));
    }

    /// Un token va en `Bearer` y **sin el usuario**: Google contesta 401 a
    /// cualquier `Basic`, y el rechazo parece de credenciales.
    #[test]
    fn el_token_viaja_en_bearer() {
        let cabecera = cabecera_de(&credencial(AuthKind::Token));

        assert_eq!(cabecera, "Bearer el-secreto");
    }

    /// El secreto nunca se codifica en base64 cuando es un token: eso es lo que
    /// hacía que Google lo rechazara, y el modo de fallo es silencioso porque
    /// una cabecera mal armada se ve igual que una bien armada.
    #[test]
    fn las_dos_formas_no_se_parecen() {
        let con_clave = cabecera_de(&credencial(AuthKind::Password));
        let con_token = cabecera_de(&credencial(AuthKind::Token));

        assert_ne!(con_clave, con_token);
    }

    /// El formato corta las líneas largas y sigue en la siguiente con un espacio
    /// adelante. Sin volver a juntarlas, un título largo aparece cortado a la
    /// mitad — y los títulos largos son justamente los que más se cortan.
    #[test]
    fn las_lineas_partidas_se_vuelven_a_juntar() {
        let ical = "SUMMARY:Reunión de\r\n  equipo\r\nUID:1\r\n";
        let lineas = unir_lineas(ical);

        assert_eq!(lineas[0], "SUMMARY:Reunión de equipo");
        assert_eq!(lineas[1], "UID:1");
    }

    /// Con tabulación también, que el estándar permite igual — y el carácter
    /// que pliega **se va**, no se convierte en un espacio. Un título cortado
    /// justo en el medio de una palabra tiene que volver a quedar entero: en el
    /// test de arriba el espacio que sobrevive es el segundo, el que el evento
    /// tenía de verdad.
    #[test]
    fn una_continuacion_con_tabulacion_tambien_se_junta() {
        assert_eq!(unir_lineas("SUMMARY:algo\r\n\tmás")[0], "SUMMARY:algomás");
        assert_eq!(unir_lineas("SUMMARY:algo\r\n\t más")[0], "SUMMARY:algo más");
    }

    /// El valor puede tener dos puntos —una URL, por ejemplo— así que el corte
    /// va por el primero. Cortar por el último partiría la línea en el lugar
    /// equivocado.
    #[test]
    fn la_linea_se_corta_por_el_primer_dos_puntos() {
        let (nombre, _, valor) = partir_linea("DESCRIPTION:ver https://ejemplo.com/x").unwrap();
        assert_eq!(nombre, "DESCRIPTION");
        assert_eq!(valor, "ver https://ejemplo.com/x");
    }

    /// Y no por uno que esté entre comillas: un parámetro puede llevarlos.
    #[test]
    fn un_dos_puntos_entre_comillas_no_corta() {
        let (nombre, parametros, valor) =
            partir_linea(r#"DTSTART;TZID="America/Argentina/Buenos Aires":20260915T140000"#)
                .unwrap();
        assert_eq!(nombre, "DTSTART");
        assert_eq!(valor, "20260915T140000");
        assert!(parametros[0].contains("America"));
    }

    #[test]
    fn los_parametros_se_separan_del_nombre() {
        let (nombre, parametros, valor) = partir_linea("DTSTART;VALUE=DATE:20260915").unwrap();
        assert_eq!(nombre, "DTSTART");
        assert_eq!(parametros, vec!["VALUE=DATE"]);
        assert_eq!(valor, "20260915");
    }

    /// Sin deshacer lo escapado, «Reunión, con Ana» se muestra con la barra a la
    /// vista.
    #[test]
    fn el_texto_se_desescapa() {
        assert_eq!(texto_de(r"Reunión\, con Ana"), "Reunión, con Ana");
        assert_eq!(texto_de(r"Uno\nDos"), "Uno\nDos");
        assert_eq!(texto_de(r"punto\; y coma"), "punto; y coma");
        assert_eq!(texto_de(r"barra\\sola"), r"barra\sola");
    }

    /// Una barra que no escapa nada conocido se deja: es un dato de alguien y no
    /// hay motivo para tragárselo.
    #[test]
    fn una_barra_que_no_escapa_nada_se_deja() {
        assert_eq!(texto_de(r"C:\Users"), r"C:\Users");
        assert_eq!(texto_de("termina en barra\\"), "termina en barra\\");
    }

    /// Un evento de día completo **no tiene hora**, y darle una lo correría de
    /// día para quien esté en otra zona.
    #[test]
    fn una_fecha_sin_hora_es_de_dia_completo() {
        let (momento, todo_el_dia) =
            instant_of("20260915", &["VALUE=DATE".into()], &Zonas::default()).unwrap();
        assert!(todo_el_dia);
        assert_eq!(momento.to_rfc3339(), "2026-09-15T00:00:00+00:00");

        // Y también si no viene el parámetro: ocho dígitos ya son una fecha.
        assert!(instant_of("20260915", &[], &Zonas::default()).unwrap().1);
    }

    #[test]
    fn una_fecha_con_hora_no_es_de_dia_completo() {
        let (momento, todo_el_dia) =
            instant_of("20260915T140000Z", &[], &Zonas::default()).unwrap();
        assert!(!todo_el_dia);
        assert_eq!(momento.to_rfc3339(), "2026-09-15T14:00:00+00:00");
    }

    #[test]
    fn una_fecha_que_no_se_entiende_no_se_inventa() {
        for basura in ["", "mañana", "2026-09-15", "20261301", "20260915T99"] {
            assert_eq!(
                instant_of(basura, &[], &Zonas::default()),
                None,
                "{basura:?}"
            );
        }
    }

    /// **El bug que este módulo tenía.** Una fecha con `TZID` se trataba como
    /// UTC, así que una reunión de las dos de la tarde en Buenos Aires se
    /// mostraba a las once de la mañana.
    #[test]
    fn una_fecha_con_tzid_no_es_utc() {
        let (momento, todo_el_dia) = instant_of(
            "20260915T140000",
            &["TZID=America/Argentina/Buenos_Aires".into()],
            &Zonas::default(),
        )
        .unwrap();
        assert!(!todo_el_dia);
        assert_eq!(momento.to_rfc3339(), "2026-09-15T17:00:00+00:00");
    }

    /// El `TZID` entre comillas, que es como lo escribe un cliente cuando el
    /// nombre tiene barras o espacios.
    #[test]
    fn el_tzid_entre_comillas_se_resuelve_igual() {
        let (momento, _) = instant_of(
            "20260915T140000",
            &[r#"TZID="America/Argentina/Buenos Aires""#.into()],
            &Zonas::default(),
        )
        .unwrap();
        assert_eq!(momento.to_rfc3339(), "2026-09-15T17:00:00+00:00");
    }

    /// Una `Z` es un instante y manda sobre cualquier `TZID` al lado: eso es un
    /// archivo mal escrito, no otra interpretación.
    #[test]
    fn la_z_manda_sobre_el_tzid() {
        let (momento, _) = instant_of(
            "20260915T140000Z",
            &["TZID=Europe/Madrid".into()],
            &Zonas::default(),
        )
        .unwrap();
        assert_eq!(momento.to_rfc3339(), "2026-09-15T14:00:00+00:00");
    }

    /// Un evento entero con su `VTIMEZONE`, como lo manda Outlook: el `TZID` no
    /// es un nombre de IANA y las reglas vienen en el mismo archivo.
    #[test]
    fn un_evento_con_su_propio_vtimezone_cae_a_la_hora_correcta() {
        let ical = "BEGIN:VCALENDAR\r\n\
            BEGIN:VTIMEZONE\r\n\
            TZID:Romance Standard Time\r\n\
            BEGIN:STANDARD\r\n\
            DTSTART:16010101T030000\r\n\
            TZOFFSETFROM:+0200\r\nTZOFFSETTO:+0100\r\n\
            RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=10\r\n\
            END:STANDARD\r\n\
            BEGIN:DAYLIGHT\r\n\
            DTSTART:16010101T020000\r\n\
            TZOFFSETFROM:+0100\r\nTZOFFSETTO:+0200\r\n\
            RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=3\r\n\
            END:DAYLIGHT\r\n\
            END:VTIMEZONE\r\n\
            BEGIN:VEVENT\r\nUID:abc\r\nSUMMARY:Reunión\r\n\
            DTSTART;TZID=Romance Standard Time:20260715T090000\r\n\
            DTEND;TZID=Romance Standard Time:20260715T100000\r\n\
            END:VEVENT\r\nEND:VCALENDAR\r\n";

        let eventos = all_events(ical);
        assert_eq!(eventos.len(), 1);
        // Julio es verano en Madrid: +2.
        assert_eq!(eventos[0].start, "2026-07-15T07:00:00+00:00");
        assert_eq!(eventos[0].end, "2026-07-15T08:00:00+00:00");
    }

    /// Un `VTIMEZONE` con el ordinal del `BYDAY` en el extremo del tipo, tal
    /// como llega de la red.
    ///
    /// **De dónde sale:** de la respuesta a un `REPORT` de CalDAV, que es lo que
    /// devuelve `eventos()` después de `ical_de_respuesta`. El archivo lo escribe
    /// el servidor —o quien controle el servidor—, no la aplicación. Por eso esto
    /// no es un archivo imaginario ni una función muerta: es exactamente el
    /// camino que corre `dav::off_runtime` cuando la persona abre un mes.
    ///
    /// Con `-2147483648`, el `abs()` del filtro de `MAX_ORDINAL` **entraba en
    /// pánico** al leer la zona, antes de mirar un solo evento. Y en release —que
    /// es como se distribuye, y con `panic = "abort"`— el `abs()` no desbordaba:
    /// el ordinal pasaba el filtro y entraba en pánico más abajo, restándole
    /// quince mil millones de días a una fecha. Los dos extremos van en el mismo
    /// archivo porque el que falla no es uno solo.
    #[test]
    fn un_vtimezone_con_el_ordinal_en_el_extremo_no_tumba_la_aplicacion() {
        let ical = "BEGIN:VCALENDAR\r\n\
            BEGIN:VTIMEZONE\r\n\
            TZID:Romance Standard Time\r\n\
            BEGIN:STANDARD\r\n\
            DTSTART:16010101T030000\r\n\
            TZOFFSETFROM:+0200\r\nTZOFFSETTO:+0100\r\n\
            RRULE:FREQ=YEARLY;BYDAY=-2147483648SU;BYMONTH=10\r\n\
            END:STANDARD\r\n\
            BEGIN:DAYLIGHT\r\n\
            DTSTART:16010101T020000\r\n\
            TZOFFSETFROM:+0100\r\nTZOFFSETTO:+0200\r\n\
            RRULE:FREQ=YEARLY;BYDAY=2147483647SU;BYMONTH=3\r\n\
            END:DAYLIGHT\r\n\
            END:VTIMEZONE\r\n\
            BEGIN:VEVENT\r\nUID:abc\r\nSUMMARY:Reunión\r\n\
            DTSTART;TZID=Romance Standard Time:20260715T090000\r\n\
            DTEND;TZID=Romance Standard Time:20260715T100000\r\n\
            END:VEVENT\r\nEND:VCALENDAR\r\n";

        // Lo que no puede pasar es que esto entre en pánico.
        let eventos = all_events(ical);
        assert_eq!(eventos.len(), 1);
        // La regla que no se entiende se descarta entera y la observancia cae
        // al respaldo de la estándar, que es lo que dice su `TZOFFSETTO`: +1.
        assert_eq!(eventos[0].start, "2026-07-15T08:00:00+00:00");
        assert_eq!(eventos[0].end, "2026-07-15T09:00:00+00:00");
    }

    /// Un evento de día completo sigue sin tener zona, aunque el archivo defina
    /// una: darle una hora lo correría de día para quien esté en otra.
    #[test]
    fn un_evento_de_dia_completo_no_se_corre_de_dia() {
        let ical = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:abc\r\n\
            DTSTART;VALUE=DATE:20260915\r\nDTEND;VALUE=DATE:20260916\r\n\
            END:VEVENT\r\nEND:VCALENDAR\r\n";

        let eventos = all_events(ical);
        assert!(eventos[0].all_day);
        assert_eq!(eventos[0].start, "2026-09-15T00:00:00+00:00");
    }

    const UN_EVENTO: &str = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:abc\r\n\
        SUMMARY:Reunión\\, con Ana\r\nDTSTART:20260915T140000Z\r\n\
        DTEND:20260915T150000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";

    /// El evento lleva la zona en la que lo escribieron, para que la ventana
    /// pueda avisar cuando no es la misma en la que se está mirando la agenda.
    #[test]
    fn el_evento_lleva_la_zona_en_la_que_lo_escribieron() {
        let ical = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:a\r\n\
            DTSTART;TZID=Europe/Madrid:20260915T140000\r\n\
            DTEND;TZID=Europe/Madrid:20260915T150000\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
        assert_eq!(all_events(ical)[0].zone, "Europe/Madrid");

        // Entre comillas es el mismo nombre, no otro.
        let comillado = ical.replace("TZID=Europe/Madrid", "TZID=\"Europe/Madrid\"");
        assert_eq!(all_events(&comillado)[0].zone, "Europe/Madrid");
    }

    /// Una fecha en UTC ya es un instante: no hay ninguna zona que mostrar.
    #[test]
    fn un_evento_en_utc_no_lleva_zona() {
        assert_eq!(all_events(UN_EVENTO)[0].zone, "");
    }

    /// Y uno de día completo tampoco, aunque el archivo le ponga una: no tiene
    /// hora, así que no hay a qué reloj referirla.
    #[test]
    fn un_evento_de_dia_completo_no_lleva_zona() {
        let ical = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:a\r\n\
            DTSTART;TZID=Europe/Madrid;VALUE=DATE:20260915\r\n\
            END:VEVENT\r\nEND:VCALENDAR\r\n";
        assert_eq!(all_events(ical)[0].zone, "");
    }

    #[test]
    fn se_lee_un_evento() {
        let eventos = all_events(UN_EVENTO);
        assert_eq!(eventos.len(), 1);
        assert_eq!(eventos[0].uid, "abc");
        assert_eq!(eventos[0].title, "Reunión, con Ana");
        assert!(!eventos[0].all_day);
        assert!(!eventos[0].recurring);
    }

    /// Un calendario trae también tareas y notas. Mostrarlas como eventos
    /// llenaría el mes de cosas que no lo son.
    #[test]
    fn las_tareas_y_las_notas_no_son_eventos() {
        let ical = "BEGIN:VCALENDAR\r\n\
            BEGIN:VTODO\r\nUID:t\r\nSUMMARY:Comprar pan\r\nDTSTART:20260915T140000Z\r\nEND:VTODO\r\n\
            BEGIN:VJOURNAL\r\nUID:j\r\nSUMMARY:Nota\r\nDTSTART:20260915T140000Z\r\nEND:VJOURNAL\r\n\
            BEGIN:VEVENT\r\nUID:e\r\nSUMMARY:Reunión\r\nDTSTART:20260915T140000Z\r\nEND:VEVENT\r\n\
            END:VCALENDAR\r\n";

        let eventos = all_events(ical);
        assert_eq!(eventos.len(), 1);
        assert_eq!(eventos[0].uid, "e");
    }

    /// El recordatorio de un evento no es el título del evento.
    ///
    /// Un `VEVENT` casi siempre trae un `VALARM` adentro, y el `VALARM` tiene su
    /// propio `SUMMARY` —«Recordatorio», o lo que le haya puesto el cliente que
    /// creó el evento—. Sin contar la anidación, esa línea pisaba el título y la
    /// cuadrícula del mes aparecía llena de «Recordatorio» en vez de reuniones.
    #[test]
    fn el_summary_de_un_recordatorio_no_pisa_el_del_evento() {
        let ical = "BEGIN:VEVENT\r\nUID:a\r\nSUMMARY:Reunión con Ana\r\n\
            DTSTART:20260915T140000Z\r\n\
            BEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT15M\r\n\
            SUMMARY:Recordatorio\r\nDESCRIPTION:Falta un rato\r\nEND:VALARM\r\n\
            END:VEVENT\r\n";

        let eventos = all_events(ical);
        assert_eq!(eventos.len(), 1);
        assert_eq!(eventos[0].title, "Reunión con Ana");
    }

    /// Y un `DTSTART` de adentro tampoco corre el evento de día.
    ///
    /// Un `VALARM` con disparador absoluto lleva su propia fecha, que es la del
    /// aviso y no la de la reunión.
    #[test]
    fn la_fecha_de_un_recordatorio_no_mueve_el_evento() {
        let ical = "BEGIN:VEVENT\r\nUID:a\r\nDTSTART:20260915T140000Z\r\n\
            BEGIN:VALARM\r\nACTION:DISPLAY\r\nDTSTART:20260101T000000Z\r\n\
            RRULE:FREQ=DAILY\r\nEND:VALARM\r\n\
            END:VEVENT\r\n";

        let evento = &all_events(ical)[0];
        assert_eq!(evento.start, "2026-09-15T14:00:00+00:00");
        // Y el `RRULE` del aviso tampoco lo marca como repetido: el que se
        // repite es el recordatorio, no la reunión.
        assert!(!evento.recurring);
    }

    /// Sin comienzo no hay dónde ponerlo en el mes. El estándar lo exige, pero
    /// un servidor puede mandar cualquier cosa y no puede tirar la lista entera.
    #[test]
    fn un_evento_sin_comienzo_se_saltea_sin_perder_los_demas() {
        let ical = "BEGIN:VCALENDAR\r\n\
            BEGIN:VEVENT\r\nUID:roto\r\nSUMMARY:Sin fecha\r\nEND:VEVENT\r\n\
            BEGIN:VEVENT\r\nUID:sano\r\nSUMMARY:Con fecha\r\nDTSTART:20260915T140000Z\r\nEND:VEVENT\r\n\
            END:VCALENDAR\r\n";

        let eventos = all_events(ical);
        assert_eq!(eventos.len(), 1);
        assert_eq!(eventos[0].uid, "sano");
    }

    /// Sin `DTEND`, un evento de día completo dura un día y uno con hora no dura
    /// nada. Inventar una hora de fin mostraría una barra que no corresponde.
    #[test]
    fn sin_fin_la_duracion_es_la_que_dice_el_estandar() {
        let de_dia = "BEGIN:VEVENT\r\nUID:d\r\nDTSTART;VALUE=DATE:20260915\r\nEND:VEVENT\r\n";
        let evento = &all_events(de_dia)[0];
        assert_eq!(evento.start, "2026-09-15T00:00:00+00:00");
        assert_eq!(evento.end, "2026-09-16T00:00:00+00:00");

        let con_hora = "BEGIN:VEVENT\r\nUID:h\r\nDTSTART:20260915T140000Z\r\nEND:VEVENT\r\n";
        let evento = &all_events(con_hora)[0];
        assert_eq!(evento.start, evento.end);
    }

    /// Un evento que se repite sale una vez por repetición, y cada una marcada:
    /// antes salía una sola, el día que empezaba, y las otras nueve semanas
    /// parecían libres.
    #[test]
    fn un_evento_que_se_repite_sale_en_cada_repeticion() {
        let ical = "BEGIN:VEVENT\r\nUID:r\r\nDTSTART:20260915T140000Z\r\n\
                    RRULE:FREQ=WEEKLY;COUNT=10\r\nEND:VEVENT\r\n";
        let eventos = all_events(ical);
        assert_eq!(eventos.len(), 10);
        assert!(eventos.iter().all(|e| e.recurring && !e.shown_once));
        assert_eq!(eventos[9].start, "2026-11-17T14:00:00+00:00");
    }

    /// Un evento sin título existe y ocupa lugar en el día de la persona igual,
    /// así que se muestra vacío en vez de descartarse.
    #[test]
    fn un_evento_sin_titulo_se_muestra_igual() {
        let ical = "BEGIN:VEVENT\r\nUID:x\r\nDTSTART:20260915T140000Z\r\nEND:VEVENT\r\n";
        let eventos = all_events(ical);
        assert_eq!(eventos.len(), 1);
        assert_eq!(eventos[0].title, "");
    }

    /// Basura no puede hacer caer la ventana: viene de un servidor y de eventos
    /// que escribió cualquiera.
    #[test]
    fn lo_que_no_es_un_calendario_no_da_eventos() {
        for basura in [
            "",
            "no es un calendario",
            "BEGIN:VEVENT",
            "END:VEVENT\r\n",
            ":::",
        ] {
            assert!(all_events(basura).is_empty(), "{basura:?}");
        }
    }

    const CALENDARIOS: &str = r#"<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"
               xmlns:a="http://apple.com/ns/ical/">
  <d:response>
    <d:href>/dav/calendars/ana/</d:href>
    <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat>
  </d:response>
  <d:response>
    <d:href>/dav/calendars/ana/personal/</d:href>
    <d:propstat><d:prop>
      <d:resourcetype><d:collection/><c:calendar/></d:resourcetype>
      <d:displayname>Personal</d:displayname>
      <a:calendar-color>#FF5733</a:calendar-color>
    </d:prop></d:propstat>
  </d:response>
</d:multistatus>"#;

    fn base() -> Url {
        Url::parse("https://nube.ejemplo.com/dav/calendars/ana/").unwrap()
    }

    /// La carpeta también trae cosas que no son calendarios. Listarlas daría
    /// entradas que al abrirlas no tienen nada.
    #[test]
    fn solo_se_listan_las_colecciones_que_son_calendarios() {
        let calendarios = calendarios_de(CALENDARIOS, &base()).unwrap();

        assert_eq!(calendarios.len(), 1);
        assert_eq!(calendarios[0].nombre, "Personal");
        assert_eq!(calendarios[0].color.as_deref(), Some("#FF5733"));
        assert_eq!(
            calendarios[0].url,
            "https://nube.ejemplo.com/dav/calendars/ana/personal/"
        );
    }

    /// Los servidores contestan con una ruta absoluta casi siempre y con una URL
    /// entera a veces, y del mismo origen: pegarlas a mano rompería la segunda.
    #[test]
    fn un_href_con_url_entera_del_mismo_origen_no_se_pega_dos_veces() {
        let xml = CALENDARIOS.replace(
            "<d:href>/dav/calendars/ana/personal/</d:href>",
            "<d:href>https://nube.ejemplo.com/dav/calendars/ana/personal/</d:href>",
        );
        let calendarios = calendarios_de(&xml, &base()).unwrap();
        assert_eq!(calendarios.len(), 1);
        assert_eq!(
            calendarios[0].url,
            "https://nube.ejemplo.com/dav/calendars/ana/personal/"
        );
    }

    /// **Un calendario de otro origen no se lista.** Es la fuga de credencial de
    /// `vasak-calendar#45`: el `calendario.url` que salía de acá se lo pedía
    /// después `eventos()` con la cabecera `Authorization` puesta, y el servidor
    /// contestando con un `href` de otra máquina se la llevaba.
    #[test]
    fn un_calendario_de_otro_servidor_no_se_lista() {
        for ajeno in [
            "https://otra.ejemplo.com/x/",
            "http://nube.ejemplo.com/dav/calendars/ana/personal/",
            // Misma máquina, otro esquema: la credencial por HTTP es a la vista.
            "https://nube.ejemplo.com:8443/dav/calendars/ana/personal/",
            // La contraseña dentro de la dirección.
            "https://ana:secreto@nube.ejemplo.com/dav/calendars/ana/personal/",
        ] {
            let xml = CALENDARIOS.replace(
                "<d:href>/dav/calendars/ana/personal/</d:href>",
                &format!("<d:href>{ajeno}</d:href>"),
            );
            let calendarios = calendarios_de(&xml, &base()).unwrap();
            assert!(
                calendarios.is_empty(),
                "{ajeno} se listó: {:?}",
                calendarios.iter().map(|c| &c.url).collect::<Vec<_>>(),
            );
        }
    }

    /// Uno de otro origen no tapa a los de la cuenta: el documento entero se
    /// sigue=listando, y el que no se puede pedir simplemente no está.
    #[test]
    fn un_calendario_ajeno_no_tapa_a_los_demas() {
        // Dos respuestas en el mismo documento: la propia y una de otro
        // servidor.
        let dos = CALENDARIOS.replace(
            "</d:multistatus>",
            r#"<d:response>
    <d:href>https://atacante.ejemplo.com/robo/</d:href>
    <d:propstat><d:prop>
      <d:resourcetype><d:collection/><c:calendar/></d:resourcetype>
      <d:displayname>Trabajo</d:displayname>
    </d:prop></d:propstat>
  </d:response>
</d:multistatus>"#,
        );
        let calendarios = calendarios_de(&dos, &base()).unwrap();
        assert_eq!(calendarios.len(), 1, "{calendarios:?}");
        assert_eq!(calendarios[0].nombre, "Personal");
    }

    /// Un XML que no se entiende es un error, no una lista vacía.
    ///
    /// Antes `calendarios_de` devolvía `vec![]` si `roxmltree` no podía leer el
    /// documento, y `ListEvents` contestaba una lista vacía de eventos sin decir
    /// nada: una conexión que se cortó o un servidor que devolvió una página de
    /// error se veían igual que «no tenés eventos».
    #[test]
    fn un_xml_roto_es_un_error_y_no_una_lista_vacia() {
        for roto in ["no es xml", "<abierto>", "", "<a><b></a>"] {
            assert!(
                matches!(calendarios_de(roto, &base()), Err(DavError::BadXml(_))),
                "calendarios_de({roto:?}) debería ser BadXml",
            );
            assert!(
                matches!(ical_de_respuesta(roto), Err(DavError::BadXml(_))),
                "ical_de_respuesta({roto:?}) debería ser BadXml",
            );
        }
    }

    /// Y el camino de verdad de un XML que no se entiende tampoco se come el
    /// documento: un `multistatus` de verdad pasa.
    #[test]
    fn un_multistatus_de_verdad_no_pasa_los_topes() {
        assert!(calendarios_de(CALENDARIOS, &base()).is_ok());
        assert!(dav::check_shape(CALENDARIOS, &LIMITES).is_ok());
    }

    /// El rango va siempre en UTC y sin guiones: un servidor rechaza el pedido
    /// entero si el formato no es exactamente ése.
    #[test]
    fn el_rango_va_en_el_formato_que_espera_el_servidor() {
        let momento = Utc.with_ymd_and_hms(2026, 9, 15, 14, 30, 0).unwrap();
        assert_eq!(momento_caldav(momento), "20260915T143000Z");

        let consulta = events_query("20260901T000000Z", "20261001T000000Z", false);
        assert!(
            consulta.contains(r#"start="20260901T000000Z""#),
            "{consulta}"
        );
        assert!(
            roxmltree::Document::parse(&consulta).is_ok(),
            "no es XML válido"
        );
    }

    // ── Lo que devuelve un servidor de verdad con y sin `<c:expand>` ─────────
    //
    // Ver `tests/fixtures/caldav/README.md`: las de Radicale están grabadas de
    // un servidor corriendo, la de Nextcloud armada siguiendo a SabreDAV.

    const RADICALE_EXPAND: &str =
        include_str!("../tests/fixtures/caldav/radicale-3.8.1-expand.xml");
    const RADICALE_PLAIN: &str = include_str!("../tests/fixtures/caldav/radicale-3.8.1-plain.xml");
    const NEXTCLOUD_EXPAND: &str = include_str!("../tests/fixtures/caldav/nextcloud-32-expand.xml");

    fn october_window() -> Window {
        Window {
            start: Utc.with_ymd_and_hms(2026, 10, 1, 0, 0, 0).unwrap(),
            end: Utc.with_ymd_and_hms(2026, 11, 15, 0, 0, 0).unwrap(),
        }
    }

    /// Lo que hace [`events`] con una respuesta, sin la red.
    fn read_response(xml: &str) -> (ServerExpansion, Vec<(String, String, bool)>) {
        let mut verdicts = Vec::new();
        let mut events = Vec::new();
        for block in ical_de_respuesta(xml).unwrap() {
            let components = components_of(&block);
            verdicts.push(server_expansion(&components));
            events.extend(crate::recurrence::expand(components, &october_window()).events);
        }
        let verdict = if verdicts.contains(&ServerExpansion::Ignored) {
            ServerExpansion::Ignored
        } else if verdicts.contains(&ServerExpansion::Honored) {
            ServerExpansion::Honored
        } else {
            ServerExpansion::NotNeeded
        };
        let mut seen: Vec<(String, String, bool)> = events
            .into_iter()
            .map(|e| (e.start, e.title, e.recurring))
            .collect();
        seen.sort();
        (verdict, seen)
    }

    /// Lo que la persona tiene que ver del mes, venga como venga: la reunión
    /// de los martes a las 10 de Madrid —a las 8 UTC antes del 25/10 y a las 9
    /// después—, sin el 13 (quitado), con la del 20 movida al 21 y sin la del
    /// 3/11 (cancelada); el cumpleaños del 15 y el dentista del 9.
    fn expected() -> Vec<(String, String, bool)> {
        let mut v: Vec<(String, String, bool)> = [
            ("2026-10-06T08:00:00+00:00", "Reunión de equipo", true),
            ("2026-10-09T14:00:00+00:00", "Dentista", false),
            ("2026-10-15T00:00:00+00:00", "Cumpleaños de Ana", true),
            (
                "2026-10-21T10:00:00+00:00",
                "Reunión de equipo (movida)",
                true,
            ),
            ("2026-10-27T09:00:00+00:00", "Reunión de equipo", true),
            ("2026-11-10T09:00:00+00:00", "Reunión de equipo", true),
        ]
        .into_iter()
        .map(|(a, b, c)| (a.to_string(), b.to_string(), c))
        .collect();
        v.sort();
        v
    }

    /// Radicale 3.8.1 respeta el `expand`: ninguna regla en la respuesta, y
    /// la cancelada viene igual, con su `STATUS:CANCELLED` —y no se muestra—.
    #[test]
    fn radicale_expande_y_se_le_cree() {
        assert!(RADICALE_EXPAND.contains("STATUS:CANCELLED"));
        let (verdict, seen) = read_response(RADICALE_EXPAND);
        assert_eq!(verdict, ServerExpansion::Honored);
        assert_eq!(seen, expected());
    }

    /// Sin `expand` —o con un servidor que lo ignora, que contesta lo
    /// mismo—, las series vienen con su `RRULE` y se expanden acá, con el
    /// **mismo** resultado que dio el servidor.
    #[test]
    fn un_servidor_que_no_expande_se_detecta_y_se_expande_aca() {
        assert!(RADICALE_PLAIN.contains("RRULE:FREQ=WEEKLY"));
        let (verdict, seen) = read_response(RADICALE_PLAIN);
        assert_eq!(verdict, ServerExpansion::Ignored);
        assert_eq!(seen, expected());
    }

    /// Nextcloud (SabreDAV) expande con los finales de línea como `&#13;` y
    /// el `RECURRENCE-ID` de día completo como fecha.
    #[test]
    fn nextcloud_expande_y_se_le_cree() {
        let (verdict, seen) = read_response(NEXTCLOUD_EXPAND);
        assert_eq!(verdict, ServerExpansion::Honored);
        let without_dentist: Vec<_> = expected()
            .into_iter()
            .filter(|(_, title, _)| title != "Dentista")
            .collect();
        assert_eq!(seen, without_dentist);
    }

    #[test]
    fn sin_nada_que_se_repita_no_se_sabe() {
        assert_eq!(
            server_expansion(&components_of(UN_EVENTO)),
            ServerExpansion::NotNeeded
        );
    }

    /// La consulta con `expand` es exactamente la que se le mandó a Radicale
    /// para grabar la respuesta: si cambia, la grabación deja de probar lo
    /// que se manda.
    #[test]
    fn la_consulta_con_expand_es_la_que_se_grabo() {
        let recorded = include_str!("../tests/fixtures/caldav/expand-query.xml");
        let normalize = |s: &str| s.split_whitespace().collect::<Vec<_>>().join(" ");
        assert_eq!(
            normalize(&events_query("20261001T000000Z", "20261115T000000Z", true)),
            normalize(recorded)
        );
        assert!(!events_query("a", "b", false).contains("expand"));
    }

    /// Un rechazo que puede ser por el `expand` se reintenta sin él; uno de
    /// credencial no, que pedir otra vez no lo arregla.
    #[test]
    fn solo_se_reintenta_sin_expand_lo_que_puede_ser_por_expand() {
        for status in [400, 403, 415, 422, 501] {
            assert!(retry_without_expand(status), "{status}");
        }
        for status in [200, 207, 301, 401, 404, 500, 503] {
            assert!(!retry_without_expand(status), "{status}");
        }
    }

    /// Las fechas sueltas tienen tope aunque antes haya un `EXDATE` roto: la
    /// lista no crece sin límite, y el primer motivo es el que queda.
    #[test]
    fn las_fechas_sueltas_tienen_tope_aunque_haya_un_error_antes() {
        let mut ical = String::from(
            "BEGIN:VEVENT\r\nUID:x\r\nDTSTART:20260105T100000Z\r\nRRULE:FREQ=DAILY\r\nEXDATE:ayer\r\n",
        );
        for day in 0..(MAX_DATES_PER_COMPONENT + 10) {
            ical.push_str(&format!(
                "EXDATE:2027{:02}{:02}T100000Z\r\n",
                day % 12 + 1,
                day % 28 + 1
            ));
        }
        ical.push_str("END:VEVENT\r\n");
        let component = &components_of(&ical)[0];
        assert!(component.exdates.len() <= MAX_DATES_PER_COMPONENT);
        assert_eq!(component.unreadable.len(), 1);
        assert!(component.unreadable[0].contains("ayer"));
    }
}
