/**
 * Color y categorías de un evento (vasak-calendar#6, puntos 2 y 3).
 *
 * Sin nada de Vue adentro, al lado de `calendar-filter.ts` y con la misma
 * idea: qué categorías se ven es **preferencia de quien mira**, se guarda en el
 * navegador de la ventana y se combina con el filtro de calendarios sin
 * tocarlo (ver `use-calendario.ts`).
 */

import { loadHiddenCalendars, saveHiddenCalendars, toggleCalendar } from '@/tools/calendar-filter';
import type { CalendarEvent } from '@/tools/mes';

/** Dónde se guarda qué categorías se ocultaron. */
export const HIDDEN_CATEGORIES_KEY = 'vasak-calendar.hidden-categories';

/** Mismas reglas que para los calendarios: si no se puede leer, no se oculta nada. */
export const loadHiddenCategories = (): Set<string> => loadHiddenCalendars(HIDDEN_CATEGORIES_KEY);
export const saveHiddenCategories = (hidden: Set<string>): void =>
	saveHiddenCalendars(hidden, HIDDEN_CATEGORIES_KEY);
/** Oculta la categoría, o la muestra si ya estaba oculta. */
export const toggleCategory = toggleCalendar;

/**
 * El color de la marca del costado: el propio del evento si lo trae, y si no el
 * de su calendario. `null` si no hay ninguno (el que dibuja usa el acento). Un
 * color en blanco no es un color.
 */
export function markColor(event: CalendarEvent): string | null {
	return event.event_color?.trim() || event.color?.trim() || null;
}

/**
 * Las categorías que aparecen en esos eventos, sin repetir y en orden alfabético.
 * Se compara el texto tal cual: «Trabajo» y «trabajo» son dos categorías, como
 * en el servidor.
 */
export function categoriesIn(events: CalendarEvent[]): string[] {
	const found = new Set<string>();
	for (const event of events) {
		for (const category of event.categories ?? []) {
			const name = category.trim();
			if (name) {
				found.add(name);
			}
		}
	}
	return [...found].sort((a, b) => a.localeCompare(b));
}

/**
 * Los eventos con al menos una categoría que **no** está oculta.
 *
 * Un evento sin categorías se muestra siempre: no hay casilla que lo apague, y
 * esconder es decisión de la persona. Uno con varias se oculta recién cuando
 * están ocultas todas.
 */
export function filterByCategories(events: CalendarEvent[], hidden: Set<string>): CalendarEvent[] {
	if (hidden.size === 0) {
		return events;
	}
	return events.filter((event) => {
		const names = (event.categories ?? []).map((c) => c.trim()).filter(Boolean);
		return names.length === 0 || names.some((name) => !hidden.has(name));
	});
}
