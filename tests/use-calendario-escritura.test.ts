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
