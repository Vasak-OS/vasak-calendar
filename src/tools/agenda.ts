/**
 * El mes como una lista, para la ventana angosta.
 *
 * Por debajo de 36 rem de fila (`tools/narrow-layout.ts`) la cuadrícula queda
 * con siete columnas de unos 30 px: los eventos se ven como una hora cortada y
 * «+2 eventos más» se parte en tres renglones. Ahí el mes pasa a ser una
 * agenda, como en una aplicación de teléfono: los días que tienen algo, en
 * orden, con la hora y el título enteros.
 *
 * Lo que está acá es la parte que se puede equivocar en silencio —qué días
 * entran y qué hora se dice de un evento que no empieza ni termina ese día—, y
 * va sin Vue para probarlo sin montar nada. Los eventos ya vienen repartidos
 * por día y ordenados de `eventsByDay` (`tools/mes.ts`): esto no los vuelve a
 * repartir, así que la agenda y la cuadrícula no pueden decir cosas distintas.
 */

import type { CalendarEvent, Dia } from '@/tools/mes';
import { civilDe, claveCivil } from '@/tools/zona';

/** Un día de la agenda, con lo que tiene. */
export interface AgendaSection {
	day: Dia;
	events: CalendarEvent[];
}

/**
 * Los días de la agenda: los del mes que tienen algo, y hoy.
 *
 * **Sólo los del mes**, no el relleno de la cuadrícula: en la cuadrícula los
 * días de agosto que asoman en la primera fila se ven apagados y se entiende
 * que son de otro mes; en una lista no hay nada que los distinga, y el 31 de
 * agosto arriba del 1 de septiembre parecería un día más del mes.
 *
 * **Hoy entra aunque esté libre**: es adonde lleva «Hoy», y que el día se vea
 * con «nada» es justamente la respuesta a «¿tengo algo hoy?». Sin él, el botón
 * llevaría al primer día con algo y parecería que hoy ya pasó.
 */
export function agendaSections(
	days: Dia[],
	eventsOf: (key: string) => CalendarEvent[]
): AgendaSection[] {
	const sections: AgendaSection[] = [];
	for (const day of days) {
		if (!day.delMes) continue;
		const events = eventsOf(day.clave);
		if (events.length > 0 || day.esHoy) {
			sections.push({ day, events });
		}
	}
	return sections;
}

/**
 * Si la agenda no tiene nada que mostrar fuera de hoy.
 *
 * Un mes sin eventos se dice con el vacío y no con un único «hoy, nada»: así se
 * ve igual el mes que viene, que no tiene hoy, y el de este mes.
 */
export function isAgendaEmpty(sections: AgendaSection[]): boolean {
	return sections.every((section) => section.events.length === 0);
}

/**
 * A qué día lleva «Hoy»: el de hoy, o si no está en la lista el primero que
 * viene después, o el último si ya pasaron todos. Vacío si no hay ninguno.
 *
 * Hoy está siempre que se mira su mes (ver `agendaSections`), así que lo demás
 * es para cuando la lista se pide antes de que el mes termine de cambiar.
 */
export function todaySectionKey(sections: AgendaSection[], todayKey: string): string {
	const next = sections.find((section) => section.day.clave >= todayKey);
	return next?.day.clave ?? sections.at(-1)?.day.clave ?? '';
}

/**
 * Qué parte de un evento cae en ese día.
 *
 * - `all-day`: es de día completo, o es un día del medio de algo que dura más.
 * - `range`: empieza y termina ese día. Se dicen las dos horas.
 * - `from`: empieza ese día y sigue al siguiente. Se dice desde cuándo.
 * - `until`: viene del día anterior y termina ese día. Se dice hasta cuándo.
 * - `at`: no dura nada (sin final, o el final igual al comienzo). Se dice la
 *   hora sola: «desde las 9» de algo que no sigue no dice nada cierto.
 *
 * Sin esto, una guardia de las 22 a las 6 diría «22:00» también el día
 * siguiente, que es una hora a la que ya está terminando.
 */
export type EventSpan =
	| { kind: 'all-day' }
	| { kind: 'range'; start: Date; end: Date }
	| { kind: 'from'; start: Date }
	| { kind: 'at'; start: Date }
	| { kind: 'until'; end: Date };

export function eventSpanOn(event: CalendarEvent, dayKey: string, zone: string): EventSpan {
	if (event.all_day) return { kind: 'all-day' };

	const start = new Date(event.start);
	const end = new Date(event.end);
	const hasEnd = !Number.isNaN(end.getTime()) && end > start;
	const startKey = claveCivil(civilDe(start, zone));

	if (!hasEnd) {
		// Sin final (o uno que no se entiende) es un evento de un instante: se
		// dice su hora el día que empieza, que es el único donde lo pone
		// `eventsByDay`.
		return startKey === dayKey ? { kind: 'at', start } : { kind: 'all-day' };
	}

	// La medianoche exacta es el corte y no un día más, con el mismo criterio
	// que `eventsByDay`: algo que termina a las 0:00 del 16 no ocupa el 16.
	const endCivil = civilDe(end, zone);
	const atMidnight = endCivil.hora === 0 && endCivil.minuto === 0;
	const lastKey = claveCivil(
		atMidnight ? civilDe(new Date(end.getTime() - 60000), zone) : endCivil
	);

	const startsHere = startKey === dayKey;
	// Termina «ese día» con una hora que decir. Si termina a medianoche, el día
	// lo cubre hasta el final y no hay hora que valga la pena: «hasta las 0:00»
	// se lee como el principio del día y no como el final.
	const endsHere = lastKey === dayKey && !atMidnight;

	// Empieza y termina ese día, aunque sea a medianoche: «22:00 – 00:00» dice
	// bien una noche que termina justo al cambiar de día.
	if (startsHere && lastKey === dayKey) {
		return { kind: 'range', start, end };
	}
	if (startsHere) return { kind: 'from', start };
	if (endsHere) return { kind: 'until', end };
	return { kind: 'all-day' };
}
