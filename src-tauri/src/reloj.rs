//! De dónde sale la zona horaria de la máquina.
//!
//! ── Por qué no se le pregunta al navegador ──────────────────────────────────
//!
//! Parecía que alcanzaba con `Intl.DateTimeFormat().resolvedOptions().timeZone`,
//! y para el primer dibujo alcanza: el motor arranca leyendo la configuración
//! del sistema y contesta bien.
//!
//! Lo que no hace es **enterarse de que cambió**. Los motores de JavaScript se
//! quedan con la zona que leyeron al arrancar y no la vuelven a mirar, así que
//! una ventana abierta mientras el sistema cambia de huso —al viajar, con el
//! reloj automático— sigue contestando la zona vieja para siempre. Preguntarle
//! cada un minuto no sirve de nada: contesta lo mismo.
//!
//! Así que la zona se la pide el programa al sistema, que sí sabe.
//!
//! ── Y por qué en este orden ─────────────────────────────────────────────────
//!
//! 1. **`TZ`**, si está. Es lo que manda para este proceso, por encima de lo que
//!    diga el sistema, y quien la define lo hace a propósito.
//! 2. **`/etc/localtime`**, que es un enlace a la zona elegida. Es la respuesta
//!    sin hablar con nadie, y funciona igual en una máquina sin systemd.
//! 3. **`timedate1`**, por el bus del sistema, para cuando `/etc/localtime` es
//!    una copia y no un enlace — que pasa.
//! 4. **UTC**, que es mentira pero es una mentira conocida: dejar la ventana sin
//!    dibujar porque no se supo la zona sería peor.
//!
//! El **aviso de que cambió** sí viene siempre de `timedate1`: es lo único que
//! anuncia el cambio en el momento en que ocurre.

use tauri::Emitter;

const SERVICIO: &str = "org.freedesktop.timedate1";
const RUTA: &str = "/org/freedesktop/timedate1";
const INTERFAZ: &str = "org.freedesktop.timedate1";

/// El directorio donde viven las zonas, y el prefijo que hay que sacarle al
/// enlace de `/etc/localtime` para quedarse con el nombre.
const ZONEINFO: &str = "/usr/share/zoneinfo/";

/// El evento con el que se le avisa a la ventana. Lleva la zona nueva adentro,
/// para que no tenga que volver a preguntar.
const EVENTO: &str = "zona-cambio";

/// Cuánto se espera antes de volver a engancharse al aviso.
///
/// Quince segundos: corto para que reconectar no se note, y largo para no
/// martillar un bus que no está.
const ESPERA_ENTRE_INTENTOS: std::time::Duration = std::time::Duration::from_secs(15);

/// En qué zona horaria está la máquina.
#[tauri::command]
pub async fn zona_del_sistema() -> String {
    de_la_variable()
        .or_else(de_etc_localtime)
        .or(de_timedate1().await)
        .unwrap_or_else(|| "UTC".to_string())
}

/// `TZ`, si nombra una zona y no un huso escrito a mano.
///
/// La variable admite dos formas: el nombre de una zona —`Europe/Madrid`, a
/// veces con dos puntos adelante— y una especificación POSIX como `EST5EDT`,
/// que no es un nombre de zona y que la ventana no sabría resolver. Sólo sirve
/// la primera.
fn de_la_variable() -> Option<String> {
    let valor = std::env::var("TZ").ok()?;
    let valor = valor.trim().trim_start_matches(':');
    nombre_valido(valor).then(|| valor.to_string())
}

/// El destino del enlace `/etc/localtime`.
fn de_etc_localtime() -> Option<String> {
    let destino = std::fs::read_link("/etc/localtime").ok()?;
    let ruta = destino.to_str()?;
    // Puede ser relativo —`../usr/share/zoneinfo/…`—, así que se busca el
    // directorio de zonas adentro en vez de exigir que la ruta empiece con él.
    let desde = ruta.find(ZONEINFO)? + ZONEINFO.len();
    let nombre = &ruta[desde..];
    nombre_valido(nombre).then(|| nombre.to_string())
}

/// Lo que dice `timedate1`, para cuando `/etc/localtime` es una copia.
async fn de_timedate1() -> Option<String> {
    let conexion = zbus::Connection::system().await.ok()?;
    let propiedades = zbus::fdo::PropertiesProxy::new(&conexion, SERVICIO, RUTA)
        .await
        .ok()?;
    let valor = propiedades
        .get(INTERFAZ.try_into().ok()?, "Timezone")
        .await
        .ok()?;
    let nombre: String = valor.downcast_ref::<&str>().ok()?.to_string();
    nombre_valido(&nombre).then_some(nombre)
}

/// Si eso puede ser el nombre de una zona de IANA.
///
/// No comprueba que exista —eso lo hace la ventana, que tiene la lista— sino que
/// **no sea otra cosa**: vacío, una ruta que se escapa del directorio de zonas,
/// o un huso POSIX escrito a mano. Lo que sale de acá termina en un
/// `Intl.DateTimeFormat`, así que conviene que sea un nombre y no cualquier cosa.
fn nombre_valido(nombre: &str) -> bool {
    !nombre.is_empty()
        && nombre != "posixrules"
        && !nombre.starts_with('/')
        && !nombre.split('/').any(|parte| parte == ".." || parte.is_empty())
        && nombre
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '_' | '-' | '+'))
        // Un nombre de IANA lleva región y ciudad. Las excepciones sin barra son
        // pocas y conocidas, y dejarlas afuera mandaría a UTC a quien las use.
        && (nombre.contains('/') || matches!(nombre, "UTC" | "GMT" | "UCT" | "Zulu" | "Universal"))
}

