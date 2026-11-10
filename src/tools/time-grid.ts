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
import { splitGlobalId } from '@/tools/event-form';
import { isoToDateTimePicker, pickerToIcal } from '@/tools/ical-date';
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

/** El paso del arrastre: lo que se mueve o se estira cae en múltiplos de 15 min. */
export const SNAP_MINUTES = 15;
/** Lo mínimo que puede durar un evento al estirarlo. */
export const MIN_DURATION_MINUTES = 15;

export type DragMode = 'move' | 'resize';
export interface MinuteRange {
	startMin: number;
	endMin: number;
}

const snap = (minutes: number) => Math.round(minutes / SNAP_MINUTES) * SNAP_MINUTES;
const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high);

/**
 * El tramo resultante de arrastrar `deltaMin` minutos. Mover corre el comienzo
 * (con snap) y conserva la duración, sin salirse del día; estirar corre el fin
 * (con snap), con duración mínima y sin pasar de las 24:00.
 */
export function dragRange(mode: DragMode, range: MinuteRange, deltaMin: number): MinuteRange {
	if (mode === 'resize') {
		const endMin = clamp(
			snap(range.endMin + deltaMin),
			range.startMin + MIN_DURATION_MINUTES,
			MINUTES_PER_DAY
		);
		return { startMin: range.startMin, endMin };
	}
	const length = range.endMin - range.startMin;
	const startMin = clamp(snap(range.startMin + deltaMin), 0, MINUTES_PER_DAY - length);
	return { startMin, endMin: startMin + length };
}

/**
 * Si el evento se puede mover o estirar en esa columna: tiene ETag (sin él la
 * edición está en pausa), ids que se pueden escribir y es un tramo entero de ese
 * día. Los de todo el día y los que siguen o vienen de otro día quedan fuera.
 */
export function isDraggableOn(event: CalendarEvent, dayKey: string, zone: string): boolean {
	const kind = eventSpanOn(event, dayKey, zone).kind;
	return (
		!!event.etag &&
		!event.all_day &&
		(kind === 'range' || kind === 'at') &&
		splitGlobalId(event.uid) !== null &&
		splitGlobalId(event.calendar) !== null
	);
}

/** `AAAA-MM-DDTHH:MM` del minuto `minutes` (puede ser 1440) de un día civil. */
function dayAt(dayKey: string, minutes: number): string {
	return new Date(Date.parse(`${dayKey}T00:00:00Z`) + minutes * 60_000).toISOString().slice(0, 16);
}

/**
 * Los valores de comienzo y fin (como los del formulario) de un evento ya
 * movido o estirado a `range` en `dayKey`. Mover conserva la duración real del
 * evento (no la del bloque agrandado); estirar deja el comienzo como estaba.
 * El fin es `null` si el evento no tenía.
 */
export function draggedValues(
	mode: DragMode,
	event: CalendarEvent,
	zone: string,
	dayKey: string,
	range: MinuteRange
): { start: string; end: string | null } {
	if (mode === 'resize') {
		return { start: isoToDateTimePicker(event.start, zone), end: dayAt(dayKey, range.endMin) };
	}
	const real = event.end ? (Date.parse(event.end) - Date.parse(event.start)) / 60_000 : null;
	return {
		start: dayAt(dayKey, range.startMin),
		end: real === null ? null : dayAt(dayKey, range.startMin + real),
	};
}

/**
 * El parche **conservador** de un cambio de hora: sólo `{ id, start, end }`, lo
 * demás no se toca (ver `store::put_event`). La cuenta y el calendario salen
 * como en `buildEdit`. `null` si algo no se puede escribir.
 */
export function buildTimeChange(
	event: CalendarEvent,
	zone: string,
	values: { start: string; end: string | null }
): { accountId: string; calendarId: string; patch: Record<string, unknown> } | null {
	const calendar = splitGlobalId(event.calendar);
	const id = Number(splitGlobalId(event.uid)?.localId);
	const start = pickerToIcal(values.start, zone, false);
	const end = values.end === null ? null : pickerToIcal(values.end, zone, false);
	if (!calendar || !Number.isInteger(id) || id <= 0 || !start || (values.end !== null && !end)) {
		return null;
	}
	const patch: Record<string, unknown> = { id, start };
	if (end) patch.end = end;
	return { accountId: calendar.accountId, calendarId: calendar.localId, patch };
}
