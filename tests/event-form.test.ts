import { describe, expect, test } from 'bun:test';
import {
	buildCreate,
	buildEdit,
	type EventFormState,
	splitGlobalId,
} from '../src/tools/event-form';

const MADRID = 'Europe/Madrid';

function form(overrides: Partial<EventFormState> = {}): EventFormState {
	return {
		summary: 'Reunión',
		calendar: 'google/1',
		allDay: false,
		start: '2026-09-15T09:00',
		end: '2026-09-15T10:00',
		location: '',
		description: '',
		...overrides,
	};
}

describe('splitGlobalId', () => {
	test('parte por la primera barra: cuenta y número local', () => {
		expect(splitGlobalId('google/42')).toEqual({ accountId: 'google', localId: '42' });
	});

	test('la cuenta nunca tiene barra; el número es lo que queda detrás', () => {
		// Si algún día un número llevara barra, igual se parte por la primera: la
		// cuenta es lo de adelante.
		expect(splitGlobalId('cuenta/7')).toEqual({ accountId: 'cuenta', localId: '7' });
	});

	test('sin las dos partes se rechaza', () => {
		for (const basura of ['', '42', 'google/', '/42', 'google']) {
			expect(splitGlobalId(basura)).toBeNull();
		}
	});
});

describe('buildCreate', () => {
	test('arma el parche con título, comienzo y fin, sin id', () => {
		const result = buildCreate(form(), MADRID);
		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		expect(result.accountId).toBe('google');
		expect(result.calendarId).toBe('1');
		expect(result.patch).toEqual({
			summary: 'Reunión',
			start: { value: '20260915T090000', params: ['TZID=Europe/Madrid'] },
			end: { value: '20260915T100000', params: ['TZID=Europe/Madrid'] },
		});
		// Crear no lleva id.
		expect('id' in result.patch).toBe(false);
	});

	test('la ubicación y la descripción van sólo si se escribieron', () => {
		const result = buildCreate(form({ location: '  Sala 2  ', description: 'Traer notas' }), MADRID);
		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		expect(result.patch.location).toBe('Sala 2');
		expect(result.patch.description).toBe('Traer notas');
	});

	test('en blanco no se mandan: un evento nuevo no nace con campos vacíos', () => {
		const result = buildCreate(form({ location: '   ', description: '' }), MADRID);
		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		expect('location' in result.patch).toBe(false);
		expect('description' in result.patch).toBe(false);
	});

	test('todo el día usa fechas DATE y recorta el título', () => {
		const result = buildCreate(
			form({ summary: '  Feriado  ', allDay: true, start: '2026-09-15', end: '2026-09-15' }),
			MADRID
		);
		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		expect(result.patch.summary).toBe('Feriado');
		expect(result.patch.start).toEqual({ value: '20260915', params: ['VALUE=DATE'] });
	});

	test('sin título no se puede guardar', () => {
		const result = buildCreate(form({ summary: '   ' }), MADRID);
		expect(result).toEqual({ ok: false, error: 'editor.faltaTitulo' });
	});

	test('sin calendario válido no se puede guardar', () => {
		const result = buildCreate(form({ calendar: '' }), MADRID);
		expect(result).toEqual({ ok: false, error: 'editor.faltaCalendario' });
	});

	test('una fecha a medio escribir se rechaza', () => {
		const result = buildCreate(form({ start: '2026-09-15' }), MADRID);
		expect(result).toEqual({ ok: false, error: 'editor.fechaInvalida' });
	});

	test('el fin antes del comienzo se rechaza', () => {
		const result = buildCreate(form({ start: '2026-09-15T10:00', end: '2026-09-15T09:00' }), MADRID);
		expect(result).toEqual({ ok: false, error: 'editor.rangoInvalido' });
	});

	test('con hora, un fin igual al comienzo no sirve', () => {
		const result = buildCreate(form({ start: '2026-09-15T09:00', end: '2026-09-15T09:00' }), MADRID);
		expect(result).toEqual({ ok: false, error: 'editor.rangoInvalido' });
	});

	test('todo el día de un solo día sí sirve (fin igual al comienzo)', () => {
		const result = buildCreate(
			form({ allDay: true, start: '2026-09-15', end: '2026-09-15' }),
			MADRID
		);
		expect(result.ok).toBe(true);
	});
});

describe('buildEdit', () => {
	test('el parche lleva el id local del evento, como número', () => {
		const result = buildEdit(form(), MADRID, 'google/42');
		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		// La cuenta y el calendario salen del calendario del evento, no del id.
		expect(result.accountId).toBe('google');
		expect(result.calendarId).toBe('1');
		expect(result.patch.id).toBe(42);
		expect(result.patch.summary).toBe('Reunión');
		expect(result.patch.start).toEqual({
			value: '20260915T090000',
			params: ['TZID=Europe/Madrid'],
		});
	});

	test('la ubicación y la descripción en blanco no se mandan: no se pisa lo que la vista no cargó', () => {
		const result = buildEdit(form({ location: '', description: '' }), MADRID, 'google/42');
		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		expect('location' in result.patch).toBe(false);
		expect('description' in result.patch).toBe(false);
	});

	test('la ubicación y la descripción escritas sí van, recortadas', () => {
		const result = buildEdit(
			form({ location: '  Sala 2  ', description: 'Notas' }),
			MADRID,
			'google/42'
		);
		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		expect(result.patch.location).toBe('Sala 2');
		expect(result.patch.description).toBe('Notas');
	});

	test('un id de evento sin la forma cuenta/número no se puede editar', () => {
		for (const basura of ['', 'sin-barra', 'google/', 'google/abc', 'google/0', 'google/-3']) {
			expect(buildEdit(form(), MADRID, basura)).toEqual({ ok: false, error: 'editor.noSePuede' });
		}
	});

	test('sin calendario válido se avisa antes de mirar el id', () => {
		expect(buildEdit(form({ calendar: '' }), MADRID, 'google/42')).toEqual({
			ok: false,
			error: 'editor.faltaCalendario',
		});
	});

	test('arrastra las mismas validaciones de fecha y título que crear', () => {
		expect(buildEdit(form({ summary: '  ' }), MADRID, 'google/42')).toEqual({
			ok: false,
			error: 'editor.faltaTitulo',
		});
		expect(
			buildEdit(form({ start: '2026-09-15T10:00', end: '2026-09-15T09:00' }), MADRID, 'google/42')
		).toEqual({ ok: false, error: 'editor.rangoInvalido' });
	});
});
