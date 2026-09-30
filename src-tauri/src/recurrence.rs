//! Expandir los eventos que se repiten (RFC 5545 §3.8.5).
//!
//! ── Qué entra y qué sale ────────────────────────────────────────────────────
//!
//! Entran los `VEVENT` de un recurso de CalDAV ya leídos —[`Component`]—, y el
//! rango que se está mirando. Salen los eventos que caen en ese rango, uno por
//! instancia, listos para la ventana.
//!
//! Un recurso de CalDAV es **un `UID`**: el evento principal, con su `RRULE`,
//! sus `RDATE` y sus `EXDATE`, y al lado un `VEVENT` por cada instancia que se
//! cambió, con el mismo `UID` y un `RECURRENCE-ID` que dice cuál reemplaza.
//!
//! ── Cómo se expande ─────────────────────────────────────────────────────────
//!
//! **En hora de pared, no en UTC.** Una reunión de las 10 en Madrid sigue a las
//! 10 después del cambio de hora de octubre, aunque en UTC pase de las 8 a las
//! 9. Así que la regla se recorre sobre la hora local escrita en el `DTSTART`
//! —como si fuera UTC, que no tiene cambios de hora— y **cada instancia** se
//! pasa después a un instante con la zona del evento, con [`Zona::a_utc`]. Es
//! lo mismo que hace todo el mundo, y sirve igual para las cuatro formas de
//! zona que resuelve [`crate::zonas`]: IANA, desplazamiento fijo, las reglas de
//! un `VTIMEZONE` de Outlook y la hora flotante.
//!
//! El algoritmo de la regla es el de la biblioteca `rrule`, que implementa
//! la §3.8.5.3 entera con sus pruebas contra los ejemplos del RFC. Lo que se
//! hace acá es lo que la biblioteca no sabe o hace distinto:
//!
//! - **El `DTSTART` es siempre la primera instancia**, aunque la regla no lo
//!   genere, y cuenta para el `COUNT` (§3.8.5.3: «The "DTSTART" property value
//!   always counts as the first occurrence»). La biblioteca sigue la semántica
//!   de `python-dateutil`, que lo descarta.
//! - **`UNTIL` se interpreta acá**, porque su forma depende del `DTSTART`: en
//!   UTC cuando el evento tiene hora, y fecha cuando es de día completo.
//!   Mezclarlos es el error clásico, y como hay archivos que lo mezclan igual,
//!   se acepta con el criterio que menos sorprende —ver [`until_wall`]—.
//! - **`EXDATE`, `RDATE` y `RECURRENCE-ID`** se aplican acá, comparando
//!   instantes: un `EXDATE` en UTC quita la instancia de un evento escrito con
//!   `TZID`, que es como lo escriben varios clientes.
//! - **La regla se valida antes** con lo que pide el RFC: la biblioteca acepta
//!   cosas que el formato prohíbe —`BYMONTHDAY=0`, `BYDAY=-1MO` con
//!   `FREQ=WEEKLY`— y a cambio **inventa fechas**: la primera da el día 1 de
//!   cada mes, la segunda todos los días. Ver [`check_rule`].
//!
//! ── Lo que no se entiende se muestra una vez ────────────────────────────────
//!
//! Mostrar mal es peor que no mostrar: un calendario que pone una reunión el
//! día equivocado es peor que uno que no la pone. Así que ante una regla que
//! no se entiende, un `EXDATE` que no se puede leer o un `RANGE=THISANDFUTURE`,
//! el evento se muestra **una vez, el día que empieza**, marcado con
//! `shown_once`, y el motivo queda en [`Expansion::notes`] para el diario.
//! **Nunca se inventa una fecha.**
//!
//! ── Topes ───────────────────────────────────────────────────────────────────
//!
//! Una regla sin fin es normal —«todos los martes»— y una armada para trabar la
//! aplicación también existe: `FREQ=SECONDLY` desde 1970, o una regla
//! imposible (`BYMONTH=2;BYMONTHDAY=30`) que la biblioteca busca durante cien
//! mil años antes de rendirse. Por eso hay tres topes: de pasos por serie
//! ([`MAX_STEPS_PER_SERIES`]), de instancias por serie en el rango
//! ([`MAX_INSTANCES_PER_SERIES`]) y de tiempo para todo el recurso
//! ([`EXPANSION_BUDGET`]). Pasado cualquiera, lo que falta no se muestra y se
//! anota por qué.

use std::collections::{HashMap, HashSet};
use std::time::{Duration as StdDuration, Instant};

use chrono::{DateTime, Datelike, Duration, NaiveDate, NaiveDateTime, NaiveTime, TimeZone, Utc};
use rrule::{RRule, Tz, Unvalidated};

use crate::caldav::Event;
use crate::zonas::Zona;

/// Cuántas instancias de una serie se muestran en un rango.
///
/// Un mes con una reunión por hora, todos los días, son unas 700. Más que esto
/// es una regla armada para llenar la ventana, no una agenda.
pub const MAX_INSTANCES_PER_SERIES: usize = 1_000;

/// Cuántos pasos se le dan a la regla para llegar al final del rango.
///
/// Cuenta **todas** las instancias que genera, también las de antes del rango:
/// una regla diaria que empezó en 1990 llega a 2026 en trece mil pasos, y una
/// por hora de hace diez años, en noventa mil. `FREQ=SECONDLY` desde 1970 no
/// llega nunca, y eso es lo que corta.
pub const MAX_STEPS_PER_SERIES: usize = 100_000;

/// Cuántos eventos se devuelven, como mucho, por recurso y por rango.
///
/// Un servidor que expande lo hace con sus reglas, no con las de acá, así que
/// este tope es el que cubre también lo que llega ya expandido.
pub const MAX_EVENTS_PER_RANGE: usize = 5_000;

/// Cuánto tiempo se le da a la expansión de un recurso entero.
///
/// Una regla imposible hace que la biblioteca recorra cien mil periodos antes
/// de rendirse: 50 ms cada una en la versión optimizada. Mil reglas así en un
/// archivo son casi un minuto con la ventana esperando.
pub const EXPANSION_BUDGET: StdDuration = StdDuration::from_secs(2);

/// Cuántas fechas sueltas (`RDATE`, `EXDATE`) se leen de un evento.
pub const MAX_DATES_PER_COMPONENT: usize = 1_000;

/// Los años en los que se acepta un `DTSTART` que se repite.
///
/// Fuera de esto no hay agenda de nadie, y sí hay aritmética de fechas cerca
/// del borde del tipo. Con `panic = "abort"` un desborde ahí no es un error,
/// es la aplicación cerrándose.
const YEARS: std::ops::RangeInclusive<i32> = 1583..=9000;

/// Un momento tal como está escrito en el archivo, antes de resolverlo.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Moment {
    /// Todo el día: una fecha sin hora y, por eso, sin zona.
    Date(NaiveDate),
    /// Una hora de pared en una zona. `Zona::Utc` si venía con `Z`.
    Time { wall: NaiveDateTime, zone: Zona },
}

impl Moment {
    pub fn is_date(&self) -> bool {
        matches!(self, Moment::Date(_))
    }

    /// La hora de pared; la medianoche para una fecha.
    pub fn wall(&self) -> NaiveDateTime {
        match self {
            Moment::Date(day) => day.and_time(NaiveTime::MIN),
            Moment::Time { wall, .. } => *wall,
        }
    }

    /// El instante que le corresponde.
    ///
    /// Una fecha sale como la medianoche UTC de ese día, que es como la ventana
    /// entiende «todo el día» sin correrlo de día para quien esté en otra zona.
    pub fn to_utc(&self) -> Option<DateTime<Utc>> {
        match self {
            Moment::Date(day) => Some(Utc.from_utc_datetime(&day.and_time(NaiveTime::MIN))),
            Moment::Time { wall, zone } => zone.a_utc(*wall),
        }
    }

    /// El mismo tipo de momento, en otra hora de pared.
    fn at(&self, wall: NaiveDateTime) -> Moment {
        match self {
            Moment::Date(_) => Moment::Date(wall.date()),
            Moment::Time { zone, .. } => Moment::Time {
                wall,
                zone: zone.clone(),
            },
        }
    }
}

/// Cuánto dura un evento.
///
/// En dos partes porque el RFC las trata distinto: los días son **nominales**
/// —un día es «el mismo reloj, mañana», dure 23 o 25 horas por un cambio de
/// hora— y el resto es **exacto**. `DURATION:P1D` en una reunión de las 10 la
/// termina a las 10 del día siguiente, haya o no cambio de hora en el medio.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Length {
    pub days: i64,
    pub exact: Duration,
}

impl Length {
    pub const ZERO: Length = Length {
        days: 0,
        exact: Duration::zero(),
    };

    /// Lo más que puede ocupar, para saber desde dónde buscar instancias que
    /// empezaron antes del rango y todavía siguen.
    fn span(&self) -> Duration {
        Duration::days(self.days + 1) + self.exact
    }
}

