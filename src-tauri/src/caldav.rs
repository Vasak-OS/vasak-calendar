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
//! ── Lo que **no** hace todavía ──────────────────────────────────────────────
//!
//! No expande repeticiones. Un evento con `RRULE` se muestra una vez, el día que
//! empieza, y no en cada repetición. Hacerlo bien es su propio trabajo —hay
//! excepciones, fechas que se corren, zonas horarias que cambian en el medio— y
//! hacerlo mal es peor que no hacerlo: un calendario que muestra una reunión el
//! día equivocado es peor que uno que no la muestra.

use std::time::Duration;

use base64::Engine;
use chrono::{DateTime, NaiveDate, NaiveDateTime, TimeZone, Utc};
use serde::Serialize;

const TIMEOUT: Duration = Duration::from_secs(20);

/// Tope de lo que se lee de una respuesta.
///
/// Un calendario de años puede ser grande, pero no ilimitado: sin tope, un
/// servidor que devuelve basura hace crecer la memoria de la ventana sin freno.
const MAX_CUERPO: usize = 8 * 1024 * 1024;

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

/// Un evento, ya listo para mostrar.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Evento {
    pub uid: String,
    pub titulo: String,
    /// Cuándo empieza, en UTC y en ISO 8601. La ventana lo pasa a la hora local.
    pub inicio: String,
    pub fin: String,
    /// Si dura todo el día. Se guarda aparte porque un evento de día completo no
    /// tiene hora, y mostrarle una —la medianoche de alguna zona— lo correría de
    /// día para quien esté en otra.
    pub todo_el_dia: bool,
    /// Si se repite. Se muestra una sola vez; ver la nota del módulo.
    pub se_repite: bool,
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

    let mut partes = izquierda.split(';');
    let nombre = partes.next()?.trim().to_ascii_uppercase();
    let parametros: Vec<String> = partes.map(|p| p.trim().to_string()).collect();

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
    salida
}

/// Interpreta una fecha de iCalendar.
///
/// Tres formas: `20260915` (todo el día), `20260915T140000Z` (UTC) y
/// `20260915T140000` con un `TZID` al lado (hora local de esa zona).
///
/// El tercer caso se trata como UTC **a propósito y con una deuda anotada**:
/// resolver una zona horaria de verdad necesita la base de datos de zonas, y
/// hacerlo mal correría los eventos de hora sin que nadie lo note. Mientras
/// tanto, un evento con `TZID` puede aparecer corrido; lo que no puede es
/// aparecer en el día equivocado por un error de parseo.
pub fn fecha_de(valor: &str, parametros: &[String]) -> Option<(DateTime<Utc>, bool)> {
    let es_dia_completo = parametros
        .iter()
        .any(|p| p.eq_ignore_ascii_case("VALUE=DATE"));

    if es_dia_completo || valor.len() == 8 {
        let dia = NaiveDate::parse_from_str(valor, "%Y%m%d").ok()?;
        let momento = dia.and_hms_opt(0, 0, 0)?;
        return Some((Utc.from_utc_datetime(&momento), true));
    }

    let sin_zona = valor.strip_suffix('Z').unwrap_or(valor);
    let momento = NaiveDateTime::parse_from_str(sin_zona, "%Y%m%dT%H%M%S").ok()?;
    Some((Utc.from_utc_datetime(&momento), false))
}

/// Saca los eventos de un iCalendar.
///
/// Sólo `VEVENT`: un calendario trae también tareas y notas, y mostrarlas como
/// si fueran eventos llenaría el mes de cosas que no lo son.
pub fn eventos_de(ical: &str) -> Vec<Evento> {
    let mut eventos = Vec::new();
    let mut dentro = false;
    let mut actual: Option<EventoCrudo> = None;

    for linea in unir_lineas(ical) {
        let Some((nombre, parametros, valor)) = partir_linea(&linea) else {
            continue;
        };

        match (nombre.as_str(), valor.trim()) {
            ("BEGIN", "VEVENT") => {
                dentro = true;
                actual = Some(EventoCrudo::default());
                continue;
            }
            ("END", "VEVENT") => {
                dentro = false;
                if let Some(crudo) = actual.take() {
                    if let Some(evento) = crudo.terminar() {
                        eventos.push(evento);
                    }
                }
                continue;
            }
            _ => {}
        }

        if !dentro {
            continue;
        }
        let Some(crudo) = actual.as_mut() else { continue };

        match nombre.as_str() {
            "UID" => crudo.uid = Some(valor),
            "SUMMARY" => crudo.titulo = Some(texto_de(&valor)),
            "DTSTART" => crudo.inicio = fecha_de(&valor, &parametros),
            "DTEND" => crudo.fin = fecha_de(&valor, &parametros),
            "RRULE" => crudo.se_repite = true,
            _ => {}
        }
    }

    eventos
}

