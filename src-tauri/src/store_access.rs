//! Volver a pedir el permiso de leer el calendario guardado (ola 2 de «pedir
//! permiso de nuevo», anclado en la decisión 6 del taller).
//!
//! Cuando la ventana no tiene permiso para leer el calendario del almacén del
//! sistema, lo que ve la persona es un estado «sin permiso» (lo decide el
//! frontend a partir de la marca [`crate::store::STORE_PERMISSION_DENIED`]). Un
//! rechazo recordado no se vuelve a preguntar con sólo reintentar la lectura: el
//! chequeo de permiso de `vasak-permissions` sólo reabre el diálogo cuando la
//! decisión está en `unknown`. Para que reaparezca hace falta que el servicio
//! **olvide** la decisión de esta ventana sobre ese recurso, y para eso existe
//! `RequestAgain` (vasak-permissions#88):
//!
//! - va al servicio de permisos, en el **bus de sistema**
//!   (`ar.net.vasak.os.Permissions`);
//! - identifica a quien llama por su conexión (pid → `/proc/<pid>/exe`), así que
//!   sólo puede re-pedir **para sí mismo**: no lleva ninguna ruta de binario y
//!   toma sólo el id del recurso;
//! - **nunca concede**: lo más que hace es dejar la decisión en `unknown`, para
//!   que el próximo chequeo vuelva a abrir el diálogo;
//! - tiene un techo de frecuencia contra la fatiga de permisos: un segundo
//!   pedido demasiado seguido contesta `LimitsExceeded` y no reabre nada.
//!
//! Tras un re-pedido con éxito la ventana vuelve a leer el calendario, y es esa
//! lectura la que dispara el diálogo nuevo.
//!
//! ── Por qué este módulo cuenta para la cobertura ─────────────────────────────
//!
//! La clasificación del desenlace ([`classify`]) y el puente de la llamada
//! ([`request_again`]) son lógica pura que se prueba contra un servicio de
//! permisos de mentira, del otro lado de un par de sockets, sin tocar el bus de
//! sistema. Por eso viven acá y no en `comandos.rs`: lo único que no se prueba
//! es abrir el bus de sistema de verdad, que es el cuerpo del comando.

use serde::Serialize;
use zbus::Connection;

/// El servicio de permisos, en el bus de sistema. Son los mismos nombres que
/// `vasak_permissions_protocol::{SERVICE_NAME, SERVICE_PATH, SERVICE_INTERFACE,
/// REQUEST_AGAIN_METHOD}`; se escriben acá para no sumar esa dependencia —ni su
/// par de listas— por una sola llamada.
const SERVICE_NAME: &str = "ar.net.vasak.os.Permissions";
const SERVICE_PATH: &str = "/ar/net/vasak/os/Permissions";
const SERVICE_INTERFACE: &str = "ar.net.vasak.os.Permissions";
const REQUEST_AGAIN_METHOD: &str = "RequestAgain";

/// El recurso de `vasak-permissions` para leer el calendario guardado —los
/// eventos y las tareas—, distinto de `account.calendar`, que entrega la
/// credencial. Es `CALENDAR_RESOURCE` de `vasak-accounts/sync/src/access.rs`.
const CALENDAR_RESOURCE: &str = "store.calendar";

/// Lo que se le contesta a la ventana tras pedir volver a preguntar.
///
/// Son los cuatro desenlaces que la ventana sabe dibujar; cada error de D-Bus
/// de `RequestAgain` cae en uno ([`classify`]). El texto que ve la persona lo
/// pone el frontend en el idioma de la sesión: acá sólo viaja qué pasó.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum ReaskOutcome {
    /// Se olvidó la decisión anterior: el próximo chequeo reabre el diálogo. La
    /// ventana ya puede volver a leer el calendario.
    Reopened,
    /// Se volvió a pedir hace muy poco; el techo de frecuencia no reabrió nada.
    /// Hay que esperar un momento (`LimitsExceeded`).
    TooSoon,
    /// La ventana no puede pedir este recurso, así que tampoco volver a pedirlo
    /// (`AccessDenied`). No debería pasar: el calendario no está entre los
    /// binarios acotados, así que puede pedir el almacén.
    NotAllowed,
    /// Cualquier otra cosa: el servicio de permisos no está, o falló.
    Failed { detail: String },
}

/// Qué quiere decir el nombre de un error de D-Bus para la ventana.
fn classify_name(name: &str) -> Option<ReaskOutcome> {
    match name {
        "org.freedesktop.DBus.Error.LimitsExceeded" => Some(ReaskOutcome::TooSoon),
        "org.freedesktop.DBus.Error.AccessDenied" | "org.freedesktop.DBus.Error.AuthFailed" => {
            Some(ReaskOutcome::NotAllowed)
        }
        _ => None,
    }
}

