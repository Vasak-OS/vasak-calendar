/**
 * La lógica del formulario de un evento, sin nada de Vue: partir los
 * identificadores globales, validar lo que eligió la persona y armar el parche
 * JSON que entiende `PutEvent` del almacén (ver `store.rs`).
 *
 * Va aparte del componente porque es lo que decide qué se sube al servidor —y
 * una fecha mal armada o un rango dado vuelta no se ven hasta que el evento cae
 * de lugar—, así que se prueba sin montar nada.
 */

import { type IcalDate, pickerToIcal } from '@/tools/ical-date';

/** Lo que el formulario junta de la persona. */
export interface EventFormState {
	/** El título (`SUMMARY`). */
	summary: string;
	/** El calendario elegido, con su id global `cuenta/calendario`. */
	calendar: string;
	allDay: boolean;
	/** El valor del campo de comienzo: `AAAA-MM-DD` o `AAAA-MM-DDTHH:MM`. */
	start: string;
	/** El valor del campo de fin, en el mismo formato que `start`. */
	end: string;
	location: string;
	description: string;
}

/** Un id global partido en la cuenta y el número local del objeto. */
export interface GlobalParts {
	accountId: string;
	/** El número local, que es lo que piden `PutEvent`/`DeleteEvent`. */
	localId: string;
}

/**
 * Parte un id global `cuenta/número` en sus dos partes, por la **primera**
 * barra: la cuenta nunca tiene una, y el número es un entero. Devuelve `null` si
 * no tiene la forma esperada —falta una parte—, que la ventana trata como un
 * objeto que no se puede escribir.
 */
export function splitGlobalId(global: string): GlobalParts | null {
	const cut = global.indexOf('/');
	if (cut <= 0 || cut === global.length - 1) {
		return null;
	}
	return { accountId: global.slice(0, cut), localId: global.slice(cut + 1) };
}

/** El parche armado y a dónde mandarlo, o la clave del aviso de lo que falta. */
export type BuildResult =
	| {
			ok: true;
			accountId: string;
			/** El número local del calendario, para `PutEvent`. */
			calendarId: string;
			/** El objeto JSON que se serializa como `payload`. */
			patch: Record<string, unknown>;
	  }
	| { ok: false; error: string };

/**
 * Arma lo necesario para crear un evento a partir del formulario, o dice qué
 * falta con una clave de i18n.
 *
 * El parche de **crear** no lleva `id`; fija el título, el comienzo y el fin, y
 * la ubicación y la descripción sólo si se escribieron (en blanco no se mandan,
 * para no crear un evento con campos vacíos explícitos). Las fechas pasan por
 * `pickerToIcal`, que elige `DATE` o `DATE-TIME` según todo-el-día.
 */
export function buildCreate(state: EventFormState, zone: string): BuildResult {
	const summary = state.summary.trim();
	if (!summary) {
		return { ok: false, error: 'editor.faltaTitulo' };
	}
	const parts = splitGlobalId(state.calendar);
	if (!parts) {
		return { ok: false, error: 'editor.faltaCalendario' };
	}
	const start = pickerToIcal(state.start, zone, state.allDay);
	const end = pickerToIcal(state.end, zone, state.allDay);
	if (!start || !end) {
		return { ok: false, error: 'editor.fechaInvalida' };
	}
	if (!startsBeforeEnd(start, end)) {
		return { ok: false, error: 'editor.rangoInvalido' };
	}

	const patch: Record<string, unknown> = {
		summary,
		start,
		end,
	};
	const location = state.location.trim();
	if (location) {
		patch.location = location;
	}
	const description = state.description.trim();
	if (description) {
		patch.description = description;
	}

	return { ok: true, accountId: parts.accountId, calendarId: parts.localId, patch };
}

/**
 * Si el comienzo es anterior al fin, comparando los valores crudos de iCalendar.
 *
 * Los dos vienen del mismo formulario y en la misma forma —los dos `DATE` o los
 * dos `DATE-TIME`, misma zona—, así que comparar sus cadenas (`AAAAMMDD…`) los
 * ordena como fechas sin tener que resolver zonas. Un `DATE-TIME` en UTC trae la
 * `Z` al final, que no estorba porque los dos la traen o ninguno.
 */
function startsBeforeEnd(start: IcalDate, end: IcalDate): boolean {
	// Todo el día de un solo día: el fin puede ser igual al comienzo (el almacén
	// lo cierra en el día siguiente). Con hora, el fin tiene que ser posterior.
	const allDay = start.params.includes('VALUE=DATE');
	return allDay ? start.value <= end.value : start.value < end.value;
}