/// Avisa a la ventana cuando la máquina cambia de zona.
pub fn escuchar(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        // **En bucle, no una sola vez.** El bus se puede cortar, y con un solo
        // intento la ventana se quedaría sin enterarse hasta que alguien la
        // cerrara y volviera a abrir.
        loop {
            if let Err(e) = seguir(&app).await {
                // Que no se pueda escuchar no rompe nada: la zona se leyó bien al
                // arrancar y se vuelve a leer al volver a la ventana. Queda dicho
                // en el diario para que no parezca otra cosa.
                eprintln!("[reloj] no se pueden recibir avisos de cambio de zona: {e}");
            }
            tokio::time::sleep(ESPERA_ENTRE_INTENTOS).await;
        }
    });
}

async fn seguir(app: &tauri::AppHandle) -> Result<(), String> {
    use zbus::export::futures_util::StreamExt;

    let conexion = zbus::Connection::system()
        .await
        .map_err(|e| format!("no se pudo contactar al bus del sistema: {e}"))?;

    let propiedades = zbus::fdo::PropertiesProxy::new(&conexion, SERVICIO, RUTA)
        .await
        .map_err(|e| format!("no se pudo hablar con {SERVICIO}: {e}"))?;

    let mut avisos = propiedades
        .receive_properties_changed()
        .await
        .map_err(|e| format!("no se pudo escuchar los cambios de {SERVICIO}: {e}"))?;

    while avisos.next().await.is_some() {
        // Se vuelve a leer en vez de sacar el valor del aviso: `timedate1` avisa
        // de todo lo suyo —la hora, el NTP, el reloj del hardware— y la mitad de
        // esos avisos no traen la zona adentro. Leerla es una llamada más y
        // siempre da la respuesta correcta.
        let _ = app.emit(EVENTO, zona_del_sistema().await);
    }

    Err("el bus del sistema cerró la conexión".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Lo que contesta `timedate1` de verdad, contra el bus de esta máquina.
    ///
    /// **Marcado `#[ignore]`**: necesita un bus del sistema con systemd y no lo
    /// hay en el servidor de integración. Se corre a mano con
    /// `cargo test -- --ignored` y existe porque este camino queda tapado en
    /// cualquier máquina donde `/etc/localtime` sea un enlace —o sea, casi
    /// todas—, así que sin esto no se ejercita nunca y un error acá se vería
    /// como «la zona nunca cambia» y nada más.
    #[tokio::test]
    #[ignore]
    async fn timedate1_contesta_una_zona() {
        let zona = de_timedate1().await.expect("timedate1 tendría que contestar");
        assert!(nombre_valido(&zona), "{zona:?}");

        // Y que el camino corto —el enlace de `/etc/localtime`— diga lo mismo.
        // Si no coincidieran, la ventana arrancaría con una zona y el primer
        // aviso de cambio la movería a otra sin que nada hubiera cambiado.
        assert_eq!(zona_del_sistema().await, zona);
    }

    #[test]
    fn un_nombre_de_zona_se_acepta() {
        for nombre in [
            "Europe/Madrid",
            "America/Argentina/Buenos_Aires",
            "Etc/GMT+3",
            "UTC",
        ] {
            assert!(nombre_valido(nombre), "{nombre:?}");
        }
    }

    /// Lo que sale de acá termina en un `Intl.DateTimeFormat` de la ventana, así
    /// que no puede ser cualquier cosa.
    #[test]
    fn lo_que_no_es_una_zona_se_rechaza() {
        for basura in [
            "",
            // Un huso POSIX escrito a mano: `TZ` lo admite y no es un nombre.
            "EST5EDT",
            "posixrules",
            // Una ruta, que además podría salirse del directorio de zonas.
            "/etc/passwd",
            "../../etc/passwd",
            "Europe/../../../etc/shadow",
            "Europe//Madrid",
            "Europe/Madrid; rm -rf",
            "Europe/Madrid\n",
        ] {
            assert!(!nombre_valido(basura), "{basura:?}");
        }
    }

    /// El enlace puede ser relativo, que es como lo dejan varias herramientas.
    #[test]
    fn el_enlace_de_localtime_se_lee_venga_como_venga() {
        // La función mira el sistema, así que acá se prueba la regla que usa:
        // encontrar el directorio de zonas adentro de la ruta y quedarse con lo
        // que sigue.
        for ruta in [
            "/usr/share/zoneinfo/Europe/Madrid",
            "../usr/share/zoneinfo/Europe/Madrid",
        ] {
            let desde = ruta.find(ZONEINFO).unwrap() + ZONEINFO.len();
            assert_eq!(&ruta[desde..], "Europe/Madrid");
        }
    }
}