/// Cómo se lee un error de `RequestAgain`.
fn classify(error: zbus::Error) -> ReaskOutcome {
    match &error {
        zbus::Error::MethodError(name, _, _) => {
            classify_name(name.as_str()).unwrap_or_else(|| ReaskOutcome::Failed {
                detail: error.to_string(),
            })
        }
        zbus::Error::FDO(fdo) => match fdo.as_ref() {
            zbus::fdo::Error::LimitsExceeded(_) => ReaskOutcome::TooSoon,
            zbus::fdo::Error::AccessDenied(_) | zbus::fdo::Error::AuthFailed(_) => {
                ReaskOutcome::NotAllowed
            }
            other => ReaskOutcome::Failed {
                detail: other.to_string(),
            },
        },
        _ => ReaskOutcome::Failed {
            detail: error.to_string(),
        },
    }
}

/// Llama a `RequestAgain(resource)` en `destination`, por `connection`. Partido
/// del comando para poder probar cada desenlace contra un servicio de permisos
/// de mentira, del otro lado de un par de sockets, sin tocar el bus de sistema.
async fn request_again(connection: &Connection, destination: &str, resource: &str) -> ReaskOutcome {
    match connection
        .call_method(
            Some(destination),
            SERVICE_PATH,
            Some(SERVICE_INTERFACE),
            REQUEST_AGAIN_METHOD,
            &(resource,),
        )
        .await
    {
        Ok(_) => ReaskOutcome::Reopened,
        Err(error) => classify(error),
    }
}

