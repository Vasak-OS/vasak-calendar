/**
 * La lógica del formulario de una tarea (`VTODO`), sin nada de Vue: validar lo
 * que eligió la persona y armar el parche JSON que entiende `PutTask` del almacén
 * (ver `store.rs` y `TaskPatch` en el servicio).
 *
 * Va aparte del componente por lo mismo que `event-form.ts`: es lo que decide qué
 * se sube al servidor —una fecha mal armada, un estado desconocido, una prioridad
 * fuera de rango no se ven hasta que la tarea cae mal—, así que se prueba sin
 * montar nada. Comparte con el evento el partir de los identificadores globales
 * (`splitGlobalId`) y el armado de fechas de iCalendar (`pickerToIcal`).
 */

import { splitGlobalId } from '@/tools/event-form';
import { pickerToIcal } from '@/tools/ical-date';

/** Los cuatro estados de una tarea, tal como los nombra `TaskPatch` del servicio. */
export type TaskStatus = 'NEEDS-ACTION' | 'IN-PROCESS' | 'COMPLETED' | 'CANCELLED';

/** Los estados que ofrece el formulario, en orden. */
export const TASK_STATUSES: readonly TaskStatus[] = [
	'NEEDS-ACTION',
	'IN-PROCESS',
	'COMPLETED',
	'CANCELLED',
] as const;

/**
 * La prioridad como la elige la persona. iCalendar la guarda de 1 (la más alta)
 * a 9, con 0 para «sin prioridad»; el formulario ofrece cuatro opciones legibles
 * y acá se traducen al número.
 */
export type TaskPriority = 'none' | 'high' | 'medium' | 'low';

/** Las prioridades que ofrece el formulario, en orden. */
export const TASK_PRIORITIES: readonly TaskPriority[] = ['none', 'high', 'medium', 'low'] as const;

/** El número de iCalendar de cada prioridad, o `null` para «sin prioridad» (sacar). */
const PRIORITY_VALUE: Record<TaskPriority, number | null> = {
	none: null,
	high: 1,
	medium: 5,
	low: 9,
};

/**
 * La prioridad legible a partir del número guardado (1–9), para abrir el
 * formulario de editar. 1–4 es alta, 5–7 media, 8–9 baja; 0 o nada, sin
 * prioridad. Es la vuelta de `PRIORITY_VALUE`, por tramos, para que un número
 * cualquiera del servidor caiga en algo y no en la nada.
 */
export function priorityFromNumber(value: number | null | undefined): TaskPriority {
	if (value === null || value === undefined || value === 0) {
		return 'none';
	}
	if (value <= 4) {
		return 'high';
	}
	if (value <= 7) {
		return 'medium';
	}
	return 'low';
}

/**
 * El estado legible a partir del que guarda el almacén (minúsculas, o vacío),
 * para abrir el formulario de editar. Lo desconocido —o la ausencia— cae en
 * `NEEDS-ACTION`, que es lo que es una tarea sin más.
 */
export function statusFromString(value: string | null | undefined): TaskStatus {
	const upper = (value ?? '').toUpperCase();
	return (TASK_STATUSES as readonly string[]).includes(upper)
		? (upper as TaskStatus)
		: 'NEEDS-ACTION';
}

/** Lo que el formulario junta de la persona. */
export interface TaskFormState {
	/** El título (`SUMMARY`). */
	summary: string;
	/** El calendario elegido, con su id global `cuenta/calendario`. */
	calendar: string;
	description: string;
	/** Si la tarea tiene vencimiento. Sin esto, el campo de fecha no cuenta. */
	hasDue: boolean;
	/** Si el vencimiento es un día entero (sin hora). */
	allDay: boolean;
	/** El valor del campo de vencimiento: `AAAA-MM-DD` o `AAAA-MM-DDTHH:MM`. */
	due: string;
	status: TaskStatus;
	priority: TaskPriority;
}

/** El parche armado y a dónde mandarlo, o la clave del aviso de lo que falta. */
export type TaskBuildResult =
	| {
			ok: true;
			accountId: string;
			/** El número local del calendario, para `PutTask`. */
			calendarId: string;
			/** El objeto JSON que se serializa como `payload`. */
			patch: Record<string, unknown>;
	  }
	| { ok: false; error: string };

/**
 * Arma el parche de los campos del formulario, o dice qué falta con una clave de
 * i18n. Es la parte común de crear y editar.
 *
 * - El **vencimiento** sólo se arma si la tarea lo tiene; con «sin vencimiento»
 *   se manda `null` para **sacarlo** (al crear no estorba: no había ninguno).
 *   Pasa por `pickerToIcal`, que elige `DATE` o `DATE-TIME` según todo-el-día.
 * - El **estado** siempre viaja: es un dominio chico y el formulario muestra el
 *   actual, así que fijarlo no pisa nada que la persona no vea.
 * - La **prioridad** se traduce a su número; «sin prioridad» la **saca** (`null`).
 * - La **descripción** en blanco no se manda (ausente), como en el evento: la
 *   escritura es conservadora y un campo que la vista no cargó no se pisa.
 */
