//! Resolver la zona horaria de una fecha de iCalendar.
//!
//! ── Por qué esto existe ─────────────────────────────────────────────────────
//!
//! Una fecha de iCalendar puede venir de tres formas, y sólo una es un instante
//! sin ambigüedad:
//!
//! - `20260915T140000Z` — UTC. Sin vueltas.
//! - `20260915T140000` con `TZID=America/Argentina/Buenos Aires` — las dos de la
//!   tarde **de esa zona**. Para saber qué instante es hay que saber cuánto
//!   estaba corriendo esa zona ese día, que depende del horario de verano.
//! - `20260915T140000` a secas — hora local flotante (RFC 5545 §3.3.5): «las dos
//!   de donde estés». Un despertador, no una reunión.
//!
//! Antes las tres se trataban como UTC. Para la primera está bien; para las
//! otras dos quería decir que un evento de las 14:00 en Buenos Aires se mostraba
//! a las 11:00, y nadie tenía forma de darse cuenta de que la hora estaba mal.
//!
//! ── De dónde sale la zona ───────────────────────────────────────────────────
//!
//! De cuatro lugares, en este orden, porque no todos los clientes escriben lo
//! mismo:
//!
//! 1. **El `TZID` es un nombre de IANA** (`Europe/Madrid`). Es lo que escriben
//!    Nextcloud, Google, Apple y Evolution, o sea la enorme mayoría. Se resuelve
//!    con la base de datos de zonas y queda exacto, horario de verano incluido.
//! 2. **El `VTIMEZONE` del archivo trae `X-LIC-LOCATION`** con el nombre de
//!    IANA adentro. Es lo que hace libical cuando el `TZID` es un nombre propio.
//! 3. **El `VTIMEZONE` define una sola observancia**: una zona sin horario de
//!    verano. Su `TZOFFSETTO` es el desplazamiento, y es exacto.
//! 4. **El `VTIMEZONE` define las transiciones con reglas anuales**. Es lo que
//!    escribe Outlook, que pone `TZID:Romance Standard Time` —que no es un
//!    nombre de IANA y nunca lo va a ser— y a cambio manda las reglas completas.
//!    Se interpretan acá.
//!
//! Si no se puede con ninguna, se usa el desplazamiento de la observancia
//! estándar. Quedar corrido una hora la mitad del año es mucho mejor que quedar
//! corrido el desplazamiento entero todo el año, que es lo que pasaba antes.
//!
//! ── Qué sigue sin estar bien ────────────────────────────────────────────────
//!
//! **La hora que no existe y la que pasa dos veces.** Cuando adelanta el reloj
//! hay una hora local que no ocurre, y cuando atrasa hay una que ocurre dos
//! veces. Un evento escrito ahí adentro es ambiguo en el formato mismo, no acá.
//! Se elige la primera de las dos y se corre hacia adelante la que no existe;
//! está en [`a_utc`] con más detalle.
//!
//! **`RDATE` en un `VTIMEZONE`.** Algunas zonas históricas listan sus
//! transiciones una por una en vez de con una regla. No se leen: esas zonas caen
//! al respaldo de la observancia estándar. Es raro y sólo afecta a fechas
//! viejas.

use std::collections::HashMap;

use chrono::{
    DateTime, Datelike, Duration, FixedOffset, LocalResult, NaiveDate, NaiveDateTime, NaiveTime,
    Offset, TimeZone, Utc, Weekday,
};
use chrono_tz::Tz;

use crate::caldav::{partir_linea, unir_lineas};

/// Tope de `VTIMEZONE` que se leen de un archivo.
///
/// Un calendario real tiene una zona, o unas pocas. Doscientas es un archivo
/// armado para hacer trabajar al programa.
const MAX_ZONAS: usize = 200;

/// Tope de observancias dentro de una zona.
///
/// Dos es lo normal —estándar y verano—; una zona con historia puede tener
/// algunas más.
const MAX_OBSERVANCIAS: usize = 64;

/// Cómo se convierte una hora local a un instante.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Zona {
    /// La fecha ya venía en UTC.
    Utc,
    /// Una zona con nombre, de la base de datos de IANA.
    Iana(Tz),
    /// Un desplazamiento fijo: una zona sin horario de verano.
    Fija(FixedOffset),
    /// Las reglas de transición que venían en el `VTIMEZONE` del archivo.
    Reglas(Reglas),
    /// Hora local flotante: la zona de quien esté mirando.
    Flotante,
}

impl Zona {
    /// Pasa una hora local de esta zona al instante que le corresponde.
    ///
    /// ── Las dos horas raras del año ─────────────────────────────────────────
    ///
    /// Cuando el reloj adelanta, una hora local **no existe**: si el salto es a
    /// las 2 y va a las 3, las 2:30 no ocurren. Y cuando atrasa, una hora local
    /// **ocurre dos veces**.
    ///
    /// Un evento escrito ahí adentro es ambiguo en el archivo, no acá: el
    /// formato no da forma de distinguirlas. Se hace lo mismo que hace todo el
    /// mundo, y se elige así porque es lo que menos sorprende:
    ///
    /// - La que ocurre dos veces se toma como **la primera**, que es la que la
    ///   persona quiso decir si escribió el evento antes del cambio.
    /// - La que no existe se corre **hacia adelante** hasta la hora que sí
    ///   existe, que es lo que hace un despertador. Devolver «no se pudo» en
    ///   cambio haría desaparecer el evento del mes, que es peor.
    pub fn a_utc(&self, local: NaiveDateTime) -> Option<DateTime<Utc>> {
        match self {
            Zona::Utc => Some(Utc.from_utc_datetime(&local)),
            Zona::Iana(tz) => con_tolerancia(local, |momento| tz.from_local_datetime(momento)),
            Zona::Fija(desplazamiento) => Some(Utc.from_utc_datetime(&(local - *desplazamiento))),
            Zona::Reglas(reglas) => {
                let desplazamiento = reglas.desplazamiento_en(local);
                Some(Utc.from_utc_datetime(&(local - desplazamiento)))
            }
            Zona::Flotante => con_tolerancia(local, |momento| {
                chrono::Local.from_local_datetime(momento)
            }),
        }
    }
}

