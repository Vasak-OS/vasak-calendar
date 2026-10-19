/**
 * Elegir qué calendarios se ven (vasak-calendar#6, punto 1).
 *
 * Aparte de los componentes y sin nada de Vue adentro: una regla que se
 * equivoca en silencio —un calendario que se cree oculto y sigue a la vista—
 * conviene poder probarla sin la ventana.
 *
 * Qué calendarios se ven es **preferencia de quien mira**, no un dato del
 * servidor: se guarda en el navegador de la ventana, por URL de calendario
 * (`CalendarEvent.calendar` es el `url` del `Calendario`).
 */

import type { CalendarEvent } from '@/tools/mes';

/** Dónde se guarda, en el navegador de la ventana, qué calendarios se ocultaron. */
export const HIDDEN_CALENDARS_KEY = 'vasak-calendar.hidden-calendars';

/**
 * Lee qué calendarios estaban ocultos. Si no se puede —una ventana privada, el
 * almacenamiento bloqueado, un valor que alguien ensució—, no se oculta
 * ninguno: ver de más es mejor que esconder lo que la persona no pidió esconder.
 */
export function loadHiddenCalendars(): Set<string> {
	try {
		const raw = globalThis.localStorage?.getItem(HIDDEN_CALENDARS_KEY);
		const parsed: unknown = raw ? JSON.parse(raw) : [];
		if (!Array.isArray(parsed)) {
			return new Set();
		}
		return new Set(parsed.filter((item): item is string => typeof item === 'string'));
	} catch {
		return new Set();
	}
}

/**
 * Guarda qué calendarios se ocultaron. Si no se puede, el filtro vale igual
 * para esta sesión; sólo no se recuerda para la próxima.
 */
export function saveHiddenCalendars(hidden: Set<string>): void {
	try {
		globalThis.localStorage?.setItem(HIDDEN_CALENDARS_KEY, JSON.stringify([...hidden]));
	} catch {
		// No recordar la preferencia no rompe nada que se esté viendo ahora.
	}
}

/** El conjunto con el calendario ocultado, o mostrado si ya estaba oculto. */
export function toggleCalendar(hidden: Set<string>, url: string): Set<string> {
	const next = new Set(hidden);
	if (!next.delete(url)) {
		next.add(url);
	}
	return next;
}

/**
 * Los eventos de los calendarios que **no** están ocultos.
 *
 * Un evento que llegó sin calendario (`calendar` vacío) se muestra: esconder es
 * una decisión de la persona, y lo que no está en la lista no es una decisión.
 */
export function filterByCalendars(events: CalendarEvent[], hidden: Set<string>): CalendarEvent[] {
	if (hidden.size === 0) {
		return events;
	}
	return events.filter((event) => !hidden.has(event.calendar));
}
