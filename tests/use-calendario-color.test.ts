/**
 * Cambiar el color de un calendario: el puente del composable con el programa.
 *
 * Se comprueba qué comando se llama y con qué argumentos, que un id que no
 * parte no llega al programa, y cómo se informa el fallo.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { effectScope } from 'vue';
import { useCalendario } from '@/composables/use-calendario';
import { STORE_PERMISSION_DENIED } from '@/tools/store-permission';
import { invocations, olvidarTodo, setAnswer, setFailure } from './dobles';

/** Corre `useCalendario` en un ámbito propio, que se cierra al terminar. */
function enUnAmbito<T>(uso: (cal: ReturnType<typeof useCalendario>) => Promise<T>): Promise<T> {
	const scope = effectScope();
	const cal = scope.run(() => useCalendario());
	if (!cal) {
		throw new Error('no se pudo crear el composable');
	}
	return uso(cal).finally(() => scope.stop());
}

function preparar() {
	setAnswer('listar_cuentas', []);
	setAnswer('store_events', { available: true, calendarios: [], eventos: [], fallos: [] });
	setAnswer('set_calendar_color', null);
}

beforeEach(olvidarTodo);
afterEach(olvidarTodo);

describe('cambiar el color de un calendario', () => {
	test('llama a set_calendar_color con la cuenta y el calendario partidos, y devuelve null', async () => {
		preparar();
		await enUnAmbito(async (cal) => {
			expect(typeof cal.setCalendarColor).toBe('function');
			const fallo = await cal.setCalendarColor('cuenta/7', '#FF0000');
			expect(fallo).toBeNull();
			const llamada = invocations.filter((i) => i.command === 'set_calendar_color');
			expect(llamada).toHaveLength(1);
			expect(llamada[0].args).toEqual({
				accountId: 'cuenta',
				calendarId: '7',
				color: '#FF0000',
			});
			// Releyó los calendarios para ver el color nuevo.
			expect(invocations.some((i) => i.command === 'store_events')).toBe(true);
		});
	});

	test('un calendario sin id global no se toca y avisa que no se puede', async () => {
		preparar();
		await enUnAmbito(async (cal) => {
			const fallo = await cal.setCalendarColor('sin-barra', '#FF0000');
			expect(fallo).toBe('cuentas.noSePuede');
			expect(invocations.some((i) => i.command === 'set_calendar_color')).toBe(false);
		});
	});

	test('si el programa falla, devuelve el error y no marca falta de permiso', async () => {
		preparar();
		setFailure('set_calendar_color', 'sin conexión');
		await enUnAmbito(async (cal) => {
			const fallo = await cal.setCalendarColor('cuenta/7', '#00FF00');
			expect(fallo).toBe('sin conexión');
			expect(cal.sinPermiso.value).toBe(false);
		});
	});

	test('si la persona negó el almacén, marca sinPermiso', async () => {
		preparar();
		setFailure('set_calendar_color', STORE_PERMISSION_DENIED);
		await enUnAmbito(async (cal) => {
			const fallo = await cal.setCalendarColor('cuenta/7', '#00FF00');
			expect(fallo).toBe(STORE_PERMISSION_DENIED);
			expect(cal.sinPermiso.value).toBe(true);
		});
	});
});