/// Resuelve una hora local aguantando las dos horas raras del año.
///
/// Ver la explicación en [`Zona::a_utc`]. Lo único que tiene truco es la hora
/// que **no existe**: para correrla hay que saber cuánto saltó el reloj, y eso
/// se averigua mirando qué desplazamiento corría el día anterior y cuál el día
/// siguiente. La diferencia es el salto.
///
/// Se hace así y no probando de a una hora porque el salto no siempre es de una
/// hora —Lord Howe salta media— y porque correr el evento el tamaño exacto del
/// salto le conserva los minutos: una reunión de las 2:30 pasa a ser de las
/// 3:30, no de las 3 en punto.
fn con_tolerancia<Z, F>(local: NaiveDateTime, resolver: F) -> Option<DateTime<Utc>>
where
    Z: TimeZone,
    F: Fn(&NaiveDateTime) -> LocalResult<DateTime<Z>>,
{
    // `earliest()` es la primera de las dos cuando la hora ocurre dos veces, y
    // la única cuando ocurre una sola.
    if let Some(momento) = resolver(&local).earliest() {
        return Some(momento.with_timezone(&Utc));
    }

    let un_dia = Duration::days(1);
    let antes = resolver(&(local - un_dia)).earliest()?.offset().fix().local_minus_utc();
    let despues = resolver(&(local + un_dia)).earliest()?.offset().fix().local_minus_utc();
    let salto = Duration::seconds((despues - antes).into());

    // Un salto que no es hacia adelante no explica el agujero. No se insiste:
    // devolver algo inventado sería peor que no mostrar la hora.
    if salto <= Duration::zero() {
        return None;
    }
    resolver(&(local + salto))
        .earliest()
        .map(|momento| momento.with_timezone(&Utc))
}

/// Las reglas de transición de un `VTIMEZONE`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reglas {
    observancias: Vec<Observancia>,
}

impl Reglas {
    /// Qué desplazamiento corría en esta zona a esa hora local.
    ///
    /// ── Cómo se compara ─────────────────────────────────────────────────────
    ///
    /// Cada transición se expresa en el reloj de pared **anterior** al cambio,
    /// que es como la define el formato. Se arman las transiciones de tres años
    /// —el anterior, el de la fecha y el siguiente, porque en el hemisferio sur
    /// el verano cruza el año— y se busca la última que ya pasó.
    ///
    /// Dentro de la hora del cambio esto puede errar por una hora, que es la
    /// misma ambigüedad que describe [`Zona::a_utc`] y que no tiene respuesta
    /// mejor.
    fn desplazamiento_en(&self, local: NaiveDateTime) -> FixedOffset {
        let mut transiciones: Vec<(NaiveDateTime, FixedOffset, FixedOffset)> = Vec::new();
        for observancia in &self.observancias {
            for anio in [local.year() - 1, local.year(), local.year() + 1] {
                if let Some(cuando) = observancia.transicion_en(anio) {
                    transiciones.push((cuando, observancia.desde, observancia.hasta));
                }
            }
        }
        transiciones.sort_by_key(|(cuando, _, _)| *cuando);

        match transiciones.iter().rev().find(|(cuando, _, _)| *cuando <= local) {
            Some((_, _, hasta)) => *hasta,
            // Antes de la primera transición conocida corría lo que esa
            // transición dejó atrás.
            None => match transiciones.first() {
                Some((_, desde, _)) => *desde,
                None => self.estandar(),
            },
        }
    }

    /// El respaldo: el desplazamiento de la observancia estándar.
    ///
    /// Se usa cuando ninguna observancia tiene una regla que se pueda calcular
    /// —una zona definida sólo con `RDATE`, por ejemplo—. Quedar corrido una
    /// hora los meses de verano es mucho mejor que quedar corrido el
    /// desplazamiento entero todo el año.
    fn estandar(&self) -> FixedOffset {
        self.observancias
            .iter()
            .find(|o| !o.es_verano)
            .or_else(|| self.observancias.first())
            .map(|o| o.hasta)
            .unwrap_or_else(|| FixedOffset::east_opt(0).expect("cero es un desplazamiento válido"))
    }
}

/// Una observancia de un `VTIMEZONE`: el `STANDARD` o el `DAYLIGHT`.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Observancia {
    es_verano: bool,
    /// `TZOFFSETFROM`: lo que corría antes de esta transición.
    desde: FixedOffset,
    /// `TZOFFSETTO`: lo que corre después.
    hasta: FixedOffset,
    /// Desde cuándo vale, y a qué hora del día cae la transición.
    comienzo: NaiveDateTime,
    /// La regla anual, si se pudo entender.
    regla: Option<ReglaAnual>,
}

impl Observancia {
    /// Cuándo cae esta transición en un año, en el reloj de pared anterior al
    /// cambio.
    fn transicion_en(&self, anio: i32) -> Option<NaiveDateTime> {
        match &self.regla {
            Some(regla) => regla.fecha_en(anio).map(|dia| dia.and_time(self.comienzo.time())),
            // Sin regla la observancia vale desde su `DTSTART` y no se repite.
            // Sirve igual: una zona de desplazamiento fijo entra por acá.
            None => (self.comienzo.year() == anio).then_some(self.comienzo),
        }
    }
}