#[derive(Default)]
struct EventoCrudo {
    uid: Option<String>,
    titulo: Option<String>,
    inicio: Option<(DateTime<Utc>, bool)>,
    fin: Option<(DateTime<Utc>, bool)>,
    se_repite: bool,
}

impl EventoCrudo {
    fn terminar(self) -> Option<Evento> {
        // Sin comienzo no hay dónde ponerlo en el mes, así que no se muestra. El
        // estándar lo exige, pero un servidor puede mandar cualquier cosa.
        let (inicio, todo_el_dia) = self.inicio?;
        // Sin fin, dura lo que el estándar dice: un día si es de día completo, y
        // nada si tiene hora. Inventar una hora de fin mostraría una barra que
        // no corresponde.
        let fin = self
            .fin
            .map(|(f, _)| f)
            .unwrap_or(if todo_el_dia { inicio + chrono::Duration::days(1) } else { inicio });

        Some(Evento {
            uid: self.uid.unwrap_or_default(),
            // Un evento sin título existe: se muestra vacío y no se descarta,
            // porque ocupa lugar en el día de la persona igual.
            titulo: self.titulo.unwrap_or_default(),
            inicio: inicio.to_rfc3339(),
            fin: fin.to_rfc3339(),
            todo_el_dia,
            se_repite: self.se_repite,
        })
    }
}

/// El cuerpo de la consulta que pide los eventos de un rango.
pub fn consulta_de_eventos(desde: &str, hasta: &str) -> String {
    format!(
        r#"<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="{NS_CALDAV}">
  <d:prop><d:getetag/><c:calendar-data/></d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT">
        <c:time-range start="{desde}" end="{hasta}"/>
      </c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>"#
    )
}

/// El formato de fecha que espera un `time-range`: siempre UTC y sin guiones.
pub fn momento_caldav(momento: DateTime<Utc>) -> String {
    momento.format("%Y%m%dT%H%M%SZ").to_string()
}

/// Lee los calendarios de una respuesta `PROPFIND`.
pub fn calendarios_de(xml: &str, base: &str) -> Vec<Calendario> {
    let Ok(documento) = roxmltree::Document::parse(xml) else {
        return Vec::new();
    };

    documento
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
            let url = reqwest::Url::parse(base).ok()?.join(href).ok()?.to_string();

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
                nombre: if nombre.is_empty() { "Calendario".into() } else { nombre },
                color,
            })
        })
        .collect()
}

/// Saca los bloques de iCalendar de una respuesta `REPORT`.
pub fn ical_de_respuesta(xml: &str) -> Vec<String> {
    let Ok(documento) = roxmltree::Document::parse(xml) else {
        return Vec::new();
    };
    documento
        .descendants()
        .filter(|n| n.has_tag_name((NS_CALDAV, "calendar-data")))
        .filter_map(|n| n.text())
        .map(str::to_string)
        .collect()
}

// ---------------------------------------------------------------------------
// La parte que habla por la red
// ---------------------------------------------------------------------------

fn cabecera_basica(usuario: &str, secreto: &str) -> String {
    format!(
        "Basic {}",
        base64::engine::general_purpose::STANDARD.encode(format!("{usuario}:{secreto}"))
    )
}

fn cliente() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(TIMEOUT)
        // Sin redirecciones: el pedido lleva la contraseña, y una redirección la
        // mandaría adonde el servidor diga.
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("VasakOS")
        .build()
        .map_err(|e| format!("no se pudo crear el cliente HTTP: {e}"))
}

