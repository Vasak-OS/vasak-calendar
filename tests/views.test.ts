/**
 * La aritmética de las vistas: qué días entra cada una y adónde lleva cada
 * flecha.
 *
 * Es lo que se equivoca en silencio —una semana corrida un día, un año al que
 * le falta el 31 de diciembre— y acota lo que se le pide al almacén, así que un
 * día de más o de menos acá deja ese día vacío sin que nada falle. Todo en UTC,
 * que es puro calendario y no tiene horario de verano que corra las puntas.
 */

import { describe, expect, test } from 'bun:test';
import {
	type CalendarView,
	CALENDAR_VIEWS,
	DAYS_VIEW_COUNT,
	isCalendarView,
	periodTitle,
	stepAnchor,
	viewDays,
} from '@/tools/views';
import { claveCivil, civilDe } from '@/tools/zona';

const ZONE = 'UTC';
// Un jueves cualquiera, y un «hoy» bien lejos para que `esHoy` no moleste.
const ANCHOR = new Date('2026-10-15T00:00:00Z');
const FAR = new Date('2000-01-01T00:00:00Z');

/** Las claves `AAAA-MM-DD` de los días de una vista, para compararlas. */
function keys(view: CalendarView): string[] {
	return viewDays(view, ANCHOR, ZONE, FAR).map((d) => d.clave);
}

describe('qué días muestra cada vista', () => {
	test('el día, uno solo', () => {
		expect(keys('day')).toEqual(['2026-10-15']);
	});

	test('N días, los que diga la constante desde el día de foco', () => {
		expect(DAYS_VIEW_COUNT).toBe(3);
		expect(keys('days')).toEqual(['2026-10-15', '2026-10-16', '2026-10-17']);
	});

	test('la semana empieza el lunes, como la cuadrícula del mes', () => {
		// El 15 es jueves: su semana va del lunes 12 al domingo 18.
		expect(keys('week')).toEqual([
			'2026-10-12',
			'2026-10-13',
			'2026-10-14',
			'2026-10-15',
			'2026-10-16',
			'2026-10-17',
			'2026-10-18',
		]);
	});

	test('el mes trae su cuadrícula entera, con el relleno de los bordes', () => {
		const days = viewDays('month', ANCHOR, ZONE, FAR);
		// Semanas completas de siete días, y el 1 del mes adentro.
		expect(days.length % 7).toBe(0);
		expect(days.some((d) => d.clave === '2026-10-01' && d.delMes)).toBe(true);
	});

	test('la agenda, los días propios del mes', () => {
		const days = viewDays('agenda', ANCHOR, ZONE, FAR);
		expect( days).toHaveLength(31);
		expect( days[0].clave).toBe('2026-10-01');
		expect( days.at(-1)?.clave).toBe('2026-10-31');
		expect( days.every((d) => d.delMes)).toBe(true);
	});

	test('el año, del 1 de enero al 31 de diciembre', () => {
		const days = viewDays('year', ANCHOR, ZONE, FAR);
		expect(days).toHaveLength(365);
		expect(days[0].clave).toBe('2026-01-01');
		expect(days.at(-1)?.clave).toBe('2026-12-31');
	});

	test('un año bisiesto tiene un día más', () => {
		const days = viewDays('year', new Date('2028-06-01T00:00:00Z'), ZONE, FAR);
		expect(days).toHaveLength(366);
		expect(days.at(-1)?.clave).toBe('2028-12-31');
	});

	test('hoy se marca en la zona de la agenda', () => {
		const days = viewDays('day', ANCHOR, ZONE, ANCHOR);
		expect(days[0].esHoy).toBe(true);
	});
});

describe('adónde lleva cada flecha', () => {
	const of = (view: CalendarView, dir: number) =>
		claveCivil(civilDe(stepAnchor(view, ANCHOR, ZONE, dir), ZONE));

	test('el día, de a uno', () => {
		expect(of('day', 1)).toBe('2026-10-16');
		expect(of('day', -1)).toBe('2026-10-14');
	});

	test('N días, de a N', () => {
		expect(of('days', 1)).toBe('2026-10-18');
		expect(of('days', -1)).toBe('2026-10-12');
	});

	test('la semana, de a siete', () => {
		expect(of('week', 1)).toBe('2026-10-22');
		expect(of('week', -1)).toBe('2026-10-08');
	});

	test('el mes y la agenda caen en el primero del mes nuevo', () => {
		expect(of('month', 1)).toBe('2026-11-01');
		expect(of('month', -1)).toBe('2026-09-01');
		expect(of('agenda', 1)).toBe('2026-11-01');
	});

	test('el año cae en el 1 de enero del año nuevo', () => {
		expect(of('year', 1)).toBe('2027-01-01');
		expect(of('year', -1)).toBe('2025-01-01');
	});
});

describe('el título del período', () => {
	const title = (view: CalendarView) => periodTitle(view, ANCHOR, viewDays(view, ANCHOR, ZONE, FAR), ZONE, 'en-US');

	test('el año es el número solo', () => {
		expect(title('year')).toBe('2026');
	});

	test('el mes y la agenda, mes y año', () => {
		expect(title('month')).toBe('October 2026');
		expect(title('agenda')).toBe('October 2026');
	});

	test('el día, el día entero', () => {
		expect(title('day')).toBe('Thursday, October 15, 2026');
	});

	test('la semana y los N días, un rango con el año', () => {
		for (const view of ['week', 'days'] as const) {
			const text = title(view);
			expect(text).toContain('2026');
			expect(text).toContain('Oct');
		}
	});
});

describe('las vistas conocidas', () => {
	test('la lista está completa y en orden', () => {
		expect(CALENDAR_VIEWS).toEqual(['day', 'days', 'week', 'month', 'year', 'agenda']);
	});

	test('reconoce una vista y descarta cualquier otra cosa', () => {
		expect(isCalendarView('week')).toBe(true);
		expect(isCalendarView('semana')).toBe(false);
		expect(isCalendarView(null)).toBe(false);
		expect(isCalendarView(undefined)).toBe(false);
	});
});