/// Una regla anual de transición, que es lo único que aparece en un
/// `VTIMEZONE` real.
#[derive(Debug, Clone, PartialEq, Eq)]
enum ReglaAnual {
    /// «El último domingo de octubre»: `FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU`.
    DiaDeSemana { mes: u32, ordinal: i32, dia: Weekday },
    /// «El 1 de enero»: `FREQ=YEARLY;BYMONTH=1;BYMONTHDAY=1`.
    DiaDelMes { mes: u32, dia: u32 },
}

impl ReglaAnual {
    fn fecha_en(&self, anio: i32) -> Option<NaiveDate> {
        match self {
            ReglaAnual::DiaDelMes { mes, dia } => NaiveDate::from_ymd_opt(anio, *mes, *dia),
            ReglaAnual::DiaDeSemana { mes, ordinal, dia } => {
                dia_de_semana_del_mes(anio, *mes, *ordinal, *dia)
            }
        }
    }
}

/// El *n*-ésimo día de semana de un mes, contando desde el final si *n* es
/// negativo.
///
/// `(-1, domingo)` es «el último domingo», que es como se escribe casi todo
/// cambio de horario del mundo. `(1, domingo)` es el primero.
///
/// Devuelve `None` si ese día no existe —«el quinto domingo» de un mes que tiene
/// cuatro—, en vez de correrlo al mes siguiente.
fn dia_de_semana_del_mes(anio: i32, mes: u32, ordinal: i32, dia: Weekday) -> Option<NaiveDate> {
    if ordinal == 0 {
        return None;
    }

    if ordinal > 0 {
        let primero = NaiveDate::from_ymd_opt(anio, mes, 1)?;
        let saltar = (7 + dia.num_days_from_monday() as i64
            - primero.weekday().num_days_from_monday() as i64)
            % 7;
        let fecha = primero + Duration::days(saltar + (ordinal as i64 - 1) * 7);
        return (fecha.month() == mes).then_some(fecha);
    }

    let ultimo = ultimo_dia_del_mes(anio, mes)?;
    let retroceder =
        (7 + ultimo.weekday().num_days_from_monday() as i64 - dia.num_days_from_monday() as i64) % 7;
    let fecha = ultimo - Duration::days(retroceder + (-ordinal as i64 - 1) * 7);
    (fecha.month() == mes).then_some(fecha)
}

fn ultimo_dia_del_mes(anio: i32, mes: u32) -> Option<NaiveDate> {
    let (anio_siguiente, mes_siguiente) = if mes == 12 { (anio + 1, 1) } else { (anio, mes + 1) };
    Some(NaiveDate::from_ymd_opt(anio_siguiente, mes_siguiente, 1)? - Duration::days(1))
}

// ---------------------------------------------------------------------------
// Leer los VTIMEZONE del archivo
// ---------------------------------------------------------------------------

/// Las zonas que definía un archivo de iCalendar, por `TZID`.
///
/// Se arma una vez por archivo y se consulta por cada fecha. Vacía es válida y
/// es el caso normal: un `TZID` que sea nombre de IANA no necesita nada de acá.
#[derive(Debug, Clone, Default)]
pub struct Zonas(HashMap<String, Zona>);

impl Zonas {
    /// Cómo se resuelve una fecha con este `TZID`.
    ///
    /// El orden está explicado arriba, en la cabecera del módulo. Un `TZID` que
    /// no se pueda resolver de ninguna forma cae en [`Zona::Flotante`]: mostrar
    /// el evento a la hora local de quien mira es lo más parecido a lo que
    /// quiso decir quien lo escribió, y no lo corre a otro día.
    pub fn resolver(&self, tzid: &str) -> Zona {
        let tzid = sin_comillas(tzid.trim());
        if tzid.is_empty() {
            return Zona::Flotante;
        }

        if let Ok(tz) = tzid.parse::<Tz>() {
            return Zona::Iana(tz);
        }
        match self.0.get(tzid) {
            Some(zona) => zona.clone(),
            None => Zona::Flotante,
        }
    }
}

/// Lee los `VTIMEZONE` de un iCalendar.
///
/// En una pasada aparte de la de los eventos, y no en la misma, porque un
/// `VTIMEZONE` puede venir **después** del evento que lo usa: el formato no fija
/// el orden y hay servidores que los ponen al final.
pub fn tabla_de(ical: &str) -> Zonas {
    let mut zonas: HashMap<String, Zona> = HashMap::new();

    let mut tzid: Option<String> = None;
    let mut ubicacion: Option<String> = None;
    let mut observancias: Vec<Observancia> = Vec::new();
    let mut abierta = false;
    let mut dentro: Option<ObservanciaCruda> = None;

    for linea in unir_lineas(ical) {
        let Some((nombre, _, valor)) = partir_linea(&linea) else {
            continue;
        };
        let valor = valor.trim();

        match (nombre.as_str(), valor.to_ascii_uppercase().as_str()) {
            ("BEGIN", "VTIMEZONE") => {
                abierta = true;
                tzid = None;
                ubicacion = None;
                observancias.clear();
                dentro = None;
                continue;
            }
            ("END", "VTIMEZONE") if abierta => {
                abierta = false;
                if zonas.len() >= MAX_ZONAS {
                    continue;
                }
                if let Some(id) = tzid.take() {
                    if let Some(zona) = armar(&id, ubicacion.take(), std::mem::take(&mut observancias))
                    {
                        zonas.insert(id, zona);
                    }
                }
                continue;
            }
            ("BEGIN", "STANDARD") | ("BEGIN", "DAYLIGHT") if abierta => {
                dentro = Some(ObservanciaCruda {
                    es_verano: valor.eq_ignore_ascii_case("DAYLIGHT"),
                    ..Default::default()
                });
                continue;
            }
            ("END", "STANDARD") | ("END", "DAYLIGHT") if abierta => {
                if let Some(cruda) = dentro.take() {
                    if observancias.len() < MAX_OBSERVANCIAS {
                        if let Some(observancia) = cruda.terminar() {
                            observancias.push(observancia);
                        }
                    }
                }
                continue;
            }
            _ => {}
        }

        if !abierta {
            continue;
        }

        match dentro.as_mut() {
            // Dentro de un STANDARD o un DAYLIGHT.
            Some(cruda) => match nombre.as_str() {
                "TZOFFSETFROM" => cruda.desde = desplazamiento_de(valor),
                "TZOFFSETTO" => cruda.hasta = desplazamiento_de(valor),
                "DTSTART" => cruda.comienzo = momento_local_de(valor),
                "RRULE" => cruda.regla = regla_de(valor),
                _ => {}
            },
            // Directamente dentro del VTIMEZONE.
            None => match nombre.as_str() {
                "TZID" => tzid = Some(sin_comillas(valor).to_string()),
                // Lo que escribe libical cuando el `TZID` no es de IANA: el
                // nombre de IANA de verdad, adentro.
                "X-LIC-LOCATION" => ubicacion = Some(valor.to_string()),
                _ => {}
            },
        }
    }

    Zonas(zonas)
}

