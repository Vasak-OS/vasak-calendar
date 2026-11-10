/**
 * La lógica de la grilla horaria de día y semana, sin Vue: dónde cae cada
 * evento en la columna de un día y cómo se reparten los que se pisan.
 *
 * Todo se mide en la zona de la agenda (`civilDe`), nunca con `getHours()`, que
 * contestaría con el reloj del sistema. El tramo de cada evento en ese día
 * viene de `eventSpanOn` (`tools/agenda.ts`), el mismo que usa la lista, así
 * que la grilla y la lista no pueden decir horas distintas.
 *
 * shortcut: el día se toma de 24 h; en el día que cambia el horario de verano
 * la grilla queda una hora corrida desde el cambio. Arreglar si molesta.
 */

import { eventSpanOn } from '@/tools/agenda';
import type { CalendarEvent } from '@/tools/mes';
import { civilDe } from '@/tools/zona';

export const MINUTES_PER_DAY = 24 * 60;

/** Los minutos desde la medianoche de un instante, en la zona de la agenda. */
export function minutesOfDay(instant: Date, zone: string): number {
	const civil = civilDe(instant, zone);
	return civil.hora * 60 + civil.minuto;
}

/** Un evento ya ubicado en la columna de un día. Posiciones en minutos del día. */
export interface PlacedEvent {
	event: CalendarEvent;
	/** Minuto de comienzo del bloque, de 0 a 1440. */
	startMin: number;
	/** Minuto de fin del bloque, con el mínimo tocable ya aplicado. */
	endMin: number;
	/** La sub-columna donde va, desde 0. */
	column: number;
	/** En cuántas sub-columnas se reparte su grupo: el ancho es `1 / columns`. */
	columns: number;
}

/**
 * El tramo en minutos de un evento ese día, o `null` si va en la franja de todo
 * el día. `from` llega al fin del día, `until` arranca a las 0:00 y `at` es un
 * instante: se le da `minMinutes` para que se pueda tocar.
 */
export function eventRangeOn(
	event: CalendarEvent,
	dayKey: string,
	zone: string,
	minMinutes: number
): { startMin: number; endMin: number } | null {
	const span = eventSpanOn(event, dayKey, zone);
	let startMin: number;
	let endMin: number;
	switch (span.kind) {
		case 'all-day':
			return null;
		case 'range':
			startMin = minutesOfDay(span.start, zone);
			endMin = minutesOfDay(span.end, zone);
			// Termina a las 0:00 del día siguiente: cierra el día, no lo abre.
			if (endMin <= startMin) endMin = MINUTES_PER_DAY;
			break;
		case 'from':
			startMin = minutesOfDay(span.start, zone);
			endMin = MINUTES_PER_DAY;
			break;
		case 'until':
			startMin = 0;
			endMin = minutesOfDay(span.end, zone);
			break;
		default:
			startMin = minutesOfDay(span.start, zone);
			endMin = startMin;
	}
	endMin = Math.min(Math.max(endMin, startMin + minMinutes), MINUTES_PER_DAY);
	startMin = Math.min(startMin, endMin - minMinutes);
	return { startMin, endMin };
}

/**
 * Ubica los eventos con hora de un día y reparte los que se pisan en
 * sub-columnas lado a lado: se ordenan por comienzo y cada uno va a la primera
 * sub-columna libre; un grupo es una cadena de eventos que se tocan, y todos
 * los del grupo comparten el mismo número de sub-columnas. Los de todo el día
 * se dejan fuera (`allDayOf`).
 */
export function placeEvents(
	events: CalendarEvent[],
	dayKey: string,
	zone: string,
	minMinutes: number
): PlacedEvent[] {
	const items = events
		.flatMap((event) => {
			const range = eventRangeOn(event, dayKey, zone, minMinutes);
			return range ? [{ event, ...range, column: 0, columns: 1 }] : [];
		})
		.sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin);

	let group: typeof items = [];
	let groupEnd = 0;
	const closeGroup = () => {
		const columns = group.reduce((max, item) => Math.max(max, item.column + 1), 1);
		for (const item of group) item.columns = columns;
		group = [];
	};

	for (const item of items) {
		if (group.length > 0 && item.startMin >= groupEnd) closeGroup();
		// Primera sub-columna donde ningún evento del grupo se pisa con éste.
		let column = 0;
		while (group.some((g) => g.column === column && g.endMin > item.startMin)) column++;
		item.column = column;
		group.push(item);
		groupEnd = Math.max(groupEnd, item.endMin);
	}
	closeGroup();
	return items;
}

/** Los eventos de un día que van en la franja de arriba (todo el día). */
export function allDayOf(events: CalendarEvent[], dayKey: string, zone: string): CalendarEvent[] {
	return events.filter((event) => eventSpanOn(event, dayKey, zone).kind === 'all-day');
}
