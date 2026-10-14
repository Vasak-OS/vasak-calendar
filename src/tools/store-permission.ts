/**
 * El permiso del almacén del calendario, visto desde la ventana.
 *
 * El programa de Rust no muestra texto: cuando la persona negó el almacén
 * devuelve una marca ([`STORE_PERMISSION_DENIED`]), y cuando se vuelve a pedir
 * el permiso devuelve un desenlace ([`ReaskOutcome`]). La ventana los traduce,
 * así el mensaje sale en el idioma de la sesión y no en el que estaba compilado
 * el backend, y la ventana decide qué pintar —el estado de «sin permiso» con su
 * botón, o un aviso al pie— sin leer una frase traducida.
 *
 * La marca tiene que coincidir letra por letra con la de
 * `src-tauri/src/store.rs`; los desenlaces, con `src-tauri/src/store_access.rs`.
 */

/** Lo que devuelve `store_events` cuando la persona negó el almacén. */
export const STORE_PERMISSION_DENIED = 'store-permission-denied';

/** Si el error de un comando es ese «no» al almacén. */
export function isStorePermissionDenied(error: unknown): boolean {
	return String(error) === STORE_PERMISSION_DENIED;
}

/**
 * Los cuatro desenlaces de volver a pedir el permiso del calendario, tal como
 * los serializa `ReaskOutcome` de Rust.
 *
 * - `reopened`: se olvidó la decisión anterior; el próximo pedido de eventos
 *   reabre el diálogo, así que hay que releer.
 * - `too_soon`: se volvió a pedir hace muy poco (el techo contra la fatiga de
 *   permisos); hay que esperar un momento.
 * - `not_allowed`: la ventana no puede pedir este recurso (no debería pasar).
 * - `failed`: el servicio de permisos no está, o falló.
 */
export type ReaskOutcome =
	| { outcome: 'reopened' }
	| { outcome: 'too_soon' }
	| { outcome: 'not_allowed' }
	| { outcome: 'failed'; detail: string };

/** Si el desenlace reabrió el diálogo: entonces hay que releer el calendario. */
export function shouldReread(outcome: ReaskOutcome | null | undefined): boolean {
	return outcome?.outcome === 'reopened';
}

/**
 * La clave de traducción del aviso para un desenlace, o `null` cuando se reabrió
 * el diálogo —ahí no hay nada que avisar, se relee—. Un desenlace desconocido
 * cae en el mensaje genérico, nunca en algo crudo.
 */
export function reaskNoticeKey(outcome: ReaskOutcome | null | undefined): string | null {
	switch (outcome?.outcome) {
		case 'reopened':
			return null;
		case 'too_soon':
			return 'permiso.limite';
		case 'not_allowed':
			return 'permiso.denegado';
		default:
			return 'permiso.error';
	}
}