/// Lee un `DURATION` (RFC 5545 §3.3.6): `P1W`, `P1D`, `PT1H30M`, `P1DT12H`.
///
/// Una duración negativa no le sirve a un evento —terminaría antes de
/// empezar— y se descarta. Y una de más de cien años también: no es una
/// agenda, y la cuenta de después desbordaría.
pub fn duration_of(value: &str) -> Option<Length> {
    let value = value.trim();
    let value = value.strip_prefix('+').unwrap_or(value);
    if value.starts_with('-') {
        return None;
    }
    let rest = value.strip_prefix(['P', 'p'])?;
    let (date_part, time_part) = match rest.split_once(['T', 't']) {
        Some((d, t)) => (d, Some(t)),
        None => (rest, None),
    };

    let mut days: i64 = 0;
    let mut seconds: i64 = 0;
    let mut any = false;

    let mut read = |part: &str, units: &[(char, i64, bool)]| -> Option<()> {
        let mut number = String::new();
        for c in part.chars() {
            if c.is_ascii_digit() {
                if number.len() >= 9 {
                    return None;
                }
                number.push(c);
                continue;
            }
            let (_, factor, is_days) = units
                .iter()
                .find(|(unit, _, _)| unit.eq_ignore_ascii_case(&c))?;
            let n: i64 = number.parse().ok()?;
            number.clear();
            any = true;
            if *is_days {
                days = days.checked_add(n.checked_mul(*factor)?)?;
            } else {
                seconds = seconds.checked_add(n.checked_mul(*factor)?)?;
            }
        }
        // Un número sin unidad al final no es una duración.
        number.is_empty().then_some(())
    };

    read(date_part, &[('W', 7, true), ('D', 1, true)])?;
    if let Some(time_part) = time_part {
        if time_part.is_empty() {
            return None;
        }
        read(
            time_part,
            &[('H', 3600, false), ('M', 60, false), ('S', 1, false)],
        )?;
    }
    if !any {
        return None;
    }

    const HUNDRED_YEARS_IN_DAYS: i64 = 36_525;
    if days > HUNDRED_YEARS_IN_DAYS || seconds / 86_400 > HUNDRED_YEARS_IN_DAYS {
        return None;
    }
    Some(Length {
        days,
        exact: Duration::seconds(seconds),
    })
}

/// Una fecha suelta que se agrega a la serie.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RDate {
    pub start: Moment,
    /// Con `VALUE=PERIOD` la fecha trae su propia duración; si no, dura lo
    /// que dura el evento.
    pub length: Option<Length>,
}

/// Un `VEVENT`, leído pero todavía sin expandir.
#[derive(Debug, Clone, Default)]
pub struct Component {
    pub uid: String,
    pub title: String,
    pub start: Option<Moment>,
    pub end: Option<Moment>,
    pub duration: Option<Length>,
    /// El `TZID` del `DTSTART`, tal como venía: es para mostrar.
    pub zone_name: String,
    /// Los valores de `RRULE`, sin interpretar. El RFC pide uno solo.
    pub rules: Vec<String>,
    pub rdates: Vec<RDate>,
    pub exdates: Vec<Moment>,
    pub recurrence_id: Option<Moment>,
    /// `RECURRENCE-ID;RANGE=THISANDFUTURE`: el cambio sigue en las próximas.
    pub this_and_future: bool,
    /// Trae un `RECURRENCE-ID` que no se entiende: es una instancia cambiada,
    /// pero no se sabe de cuál.
    pub unplaced_override: bool,
    /// `STATUS:CANCELLED`.
    pub cancelled: bool,
    /// Lo que no se pudo leer y cambia qué fechas tiene la serie: un
    /// `EXDATE` roto puede ser justo la reunión que se suspendió.
    pub unreadable: Vec<String>,
}

impl Component {
    fn is_series(&self) -> bool {
        !self.rules.is_empty() || !self.rdates.is_empty()
    }

    /// Cuánto dura: `DTEND`, o `DURATION`, o lo que dice el RFC sin ninguno
    /// de los dos —un día si es de día completo, nada si tiene hora—.
    ///
    /// Un fin anterior al comienzo no es una duración y cuenta como cero.
    fn length(&self) -> Length {
        let Some(start) = &self.start else {
            return Length::ZERO;
        };
        match (start, &self.end) {
            (Moment::Date(s), Some(Moment::Date(e))) => Length {
                days: (*e - *s).num_days().max(0),
                exact: Duration::zero(),
            },
            (Moment::Time { .. }, Some(end @ Moment::Time { .. })) => {
                match (start.to_utc(), end.to_utc()) {
                    (Some(s), Some(e)) if e > s => Length {
                        days: 0,
                        exact: e - s,
                    },
                    _ => Length::ZERO,
                }
            }
            _ => match (self.duration, start.is_date()) {
                (Some(length), _) => length,
                (None, true) => Length {
                    days: 1,
                    exact: Duration::zero(),
                },
                (None, false) => Length::ZERO,
            },
        }
    }
}

/// El rango que se está mirando: `[start, end)`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Window {
    pub start: DateTime<Utc>,
    pub end: DateTime<Utc>,
}

impl Window {
    /// Si un evento de `[start, end)` se ve en el rango. Uno que no dura nada
    /// se ve si empieza adentro.
    fn overlaps(&self, start: DateTime<Utc>, end: DateTime<Utc>) -> bool {
        if end > start {
            start < self.end && end > self.start
        } else {
            start >= self.start && start < self.end
        }
    }
}

/// Lo que salió de expandir, y lo que no se pudo y por qué.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Expansion {
    pub events: Vec<Event>,
    /// Para el diario: qué se mostró una vez en vez de expandirse, y por qué.
    pub notes: Vec<String>,
}

/// Expande los eventos de un recurso en un rango.
pub fn expand(components: Vec<Component>, window: &Window) -> Expansion {
    let deadline = Instant::now() + EXPANSION_BUDGET;
    let mut expansion = Expansion::default();

    // Por `UID`, en el orden en que llegaron. Un evento sin `UID` no puede
    // tener instancias cambiadas —no hay con qué emparejarlas— y va solo.
    let mut order: Vec<Option<String>> = Vec::new();
    let mut groups: HashMap<String, Vec<Component>> = HashMap::new();
    let mut loose: Vec<Component> = Vec::new();
    for component in components {
        if component.uid.is_empty() {
            order.push(None);
            loose.push(component);
            continue;
        }
        let group = groups.entry(component.uid.clone()).or_default();
        if group.is_empty() {
            order.push(Some(component.uid.clone()));
        }
        group.push(component);
    }

    let mut loose = loose.into_iter();
    for key in order {
        let group = match key {
            Some(uid) => groups.remove(&uid).unwrap_or_default(),
            None => loose.next().into_iter().collect(),
        };
        expand_group(group, window, deadline, &mut expansion);
    }

    if expansion.events.len() > MAX_EVENTS_PER_RANGE {
        expansion.notes.push(format!(
            "el recurso tiene {} eventos en el rango; se muestran los primeros {MAX_EVENTS_PER_RANGE}",
            expansion.events.len()
        ));
        expansion.events.truncate(MAX_EVENTS_PER_RANGE);
    }
    expansion
}

/// Cómo se compara una instancia con un `EXDATE` o un `RECURRENCE-ID`.
///
/// Por instante cuando las dos tienen hora, y por día cuando alguna es de día
/// completo. Un `EXDATE;VALUE=DATE` en una serie con hora está mal escrito
/// —el RFC pide el mismo tipo que el `DTSTART`—, y quitar la instancia de ese
/// día es lo único que puede haber querido decir.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum Key {
    Day(NaiveDate),
    Instant(i64),
}

fn key_of(moment: &Moment, series_is_date: bool) -> Option<Key> {
    match (moment, series_is_date) {
        (Moment::Date(day), _) => Some(Key::Day(*day)),
        (Moment::Time { wall, .. }, true) => Some(Key::Day(wall.date())),
        (Moment::Time { .. }, false) => moment.to_utc().map(|u| Key::Instant(u.timestamp())),
    }
}

/// Si una instancia está en un conjunto de claves: por su instante, o por su
/// día cuando la clave es de día.
fn is_in(keys: &HashSet<Key>, instance: &Moment, series_is_date: bool) -> bool {
    if keys.is_empty() {
        return false;
    }
    let by_day = keys.contains(&Key::Day(instance.wall().date()));
    by_day || key_of(instance, series_is_date).is_some_and(|k| keys.contains(&k))
}

fn expand_group(
    group: Vec<Component>,
    window: &Window,
    deadline: Instant,
    expansion: &mut Expansion,
) {
    let (masters, overrides): (Vec<Component>, Vec<Component>) = group
        .into_iter()
        .partition(|c| c.recurrence_id.is_none() && !c.unplaced_override);

    // Las instancias cambiadas se muestran siempre por su cuenta —son un dato
    // explícito, no una cuenta—, salvo las canceladas. Si no hay principal es
    // lo que devuelve un servidor que expandió: todas las instancias vienen
    // así, cada una con su `RECURRENCE-ID`.
    let emit_overrides = |expansion: &mut Expansion| {
        for instance in overrides.iter().filter(|c| !c.cancelled) {
            if let Some(start) = &instance.start {
                if let Some(event) = event_at(instance, start, instance.length(), true, false) {
                    if in_window(&event, window) {
                        expansion.events.push(event);
                    }
                }
            }
        }
    };

    let [master] = masters.as_slice() else {
        // Ninguno, o más de uno con el mismo `UID` sin `RECURRENCE-ID`, que es
        // un archivo mal armado: cada uno se muestra una vez, como antes.
        for master in &masters {
            if master.is_series() {
                expansion.notes.push(format!(
                    "{}: hay más de un evento principal con el mismo UID; se muestra una sola vez",
                    master.uid
                ));
            }
            push_single(master, master.is_series(), expansion);
        }
        emit_overrides(expansion);
        return;
    };

    if !master.is_series() {
        push_single(master, false, expansion);
        emit_overrides(expansion);
        return;
    }

    // La serie entera cancelada: no hay ninguna instancia que mostrar, ni las
    // cambiadas.
    if master.cancelled {
        return;
    }

    let series_is_date = master.start.as_ref().is_some_and(Moment::is_date);
    let override_keys: HashSet<Key> = overrides
        .iter()
        .filter_map(|c| c.recurrence_id.as_ref())
        .filter_map(|id| key_of(id, series_is_date))
        .collect();

    let this_and_future = overrides.iter().any(|c| c.this_and_future);
    let outcome = if this_and_future {
        Err("una instancia cambia «ésta y las siguientes» (RANGE=THISANDFUTURE)".to_string())
    } else {
        series_instances(master, window, deadline, &mut expansion.notes)
    };

    match outcome {
        Ok(instances) => {
            let exdates: HashSet<Key> = master
                .exdates
                .iter()
                .filter_map(|m| key_of(m, series_is_date))
                .collect();
            for (start, length) in instances {
                if is_in(&exdates, &start, series_is_date)
                    || is_in(&override_keys, &start, series_is_date)
                {
                    continue;
                }
                if let Some(event) = event_at(master, &start, length, true, false) {
                    if in_window(&event, window) {
                        expansion.events.push(event);
                    }
                }
            }
        }
        Err(reason) => {
            expansion.notes.push(format!(
                "{}: {reason}; se muestra una sola vez, el día que empieza",
                master.uid
            ));
            // Una vez, el día que empieza, salvo que ese mismo día esté
            // quitado o cambiado: ahí mostrarlo sería mostrar lo que se
            // canceló.
            let first_removed = master.start.as_ref().is_some_and(|start| {
                let exdates: HashSet<Key> = master
                    .exdates
                    .iter()
                    .filter_map(|m| key_of(m, series_is_date))
                    .collect();
                is_in(&exdates, start, series_is_date)
                    || is_in(&override_keys, start, series_is_date)
            });
            if !first_removed {
                push_single(master, true, expansion);
            }
        }
    }
    emit_overrides(expansion);
}

