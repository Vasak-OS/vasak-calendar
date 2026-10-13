/**
 * Las vistas del calendario: día, N días, semana, mes, año y agenda.
 *
 * Va aparte de los componentes y sin nada de Vue adentro por lo mismo que
 * `mes.ts` y `zona.ts`: lo que cuesta acertar en un calendario no es dibujarlo
 * sino **contar los días** —cuáles entran en una semana, cuántos tiene un mes,
 * en qué año cae cada punta— y eso se equivoca en silencio. Acá se prueba sin
 * montar nada.
 *
 * ── Todo pasa en «la zona de la agenda» ─────────────────────────────────────
 *
 * Como en `mes.ts`: cada función recibe la zona y trabaja con **fechas
 * civiles** (lo que marca un reloj colgado en esa zona), nunca con los métodos
 * de `Date`, que contestan en la del sistema. Así, quien viaja y fija la hora
 * de su casa ve la semana y el día que espera y no los del país donde está.
 */

import { type CalendarEvent, cuadricula, type Dia } from '@/tools/mes';
import {
	type Civil,
	civilDe,
	claveCivil,
	columnaCivil,
	medianocheDe,
	mismoDiaCivil,
	primeroDeMesCivil,
	sumarDiasCivil,
} from '@/tools/zona';

/** Las vistas que se pueden elegir, en el orden del selector. */
export type CalendarView = 'day' | 'days' | 'week' | 'month' | 'year' | 'agenda';

/** El orden en el que se ofrecen, de lo más corto a lo más largo y la lista. */
export const CALENDAR_VIEWS: readonly CalendarView[] = [
	'day',
	'days',
	'week',
	'month',
	'year',
	'agenda',
] as const;

/**
 * Con qué vista se abre.
 *
 * El mes: es lo que se venía viendo y lo que casi todo el mundo quiere de un
 * calendario. Cambiarla es una preferencia de esta ventana, que se recuerda.
 */
export const DEFAULT_VIEW: CalendarView = 'month';

/**
 * Cuántos días muestra la vista «N días».
 *
 * Tres, que es lo que entra cómodo en una ventana angosta sin aplastar cada
 * columna y lo que ofrecen las aplicaciones de teléfono. Nombrado para que la
 * etiqueta y la aritmética digan el mismo número.
 */
export const DAYS_VIEW_COUNT = 3;

/** Los días de una semana. Nombrado para que la cuenta se lea. */
const WEEK_DAYS = 7;

/** Si un texto cualquiera es una vista conocida: lo guardado puede estar viejo. */
export function isCalendarView(value: unknown): value is CalendarView {
	return typeof value === 'string' && (CALENDAR_VIEWS as readonly string[]).includes(value);
}

/** Un día, con su medianoche como instante y su clave `AAAA-MM-DD`. */
function dayFrom(civil: Civil, zone: string, today: Civil, inMonth = true): Dia {
	return {
		fecha: medianocheDe(civil, zone),
		clave: claveCivil(civil),
		delMes: inMonth,
		esHoy: mismoDiaCivil(civil, today),
	};
}

/** `count` días seguidos desde `start`, contados por el calendario. */
function run(start: Civil, count: number, zone: string, today: Civil): Dia[] {
	const first: Civil = { ...start, hora: 0, minuto: 0 };
	return Array.from({ length: count }, (_, i) => dayFrom(sumarDiasCivil(first, i), zone, today));
}

/** Cuántos días tiene el mes de esa fecha civil. */
function daysInCivilMonth(civil: Civil): number {
	return sumarDiasCivil(primeroDeMesCivil(civil, 1), -1).dia;
}

/** Cuántos días tiene un año, contando el bisiesto sin reglas a mano. */
function daysInYear(year: number): number {
	return (Date.UTC(year + 1, 0, 1) - Date.UTC(year, 0, 1)) / 86_400_000;
}

/**
 * Los días que muestra una vista, en la zona de la agenda.
 *
 * Es lo que se dibuja y además **lo que se le pide al almacén**: el rango sale
 * de la primera y la última de estas celdas (`rangoDe` en `mes.ts`), así que si
 * acá entra un día de más o de menos, ese día aparece vacío sin que nada falle.
 *
 * - `day`: el día de `anchor`.
 * - `days`: `DAYS_VIEW_COUNT` días desde `anchor`.
 * - `week`: la semana de `anchor`, con el lunes primero —como la cuadrícula del
 *   mes (`columnaCivil`)—, para que las dos vistas empiecen la semana igual.
 * - `month`: las semanas del mes (reusa `cuadricula`, con su relleno).
 * - `year`: todos los días del año de `anchor`, para marcar cuáles tienen algo.
 * - `agenda`: los días del mes de `anchor`, que la lista recorre.
 */
