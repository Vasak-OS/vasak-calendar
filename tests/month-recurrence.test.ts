/**
 * La marca de repetición en la cuadrícula del mes.
 *
 * Una serie expandida sale una vez por instancia, cada una con `recurring`; una
 * que no se pudo expandir sale una sola vez con `shown_once`, y eso **se dice**:
 * sin el aviso, una reunión semanal parece única y las demás semanas parecen
 * libres. Sin catálogo cargado, `t()` devuelve la clave, así que se comparan
 * claves.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mount, type VueWrapper } from '@vue/test-utils';
import MesComponent from '@/components/calendario/MesComponent.vue';
import { type CalendarEvent, cuadricula } from '@/tools/mes';

let vista: VueWrapper | null = null;

afterEach(() => {
	vista?.unmount();
	vista = null;
});

function event(extra: Partial<CalendarEvent>): CalendarEvent {
	return {
		uid: 'serie',
		title: 'Reunión',
		start: '2026-09-15T14:00:00+00:00',
		end: '2026-09-15T15:00:00+00:00',
		all_day: false,
		recurring: false,
		shown_once: false,
		zone: '',
		calendar: 'https://nube.ejemplo.com/dav/calendars/ana/personal/',
		color: null,
		...extra,
	};
}

function marksFor(extra: Partial<CalendarEvent>): string[] {
	const dias = cuadricula(new Date('2026-09-15T12:00:00Z'), 'UTC');
	vista = mount(MesComponent, {
		props: {
			dias,
			zona: 'UTC',
			eventsOf: (clave: string) => (clave === '2026-09-15' ? [event(extra)] : []),
		},
	});
	return vista
		.findAll('span[aria-label]')
		.filter((s) => s.text() === '↻')
		.map((s) => s.attributes('aria-label') ?? '');
}

describe('la marca de repetición', () => {
	test('un evento suelto no la lleva', () => {
		expect(marksFor({})).toEqual([]);
	});

	test('una instancia de una serie dice que se repite, y nada más', () => {
		expect(marksFor({ recurring: true })).toEqual(['calendario.recurring']);
	});

	test('una serie que no se pudo expandir dice que se muestra sólo el día que empieza', () => {
		const [mark] = marksFor({ recurring: true, shown_once: true });
		expect(mark).toContain('calendario.recurring');
		expect(mark).toContain('calendario.shownOnce');
	});
});