/// Un evento que no se expande: se muestra donde está, sin mirar el rango —el
/// servidor ya lo eligió por el rango—, como se hacía siempre.
///
/// `shown_once` es para una serie que no se pudo expandir, y por eso también
/// la marca como repetida: lo que se muestra una vez es siempre una serie.
fn push_single(component: &Component, shown_once: bool, expansion: &mut Expansion) {
    let Some(start) = &component.start else {
        return;
    };
    let recurring = shown_once;
    if let Some(event) = event_at(component, start, component.length(), recurring, shown_once) {
        expansion.events.push(event);
    }
}

fn in_window(event: &Event, window: &Window) -> bool {
    let parse = |s: &str| DateTime::parse_from_rfc3339(s).map(|d| d.with_timezone(&Utc));
    match (parse(&event.start), parse(&event.end)) {
        (Ok(start), Ok(end)) => window.overlaps(start, end),
        _ => false,
    }
}

/// Arma el evento de una instancia.
fn event_at(
    component: &Component,
    start: &Moment,
    length: Length,
    recurring: bool,
    shown_once: bool,
) -> Option<Event> {
    let start_utc = start.to_utc()?;
    let end_utc = match start {
        Moment::Date(day) => {
            let end_day = day.checked_add_signed(Duration::days(length.days))?;
            Utc.from_utc_datetime(&end_day.and_time(NaiveTime::MIN))
        }
        Moment::Time { wall, zone } => {
            // Los días en el reloj de la zona, y el resto exacto: ver
            // [`Length`].
            let base = if length.days != 0 {
                zone.a_utc(wall.checked_add_signed(Duration::days(length.days))?)?
            } else {
                start_utc
            };
            base.checked_add_signed(length.exact)?
        }
    };
    let all_day = start.is_date();
    Some(Event {
        uid: component.uid.clone(),
        // Un evento sin título existe: se muestra vacío y no se descarta,
        // porque ocupa lugar en el día de la persona igual.
        title: component.title.clone(),
        start: start_utc.to_rfc3339(),
        end: end_utc.to_rfc3339(),
        all_day,
        recurring,
        shown_once,
        // Un evento de día completo no tiene hora, así que no tiene zona,
        // aunque el archivo le haya puesto una.
        zone: if all_day {
            String::new()
        } else {
            component.zone_name.clone()
        },
    })
}

/// Las instancias de una serie que pueden caer en el rango, con lo que dura
/// cada una. Sin quitar todavía los `EXDATE` ni las cambiadas.
fn series_instances(
    master: &Component,
    window: &Window,
    deadline: Instant,
    notes: &mut Vec<String>,
) -> Result<Vec<(Moment, Length)>, String> {
    let start = master
        .start
        .as_ref()
        .ok_or_else(|| "no tiene DTSTART".to_string())?;
    if let Some(reason) = master.unreadable.first() {
        return Err(reason.clone());
    }
    if master.rules.len() > 1 {
        return Err(format!(
            "tiene {} RRULE y el RFC pide una sola",
            master.rules.len()
        ));
    }
    let year = start.wall().year();
    if !YEARS.contains(&year) {
        return Err(format!("empieza en el año {year}"));
    }

    let length = master.length();
    // La hora de pared puede estar hasta catorce horas corrida del UTC, así
    // que se busca con un día de margen para cada lado y después se mira el
    // rango de verdad con cada instancia ya resuelta.
    let low = window.start.naive_utc() - Duration::days(1) - length.span();
    let high = window.end.naive_utc() + Duration::days(1);

    let walls = match master.rules.first() {
        Some(rule) => rule_walls(rule, start, low, high, deadline, &master.uid, notes)?,
        // Sólo `RDATE`: el `DTSTART` es igual la primera instancia.
        None => {
            let wall = start.wall();
            if wall >= low && wall <= high {
                vec![wall]
            } else {
                Vec::new()
            }
        }
    };

    let series_is_date = start.is_date();
    let mut seen: HashSet<Key> = HashSet::new();
    let mut instances = Vec::with_capacity(walls.len() + master.rdates.len());
    for wall in walls {
        let moment = start.at(wall);
        if let Some(key) = key_of(&moment, series_is_date) {
            seen.insert(key);
        }
        instances.push((moment, length));
    }
    for rdate in &master.rdates {
        let Some(key) = key_of(&rdate.start, series_is_date) else {
            continue;
        };
        if seen.insert(key) {
            instances.push((rdate.start.clone(), rdate.length.unwrap_or(length)));
        }
    }
    Ok(instances)
}

/// Una regla que pasó por [`check_rule`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckedRule {
    /// La regla para la biblioteca: sin `UNTIL` —se resuelve acá— y sin las
    /// partes `X-`, que el RFC deja ignorar y la biblioteca rechaza.
    text: String,
    until: Option<String>,
    count: Option<u32>,
}

const FREQUENCIES: [&str; 7] = [
    "SECONDLY", "MINUTELY", "HOURLY", "DAILY", "WEEKLY", "MONTHLY", "YEARLY",
];
const PARTS: [&str; 14] = [
    "FREQ",
    "INTERVAL",
    "COUNT",
    "UNTIL",
    "BYSECOND",
    "BYMINUTE",
    "BYHOUR",
    "BYDAY",
    "BYMONTHDAY",
    "BYYEARDAY",
    "BYWEEKNO",
    "BYMONTH",
    "BYSETPOS",
    "WKST",
];

/// Revisa una regla con lo que pide el RFC, **antes** de dársela a la
/// biblioteca.
///
/// La biblioteca acepta cosas que el formato prohíbe y, con ellas, inventa
/// fechas —medido—: `BYMONTHDAY=0` da el día 1 de cada mes, `BYDAY=0MO` todos
/// los lunes, y `FREQ=WEEKLY;BYDAY=-1MO` **todos los días**. Lo que el RFC no
/// define no tiene una interpretación correcta, así que se rechaza y el evento
/// se muestra una vez.
pub fn check_rule(value: &str, all_day: bool) -> Result<CheckedRule, String> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut kept: Vec<String> = Vec::new();
    let mut freq: Option<String> = None;
    let mut until = None;
    let mut count = None;
    let mut by: HashMap<String, String> = HashMap::new();

    for part in value.split(';').map(str::trim).filter(|p| !p.is_empty()) {
        let (name, content) = part
            .split_once('=')
            .ok_or_else(|| format!("la parte «{part}» de la regla no tiene valor"))?;
        let name = name.trim().to_ascii_uppercase();
        let content = content.trim();
        if name.starts_with("X-") {
            continue;
        }
        if !PARTS.contains(&name.as_str()) {
            return Err(format!("la regla tiene una parte desconocida: {name}"));
        }
        if !seen.insert(name.clone()) {
            return Err(format!("la regla repite {name}"));
        }
        match name.as_str() {
            "FREQ" => {
                let upper = content.to_ascii_uppercase();
                if !FREQUENCIES.contains(&upper.as_str()) {
                    return Err(format!("FREQ={content} no existe"));
                }
                freq = Some(upper);
            }
            "INTERVAL" => {
                if !content.parse::<u16>().is_ok_and(|n| n >= 1) {
                    return Err(format!("INTERVAL={content} no es un entero positivo"));
                }
            }
            "COUNT" => {
                let n = content
                    .parse::<u32>()
                    .ok()
                    .filter(|n| *n >= 1)
                    .ok_or_else(|| format!("COUNT={content} no es un entero positivo"))?;
                count = Some(n);
            }
            "UNTIL" => {
                until = Some(content.to_string());
                continue;
            }
            n if n.starts_with("BY") => {
                by.insert(name.clone(), content.to_string());
            }
            _ => {}
        }
        kept.push(format!("{name}={content}"));
    }

    let freq = freq.ok_or_else(|| "la regla no tiene FREQ".to_string())?;
    if count.is_some() && until.is_some() {
        return Err("la regla tiene COUNT y UNTIL a la vez".into());
    }
    let sub_daily = matches!(freq.as_str(), "SECONDLY" | "MINUTELY" | "HOURLY");
    let has_time_parts = ["BYHOUR", "BYMINUTE", "BYSECOND"]
        .iter()
        .any(|p| by.contains_key(*p));
    if all_day && (sub_daily || has_time_parts) {
        return Err("un evento de día completo con una regla por horas".into());
    }

    let numbers = |list: &str| -> Result<Vec<i32>, String> {
        list.split(',')
            .map(|n| {
                n.trim()
                    .parse::<i32>()
                    .map_err(|_| format!("«{n}» no es un número"))
            })
            .collect()
    };
    if let Some(list) = by.get("BYMONTHDAY") {
        if freq == "WEEKLY" {
            return Err("BYMONTHDAY con FREQ=WEEKLY".into());
        }
        if numbers(list)?.contains(&0) {
            return Err("BYMONTHDAY=0 no es un día".into());
        }
    }
    if let Some(list) = by.get("BYYEARDAY") {
        if matches!(freq.as_str(), "DAILY" | "WEEKLY" | "MONTHLY") {
            return Err(format!("BYYEARDAY con FREQ={freq}"));
        }
        if numbers(list)?.contains(&0) {
            return Err("BYYEARDAY=0 no es un día".into());
        }
    }
    if let Some(list) = by.get("BYWEEKNO") {
        if freq != "YEARLY" {
            return Err(format!("BYWEEKNO con FREQ={freq}"));
        }
        if numbers(list)?.contains(&0) {
            return Err("BYWEEKNO=0 no es una semana".into());
        }
    }
    if let Some(list) = by.get("BYSETPOS") {
        if numbers(list)?.contains(&0) {
            return Err("BYSETPOS=0 no es una posición".into());
        }
        if !by.keys().any(|k| k != "BYSETPOS") {
            return Err("BYSETPOS sin otra parte BY que ordenar".into());
        }
    }
    if let Some(list) = by.get("BYDAY") {
        for item in list.split(',').map(str::trim) {
            let digits = item.trim_end_matches(|c: char| c.is_ascii_alphabetic());
            if digits.is_empty() {
                continue;
            }
            let ordinal: i32 = digits
                .parse()
                .map_err(|_| format!("BYDAY={item} no se entiende"))?;
            if ordinal == 0 || ordinal.abs() > 53 {
                return Err(format!("BYDAY={item} no es una posición"));
            }
            if !matches!(freq.as_str(), "MONTHLY" | "YEARLY") {
                return Err(format!("BYDAY={item} con posición y FREQ={freq}"));
            }
            if freq == "YEARLY" && by.contains_key("BYWEEKNO") {
                return Err(format!("BYDAY={item} con posición y BYWEEKNO"));
            }
        }
    }

    Ok(CheckedRule {
        text: kept.join(";"),
        until,
        count,
    })
}

