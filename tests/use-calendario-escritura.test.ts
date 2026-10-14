/**
 * Las escrituras del composable: crear y borrar un evento.
 *
 * Lo que se comprueba es el puente con el programa —qué comando se llama, con
 * qué argumentos— y el borrado optimista, que saca el evento de la vista antes
 * de que el servidor conteste. La lógica de armar el parche vive en
 * `tools/event-form.ts` y se prueba aparte; acá se mira el orquesta.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { effectScope } from 'vue';
import { useCalendario } from '@/composables/use-calendario';
import type { CalendarEvent } from '@/tools/mes';
import { invocations, olvidarTodo, setAnswer, setFailure } from './dobles';

/** Un evento mínimo para la vista: para borrar sólo importa el `uid`. */
function evento(uid: string): CalendarEvent {
	return {
		uid,
		title: 'Reunión',
		start: '2026-09-15T14:00:00Z',
		end: '2026-09-15T15:00:00Z',
		all_day: false,
		recurring: false,
		shown_once: false,
		zone: '',
		calendar: 'google/1',
		color: null,
	};
}

/** Corre `useCalendario` en un ámbito propio, que se cierra al terminar. */
function enUnAmbito<T>(uso: (cal: ReturnType<typeof useCalendario>) => Promise<T>): Promise<T> {
	const scope = effectScope();
	const cal = scope.run(() => useCalendario());
	if (!cal) {
		throw new Error('no se pudo crear el composable');
	}
	return uso(cal).finally(() => scope.stop());
}

/** Lo último que se le pidió a un comando. */
function ultimaLlamada(comando: string): unknown {
	const suyas = invocations.filter((i) => i.command === comando);
	return suyas.at(-1)?.args;
}

beforeEach(() => {
	olvidarTodo();
});

afterEach(() => {
	olvidarTodo();
});

describe('crear', () => {
	test('llama a put_event con el parche serializado y sin ETag, y relee', async () => {
		setAnswer('listar_cuentas', []);
		setAnswer('store_events', { available: true, calendarios: [], eventos: [], fallos: [] });

		await enUnAmbito(async (cal) => {
			const fallo = await cal.writeEvent('google', '1', { summary: 'Hola' }, '');
			expect(fallo).toBeNull();

			expect(ultimaLlamada('put_event')).toEqual({
				accountId: 'google',
				calendarId: '1',
				payload: JSON.stringify({ summary: 'Hola' }),
				ifMatch: '',
			});
			// Releyó: volvió a pedir los eventos del almacén.
			expect(invocations.some((i) => i.command === 'store_events')).toBe(true);
		});
	});

	test('un fallo del programa vuelve como texto para el formulario', async () => {
		setAnswer('listar_cuentas', []);
		setFailure('put_event', 'la fecha no sirve');

		await enUnAmbito(async (cal) => {
			const fallo = await cal.writeEvent('google', '1', {}, '');
			expect(fallo).toBe('la fecha no sirve');
		});
	});
});

describe('editar', () => {
	test('pasa el ETag como ifMatch y el parche con id', async () => {
		setAnswer('listar_cuentas', []);
		setAnswer('store_events', { available: true, calendarios: [], eventos: [], fallos: [] });

		await enUnAmbito(async (cal) => {
			const fallo = await cal.writeEvent('google', '1', { id: 42, summary: 'Otro' }, '"etag-1"');
			expect(fallo).toBeNull();
			expect(ultimaLlamada('put_event')).toEqual({
				accountId: 'google',
				calendarId: '1',
				payload: JSON.stringify({ id: 42, summary: 'Otro' }),
				ifMatch: '"etag-1"',
			});
		});
	});
});