async fn cuerpo_con_tope(respuesta: reqwest::Response) -> Result<String, String> {
    let estado = respuesta.status();
    if estado == reqwest::StatusCode::UNAUTHORIZED {
        return Err("el servidor rechazó el usuario o la contraseña. \
                    Volvé a conectar la cuenta desde Configuración"
            .into());
    }
    if !estado.is_success() {
        return Err(format!("el servidor respondió {estado}"));
    }

    let bytes = respuesta
        .bytes()
        .await
        .map_err(|e| format!("no se pudo leer la respuesta: {e}"))?;
    if bytes.len() > MAX_CUERPO {
        return Err(format!(
            "el servidor devolvió {} bytes, más de los {MAX_CUERPO} que se leen",
            bytes.len()
        ));
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Los calendarios que hay en la carpeta de la persona.
pub async fn calendarios(credencial: &crate::cuentas::Credencial) -> Result<Vec<Calendario>, String> {
    let cuerpo = format!(
        r#"<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="{NS_CALDAV}" xmlns:a="{NS_APPLE}">
  <d:prop><d:resourcetype/><d:displayname/><a:calendar-color/></d:prop>
</d:propfind>"#
    );

    let respuesta = cliente()?
        .request(metodo("PROPFIND"), &credencial.home)
        .header("Authorization", cabecera_basica(&credencial.usuario, &credencial.secreto))
        // 1: la carpeta y lo que hay dentro. Con 0 sólo vendría la carpeta, que
        // es justo lo que no interesa.
        .header("Depth", "1")
        .header("Content-Type", "application/xml; charset=utf-8")
        .body(cuerpo)
        .send()
        .await
        .map_err(|e| format!("no se pudo consultar {}: {e}", credencial.home))?;

    let xml = cuerpo_con_tope(respuesta).await?;
    Ok(calendarios_de(&xml, &credencial.home))
}

/// Los eventos de un calendario entre dos momentos.
pub async fn eventos(
    credencial: &crate::cuentas::Credencial,
    calendario: &str,
    desde: DateTime<Utc>,
    hasta: DateTime<Utc>,
) -> Result<Vec<Evento>, String> {
    let respuesta = cliente()?
        .request(metodo("REPORT"), calendario)
        .header("Authorization", cabecera_basica(&credencial.usuario, &credencial.secreto))
        // 1: los eventos de este calendario. El estándar lo pide para una
        // consulta de calendario, y hay servidores que sin esto devuelven vacío.
        .header("Depth", "1")
        .header("Content-Type", "application/xml; charset=utf-8")
        .body(consulta_de_eventos(&momento_caldav(desde), &momento_caldav(hasta)))
        .send()
        .await
        .map_err(|e| format!("no se pudieron pedir los eventos: {e}"))?;

    let xml = cuerpo_con_tope(respuesta).await?;
    Ok(ical_de_respuesta(&xml)
        .iter()
        .flat_map(|ical| eventos_de(ical))
        .collect())
}

fn metodo(nombre: &str) -> reqwest::Method {
    reqwest::Method::from_bytes(nombre.as_bytes()).expect("es un método válido")
}

#[cfg(test)]
mod tests {
    use super::*;

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
            partir_linea(r#"DTSTART;TZID="America/Argentina/Buenos Aires":20260915T140000"#).unwrap();
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
        let (momento, todo_el_dia) = fecha_de("20260915", &["VALUE=DATE".into()]).unwrap();
        assert!(todo_el_dia);
        assert_eq!(momento.to_rfc3339(), "2026-09-15T00:00:00+00:00");

        // Y también si no viene el parámetro: ocho dígitos ya son una fecha.
        assert!(fecha_de("20260915", &[]).unwrap().1);
    }

    #[test]
    fn una_fecha_con_hora_no_es_de_dia_completo() {
        let (momento, todo_el_dia) = fecha_de("20260915T140000Z", &[]).unwrap();
        assert!(!todo_el_dia);
        assert_eq!(momento.to_rfc3339(), "2026-09-15T14:00:00+00:00");
    }

    #[test]
    fn una_fecha_que_no_se_entiende_no_se_inventa() {
        for basura in ["", "mañana", "2026-09-15", "20261301", "20260915T99"] {
            assert_eq!(fecha_de(basura, &[]), None, "{basura:?}");
        }
    }

    const UN_EVENTO: &str = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:abc\r\n\
        SUMMARY:Reunión\\, con Ana\r\nDTSTART:20260915T140000Z\r\n\
        DTEND:20260915T150000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";

    #[test]
    fn se_lee_un_evento() {
        let eventos = eventos_de(UN_EVENTO);
        assert_eq!(eventos.len(), 1);
        assert_eq!(eventos[0].uid, "abc");
        assert_eq!(eventos[0].titulo, "Reunión, con Ana");
        assert!(!eventos[0].todo_el_dia);
        assert!(!eventos[0].se_repite);
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

        let eventos = eventos_de(ical);
        assert_eq!(eventos.len(), 1);
        assert_eq!(eventos[0].uid, "e");
    }

    /// Sin comienzo no hay dónde ponerlo en el mes. El estándar lo exige, pero
    /// un servidor puede mandar cualquier cosa y no puede tirar la lista entera.
    #[test]
    fn un_evento_sin_comienzo_se_saltea_sin_perder_los_demas() {
        let ical = "BEGIN:VCALENDAR\r\n\
            BEGIN:VEVENT\r\nUID:roto\r\nSUMMARY:Sin fecha\r\nEND:VEVENT\r\n\
            BEGIN:VEVENT\r\nUID:sano\r\nSUMMARY:Con fecha\r\nDTSTART:20260915T140000Z\r\nEND:VEVENT\r\n\
            END:VCALENDAR\r\n";

        let eventos = eventos_de(ical);
        assert_eq!(eventos.len(), 1);
        assert_eq!(eventos[0].uid, "sano");
    }

    /// Sin `DTEND`, un evento de día completo dura un día y uno con hora no dura
    /// nada. Inventar una hora de fin mostraría una barra que no corresponde.
    #[test]
    fn sin_fin_la_duracion_es_la_que_dice_el_estandar() {
        let de_dia = "BEGIN:VEVENT\r\nUID:d\r\nDTSTART;VALUE=DATE:20260915\r\nEND:VEVENT\r\n";
        let evento = &eventos_de(de_dia)[0];
        assert_eq!(evento.inicio, "2026-09-15T00:00:00+00:00");
        assert_eq!(evento.fin, "2026-09-16T00:00:00+00:00");

        let con_hora = "BEGIN:VEVENT\r\nUID:h\r\nDTSTART:20260915T140000Z\r\nEND:VEVENT\r\n";
        let evento = &eventos_de(con_hora)[0];
        assert_eq!(evento.inicio, evento.fin);
    }

    /// Un evento que se repite se marca, aunque todavía no se expandan las
    /// repeticiones: la ventana puede decir que hay más, en vez de mostrar una
    /// reunión semanal como si fuera única.
    #[test]
    fn un_evento_que_se_repite_queda_marcado() {
        let ical = "BEGIN:VEVENT\r\nUID:r\r\nDTSTART:20260915T140000Z\r\n\
                    RRULE:FREQ=WEEKLY;COUNT=10\r\nEND:VEVENT\r\n";
        assert!(eventos_de(ical)[0].se_repite);
    }

    /// Un evento sin título existe y ocupa lugar en el día de la persona igual,
    /// así que se muestra vacío en vez de descartarse.
    #[test]
    fn un_evento_sin_titulo_se_muestra_igual() {
        let ical = "BEGIN:VEVENT\r\nUID:x\r\nDTSTART:20260915T140000Z\r\nEND:VEVENT\r\n";
        let eventos = eventos_de(ical);
        assert_eq!(eventos.len(), 1);
        assert_eq!(eventos[0].titulo, "");
    }

    /// Basura no puede hacer caer la ventana: viene de un servidor y de eventos
    /// que escribió cualquiera.
    #[test]
    fn lo_que_no_es_un_calendario_no_da_eventos() {
        for basura in ["", "no es un calendario", "BEGIN:VEVENT", "END:VEVENT\r\n", ":::"] {
            assert!(eventos_de(basura).is_empty(), "{basura:?}");
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

    /// La carpeta también trae cosas que no son calendarios. Listarlas daría
    /// entradas que al abrirlas no tienen nada.
    #[test]
    fn solo_se_listan_las_colecciones_que_son_calendarios() {
        let calendarios = calendarios_de(CALENDARIOS, "https://nube.ejemplo.com/dav/calendars/ana/");

        assert_eq!(calendarios.len(), 1);
        assert_eq!(calendarios[0].nombre, "Personal");
        assert_eq!(calendarios[0].color.as_deref(), Some("#FF5733"));
        assert_eq!(
            calendarios[0].url,
            "https://nube.ejemplo.com/dav/calendars/ana/personal/"
        );
    }

    /// Los servidores contestan con una ruta absoluta casi siempre y con una URL
    /// entera a veces. Pegarlas a mano rompería la segunda.
    #[test]
    fn un_href_con_url_entera_no_se_pega_dos_veces() {
        let xml = CALENDARIOS.replace(
            "<d:href>/dav/calendars/ana/personal/</d:href>",
            "<d:href>https://otra.ejemplo.com/x/</d:href>",
        );
        let calendarios = calendarios_de(&xml, "https://nube.ejemplo.com/dav/calendars/ana/");
        assert_eq!(calendarios[0].url, "https://otra.ejemplo.com/x/");
    }

    #[test]
    fn un_xml_roto_no_da_calendarios() {
        assert!(calendarios_de("no es xml", "https://x/").is_empty());
        assert!(ical_de_respuesta("<abierto>").is_empty());
    }

    /// El rango va siempre en UTC y sin guiones: un servidor rechaza el pedido
    /// entero si el formato no es exactamente ése.
    #[test]
    fn el_rango_va_en_el_formato_que_espera_el_servidor() {
        let momento = Utc.with_ymd_and_hms(2026, 9, 15, 14, 30, 0).unwrap();
        assert_eq!(momento_caldav(momento), "20260915T143000Z");

        let consulta = consulta_de_eventos("20260901T000000Z", "20261001T000000Z");
        assert!(consulta.contains(r#"start="20260901T000000Z""#), "{consulta}");
        assert!(roxmltree::Document::parse(&consulta).is_ok(), "no es XML válido");
    }
}