/// La hora de pared, en la zona del `DTSTART`, hasta la que sigue la regla.
///
/// El RFC pide que `UNTIL` sea una fecha si el `DTSTART` lo es, y un instante
/// UTC si tiene hora. Cuando un archivo los mezcla se toma lo que menos
/// sorprende:
///
/// - fecha con `DTSTART` con hora: hasta el final de ese día, en la zona del
///   evento;
/// - instante con `DTSTART` de día completo: hasta ese día, en UTC;
/// - hora sin `Z` con `DTSTART` con hora: esa hora en la zona del evento.
///
/// `UNTIL` incluye: una instancia que cae justo ahí se muestra.
pub fn until_wall(value: &str, start: &Moment) -> Option<NaiveDateTime> {
    let value = value.trim();
    if value.len() == 8 {
        let day = NaiveDate::parse_from_str(value, "%Y%m%d").ok()?;
        return Some(match start {
            Moment::Date(_) => day.and_time(NaiveTime::MIN),
            Moment::Time { .. } => day.and_hms_opt(23, 59, 59)?,
        });
    }
    let local =
        NaiveDateTime::parse_from_str(value.strip_suffix('Z').unwrap_or(value), "%Y%m%dT%H%M%S")
            .ok()?;
    match start {
        Moment::Date(_) => Some(local.date().and_time(NaiveTime::MIN)),
        Moment::Time { zone, .. } if value.ends_with('Z') => {
            wall_of(zone, Utc.from_utc_datetime(&local))
        }
        Moment::Time { .. } => Some(local),
    }
}

/// La hora de pared que marca una zona en un instante.
///
/// [`Zona`] sólo sabe ir de la hora de pared al instante, así que se da la
/// vuelta por aproximación: el desplazamiento en la hora UTC, y después el de
/// la hora que eso da. Dos pasos alcanzan salvo dentro de la hora misma de un
/// cambio, que es la ambigüedad que ya describe [`Zona::a_utc`].
fn wall_of(zone: &Zona, instant: DateTime<Utc>) -> Option<NaiveDateTime> {
    let offset_at = |wall: NaiveDateTime| zone.a_utc(wall).map(|u| wall - u.naive_utc());
    let first = instant.naive_utc();
    let guess = first + offset_at(first)?;
    Some(first + offset_at(guess)?)
}