/// Decide con qué se resuelve una zona, con los cuatro caminos de la cabecera.
fn armar(tzid: &str, ubicacion: Option<String>, observancias: Vec<Observancia>) -> Option<Zona> {
    // El `TZID` mismo, por si el archivo define una zona que además tiene nombre
    // de IANA. La base de datos sabe más que el archivo: tiene la historia
    // completa y el archivo suele traer sólo la regla vigente.
    if let Ok(tz) = tzid.parse::<Tz>() {
        return Some(Zona::Iana(tz));
    }
    if let Some(tz) = ubicacion.and_then(|u| u.trim().parse::<Tz>().ok()) {
        return Some(Zona::Iana(tz));
    }
    if observancias.is_empty() {
        return None;
    }
    // Una sola observancia es una zona sin horario de verano: su desplazamiento
    // es el desplazamiento, sin más.
    if observancias.len() == 1 {
        return Some(Zona::Fija(observancias[0].hasta));
    }
    Some(Zona::Reglas(Reglas { observancias }))
}

#[derive(Default)]
struct ObservanciaCruda {
    es_verano: bool,
    desde: Option<FixedOffset>,
    hasta: Option<FixedOffset>,
    comienzo: Option<NaiveDateTime>,
    regla: Option<ReglaAnual>,
}

impl ObservanciaCruda {
    fn terminar(self) -> Option<Observancia> {
        // Sin `TZOFFSETTO` la observancia no dice nada: es el único campo del
        // que no se puede prescindir.
        let hasta = self.hasta?;
        Some(Observancia {
            es_verano: self.es_verano,
            desde: self.desde.unwrap_or(hasta),
            hasta,
            // Sin `DTSTART` se toma la medianoche del año cero del formato, que
            // es lo que hace que la regla anual mande y la transición caiga a
            // las 00:00.
            comienzo: self.comienzo.unwrap_or_else(|| {
                NaiveDate::from_ymd_opt(1601, 1, 1)
                    .expect("1601-01-01 existe")
                    .and_time(NaiveTime::MIN)
            }),
            regla: self.regla,
        })
    }
}

/// Lee un `TZOFFSETFROM`/`TZOFFSETTO`: `+0200`, `-0330`, `+020000`.
fn desplazamiento_de(valor: &str) -> Option<FixedOffset> {
    let valor = valor.trim();
    let (signo, resto) = match valor.chars().next()? {
        '+' => (1, &valor[1..]),
        '-' => (-1, &valor[1..]),
        // Sin signo no es un desplazamiento válido, y adivinar que es positivo
        // sería adivinar el hemisferio.
        _ => return None,
    };
    if !resto.chars().all(|c| c.is_ascii_digit()) || (resto.len() != 4 && resto.len() != 6) {
        return None;
    }

    let horas: i32 = resto[0..2].parse().ok()?;
    let minutos: i32 = resto[2..4].parse().ok()?;
    let segundos: i32 = if resto.len() == 6 { resto[4..6].parse().ok()? } else { 0 };
    if minutos > 59 || segundos > 59 {
        return None;
    }

    FixedOffset::east_opt(signo * (horas * 3600 + minutos * 60 + segundos))
}

/// Lee el `DTSTART` de una observancia, que siempre es hora local sin zona.
fn momento_local_de(valor: &str) -> Option<NaiveDateTime> {
    NaiveDateTime::parse_from_str(valor.trim(), "%Y%m%dT%H%M%S").ok()
}