/// Le pide a `vasak-permissions` que vuelva a preguntar por el permiso de leer
/// el calendario guardado. Tras [`ReaskOutcome::Reopened`] la ventana relee el
/// calendario y el diálogo reaparece.
#[tauri::command]
pub async fn request_calendar_access_again() -> ReaskOutcome {
    let connection = match Connection::system().await {
        Ok(connection) => connection,
        Err(error) => {
            eprintln!(
                "[calendario] no se pudo abrir el bus de sistema para re-pedir el permiso: {error}"
            );
            return ReaskOutcome::Failed {
                detail: error.to_string(),
            };
        }
    };
    let outcome = request_again(&connection, SERVICE_NAME, CALENDAR_RESOURCE).await;
    if let ReaskOutcome::Failed { detail } = &outcome {
        eprintln!("[calendario] no se pudo volver a pedir el permiso: {detail}");
    }
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_bus::{self, PrivateBus};
    use std::sync::{Arc, Mutex};

    /// El nombre bajo el que el servicio de permisos de mentira toma el bus
    /// privado. No es el de verdad (`SERVICE_NAME`), para no chocar con nada; lo
    /// que importa es que `request_again` llame a ese nombre y le llegue.
    const PERMISSIONS_NAME: &str = "ar.net.vasak.os.Permissions.Test";

    /// Qué va a contestar el servicio de permisos de mentira a `RequestAgain`.
    #[derive(Clone, Copy, Default)]
    enum Answer {
        #[default]
        Ok,
        TooSoon,
        Denied,
        Failed,
    }

    /// Un `vasak-permissions` de mentira: contesta `RequestAgain` según `answer`
    /// y anota con qué recurso lo llamaron, para comprobar que va `store.calendar`
    /// y nada más.
    #[derive(Clone, Default)]
    struct FakePermissions {
        answer: Answer,
        resources: Arc<Mutex<Vec<String>>>,
    }

    #[zbus::interface(name = "ar.net.vasak.os.Permissions")]
    impl FakePermissions {
        fn request_again(&self, resource_id: String) -> zbus::fdo::Result<()> {
            self.resources.lock().unwrap().push(resource_id);
            match self.answer {
                Answer::Ok => Ok(()),
                Answer::TooSoon => {
                    Err(zbus::fdo::Error::LimitsExceeded("esperá un momento".into()))
                }
                Answer::Denied => Err(zbus::fdo::Error::AccessDenied("fuera de alcance".into())),
                Answer::Failed => Err(zbus::fdo::Error::Failed("se rompió".into())),
            }
        }
    }

    /// Publica el servicio de mentira en el bus privado y le hace tomar el nombre
    /// del servicio de permisos. Sin el par de sockets p2p —que pediría la
    /// característica `p2p` de zbus—: por el mismo `dbus-daemon` por prueba que
    /// usan las pruebas del almacén (`test_bus`). El servidor que devuelve tiene
    /// que seguir vivo mientras dure la prueba.
    async fn serve(bus: &PrivateBus, service: FakePermissions) -> Connection {
        zbus::connection::Builder::address(bus.address.as_str())
            .unwrap()
            .serve_at(SERVICE_PATH, service)
            .unwrap()
            .name(PERMISSIONS_NAME)
            .unwrap()
            .build()
            .await
            .unwrap()
    }

    /// Un cliente del mismo bus privado: `request_again` va por él al servicio de
    /// mentira, no por el bus de sistema.
    async fn client() -> Connection {
        Connection::session().await.unwrap()
    }

    #[tokio::test]
    async fn un_re_pedido_con_exito_reabre_el_dialogo_y_pide_el_recurso_del_calendario() {
        let _turno = test_bus::exclusive();
        let bus = PrivateBus::start();
        let service = FakePermissions {
            answer: Answer::Ok,
            ..Default::default()
        };
        let resources = service.resources.clone();
        let _server = serve(&bus, service).await;

        let outcome = request_again(&client().await, PERMISSIONS_NAME, CALENDAR_RESOURCE).await;

        assert_eq!(outcome, ReaskOutcome::Reopened);
        // Va exactamente el recurso del calendario guardado, y ninguno más.
        assert_eq!(
            *resources.lock().unwrap(),
            vec!["store.calendar".to_string()]
        );
    }

    #[tokio::test]
    async fn un_re_pedido_demasiado_seguido_es_too_soon() {
        let _turno = test_bus::exclusive();
        let bus = PrivateBus::start();
        let _server = serve(
            &bus,
            FakePermissions {
                answer: Answer::TooSoon,
                ..Default::default()
            },
        )
        .await;

        assert_eq!(
            request_again(&client().await, PERMISSIONS_NAME, CALENDAR_RESOURCE).await,
            ReaskOutcome::TooSoon
        );
    }

    #[tokio::test]
    async fn un_recurso_fuera_de_alcance_es_not_allowed() {
        let _turno = test_bus::exclusive();
        let bus = PrivateBus::start();
        let _server = serve(
            &bus,
            FakePermissions {
                answer: Answer::Denied,
                ..Default::default()
            },
        )
        .await;

        assert_eq!(
            request_again(&client().await, PERMISSIONS_NAME, CALENDAR_RESOURCE).await,
            ReaskOutcome::NotAllowed
        );
    }

    #[tokio::test]
    async fn cualquier_otro_error_es_failed() {
        let _turno = test_bus::exclusive();
        let bus = PrivateBus::start();
        let _server = serve(
            &bus,
            FakePermissions {
                answer: Answer::Failed,
                ..Default::default()
            },
        )
        .await;

        assert!(matches!(
            request_again(&client().await, PERMISSIONS_NAME, CALENDAR_RESOURCE).await,
            ReaskOutcome::Failed { .. }
        ));
    }

    #[test]
    fn los_errores_de_dbus_caen_en_un_desenlace() {
        assert_eq!(
            classify_name("org.freedesktop.DBus.Error.LimitsExceeded"),
            Some(ReaskOutcome::TooSoon)
        );
        assert_eq!(
            classify_name("org.freedesktop.DBus.Error.AccessDenied"),
            Some(ReaskOutcome::NotAllowed)
        );
        assert_eq!(
            classify_name("org.freedesktop.DBus.Error.AuthFailed"),
            Some(ReaskOutcome::NotAllowed)
        );
        assert_eq!(classify_name("org.freedesktop.DBus.Error.Failed"), None);
    }

    #[test]
    fn el_desenlace_viaja_con_su_nombre() {
        assert_eq!(
            serde_json::to_value(ReaskOutcome::Reopened).unwrap()["outcome"],
            "reopened"
        );
        assert_eq!(
            serde_json::to_value(ReaskOutcome::TooSoon).unwrap()["outcome"],
            "too_soon"
        );
        assert_eq!(
            serde_json::to_value(ReaskOutcome::NotAllowed).unwrap()["outcome"],
            "not_allowed"
        );
        let failed = serde_json::to_value(ReaskOutcome::Failed { detail: "x".into() }).unwrap();
        assert_eq!(failed["outcome"], "failed");
        assert_eq!(failed["detail"], "x");
    }

    #[test]
    fn el_recurso_es_el_del_calendario_guardado() {
        // Si cambiara acá y no en `access.rs` de vasak-accounts, el re-pedido
        // iría a un recurso que el servicio de permisos no acota, y el diálogo
        // no reaparecería nunca.
        assert_eq!(CALENDAR_RESOURCE, "store.calendar");
    }
}