describe('conflictos', () => {
	test('getConflict parte el id global y pide la comparación', async () => {
		setAnswer('listar_cuentas', []);
		const comparison = {
			id: '42',
			op: 'put',
			local: 'LOCAL',
			server: 'SERVER',
			server_etag: '"srv"',
			server_unavailable: false,
		};
		setAnswer('get_conflict', comparison);

		await enUnAmbito(async (cal) => {
			const traido = await cal.getConflict('google/42');
			expect(traido).toEqual(comparison);
			expect(ultimaLlamada('get_conflict')).toEqual({ accountId: 'google', id: '42' });
		});
	});

	test('getConflict devuelve null si el id no tiene forma global', async () => {
		setAnswer('listar_cuentas', []);
		await enUnAmbito(async (cal) => {
			expect(await cal.getConflict('sin-barra')).toBeNull();
			expect(invocations.some((i) => i.command === 'get_conflict')).toBe(false);
		});
	});

	test('getConflict trata undefined como null (el id ya no está en conflicto)', async () => {
		setAnswer('listar_cuentas', []);
		await enUnAmbito(async (cal) => {
			expect(await cal.getConflict('google/42')).toBeNull();
		});
	});

	test('resolveConflict manda la elección y relee', async () => {
		setAnswer('listar_cuentas', []);
		setAnswer('store_events', { available: true, calendarios: [], eventos: [], fallos: [] });

		await enUnAmbito(async (cal) => {
			const fallo = await cal.resolveConflict('google/42', 'keep_local');
			expect(fallo).toBeNull();
			expect(ultimaLlamada('resolve_conflict')).toEqual({
				accountId: 'google',
				id: '42',
				choice: 'keep_local',
			});
			// Releyó: volvió a pedir los eventos del almacén.
			expect(invocations.some((i) => i.command === 'store_events')).toBe(true);
		});
	});

	test('resolveConflict de un id sin forma global no intenta nada', async () => {
		setAnswer('listar_cuentas', []);
		await enUnAmbito(async (cal) => {
			const fallo = await cal.resolveConflict('sin-barra', 'take_server');
			expect(fallo).toBe('editor.noSePuede');
			expect(invocations.some((i) => i.command === 'resolve_conflict')).toBe(false);
		});
	});

	test('un fallo al resolver vuelve como texto', async () => {
		setAnswer('listar_cuentas', []);
		setFailure('resolve_conflict', 'sin conexión');
		await enUnAmbito(async (cal) => {
			const fallo = await cal.resolveConflict('google/42', 'take_server');
			expect(fallo).toBe('sin conexión');
		});
	});
});

describe('borrar', () => {
	test('saca el evento de la vista ya y llama a delete_event', async () => {
		setAnswer('listar_cuentas', []);
		setAnswer('store_events', {
			available: true,
			calendarios: [],
			eventos: [evento('google/42'), evento('google/7')],
			fallos: [],
		});

		await enUnAmbito(async (cal) => {
			await cal.cargar();
			expect(cal.eventos.value).toHaveLength(2);

			const fallo = await cal.deleteEvent(evento('google/42'));
			expect(fallo).toBeNull();
			// Optimista: ya no está, sin esperar a releer.
			expect(cal.eventos.value.map((e) => e.uid)).toEqual(['google/7']);
			expect(ultimaLlamada('delete_event')).toEqual({
				accountId: 'google',
				eventId: '42',
				ifMatch: '',
			});
		});
	});

	test('un evento sin id global no se puede borrar', async () => {
		setAnswer('listar_cuentas', []);

		await enUnAmbito(async (cal) => {
			const fallo = await cal.deleteEvent(evento('sin-barra'));
			expect(fallo).toBe('editor.noSePuede');
			// No se intentó borrar nada.
			expect(invocations.some((i) => i.command === 'delete_event')).toBe(false);
		});
	});

	test('si el borrado falla, el evento vuelve a la vista', async () => {
		setAnswer('listar_cuentas', []);
		setAnswer('store_events', {
			available: true,
			calendarios: [],
			eventos: [evento('google/42')],
			fallos: [],
		});
		setFailure('delete_event', 'sin conexión');

		await enUnAmbito(async (cal) => {
			await cal.cargar();
			const fallo = await cal.deleteEvent(evento('google/42'));
			expect(fallo).toBe('sin conexión');
			// Se restauró: no se perdió.
			expect(cal.eventos.value.map((e) => e.uid)).toEqual(['google/42']);
		});
	});
});