/// Lee la regla anual de una observancia.
///
/// Sólo el subconjunto que aparece en un `VTIMEZONE`: `FREQ=YEARLY` con un mes y
/// un día de semana, o con un mes y un día del mes. Cualquier otra cosa devuelve
/// `None` y la zona cae al respaldo, que es mejor que interpretarla a medias.
fn regla_de(valor: &str) -> Option<ReglaAnual> {
    let mut anual = false;
    let mut mes = None;
    let mut dia_del_mes = None;
    let mut dia_de_semana = None;

    for parte in valor.split(';') {
        // Un punto y coma de más —`BYDAY=-1SU;`— deja un pedazo vacío. No es un
        // pedazo que no se entienda: no hay nada ahí. Descartar la regla entera
        // por eso mandaría una zona perfectamente legible al respaldo.
        if parte.trim().is_empty() {
            continue;
        }
        let (nombre, contenido) = parte.split_once('=')?;
        match nombre.trim().to_ascii_uppercase().as_str() {
            "FREQ" => anual = contenido.trim().eq_ignore_ascii_case("YEARLY"),
            "BYMONTH" => mes = contenido.trim().parse::<u32>().ok().filter(|m| (1..=12).contains(m)),
            "BYMONTHDAY" => {
                dia_del_mes = contenido.trim().parse::<u32>().ok().filter(|d| (1..=31).contains(d))
            }
            "BYDAY" => dia_de_semana = dia_de_semana_de(contenido.trim()),
            // `INTERVAL`, `UNTIL` y `COUNT` en un `VTIMEZONE` son rarísimos y
            // cambiarían el resultado, así que se descarta la regla entera en
            // vez de ignorarlos.
            "INTERVAL" | "UNTIL" | "COUNT" => return None,
            _ => {}
        }
    }

    if !anual {
        return None;
    }
    let mes = mes?;
    match (dia_de_semana, dia_del_mes) {
        (Some((ordinal, dia)), _) => Some(ReglaAnual::DiaDeSemana { mes, ordinal, dia }),
        (None, Some(dia)) => Some(ReglaAnual::DiaDelMes { mes, dia }),
        (None, None) => None,
    }
}

/// Cuántas veces puede aparecer un día de semana en un mes.
///
/// Cinco, y por eso `BYDAY` en una transición sólo admite de -5 a 5 sin el cero.
/// No es una restricción de estilo: sin ella, un `BYDAY=999999999SU` de un
/// archivo cualquiera hace que el cálculo del día **entre en pánico** al sumarle
/// esos años a una fecha, y un archivo lo escribe quien quiera.
const MAX_ORDINAL: i32 = 5;

/// Lee un `BYDAY`: `-1SU`, `2MO`, `SU`.
///
/// Sin número adelante es «todos los domingos del mes», que en una transición
/// no quiere decir nada; se toma como el primero, que es lo que hacen los pocos
/// archivos que lo escriben así.
fn dia_de_semana_de(valor: &str) -> Option<(i32, Weekday)> {
    // Una lista —`MO,TU`— no define una transición única. Se descarta.
    if valor.contains(',') {
        return None;
    }
    // **Sólo ASCII**, y no por purismo: los dos últimos octetos de un valor con
    // acentos pueden caer en medio de un carácter, y cortar ahí entra en pánico.
    // Un `BYDAY` válido son dos letras y un número, así que nada se pierde.
    if !valor.is_ascii() {
        return None;
    }
    let corte = valor.len().checked_sub(2)?;
    let (prefijo, dia) = valor.split_at(corte);

    let dia = match dia.to_ascii_uppercase().as_str() {
        "MO" => Weekday::Mon,
        "TU" => Weekday::Tue,
        "WE" => Weekday::Wed,
        "TH" => Weekday::Thu,
        "FR" => Weekday::Fri,
        "SA" => Weekday::Sat,
        "SU" => Weekday::Sun,
        _ => return None,
    };

    let ordinal = if prefijo.is_empty() { 1 } else { prefijo.parse::<i32>().ok()? };
    (ordinal != 0 && ordinal.abs() <= MAX_ORDINAL).then_some((ordinal, dia))
}