export function viewDays(
	view: CalendarView,
	anchor: Date,
	zone: string,
	today: Date = new Date(),
	daysCount: number = DAYS_VIEW_COUNT
): Dia[] {
	const civil = civilDe(anchor, zone);
	const todayCivil = civilDe(today, zone);

	switch (view) {
		case 'month':
			return cuadricula(anchor, zone, today);
		case 'day':
			return run(civil, 1, zone, todayCivil);
		case 'days':
			return run(civil, Math.max(1, Math.trunc(daysCount)), zone, todayCivil);
		case 'week': {
			const monday = sumarDiasCivil(civil, -columnaCivil(civil));
			return run(monday, WEEK_DAYS, zone, todayCivil);
		}
		case 'agenda': {
			const first: Civil = { ...civil, dia: 1 };
			return run(first, daysInCivilMonth(civil), zone, todayCivil);
		}
		case 'year': {
			const jan1: Civil = { anio: civil.anio, mes: 1, dia: 1, hora: 0, minuto: 0 };
			return run(jan1, daysInYear(civil.anio), zone, todayCivil);
		}
	}
}

/**
 * Adónde lleva la flecha de ir atrás (`dir = -1`) o adelante (`dir = 1`), según
 * la vista: un día, N días, una semana, un mes, o un año entero.
 *
 * Para el mes, el año y la agenda cae en el **primero** del período nuevo, que
 * es su referencia; para el día, los N días y la semana corre `anchor` tal
 * cual, para no perder qué día se estaba mirando.
 */
export function stepAnchor(
	view: CalendarView,
	anchor: Date,
	zone: string,
	dir: number,
	daysCount: number = DAYS_VIEW_COUNT
): Date {
	const civil = civilDe(anchor, zone);

	switch (view) {
		case 'day':
			return medianocheDe(sumarDiasCivil(civil, dir), zone);
		case 'days':
			return medianocheDe(sumarDiasCivil(civil, dir * Math.max(1, Math.trunc(daysCount))), zone);
		case 'week':
			return medianocheDe(sumarDiasCivil(civil, dir * WEEK_DAYS), zone);
		case 'month':
		case 'agenda':
			return medianocheDe(primeroDeMesCivil(civil, dir), zone);
		case 'year':
			return medianocheDe({ anio: civil.anio + dir, mes: 1, dia: 1, hora: 0, minuto: 0 }, zone);
	}
}

/**
 * El título del período que se está mirando, en el idioma de la sesión y sin
 * traducirlo a mano (lo arma `Intl`).
 *
 * Lleva `timeZone` siempre: el período se guarda como un instante, y leído en
 * otra zona puede caer el día o el mes de al lado. Para la semana y los N días
 * es un rango —«13 – 19 oct 2026»— que arma `formatRange` cuando el motor lo
 * tiene, y si no, las dos puntas con un guión.
 */
export function periodTitle(
	view: CalendarView,
	anchor: Date,
	days: Dia[],
	zone: string,
	locale: string
): string {
	const base: Intl.DateTimeFormatOptions = { timeZone: zone };

	if (view === 'year') {
		return new Intl.DateTimeFormat(locale, { ...base, year: 'numeric' }).format(anchor);
	}
	if (view === 'month' || view === 'agenda') {
		return new Intl.DateTimeFormat(locale, { ...base, month: 'long', year: 'numeric' }).format(
			anchor
		);
	}
	if (view === 'day') {
		return new Intl.DateTimeFormat(locale, {
			...base,
			weekday: 'long',
			day: 'numeric',
			month: 'long',
			year: 'numeric',
		}).format(anchor);
	}

	const first = days[0]?.fecha ?? anchor;
	const last = days[days.length - 1]?.fecha ?? anchor;
	const fmt = new Intl.DateTimeFormat(locale, {
		...base,
		day: 'numeric',
		month: 'short',
		year: 'numeric',
	});
	return typeof fmt.formatRange === 'function'
		? fmt.formatRange(first, last)
		: `${fmt.format(first)} – ${fmt.format(last)}`;
}

/** Los eventos de un día ya repartidos, para una vista que recibe la función. */
export type EventsOf = (clave: string) => CalendarEvent[];

/**
 * Lo que recibe una vista que dibuja un rango de días: la cuadrícula del mes,
 * la agenda y las columnas de día lo comparten, así que su forma vive una sola
 * vez acá en vez de repetirse en cada componente.
 */
export interface DayRangeProps {
	/** Los días que la vista muestra. */
	days: Dia[];
	/** En qué zona se está mirando la agenda. Todo lo que dice una hora la usa. */
	zone: string;
	/** Los eventos de un día, ya repartidos. */
	eventsOf: EventsOf;
}
