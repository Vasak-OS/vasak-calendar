/**
 * El estado de sincronización de un objeto del almacén, visto desde la ventana.
 *
 * Es lo común entre un evento y una tarea: los dos llegan del almacén con un
 * `sync_state` —`synced`, `pending` o `conflict`— y un `etag` que hace falta para
 * editar. El badge de «sin sincronizar», el aviso de conflicto y el candado de
 * editar miran estos dos campos y nada más, así que la lógica vive una sola vez
 * acá y la usan el calendario y las tareas por igual (en vez de una copia por
 * tipo que termine diciendo cada una una cosa).
 */

/** Lo mínimo para saber el estado de sincronización de un objeto del almacén. */
export interface SyncStatus {
	/**
	 * `synced` (al día, sin marca), `pending` (sin sincronizar) o `conflict`
	 * (chocó con el servidor y hay que resolverlo). Ausente en lecturas viejas,
	 * que se tratan como `synced`.
	 */
	sync_state?: string;
	/**
	 * El ETag del objeto, cuando el almacén lo entrega. Es lo que hace falta para
	 * editar (`if_match`); mientras no esté, editar queda en pausa. Vacío en una
	 * creación local sin confirmar.
	 */
	etag?: string | null;
}

/** Si un objeto está sin sincronizar: cambiado en local, todavía no en el servidor. */
export function isPending(item: SyncStatus): boolean {
	return item.sync_state === 'pending';
}

/** Si un objeto chocó con el servidor y espera que la persona lo resuelva. */
export function isConflict(item: SyncStatus): boolean {
	return item.sync_state === 'conflict';
}

/** Si un objeto se puede editar: tiene un ETag con el que pedir la precondición. */
export function canEdit(item: SyncStatus | null | undefined): boolean {
	return !!item?.etag;
}