/// Recorre la regla y devuelve las horas de pared que caen entre `low` y
/// `high`.
fn rule_walls(
    rule: &str,
    start: &Moment,
    low: NaiveDateTime,
    high: NaiveDateTime,
    deadline: Instant,
    uid: &str,
    notes: &mut Vec<String>,
) -> Result<Vec<NaiveDateTime>, String> {
    let checked = check_rule(rule, start.is_date())?;
    let first_wall = start.wall();
    let until = match &checked.until {
        Some(text) => {
            Some(until_wall(text, start).ok_or_else(|| format!("UNTIL={text} no se entiende"))?)
        }
        None => None,
    };
    let in_range = |wall: NaiveDateTime| wall >= low && wall <= high;

    // Un `UNTIL` antes del comienzo deja sólo el `DTSTART`, que siempre es la
    // primera instancia. La biblioteca, en cambio, lo rechaza.
    if until.is_some_and(|u| u < first_wall) {
        return Ok(if in_range(first_wall) {
            vec![first_wall]
        } else {
            Vec::new()
        });
    }

    let build = |count: Option<u32>| -> Result<rrule::RRuleSet, String> {
        let mut parsed: RRule<Unvalidated> = checked
            .text
            .parse()
            .map_err(|e| format!("la biblioteca no acepta la regla: {e}"))?;
        if let Some(until) = until {
            parsed = parsed.until(Tz::UTC.from_utc_datetime(&until));
        }
        if let Some(count) = count {
            parsed = parsed.count(count);
        }
        parsed
            .build(Tz::UTC.from_utc_datetime(&first_wall))
            .map(rrule::RRuleSet::limit)
            .map_err(|e| format!("la biblioteca no acepta la regla: {e}"))
    };

    let set = build(checked.count)?;
    // El `DTSTART` es la primera instancia aunque la regla no lo genere, y
    // cuenta para el `COUNT`: si no lo genera, la regla da uno menos.
    let first_generated = set.clone().into_iter().next().map(|d| d.naive_utc());
    let start_is_extra = first_generated != Some(first_wall);
    let set = match (start_is_extra, checked.count) {
        (true, Some(1)) => None,
        (true, Some(n)) => Some(build(Some(n - 1))?),
        _ => Some(set),
    };

    let mut walls = Vec::new();
    if start_is_extra && in_range(first_wall) {
        walls.push(first_wall);
    }
    let Some(set) = set else {
        return Ok(walls);
    };

    for (step, date) in set.into_iter().enumerate() {
        if step >= MAX_STEPS_PER_SERIES {
            return Err(format!(
                "la regla genera más de {MAX_STEPS_PER_SERIES} repeticiones antes de llegar al rango"
            ));
        }
        if step % 64 == 0 && Instant::now() > deadline {
            return Err("se terminó el tiempo para expandir este recurso".into());
        }
        let wall = date.naive_utc();
        if wall > high {
            break;
        }
        if wall < low {
            continue;
        }
        if walls.len() >= MAX_INSTANCES_PER_SERIES {
            notes.push(format!(
                "{uid}: la regla tiene más de {MAX_INSTANCES_PER_SERIES} repeticiones en el rango; se muestran las primeras"
            ));
            break;
        }
        walls.push(wall);
    }
    Ok(walls)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::caldav::components_of;

    fn utc(y: i32, m: u32, d: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(y, m, d, 0, 0, 0).unwrap()
    }

    fn window(from: DateTime<Utc>, to: DateTime<Utc>) -> Window {
        Window {
            start: from,
            end: to,
        }
    }

    /// Un `VCALENDAR` con un solo `VEVENT` armado con estas líneas.
    fn ical(lines: &[&str]) -> String {
        let mut text = String::from("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:serie\r\n");
        for line in lines {
            text.push_str(line);
            text.push_str("\r\n");
        }
        text.push_str("END:VEVENT\r\nEND:VCALENDAR\r\n");
        text
    }

    fn expand_text(text: &str, range: Window) -> Expansion {
        expand(components_of(text), &range)
    }

    /// Los comienzos, en UTC y ordenados: lo que se compara casi siempre.
    fn starts(text: &str, range: Window) -> Vec<String> {
        let mut starts: Vec<String> = expand_text(text, range)
            .events
            .into_iter()
            .map(|e| e.start)
            .collect();
        starts.sort();
        starts
    }

    /// Las fechas de los comienzos en la hora de Nueva York, que es como las
    /// escribe el RFC en sus ejemplos.
    fn new_york_days(text: &str, range: Window) -> Vec<String> {
        let tz: chrono_tz::Tz = "America/New_York".parse().unwrap();
        starts(text, range)
            .iter()
            .map(|s| {
                DateTime::parse_from_rfc3339(s)
                    .unwrap()
                    .with_timezone(&tz)
                    .format("%Y-%m-%d %H:%M")
                    .to_string()
            })
            .collect()
    }

    const NY: &str = "DTSTART;TZID=America/New_York:";

    fn nineties() -> Window {
        window(utc(1996, 1, 1), utc(2010, 1, 1))
    }

    // ── Los ejemplos de la §3.8.5.3 ─────────────────────────────────────────

    #[test]
    fn rfc_diario_diez_veces() {
        let text = ical(&[&format!("{NY}19970902T090000"), "RRULE:FREQ=DAILY;COUNT=10"]);
        let days = new_york_days(&text, nineties());
        assert_eq!(days.len(), 10);
        assert_eq!(days[0], "1997-09-02 09:00");
        assert_eq!(days[9], "1997-09-11 09:00");
    }

    /// Diario hasta el 24 de diciembre: cruza el fin del horario de verano de
    /// Nueva York (26/10/1997) y **sigue a las 9**, aunque en UTC pase de las
    /// 13 a las 14.
    #[test]
    fn rfc_diario_hasta_una_fecha_cruzando_el_cambio_de_hora() {
        let text = ical(&[
            &format!("{NY}19970902T090000"),
            "RRULE:FREQ=DAILY;UNTIL=19971224T000000Z",
        ]);
        let days = new_york_days(&text, nineties());
        assert_eq!(days.len(), 113);
        assert!(days.iter().all(|d| d.ends_with("09:00")), "{days:?}");
        let raw = starts(&text, nineties());
        assert!(raw.contains(&"1997-10-25T13:00:00+00:00".to_string()));
        assert!(raw.contains(&"1997-10-27T14:00:00+00:00".to_string()));
        assert_eq!(days.last().unwrap(), "1997-12-23 09:00");
    }

    #[test]
    fn rfc_cada_diez_dias_cinco_veces() {
        let text = ical(&[
            &format!("{NY}19970902T090000"),
            "RRULE:FREQ=DAILY;INTERVAL=10;COUNT=5",
        ]);
        let days: Vec<String> = new_york_days(&text, nineties())
            .into_iter()
            .map(|d| d[..10].to_string())
            .collect();
        assert_eq!(
            days,
            [
                "1997-09-02",
                "1997-09-12",
                "1997-09-22",
                "1997-10-02",
                "1997-10-12"
            ]
        );
    }

    #[test]
    fn rfc_cada_dos_semanas_lunes_miercoles_y_viernes_con_wkst_domingo() {
        let text = ical(&[
            &format!("{NY}19970901T090000"),
            "RRULE:FREQ=WEEKLY;INTERVAL=2;UNTIL=19971224T000000Z;WKST=SU;BYDAY=MO,WE,FR",
        ]);
        let days: Vec<String> = new_york_days(&text, nineties())
            .into_iter()
            .map(|d| d[5..10].to_string())
            .collect();
        assert_eq!(
            days,
            [
                "09-01", "09-03", "09-05", "09-15", "09-17", "09-19", "09-29", "10-01", "10-03",
                "10-13", "10-15", "10-17", "10-27", "10-29", "10-31", "11-10", "11-12", "11-14",
                "11-24", "11-26", "11-28", "12-08", "12-10", "12-12", "12-22"
            ]
        );
    }

    /// El ejemplo con el que el RFC muestra que `WKST` cambia el resultado de
    /// un `INTERVAL` semanal.
    #[test]
    fn rfc_wkst_cambia_el_intervalo_semanal() {
        let with = |wkst: &str| {
            let text = ical(&[
                &format!("{NY}19970805T090000"),
                &format!("RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=4;BYDAY=TU,SU;WKST={wkst}"),
            ]);
            new_york_days(&text, nineties())
                .into_iter()
                .map(|d| d[5..10].to_string())
                .collect::<Vec<_>>()
        };
        assert_eq!(with("MO"), ["08-05", "08-10", "08-19", "08-24"]);
        assert_eq!(with("SU"), ["08-05", "08-17", "08-19", "08-31"]);
    }

    #[test]
    fn rfc_el_primer_viernes_de_cada_mes() {
        let text = ical(&[
            &format!("{NY}19970905T090000"),
            "RRULE:FREQ=MONTHLY;COUNT=10;BYDAY=1FR",
        ]);
        let days: Vec<String> = new_york_days(&text, nineties())
            .into_iter()
            .map(|d| d[..10].to_string())
            .collect();
        assert_eq!(
            days,
            [
                "1997-09-05",
                "1997-10-03",
                "1997-11-07",
                "1997-12-05",
                "1998-01-02",
                "1998-02-06",
                "1998-03-06",
                "1998-04-03",
                "1998-05-01",
                "1998-06-05"
            ]
        );
    }

    #[test]
    fn rfc_el_penultimo_lunes_de_cada_mes() {
        let text = ical(&[
            &format!("{NY}19970922T090000"),
            "RRULE:FREQ=MONTHLY;COUNT=6;BYDAY=-2MO",
        ]);
        let days: Vec<String> = new_york_days(&text, nineties())
            .into_iter()
            .map(|d| d[..10].to_string())
            .collect();
        assert_eq!(
            days,
            [
                "1997-09-22",
                "1997-10-20",
                "1997-11-17",
                "1997-12-22",
                "1998-01-19",
                "1998-02-16"
            ]
        );
    }

    #[test]
    fn rfc_el_antepenultimo_dia_del_mes() {
        let text = ical(&[
            &format!("{NY}19970928T090000"),
            "RRULE:FREQ=MONTHLY;COUNT=6;BYMONTHDAY=-3",
        ]);
        let days: Vec<String> = new_york_days(&text, nineties())
            .into_iter()
            .map(|d| d[..10].to_string())
            .collect();
        assert_eq!(
            days,
            [
                "1997-09-28",
                "1997-10-29",
                "1997-11-28",
                "1997-12-29",
                "1998-01-29",
                "1998-02-26"
            ]
        );
    }

    /// `BYSETPOS`: el último día hábil de cada mes.
    #[test]
    fn rfc_el_ultimo_dia_habil_del_mes() {
        let text = ical(&[
            &format!("{NY}19970930T090000"),
            "RRULE:FREQ=MONTHLY;COUNT=7;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1",
        ]);
        let days: Vec<String> = new_york_days(&text, nineties())
            .into_iter()
            .map(|d| d[..10].to_string())
            .collect();
        assert_eq!(
            days,
            [
                "1997-09-30",
                "1997-10-31",
                "1997-11-28",
                "1997-12-31",
                "1998-01-30",
                "1998-02-27",
                "1998-03-31"
            ]
        );
    }

    #[test]
    fn rfc_la_tercera_de_martes_miercoles_o_jueves() {
        let text = ical(&[
            &format!("{NY}19970904T090000"),
            "RRULE:FREQ=MONTHLY;COUNT=3;BYDAY=TU,WE,TH;BYSETPOS=3",
        ]);
        let days: Vec<String> = new_york_days(&text, nineties())
            .into_iter()
            .map(|d| d[..10].to_string())
            .collect();
        assert_eq!(days, ["1997-09-04", "1997-10-07", "1997-11-06"]);
    }

    #[test]
    fn rfc_junio_y_julio_de_cada_anio() {
        let text = ical(&[
            &format!("{NY}19970610T090000"),
            "RRULE:FREQ=YEARLY;COUNT=10;BYMONTH=6,7",
        ]);
        let days = new_york_days(&text, nineties());
        assert_eq!(days.len(), 10);
        assert_eq!(days[1], "1997-07-10 09:00");
        assert_eq!(days[9], "2001-07-10 09:00");
    }

    /// Todos los viernes 13, con el `EXDATE` que el RFC le pone al `DTSTART`
    /// —un martes 2, que si no se quitara sería la primera instancia—.
    #[test]
    fn rfc_los_viernes_trece_con_exdate_del_comienzo() {
        let text = ical(&[
            &format!("{NY}19970902T090000"),
            "EXDATE;TZID=America/New_York:19970902T090000",
            "RRULE:FREQ=MONTHLY;BYDAY=FR;BYMONTHDAY=13",
        ]);
        let days: Vec<String> = new_york_days(&text, window(utc(1997, 1, 1), utc(2001, 1, 1)))
            .into_iter()
            .map(|d| d[..10].to_string())
            .collect();
        assert_eq!(
            days,
            [
                "1998-02-13",
                "1998-03-13",
                "1998-11-13",
                "1999-08-13",
                "2000-10-13"
            ]
        );
    }

    #[test]
    fn rfc_el_dia_de_elecciones_en_estados_unidos() {
        let text = ical(&[
            &format!("{NY}19961105T090000"),
            "RRULE:FREQ=YEARLY;INTERVAL=4;BYMONTH=11;BYDAY=TU;BYMONTHDAY=2,3,4,5,6,7,8",
        ]);
        let days: Vec<String> = new_york_days(&text, window(utc(1996, 1, 1), utc(2005, 1, 1)))
            .into_iter()
            .map(|d| d[..10].to_string())
            .collect();
        assert_eq!(days, ["1996-11-05", "2000-11-07", "2004-11-02"]);
    }

    /// Un día que no existe **se omite**, no se corre: el 30 de febrero no
    /// pasa al 1 de marzo (ejemplo `BYMONTHDAY=15,30` del RFC).
    #[test]
    fn rfc_el_dia_que_no_existe_se_omite() {
        let text = ical(&[
            &format!("{NY}20070115T090000"),
            "RRULE:FREQ=MONTHLY;BYMONTHDAY=15,30;COUNT=5",
        ]);
        let days: Vec<String> = new_york_days(&text, window(utc(2007, 1, 1), utc(2008, 1, 1)))
            .into_iter()
            .map(|d| d[..10].to_string())
            .collect();
        assert_eq!(
            days,
            [
                "2007-01-15",
                "2007-01-30",
                "2007-02-15",
                "2007-03-15",
                "2007-03-30"
            ]
        );
    }

    // ── Los casos del issue ─────────────────────────────────────────────────

    #[test]
    fn el_31_de_cada_mes_salta_los_meses_de_30() {
        let text = ical(&["DTSTART:20260131T090000Z", "RRULE:FREQ=MONTHLY"]);
        let days: Vec<String> = starts(&text, window(utc(2026, 1, 1), utc(2027, 1, 1)))
            .into_iter()
            .map(|d| d[..10].to_string())
            .collect();
        assert_eq!(
            days,
            [
                "2026-01-31",
                "2026-03-31",
                "2026-05-31",
                "2026-07-31",
                "2026-08-31",
                "2026-10-31",
                "2026-12-31"
            ]
        );
    }

    #[test]
    fn el_29_de_febrero_salta_tres_de_cada_cuatro_anios() {
        let text = ical(&["DTSTART;VALUE=DATE:20240229", "RRULE:FREQ=YEARLY"]);
        let days: Vec<String> = starts(&text, window(utc(2024, 1, 1), utc(2033, 1, 1)))
            .into_iter()
            .map(|d| d[..10].to_string())
            .collect();
        assert_eq!(days, ["2024-02-29", "2028-02-29", "2032-02-29"]);
    }

    #[test]
    fn cada_dos_semanas_los_lunes_y_jueves() {
        let text = ical(&[
            "DTSTART:20260907T130000Z",
            "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH",
        ]);
        let days: Vec<String> = starts(&text, window(utc(2026, 9, 1), utc(2026, 10, 15)))
            .into_iter()
            .map(|d| d[..10].to_string())
            .collect();
        assert_eq!(
            days,
            [
                "2026-09-07",
                "2026-09-10",
                "2026-09-21",
                "2026-09-24",
                "2026-10-05",
                "2026-10-08"
            ]
        );
    }

    #[test]
    fn el_tercer_martes_y_el_ultimo_viernes() {
        let third = ical(&["DTSTART:20260901T130000Z", "RRULE:FREQ=MONTHLY;BYDAY=3TU"]);
        let days: Vec<String> = starts(&third, window(utc(2026, 9, 1), utc(2026, 12, 1)))
            .into_iter()
            .map(|d| d[..10].to_string())
            .collect();
        // El 1/9 es el `DTSTART`: siempre es la primera instancia.
        assert_eq!(
            days,
            ["2026-09-01", "2026-09-15", "2026-10-20", "2026-11-17"]
        );

        let last = ical(&["DTSTART:20260925T130000Z", "RRULE:FREQ=MONTHLY;BYDAY=-1FR"]);
        let days: Vec<String> = starts(&last, window(utc(2026, 9, 1), utc(2027, 1, 1)))
            .into_iter()
            .map(|d| d[..10].to_string())
            .collect();
        assert_eq!(
            days,
            ["2026-09-25", "2026-10-30", "2026-11-27", "2026-12-25"]
        );
    }

    /// El `DTSTART` es la primera instancia aunque la regla no lo genere, y
    /// cuenta para el `COUNT`: la biblioteca, sola, lo descartaba.
    #[test]
    fn el_comienzo_cuenta_aunque_la_regla_no_lo_genere() {
        // Un lunes, con una regla de martes.
        let text = ical(&[
            "DTSTART:20261005T100000Z",
            "RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=3",
        ]);
        let days: Vec<String> = starts(&text, window(utc(2026, 10, 1), utc(2026, 12, 1)))
            .into_iter()
            .map(|d| d[..10].to_string())
            .collect();
        assert_eq!(days, ["2026-10-05", "2026-10-06", "2026-10-13"]);

        let once = ical(&[
            "DTSTART:20261005T100000Z",
            "RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=1",
        ]);
        assert_eq!(
            starts(&once, window(utc(2026, 10, 1), utc(2026, 12, 1))),
            ["2026-10-05T10:00:00+00:00"]
        );
    }

    // ── Zonas y cambios de hora ─────────────────────────────────────────────

    /// **El caso de la cabecera.** Una reunión de las 10 en Madrid sigue a
    /// las 10 después del cambio de hora del 25 de octubre: en UTC pasa de las
    /// 8 a las 9. Expandir sobre UTC la dejaba a las 11.
    #[test]
    fn madrid_sigue_a_las_diez_despues_del_cambio_de_hora() {
        let text = ical(&[
            "DTSTART;TZID=Europe/Madrid:20261006T100000",
            "DTEND;TZID=Europe/Madrid:20261006T110000",
            "RRULE:FREQ=WEEKLY",
        ]);
        let events = expand_text(&text, window(utc(2026, 10, 15), utc(2026, 11, 5))).events;
        let pairs: Vec<(&str, &str)> = events
            .iter()
            .map(|e| (e.start.as_str(), e.end.as_str()))
            .collect();
        assert_eq!(
            pairs,
            [
                ("2026-10-20T08:00:00+00:00", "2026-10-20T09:00:00+00:00"),
                ("2026-10-27T09:00:00+00:00", "2026-10-27T10:00:00+00:00"),
                ("2026-11-03T09:00:00+00:00", "2026-11-03T10:00:00+00:00"),
            ]
        );
        assert!(events.iter().all(|e| e.zone == "Europe/Madrid"));
    }

    /// Y al adelantar la hora, en marzo: las 2:30 del 29/3 no existen en
    /// Madrid, y la instancia se corre a las 3:30, que es lo que hace un
    /// despertador —y lo que dice el RFC para una hora que no existe—.
    #[test]
    fn madrid_la_hora_que_no_existe_se_corre_hacia_adelante() {
        let text = ical(&[
            "DTSTART;TZID=Europe/Madrid:20260327T023000",
            "RRULE:FREQ=DAILY",
        ]);
        assert_eq!(
            starts(&text, window(utc(2026, 3, 27), utc(2026, 3, 31))),
            [
                "2026-03-27T01:30:00+00:00",
                "2026-03-28T01:30:00+00:00",
                // 3:30 CEST.
                "2026-03-29T01:30:00+00:00",
                "2026-03-30T00:30:00+00:00",
            ]
        );
    }

    /// Buenos Aires tuvo horario de verano por última vez en 2008-2009:
    /// adelantó el 19 de octubre de 2008. Una reunión de las 9 sigue a las 9.
    #[test]
    fn buenos_aires_sigue_a_las_nueve_con_el_horario_de_verano_de_2008() {
        let text = ical(&[
            "DTSTART;TZID=America/Argentina/Buenos_Aires:20081012T090000",
            "RRULE:FREQ=WEEKLY;COUNT=3",
        ]);
        assert_eq!(
            starts(&text, window(utc(2008, 10, 1), utc(2008, 11, 1))),
            [
                "2008-10-12T12:00:00+00:00",
                "2008-10-19T11:00:00+00:00",
                "2008-10-26T11:00:00+00:00",
            ]
        );
    }

    /// Y hoy no tiene cambios: las 9 son las 12 UTC todo el año.
    #[test]
    fn buenos_aires_hoy_no_cambia_en_todo_el_anio() {
        let text = ical(&[
            "DTSTART;TZID=America/Argentina/Buenos_Aires:20260105T090000",
            "RRULE:FREQ=WEEKLY",
        ]);
        let all = starts(&text, window(utc(2026, 1, 1), utc(2027, 1, 1)));
        assert_eq!(all.len(), 52);
        assert!(
            all.iter().all(|s| s.ends_with("T12:00:00+00:00")),
            "{all:?}"
        );
    }

    /// Un `UNTIL` en UTC corta en el instante justo aunque la zona haya
    /// cambiado de desplazamiento en el medio: la del 27/10 a las 10 de Madrid
    /// son las 9 UTC, y con `UNTIL` a las 9 UTC entra.
    #[test]
    fn until_en_utc_se_compara_en_la_zona_del_evento() {
        let text = ical(&[
            "DTSTART;TZID=Europe/Madrid:20261006T100000",
            "RRULE:FREQ=WEEKLY;UNTIL=20261027T090000Z",
        ]);
        let all = starts(&text, window(utc(2026, 10, 1), utc(2026, 12, 1)));
        assert_eq!(all.len(), 4);
        assert_eq!(all[3], "2026-10-27T09:00:00+00:00");

        let before = text.replace("UNTIL=20261027T090000Z", "UNTIL=20261027T085959Z");
        assert_eq!(
            starts(&before, window(utc(2026, 10, 1), utc(2026, 12, 1))).len(),
            3
        );
    }

    /// `DURATION:P1D` es nominal: termina a la misma hora del día siguiente,
    /// aunque ese día dure 25 horas por el cambio. `DTEND` es exacto.
    #[test]
    fn la_duracion_en_dias_es_nominal_y_la_de_dtend_exacta() {
        let nominal = ical(&[
            "DTSTART;TZID=Europe/Madrid:20261024T100000",
            "DURATION:P1D",
            "RRULE:FREQ=DAILY;COUNT=1",
        ]);
        let event = &expand_text(&nominal, window(utc(2026, 10, 1), utc(2026, 11, 1))).events[0];
        assert_eq!(event.start, "2026-10-24T08:00:00+00:00");
        assert_eq!(event.end, "2026-10-25T09:00:00+00:00");

        let exact = ical(&[
            "DTSTART;TZID=Europe/Madrid:20261024T100000",
            "DTEND;TZID=Europe/Madrid:20261025T100000",
            "RRULE:FREQ=WEEKLY;COUNT=2",
        ]);
        let events = expand_text(&exact, window(utc(2026, 10, 1), utc(2026, 11, 5))).events;
        // La primera dura 25 horas —cruza el cambio—, y cada instancia dura
        // exactamente eso.
        assert_eq!(events[1].start, "2026-10-31T09:00:00+00:00");
        assert_eq!(events[1].end, "2026-11-01T10:00:00+00:00");
    }

    /// Un `VTIMEZONE` de Outlook, con el `TZID` que no es de IANA: la regla
    /// se recorre en la hora de pared y cada instancia usa las reglas del
    /// archivo.
    #[test]
    fn un_vtimezone_de_outlook_cruza_el_cambio_de_hora() {
        let text = "BEGIN:VCALENDAR\r\n\
            BEGIN:VTIMEZONE\r\nTZID:Romance Standard Time\r\n\
            BEGIN:STANDARD\r\nDTSTART:16010101T030000\r\n\
            TZOFFSETFROM:+0200\r\nTZOFFSETTO:+0100\r\n\
            RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=10\r\nEND:STANDARD\r\n\
            BEGIN:DAYLIGHT\r\nDTSTART:16010101T020000\r\n\
            TZOFFSETFROM:+0100\r\nTZOFFSETTO:+0200\r\n\
            RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=3\r\nEND:DAYLIGHT\r\n\
            END:VTIMEZONE\r\n\
            BEGIN:VEVENT\r\nUID:o\r\n\
            DTSTART;TZID=Romance Standard Time:20261020T100000\r\n\
            RRULE:FREQ=WEEKLY;COUNT=2\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
        assert_eq!(
            starts(text, window(utc(2026, 10, 1), utc(2026, 11, 1))),
            ["2026-10-20T08:00:00+00:00", "2026-10-27T09:00:00+00:00"]
        );
    }

    // ── Día completo ────────────────────────────────────────────────────────

    #[test]
    fn un_cumpleanios_anual_de_dia_completo() {
        let text = ical(&[
            "DTSTART;VALUE=DATE:20201015",
            "DTEND;VALUE=DATE:20201016",
            "RRULE:FREQ=YEARLY",
        ]);
        let events = expand_text(&text, window(utc(2026, 10, 1), utc(2026, 11, 1))).events;
        assert_eq!(events.len(), 1);
        assert!(events[0].all_day && events[0].recurring);
        assert_eq!(events[0].start, "2026-10-15T00:00:00+00:00");
        assert_eq!(events[0].end, "2026-10-16T00:00:00+00:00");
        assert_eq!(events[0].zone, "");
    }

    /// `UNTIL` como fecha con un evento de día completo incluye ese día.
    #[test]
    fn until_fecha_en_dia_completo_incluye_el_dia() {
        let text = ical(&[
            "DTSTART;VALUE=DATE:20261001",
            "RRULE:FREQ=DAILY;UNTIL=20261003",
        ]);
        assert_eq!(
            starts(&text, window(utc(2026, 9, 1), utc(2026, 11, 1))).len(),
            3
        );
    }

    /// El error clásico: `UNTIL` como fecha con un `DTSTART` con hora. Se
    /// toma hasta el final de ese día en la zona del evento.
    #[test]
    fn until_fecha_con_hora_llega_hasta_el_final_del_dia() {
        let text = ical(&[
            "DTSTART;TZID=America/Argentina/Buenos_Aires:20261001T220000",
            "RRULE:FREQ=DAILY;UNTIL=20261003",
        ]);
        let all = starts(&text, window(utc(2026, 9, 1), utc(2026, 11, 1)));
        assert_eq!(all.len(), 3);
        // Las 22 del 3 en Buenos Aires son la 1 del 4 en UTC: entra igual.
        assert_eq!(all[2], "2026-10-04T01:00:00+00:00");
    }

    #[test]
    fn until_antes_del_comienzo_deja_solo_el_comienzo() {
        let text = ical(&[
            "DTSTART:20261010T100000Z",
            "RRULE:FREQ=DAILY;UNTIL=20261001T000000Z",
        ]);
        assert_eq!(
            starts(&text, window(utc(2026, 9, 1), utc(2026, 11, 1))),
            ["2026-10-10T10:00:00+00:00"]
        );
    }

    // ── EXDATE, RDATE y RECURRENCE-ID ───────────────────────────────────────

    /// Un `EXDATE` en UTC quita la instancia de una serie escrita con `TZID`:
    /// se comparan instantes, no textos.
    #[test]
    fn exdate_en_utc_quita_la_instancia_con_tzid() {
        let text = ical(&[
            "DTSTART;TZID=Europe/Madrid:20261006T100000",
            "RRULE:FREQ=WEEKLY;COUNT=4",
            "EXDATE:20261013T080000Z,20261027T090000Z",
        ]);
        let days: Vec<String> = starts(&text, window(utc(2026, 10, 1), utc(2026, 11, 1)))
            .into_iter()
            .map(|d| d[..10].to_string())
            .collect();
        assert_eq!(days, ["2026-10-06", "2026-10-20"]);
    }

    /// Un `EXDATE;VALUE=DATE` en una serie con hora está mal escrito, y lo
    /// único que puede querer decir es «ese día no».
    #[test]
    fn exdate_como_fecha_en_serie_con_hora_quita_ese_dia() {
        let text = ical(&[
            "DTSTART:20261005T100000Z",
            "RRULE:FREQ=DAILY;COUNT=3",
            "EXDATE;VALUE=DATE:20261006",
        ]);
        assert_eq!(
            starts(&text, window(utc(2026, 10, 1), utc(2026, 11, 1))),
            ["2026-10-05T10:00:00+00:00", "2026-10-07T10:00:00+00:00"]
        );
    }

    #[test]
    fn rdate_agrega_fechas_sueltas_y_periodos() {
        let text = ical(&[
            "DTSTART;TZID=Europe/Madrid:20261006T100000",
            "DTEND;TZID=Europe/Madrid:20261006T110000",
            "RRULE:FREQ=WEEKLY;COUNT=2",
            "RDATE;TZID=Europe/Madrid:20261008T160000",
            "RDATE;VALUE=PERIOD:20261009T120000Z/PT3H",
            // Repetida con una de la regla: no se muestra dos veces.
            "RDATE:20261013T080000Z",
        ]);
        let events = expand_text(&text, window(utc(2026, 10, 1), utc(2026, 11, 1))).events;
        let mut pairs: Vec<(String, String)> =
            events.into_iter().map(|e| (e.start, e.end)).collect();
        pairs.sort();
        assert_eq!(
            pairs,
            [
                (
                    "2026-10-06T08:00:00+00:00".into(),
                    "2026-10-06T09:00:00+00:00".into()
                ),
                (
                    "2026-10-08T14:00:00+00:00".into(),
                    "2026-10-08T15:00:00+00:00".into()
                ),
                (
                    "2026-10-09T12:00:00+00:00".into(),
                    "2026-10-09T15:00:00+00:00".into()
                ),
                (
                    "2026-10-13T08:00:00+00:00".into(),
                    "2026-10-13T09:00:00+00:00".into()
                ),
            ]
        );
    }

    /// Sólo `RDATE`, sin regla: el `DTSTART` es igual la primera.
    #[test]
    fn solo_rdate_tambien_es_una_serie() {
        let text = ical(&[
            "DTSTART;VALUE=DATE:20261001",
            "RDATE;VALUE=DATE:20261010,20261020",
        ]);
        let events = expand_text(&text, window(utc(2026, 9, 1), utc(2026, 11, 1))).events;
        assert_eq!(events.len(), 3);
        assert!(events.iter().all(|e| e.all_day && e.recurring));
    }

    const SERIES_WITH_OVERRIDES: &str = "BEGIN:VCALENDAR\r\n\
        BEGIN:VEVENT\r\nUID:s\r\nSUMMARY:Reunión\r\n\
        DTSTART;TZID=Europe/Madrid:20261006T100000\r\n\
        DTEND;TZID=Europe/Madrid:20261006T110000\r\n\
        RRULE:FREQ=WEEKLY\r\nEND:VEVENT\r\n\
        BEGIN:VEVENT\r\nUID:s\r\nSUMMARY:Reunión (movida)\r\n\
        RECURRENCE-ID;TZID=Europe/Madrid:20261013T100000\r\n\
        DTSTART;TZID=Europe/Madrid:20261014T120000\r\n\
        DTEND;TZID=Europe/Madrid:20261014T130000\r\nEND:VEVENT\r\n\
        BEGIN:VEVENT\r\nUID:s\r\nSUMMARY:Reunión\r\n\
        RECURRENCE-ID:20261020T080000Z\r\nSTATUS:CANCELLED\r\n\
        DTSTART;TZID=Europe/Madrid:20261020T100000\r\nEND:VEVENT\r\n\
        END:VCALENDAR\r\n";

    /// **Sin esto, la reunión que se movió aparece dos veces**: en el martes
    /// que calcula la regla y en el miércoles al que la movieron. Y la que se
    /// canceló no aparece, aunque la regla la genere.
    #[test]
    fn recurrence_id_reemplaza_la_instancia_y_la_cancelada_no_se_ve() {
        let events = expand_text(
            SERIES_WITH_OVERRIDES,
            window(utc(2026, 10, 1), utc(2026, 10, 31)),
        )
        .events;
        let mut seen: Vec<(String, String)> =
            events.into_iter().map(|e| (e.start, e.title)).collect();
        seen.sort();
        assert_eq!(
            seen,
            [
                ("2026-10-06T08:00:00+00:00".into(), "Reunión".into()),
                (
                    "2026-10-14T10:00:00+00:00".into(),
                    "Reunión (movida)".into()
                ),
                ("2026-10-27T09:00:00+00:00".into(), "Reunión".into()),
            ]
        );
    }

    /// Una instancia movida **fuera** del rango se va del rango; una movida
    /// **adentro** desde afuera, entra.
    #[test]
    fn la_instancia_movida_sigue_a_su_fecha_nueva() {
        // El rango es sólo el martes 13: la instancia de ese día se movió al 14.
        let only_13 = window(utc(2026, 10, 13), utc(2026, 10, 14));
        assert!(expand_text(SERIES_WITH_OVERRIDES, only_13)
            .events
            .is_empty());
        // Y el 14, que la regla no genera, la tiene.
        let only_14 = window(utc(2026, 10, 14), utc(2026, 10, 15));
        let events = expand_text(SERIES_WITH_OVERRIDES, only_14).events;
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].title, "Reunión (movida)");
    }

    /// La serie entera cancelada no deja nada, tampoco las cambiadas.
    #[test]
    fn la_serie_cancelada_no_se_ve() {
        let text = SERIES_WITH_OVERRIDES.replacen(
            "RRULE:FREQ=WEEKLY\r\n",
            "RRULE:FREQ=WEEKLY\r\nSTATUS:CANCELLED\r\n",
            1,
        );
        assert!(
            expand_text(&text, window(utc(2026, 10, 1), utc(2026, 10, 31)))
                .events
                .is_empty()
        );
    }

    // ── Lo que no se entiende se muestra una vez ────────────────────────────

    fn shown_once(text: &str) -> Expansion {
        let expansion = expand_text(text, window(utc(2026, 1, 1), utc(2027, 1, 1)));
        assert_eq!(expansion.events.len(), 1, "{:?}", expansion.events);
        assert!(expansion.events[0].shown_once && expansion.events[0].recurring);
        assert_eq!(expansion.notes.len(), 1, "{:?}", expansion.notes);
        expansion
    }

    /// La biblioteca acepta estas reglas y **inventa fechas** con ellas —el
    /// día 1 de cada mes, todos los lunes, todos los días—. El RFC no las
    /// define, así que no hay fecha correcta que dar.
    #[test]
    fn una_regla_que_el_rfc_no_define_se_muestra_una_vez() {
        for rule in [
            "FREQ=MONTHLY;BYMONTHDAY=0",
            "FREQ=MONTHLY;BYDAY=0MO",
            "FREQ=WEEKLY;BYDAY=-1MO",
            "FREQ=DAILY;INTERVAL=0",
            "FREQ=DAILY;COUNT=0",
            "FREQ=FORTNIGHTLY",
            "INTERVAL=2",
            "FREQ=DAILY;BYEASTER=0",
            "FREQ=DAILY;COUNT=3;UNTIL=20261231T000000Z",
            "FREQ=DAILY;FREQ=WEEKLY",
            "FREQ=MONTHLY;BYSETPOS=1",
            "FREQ=DAILY;UNTIL=mañana",
            "basura",
        ] {
            let text = ical(&["DTSTART:20260105T100000Z", &format!("RRULE:{rule}")]);
            let expansion = shown_once(&text);
            assert_eq!(
                expansion.events[0].start, "2026-01-05T10:00:00+00:00",
                "{rule}"
            );
        }
    }

    /// Las partes `X-` las deja ignorar el RFC; la biblioteca las rechaza.
    #[test]
    fn una_parte_x_se_ignora() {
        let text = ical(&[
            "DTSTART:20260105T100000Z",
            "RRULE:FREQ=DAILY;COUNT=3;X-NAME=algo",
        ]);
        assert_eq!(
            starts(&text, window(utc(2026, 1, 1), utc(2027, 1, 1))).len(),
            3
        );
    }

    #[test]
    fn un_exdate_ilegible_no_deja_expandir() {
        let text = ical(&[
            "DTSTART:20260105T100000Z",
            "RRULE:FREQ=DAILY;COUNT=3",
            "EXDATE:20260106T100000Z,ayer",
        ]);
        shown_once(&text);
    }

    #[test]
    fn this_and_future_se_muestra_una_vez_con_la_cambiada() {
        let text = "BEGIN:VCALENDAR\r\n\
            BEGIN:VEVENT\r\nUID:s\r\nDTSTART:20260105T100000Z\r\n\
            RRULE:FREQ=WEEKLY\r\nEND:VEVENT\r\n\
            BEGIN:VEVENT\r\nUID:s\r\nSUMMARY:Desde acá, a las 11\r\n\
            RECURRENCE-ID;RANGE=THISANDFUTURE:20260119T100000Z\r\n\
            DTSTART:20260119T110000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
        let expansion = expand_text(text, window(utc(2026, 1, 1), utc(2026, 3, 1)));
        let mut starts: Vec<&str> = expansion.events.iter().map(|e| e.start.as_str()).collect();
        starts.sort();
        assert_eq!(
            starts,
            ["2026-01-05T10:00:00+00:00", "2026-01-19T11:00:00+00:00"]
        );
        assert!(expansion.notes[0].contains("THISANDFUTURE"));
    }

    /// Si la serie no se entiende pero el `DTSTART` mismo está quitado, no se
    /// muestra: sería mostrar justo la que se canceló.
    #[test]
    fn la_que_se_muestra_una_vez_respeta_su_exdate() {
        let text = ical(&[
            "DTSTART:20260105T100000Z",
            "RRULE:FREQ=MONTHLY;BYMONTHDAY=0",
            "EXDATE:20260105T100000Z",
        ]);
        let expansion = expand_text(&text, window(utc(2026, 1, 1), utc(2027, 1, 1)));
        assert!(expansion.events.is_empty());
        assert_eq!(expansion.notes.len(), 1);
    }

    // ── Topes ───────────────────────────────────────────────────────────────

    /// Una regla sin fin, por minuto: el mes tiene 44 mil instancias y se
    /// muestran las primeras mil, con el motivo anotado.
    #[test]
    fn una_regla_sin_fin_tiene_tope_de_instancias() {
        let text = ical(&["DTSTART:20260901T000000Z", "RRULE:FREQ=MINUTELY"]);
        let expansion = expand_text(&text, window(utc(2026, 9, 1), utc(2026, 10, 1)));
        assert_eq!(expansion.events.len(), MAX_INSTANCES_PER_SERIES);
        assert!(expansion.notes[0].contains("repeticiones en el rango"));
    }

    /// Por segundo desde 1970 no llega nunca al rango: se corta por pasos y se
    /// muestra una vez, en vez de colgar la ventana.
    #[test]
    fn una_regla_que_no_llega_al_rango_se_corta() {
        let text = ical(&["DTSTART:19700101T000000Z", "RRULE:FREQ=SECONDLY"]);
        let started = Instant::now();
        let expansion = expand_text(&text, window(utc(2026, 9, 1), utc(2026, 10, 1)));
        assert!(started.elapsed() < StdDuration::from_secs(30));
        assert_eq!(expansion.events.len(), 1);
        assert!(expansion.events[0].shown_once);
        assert!(expansion.notes[0].contains("antes de llegar al rango"));
    }

    /// Una regla que nunca da una fecha —el 30 de febrero— termina, y sin
    /// inventar nada: queda sólo el `DTSTART`.
    #[test]
    fn una_regla_imposible_termina_sin_inventar() {
        let text = ical(&[
            "DTSTART:20260105T100000Z",
            "RRULE:FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30",
        ]);
        assert_eq!(
            starts(&text, window(utc(2026, 1, 1), utc(2030, 1, 1))),
            ["2026-01-05T10:00:00+00:00"]
        );
    }

    #[test]
    fn un_evento_de_dia_completo_por_horas_se_muestra_una_vez() {
        shown_once(&ical(&["DTSTART;VALUE=DATE:20260105", "RRULE:FREQ=HOURLY"]));
    }

    // ── Lo que ya venía expandido ───────────────────────────────────────────

    /// Un servidor que expandió manda cada instancia sola, con su
    /// `RECURRENCE-ID` y sin principal: se muestran como vienen, marcadas, y
    /// la cancelada no.
    #[test]
    fn las_instancias_expandidas_por_el_servidor_se_muestran_como_vienen() {
        let text = "BEGIN:VCALENDAR\r\n\
            BEGIN:VEVENT\r\nUID:s\r\nRECURRENCE-ID:20261006T080000Z\r\n\
            DTSTART:20261006T080000Z\r\nDTEND:20261006T090000Z\r\nEND:VEVENT\r\n\
            BEGIN:VEVENT\r\nUID:s\r\nRECURRENCE-ID:20261013T080000Z\r\nSTATUS:CANCELLED\r\n\
            DTSTART:20261013T080000Z\r\nDTEND:20261013T090000Z\r\nEND:VEVENT\r\n\
            END:VCALENDAR\r\n";
        let events = expand_text(text, window(utc(2026, 10, 1), utc(2026, 11, 1))).events;
        assert_eq!(events.len(), 1);
        assert!(events[0].recurring && !events[0].shown_once);
        assert_eq!(events[0].end, "2026-10-06T09:00:00+00:00");
    }

    // ── Piezas sueltas ──────────────────────────────────────────────────────

    #[test]
    fn las_duraciones_se_leen() {
        let exact = |s: i64| Duration::seconds(s);
        assert_eq!(
            duration_of("PT1H30M"),
            Some(Length {
                days: 0,
                exact: exact(5400)
            })
        );
        assert_eq!(
            duration_of("P1W"),
            Some(Length {
                days: 7,
                exact: exact(0)
            })
        );
        assert_eq!(
            duration_of("P1DT12H"),
            Some(Length {
                days: 1,
                exact: exact(43200)
            })
        );
        assert_eq!(
            duration_of("+PT15S"),
            Some(Length {
                days: 0,
                exact: exact(15)
            })
        );
        for broken in [
            "",
            "P",
            "PT",
            "-PT1H",
            "1H",
            "P1",
            "PT1X",
            "P99999999999D",
            "P40000D",
        ] {
            assert_eq!(duration_of(broken), None, "{broken:?}");
        }
    }

    #[test]
    fn una_regla_valida_pasa_la_revision_sin_until_ni_x() {
        let checked = check_rule(
            "FREQ=WEEKLY;UNTIL=20261231T000000Z;X-A=1;BYDAY=MO,TH",
            false,
        )
        .unwrap();
        assert_eq!(checked.text, "FREQ=WEEKLY;BYDAY=MO,TH");
        assert_eq!(checked.until.as_deref(), Some("20261231T000000Z"));
        assert!(check_rule("freq=monthly;byday=-1fr", false).is_ok());
    }
}