function buildPatch(
	state: TaskFormState,
	zone: string
): { ok: true; patch: Record<string, unknown> } | { ok: false; error: string } {
	const summary = state.summary.trim();
	if (!summary) {
		return { ok: false, error: 'tareas.faltaTitulo' };
	}

	const patch: Record<string, unknown> = { summary };

	if (state.hasDue) {
		const due = pickerToIcal(state.due, zone, state.allDay);
		if (!due) {
			return { ok: false, error: 'tareas.fechaInvalida' };
		}
		patch.due = due;
	} else {
		// Sin vencimiento: se saca. Al crear no había ninguno, así que no estorba.
		patch.due = null;
	}

	patch.status = state.status;
	patch.priority = PRIORITY_VALUE[state.priority];

	const description = state.description.trim();
	if (description) {
		patch.description = description;
	}
	return { ok: true, patch };
}

/**
 * Arma lo necesario para **crear** una tarea, o dice qué falta con una clave de
 * i18n. El parche de crear no lleva `id`: el sincronizador genera el `UID`.
 */
export function buildCreateTask(state: TaskFormState, zone: string): TaskBuildResult {
	const parts = splitGlobalId(state.calendar);
	if (!parts) {
		return { ok: false, error: 'tareas.faltaCalendario' };
	}
	const built = buildPatch(state, zone);
	if (!built.ok) {
		return built;
	}
	return { ok: true, accountId: parts.accountId, calendarId: parts.localId, patch: built.patch };
}

/**
 * Arma lo necesario para **editar** una tarea, o dice qué falta con una clave de
 * i18n. A diferencia de crear, el parche lleva el `id` **local** de la tarea —el
 * número de `taskUid`, partido de su id global `cuenta/número`—, que es lo que
 * pide `PutTask` para saber cuál editar. La cuenta y el calendario salen de
 * `calendar` (el id global del calendario de la tarea), no del desplegable: al
 * editar no se puede mover de lista.
 */
export function buildEditTask(
	state: TaskFormState,
	zone: string,
	taskUid: string
): TaskBuildResult {
	const calendarParts = splitGlobalId(state.calendar);
	if (!calendarParts) {
		return { ok: false, error: 'tareas.faltaCalendario' };
	}
	const id = localIdOf(taskUid);
	if (id === null) {
		return { ok: false, error: 'tareas.noSePuede' };
	}
	const built = buildPatch(state, zone);
	if (!built.ok) {
		return built;
	}
	return {
		ok: true,
		accountId: calendarParts.accountId,
		calendarId: calendarParts.localId,
		patch: { id, ...built.patch },
	};
}

/**
 * Lo mínimo de una tarea para marcarla hecha o sin hacer: su id global y el de su
 * lista, y el ETag de precondición.
 */
export interface TaskRef {
	task_id: string;
	calendar_id: string;
	etag?: string | null;
}

/**
 * Arma el parche de **completar** (o descompletar) una tarea desde la casilla de
 * la lista. Completar fija el estado en `COMPLETED` y el porcentaje en 100;
 * descompletar vuelve a `NEEDS-ACTION` y 0, que es lo simétrico. Devuelve además
 * a dónde mandarlo y el ETag de precondición, o la clave del aviso si la tarea no
 * se puede identificar o todavía no tiene ETag.
 */
export function buildToggleDone(
	task: TaskRef,
	done: boolean
):
	| {
			ok: true;
			accountId: string;
			calendarId: string;
			patch: Record<string, unknown>;
			ifMatch: string;
	  }
	| { ok: false; error: string } {
	const id = localIdOf(task.task_id);
	const calendarParts = splitGlobalId(task.calendar_id);
	if (id === null || !calendarParts) {
		return { ok: false, error: 'tareas.noSePuede' };
	}
	// Completar o cambiar la tarea exige su ETag como precondición: sin él, la
	// tarea está pendiente de sincronizar y todavía no se puede tocar.
	const ifMatch = task.etag ?? '';
	if (!ifMatch) {
		return { ok: false, error: 'tareas.pendiente' };
	}
	const patch = done
		? { id, status: 'COMPLETED', percent_complete: 100 }
		: { id, status: 'NEEDS-ACTION', percent_complete: 0 };
	return {
		ok: true,
		accountId: calendarParts.accountId,
		calendarId: calendarParts.localId,
		patch,
		ifMatch,
	};
}

/** El número local de un id global `cuenta/número`, o `null` si no tiene esa forma. */
function localIdOf(global: string): number | null {
	const parts = splitGlobalId(global);
	if (!parts) {
		return null;
	}
	const id = Number(parts.localId);
	return Number.isInteger(id) && id > 0 ? id : null;
}