/// Saca las comillas de un valor de parámetro.
///
/// Un `TZID` con barras o espacios viene entre comillas —`TZID="America/New
/// York"`— y el nombre de la zona es lo de adentro.
pub fn sin_comillas(valor: &str) -> &str {
    valor
        .strip_prefix('"')
        .and_then(|v| v.strip_suffix('"'))
        .unwrap_or(valor)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Lo que escriben Nextcloud, Google y Apple: el nombre de IANA en el
    /// `TZID`, sin que haga falta mirar el `VTIMEZONE`.
    #[test]
    fn un_tzid_de_iana_se_resuelve_solo() {
        let zonas = Zonas::default();
        let zona = zonas.resolver("America/Argentina/Buenos_Aires");
        assert_eq!(zona, Zona::Iana(chrono_tz::America::Argentina::Buenos_Aires));

        // Las dos de la tarde en Buenos Aires son las cinco UTC, no las dos.
        let local = NaiveDate::from_ymd_opt(2026, 9, 15)
            .unwrap()
            .and_hms_opt(14, 0, 0)
            .unwrap();
        assert_eq!(zona.a_utc(local).unwrap().to_rfc3339(), "2026-09-15T17:00:00+00:00");
    }

    /// El mismo `TZID` entre comillas, que es como viene cuando tiene barras.
    #[test]
    fn el_tzid_puede_venir_entre_comillas() {
        let zonas = Zonas::default();
        assert_eq!(
            zonas.resolver(r#""Europe/Madrid""#),
            Zona::Iana(chrono_tz::Europe::Madrid)
        );
    }

    /// El horario de verano cambia el resultado. Madrid corre +1 en invierno y
    /// +2 en verano, así que la misma hora local da dos instantes distintos.
    #[test]
    fn el_horario_de_verano_cambia_el_instante() {
        let zona = Zonas::default().resolver("Europe/Madrid");

        let invierno = NaiveDate::from_ymd_opt(2026, 1, 15).unwrap().and_hms_opt(9, 0, 0).unwrap();
        assert_eq!(zona.a_utc(invierno).unwrap().to_rfc3339(), "2026-01-15T08:00:00+00:00");

        let verano = NaiveDate::from_ymd_opt(2026, 7, 15).unwrap().and_hms_opt(9, 0, 0).unwrap();
        assert_eq!(zona.a_utc(verano).unwrap().to_rfc3339(), "2026-07-15T07:00:00+00:00");
    }

    /// Lo que escribe Outlook: un `TZID` que no es de IANA y las reglas
    /// completas al lado.
    const ROMANCE: &str = "BEGIN:VCALENDAR\r\n\
        BEGIN:VTIMEZONE\r\n\
        TZID:Romance Standard Time\r\n\
        BEGIN:STANDARD\r\n\
        DTSTART:16010101T030000\r\n\
        TZOFFSETFROM:+0200\r\n\
        TZOFFSETTO:+0100\r\n\
        RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=10\r\n\
        END:STANDARD\r\n\
        BEGIN:DAYLIGHT\r\n\
        DTSTART:16010101T020000\r\n\
        TZOFFSETFROM:+0100\r\n\
        TZOFFSETTO:+0200\r\n\
        RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=3\r\n\
        END:DAYLIGHT\r\n\
        END:VTIMEZONE\r\n\
        END:VCALENDAR\r\n";

    #[test]
    fn las_reglas_de_outlook_se_interpretan() {
        let zonas = tabla_de(ROMANCE);
        let zona = zonas.resolver("Romance Standard Time");
        assert!(matches!(zona, Zona::Reglas(_)), "{zona:?}");

        // Invierno: +1. En 2026 el cambio a verano es el 29 de marzo.
        let invierno = NaiveDate::from_ymd_opt(2026, 1, 15).unwrap().and_hms_opt(9, 0, 0).unwrap();
        assert_eq!(zona.a_utc(invierno).unwrap().to_rfc3339(), "2026-01-15T08:00:00+00:00");

        // Verano: +2.
        let verano = NaiveDate::from_ymd_opt(2026, 7, 15).unwrap().and_hms_opt(9, 0, 0).unwrap();
        assert_eq!(zona.a_utc(verano).unwrap().to_rfc3339(), "2026-07-15T07:00:00+00:00");
    }

    /// Y da lo mismo que la zona de IANA equivalente, que es la prueba de que
    /// las reglas se calcularon bien y no de casualidad.
    #[test]
    fn las_reglas_de_outlook_coinciden_con_la_base_de_datos() {
        let de_las_reglas = tabla_de(ROMANCE).resolver("Romance Standard Time");
        let de_iana = Zonas::default().resolver("Europe/Madrid");

        for (mes, dia) in [(1, 15), (3, 28), (4, 2), (7, 15), (10, 24), (11, 2), (12, 31)] {
            let local = NaiveDate::from_ymd_opt(2026, mes, dia)
                .unwrap()
                .and_hms_opt(9, 0, 0)
                .unwrap();
            assert_eq!(
                de_las_reglas.a_utc(local),
                de_iana.a_utc(local),
                "el {dia}/{mes} no coincide"
            );
        }
    }

    /// El hemisferio sur: el verano cruza el año, así que las transiciones del
    /// año anterior tienen que entrar en la cuenta.
    #[test]
    fn una_zona_del_sur_con_verano_a_caballo_del_anio() {
        let ical = "BEGIN:VTIMEZONE\r\n\
            TZID:Zona del sur\r\n\
            BEGIN:STANDARD\r\n\
            DTSTART:16010101T030000\r\n\
            TZOFFSETFROM:-0300\r\n\
            TZOFFSETTO:-0400\r\n\
            RRULE:FREQ=YEARLY;BYDAY=1SU;BYMONTH=4\r\n\
            END:STANDARD\r\n\
            BEGIN:DAYLIGHT\r\n\
            DTSTART:16010101T020000\r\n\
            TZOFFSETFROM:-0400\r\n\
            TZOFFSETTO:-0300\r\n\
            RRULE:FREQ=YEARLY;BYDAY=1SU;BYMONTH=9\r\n\
            END:DAYLIGHT\r\n\
            END:VTIMEZONE\r\n";
        let zona = tabla_de(ical).resolver("Zona del sur");

        // Enero está del lado del verano que empezó en septiembre **del año
        // anterior**: -3. Sin mirar el año anterior daría -4.
        let enero = NaiveDate::from_ymd_opt(2026, 1, 15).unwrap().and_hms_opt(9, 0, 0).unwrap();
        assert_eq!(zona.a_utc(enero).unwrap().to_rfc3339(), "2026-01-15T12:00:00+00:00");

        // Junio es invierno: -4.
        let junio = NaiveDate::from_ymd_opt(2026, 6, 15).unwrap().and_hms_opt(9, 0, 0).unwrap();
        assert_eq!(zona.a_utc(junio).unwrap().to_rfc3339(), "2026-06-15T13:00:00+00:00");
    }

    /// Una zona sin horario de verano: una sola observancia y su desplazamiento.
    #[test]
    fn una_zona_sin_verano_es_un_desplazamiento_fijo() {
        let ical = "BEGIN:VTIMEZONE\r\n\
            TZID:Zona quieta\r\n\
            BEGIN:STANDARD\r\n\
            DTSTART:16010101T000000\r\n\
            TZOFFSETFROM:-0300\r\n\
            TZOFFSETTO:-0300\r\n\
            END:STANDARD\r\n\
            END:VTIMEZONE\r\n";
        let zona = tabla_de(ical).resolver("Zona quieta");
        assert_eq!(zona, Zona::Fija(FixedOffset::east_opt(-3 * 3600).unwrap()));

        let local = NaiveDate::from_ymd_opt(2026, 9, 15).unwrap().and_hms_opt(14, 0, 0).unwrap();
        assert_eq!(zona.a_utc(local).unwrap().to_rfc3339(), "2026-09-15T17:00:00+00:00");
    }

    /// Lo que escribe libical: nombre propio en el `TZID` y el de IANA adentro.
    #[test]
    fn el_x_lic_location_da_el_nombre_de_iana() {
        let ical = "BEGIN:VTIMEZONE\r\n\
            TZID:/freeassociation.sourceforge.net/Europe/Madrid\r\n\
            X-LIC-LOCATION:Europe/Madrid\r\n\
            BEGIN:STANDARD\r\n\
            TZOFFSETFROM:+0200\r\n\
            TZOFFSETTO:+0100\r\n\
            END:STANDARD\r\n\
            END:VTIMEZONE\r\n";
        let zona = tabla_de(ical).resolver("/freeassociation.sourceforge.net/Europe/Madrid");
        assert_eq!(zona, Zona::Iana(chrono_tz::Europe::Madrid));
    }

    /// Un `VTIMEZONE` puede venir después del evento que lo usa. Por eso se lee
    /// en una pasada aparte.
    #[test]
    fn la_zona_se_encuentra_aunque_venga_despues_del_evento() {
        let ical = format!(
            "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:1\r\n\
             DTSTART;TZID=Romance Standard Time:20260715T090000\r\nEND:VEVENT\r\n{}",
            ROMANCE
                .trim_start_matches("BEGIN:VCALENDAR\r\n")
                .trim_end_matches("END:VCALENDAR\r\n")
        );
        assert!(matches!(tabla_de(&ical).resolver("Romance Standard Time"), Zona::Reglas(_)));
    }

    /// Un `TZID` que no se conoce y que el archivo no define: se muestra a la
    /// hora local de quien mira, que es lo más parecido a lo que quiso decir
    /// quien lo escribió.
    #[test]
    fn un_tzid_desconocido_queda_flotante() {
        assert_eq!(Zonas::default().resolver("Zona Inventada"), Zona::Flotante);
    }

    /// Una fecha sin `Z` y sin `TZID` es hora local flotante: «las nueve de
    /// donde estés». Tratarla como UTC la corría el desplazamiento entero.
    ///
    /// La prueba se escribe contra la zona de la máquina a propósito: es la
    /// definición misma de flotante, y así no depende de en qué zona corra.
    #[test]
    fn una_hora_flotante_es_la_de_la_sesion() {
        let local = NaiveDate::from_ymd_opt(2026, 9, 15).unwrap().and_hms_opt(9, 0, 0).unwrap();
        let esperado = chrono::Local
            .from_local_datetime(&local)
            .earliest()
            .expect("las 9 de la mañana existen en cualquier zona")
            .with_timezone(&Utc);

        assert_eq!(Zona::Flotante.a_utc(local), Some(esperado));
    }

    #[test]
    fn los_desplazamientos_se_leen_en_sus_tres_formas() {
        assert_eq!(desplazamiento_de("+0200"), FixedOffset::east_opt(2 * 3600));
        assert_eq!(desplazamiento_de("-0330"), FixedOffset::east_opt(-(3 * 3600 + 30 * 60)));
        assert_eq!(desplazamiento_de("+020000"), FixedOffset::east_opt(2 * 3600));
        assert_eq!(desplazamiento_de("-0000"), FixedOffset::east_opt(0));
    }

    /// Sin signo no es un desplazamiento: adivinar que es positivo sería
    /// adivinar el hemisferio.
    #[test]
    fn un_desplazamiento_roto_no_se_adivina() {
        for basura in ["0200", "", "+2", "+02:00", "+0270", "hola", "+02000"] {
            assert_eq!(desplazamiento_de(basura), None, "{basura:?}");
        }
    }

    #[test]
    fn el_ultimo_domingo_del_mes_se_calcula_bien() {
        // Octubre de 2026 termina un sábado; el último domingo es el 25.
        let ultimo = dia_de_semana_del_mes(2026, 10, -1, Weekday::Sun).unwrap();
        assert_eq!(ultimo, NaiveDate::from_ymd_opt(2026, 10, 25).unwrap());

        // El primer domingo de marzo de 2026 es el 1.
        let primero = dia_de_semana_del_mes(2026, 3, 1, Weekday::Sun).unwrap();
        assert_eq!(primero, NaiveDate::from_ymd_opt(2026, 3, 1).unwrap());

        // El segundo, el 8.
        let segundo = dia_de_semana_del_mes(2026, 3, 2, Weekday::Sun).unwrap();
        assert_eq!(segundo, NaiveDate::from_ymd_opt(2026, 3, 8).unwrap());
    }

    /// «El quinto domingo» de un mes que tiene cuatro no existe, y no se corre
    /// al mes siguiente.
    #[test]
    fn un_dia_de_semana_que_no_existe_no_se_corre_de_mes() {
        assert_eq!(dia_de_semana_del_mes(2026, 2, 5, Weekday::Sun), None);
        assert_eq!(dia_de_semana_del_mes(2026, 2, -5, Weekday::Sun), None);
        assert_eq!(dia_de_semana_del_mes(2026, 3, 0, Weekday::Sun), None);
    }

    #[test]
    fn las_reglas_que_no_se_entienden_se_descartan_enteras() {
        // Una lista de días no define una transición única.
        assert_eq!(regla_de("FREQ=YEARLY;BYMONTH=3;BYDAY=MO,TU"), None);
        // Mensual no es anual.
        assert_eq!(regla_de("FREQ=MONTHLY;BYMONTH=3;BYDAY=-1SU"), None);
        // Un intervalo cambiaría el resultado y se descarta en vez de ignorarse.
        assert_eq!(regla_de("FREQ=YEARLY;INTERVAL=2;BYMONTH=3;BYDAY=-1SU"), None);
        // Sin mes no hay nada que calcular.
        assert_eq!(regla_de("FREQ=YEARLY;BYDAY=-1SU"), None);
    }

    /// Un `BYDAY` no ASCII cortaba a la mitad de un carácter y entraba en
    /// pánico. Lo escribe quien mande el archivo.
    #[test]
    fn un_byday_con_acentos_no_rompe_nada() {
        for basura in ["€", "añSU", "SÜ", "áé", "\u{1f600}"] {
            assert_eq!(dia_de_semana_de(basura), None, "{basura:?}");
        }
    }

    /// Un ordinal enorme le sumaba millones de días a una fecha, y eso también
    /// entraba en pánico. Un día de semana aparece cinco veces en un mes como
    /// mucho.
    #[test]
    fn un_ordinal_fuera_de_rango_se_rechaza() {
        assert_eq!(dia_de_semana_de("999999999SU"), None);
        assert_eq!(dia_de_semana_de("-999999999SU"), None);
        assert_eq!(dia_de_semana_de("6SU"), None);
        assert_eq!(dia_de_semana_de("0SU"), None);

        // Y el rango que sí vale sigue valiendo.
        assert_eq!(dia_de_semana_de("5SU"), Some((5, Weekday::Sun)));
        assert_eq!(dia_de_semana_de("-1SU"), Some((-1, Weekday::Sun)));
        assert_eq!(dia_de_semana_de("SU"), Some((1, Weekday::Sun)));
    }

    /// Un punto y coma de más no puede mandar una regla legible al respaldo.
    #[test]
    fn un_punto_y_coma_de_mas_no_descarta_la_regla() {
        assert_eq!(
            regla_de("FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU;"),
            Some(ReglaAnual::DiaDeSemana { mes: 3, ordinal: -1, dia: Weekday::Sun })
        );
        assert_eq!(
            regla_de(";;FREQ=YEARLY;;BYMONTH=3;BYDAY=-1SU"),
            Some(ReglaAnual::DiaDeSemana { mes: 3, ordinal: -1, dia: Weekday::Sun })
        );
        // Un pedazo que **sí** dice algo y no se entiende sigue descartando la
        // regla entera: interpretarla a medias es peor.
        assert_eq!(regla_de("FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU;basura"), None);
    }

    /// Una zona definida sólo con fechas sueltas cae al respaldo de la
    /// observancia estándar, que es quedar corrido una hora medio año en vez de
    /// quedar corrido el desplazamiento entero todo el año.
    #[test]
    fn una_zona_sin_reglas_usables_cae_a_la_observancia_estandar() {
        let ical = "BEGIN:VTIMEZONE\r\n\
            TZID:Zona historica\r\n\
            BEGIN:DAYLIGHT\r\n\
            DTSTART:19810329T020000\r\n\
            TZOFFSETFROM:+0100\r\n\
            TZOFFSETTO:+0200\r\n\
            RDATE:19820328T020000\r\n\
            END:DAYLIGHT\r\n\
            BEGIN:STANDARD\r\n\
            DTSTART:19811025T030000\r\n\
            TZOFFSETFROM:+0200\r\n\
            TZOFFSETTO:+0100\r\n\
            END:STANDARD\r\n\
            END:VTIMEZONE\r\n";
        let zona = tabla_de(ical).resolver("Zona historica");

        let local = NaiveDate::from_ymd_opt(2026, 7, 15).unwrap().and_hms_opt(9, 0, 0).unwrap();
        assert_eq!(zona.a_utc(local).unwrap().to_rfc3339(), "2026-07-15T08:00:00+00:00");
    }

    /// La hora que no existe se corre hacia adelante en vez de hacer desaparecer
    /// el evento. En Madrid, el 29 de marzo de 2026 el reloj salta de las 2 a
    /// las 3, así que las 2:30 no ocurren.
    #[test]
    fn la_hora_que_no_existe_se_corre_hacia_adelante() {
        let zona = Zonas::default().resolver("Europe/Madrid");
        let inexistente = NaiveDate::from_ymd_opt(2026, 3, 29).unwrap().and_hms_opt(2, 30, 0).unwrap();

        let momento = zona.a_utc(inexistente).expect("no puede desaparecer del mes");
        assert_eq!(momento.to_rfc3339(), "2026-03-29T01:30:00+00:00");
    }

    /// La hora que ocurre dos veces se toma como la primera.
    #[test]
    fn la_hora_que_ocurre_dos_veces_se_toma_la_primera() {
        let zona = Zonas::default().resolver("Europe/Madrid");
        // El 25 de octubre de 2026 el reloj atrasa de las 3 a las 2.
        let ambigua = NaiveDate::from_ymd_opt(2026, 10, 25).unwrap().and_hms_opt(2, 30, 0).unwrap();

        // La primera es con +2 todavía puesto: 00:30 UTC.
        assert_eq!(zona.a_utc(ambigua).unwrap().to_rfc3339(), "2026-10-25T00:30:00+00:00");
    }

    /// Un archivo con muchísimas zonas no hace crecer la tabla sin freno.
    #[test]
    fn hay_tope_de_zonas() {
        let mut ical = String::new();
        for i in 0..(MAX_ZONAS + 50) {
            ical.push_str(&format!(
                "BEGIN:VTIMEZONE\r\nTZID:Zona {i}\r\nBEGIN:STANDARD\r\n\
                 TZOFFSETTO:+0100\r\nEND:STANDARD\r\nEND:VTIMEZONE\r\n"
            ));
        }
        assert_eq!(tabla_de(&ical).0.len(), MAX_ZONAS);
    }

    /// Un archivo sin ningún `VTIMEZONE` no es un error: es el caso normal.
    #[test]
    fn un_archivo_sin_zonas_da_una_tabla_vacia() {
        let ical = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:1\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
        assert!(tabla_de(ical).0.is_empty());
    }
}
