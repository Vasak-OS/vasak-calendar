/**
 * El mes, leído del almacén del sistema.
 *
 * `vasak-accounts-sync` ya tiene los calendarios de todas las cuentas
 * sincronizados —con la credencial correcta, también los de Google— y la
 * ventana los lee de ahí antes de ir a cada servidor. Lo que se comprueba:
 *
 * - que con el almacén disponible se muestra lo suyo y **no** se le pide nada a
 *   cada cuenta;
 * - que sin almacén —no contesta, o no tiene calendarios todavía— se lee
 *   cuenta por cuenta como antes;
 * - que «Actualizar» le pide una vuelta al sincronizador y relee, aunque el
 *   pedido falle;
 * - que el aviso de cambios del plugin del almacén (`CHANGED_EVENT`) relee el mes, y que al cerrar la ventana
 *   se deja de escucharlo, también si se cerró antes de engancharse.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { CHANGED_EVENT } from '@vasakgroup/plugin-vsk-store';
import { ActionButton } from '@vasakgroup/vue-libvasak';
import { mount, type VueWrapper } from '@vue/test-utils';
import { type EffectScope, effectScope } from 'vue';
import { useCalendario } from '@/composables/use-calendario';
import type { CalendarEvent } from '@/tools/mes';
import { rangoDe } from '@/tools/mes';
import CalendarView from '@/views/CalendarView.vue';
import { emit, invocations, olvidarTodo, setAnswer, setFailure, timesInvoked } from './dobles';

/** El pedido de «Actualizar» del plugin del almacén. */
const REQUEST_SYNC = 'plugin:vsk-store|request_sync';

let scope: EffectScope | null = null;
let mounted: VueWrapper | null = null;

afterEach(() => {
	scope?.stop();
	scope = null;
	mounted?.unmount();
	mounted = null;
	document.body.innerHTML = '';
	olvidarTodo();
});

/** El composable dentro de un alcance, como lo usaría una vista. */
function open() {
	scope = effectScope();
	const calendar = scope.run(() => useCalendario());
	if (!calendar) throw new Error('el alcance no devolvió el calendario');
	return calendar;
}

/** Que terminen la carga y las promesas que encadena. */
async function flush(rounds = 10) {
	for (let i = 0; i < rounds; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

function event(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
	return {
		uid: 'google/42',
		title: 'Reunión',
		start: '2026-09-15T14:00:00Z',
		end: '2026-09-15T15:00:00Z',
		all_day: false,
		recurring: false,
		shown_once: false,
		zone: '',
		calendar: 'google/1',
		color: '#3366FF',
		...overrides,
	} as CalendarEvent;
}

const ACCOUNTS = [
	{ id: 'google', nombre: 'ana@gmail.com', necesita_reconectarse: false },
	{ id: 'nube', nombre: 'ana@nube', necesita_reconectarse: false },
];

const FROM_ACCOUNT = {
	calendarios: [{ url: 'https://nube/dav/ana/', nombre: 'Casa', color: null }],
	eventos: [event({ uid: 'de-la-cuenta', calendar: 'https://nube/dav/ana/' })],
	fallos: [],
};

const FROM_STORE = {
	calendarios: [{ url: 'google/1', nombre: 'Personal', color: '#3366FF' }],
	eventos: [event({ uid: 'del-almacen' })],
	fallos: ['hay eventos que no se pudieron expandir del todo'],
	available: true,
};

describe('el mes sale del almacén del sistema', () => {
	test('con el almacén disponible se muestra lo suyo y no se le pide nada a cada cuenta', async () => {
		setAnswer('listar_cuentas', ACCOUNTS);
		setAnswer('store_events', FROM_STORE);
		setAnswer('account_events', FROM_ACCOUNT);
		const calendar = open();

		await calendar.cargar();

		expect(calendar.eventos.value.map((e) => e.uid)).toEqual(['del-almacen']);
		expect(calendar.calendarios.value).toEqual(FROM_STORE.calendarios);
		expect(calendar.avisos.value).toEqual(FROM_STORE.fallos);
		expect(calendar.cuentas.value).toEqual(ACCOUNTS);
		expect(timesInvoked('account_events')).toBe(0);
	});

	test('al almacén se le pide el mismo rango que dibuja la cuadrícula', async () => {
		setAnswer('listar_cuentas', ACCOUNTS);
		setAnswer('store_events', FROM_STORE);
		const calendar = open();

		await calendar.cargar();

		const { desde, hasta } = rangoDe(calendar.dias.value, calendar.zona.value);
		const pedido = invocations.find((i) => i.command === 'store_events');
		expect(pedido?.args).toEqual({ from: desde, to: hasta });
	});

	test('sin calendarios en el almacén se lee cuenta por cuenta, como antes', async () => {
		setAnswer('listar_cuentas', ACCOUNTS);
		setAnswer('store_events', { calendarios: [], eventos: [], fallos: [], available: false });
		setAnswer('account_events', FROM_ACCOUNT);
		const calendar = open();

		await calendar.cargar();

		expect(timesInvoked('account_events')).toBe(2);
		expect(calendar.eventos.value.map((e) => e.uid)).toEqual(['de-la-cuenta', 'de-la-cuenta']);
	});

	test('una respuesta del almacén sin «available» no se toma como el mes', async () => {
		setAnswer('listar_cuentas', ACCOUNTS);
		setAnswer('store_events', { calendarios: [], eventos: [event({ uid: 'fantasma' })], fallos: [] });
		setAnswer('account_events', FROM_ACCOUNT);
		const calendar = open();

		await calendar.cargar();

		expect(timesInvoked('account_events')).toBe(2);
		expect(calendar.eventos.value.map((e) => e.uid)).not.toContain('fantasma');
	});

	test('si el almacén no contesta se lee cuenta por cuenta, sin avisar del almacén', async () => {
		setAnswer('listar_cuentas', ACCOUNTS);
		setFailure('store_events', 'ListCalendars: el servicio no existe');
		setAnswer('account_events', FROM_ACCOUNT);
		const calendar = open();
		const realError = console.error;
		console.error = () => {};

		try {
			await calendar.cargar();
		} finally {
			console.error = realError;
		}

		expect(timesInvoked('account_events')).toBe(2);
		expect(calendar.eventos.value).toHaveLength(2);
		// El camino de siempre salió bien: no hay nada que la persona tenga que
		// hacer, así que no se le muestra el error del almacén.
		expect(calendar.avisos.value).toEqual([]);
	});

	test('una cuenta para reconectar no se lee aunque el almacén no esté', async () => {
		setAnswer('listar_cuentas', [
			ACCOUNTS[0],
			{ id: 'vencida', nombre: 'vieja', necesita_reconectarse: true },
		]);
		setAnswer('store_events', { calendarios: [], eventos: [], fallos: [], available: false });
		setAnswer('account_events', FROM_ACCOUNT);
		const calendar = open();

		await calendar.cargar();

		const leidas = invocations
			.filter((i) => i.command === 'account_events')
			.map((i) => (i.args as { accountId: string }).accountId);
		expect(leidas).toEqual(['google']);
	});

	test('una lista de cuentas que no es lista deja la ventana sin cuentas y sin avisos', async () => {
		setAnswer('listar_cuentas', null);
		setAnswer('store_events', { calendarios: [], eventos: [], fallos: [], available: false });
		const calendar = open();

		await calendar.cargar();

		expect(calendar.cuentas.value).toEqual([]);
		// Antes se recorría `null` y la persona veía un `TypeError` arriba del
		// mes, que no le dice nada que pueda hacer.
		expect(calendar.avisos.value).toEqual([]);
	});
});

describe('«Actualizar»', () => {
	test('pide una vuelta de todas las cuentas al sincronizador y relee el mes', async () => {
		setAnswer('listar_cuentas', ACCOUNTS);
		setAnswer('store_events', FROM_STORE);
		const calendar = open();
		await calendar.cargar();
		invocations.length = 0;

		await calendar.refresh();

		const commands = invocations.map((i) => i.command);
		expect(commands[0]).toBe(REQUEST_SYNC);
		expect(invocations[0].args).toEqual({ accountIds: ['google', 'nube'] });
		// Relee después de pedir: lo que ya está se ve mientras llega lo nuevo.
		expect(commands).toContain('listar_cuentas');
		expect(commands).toContain('store_events');
	});

	test('si pedir la vuelta falla, igual relee lo que hay', async () => {
		setAnswer('listar_cuentas', ACCOUNTS);
		setAnswer('store_events', FROM_STORE);
		setFailure(REQUEST_SYNC, 'RequestSync: demasiados pedidos');
		const calendar = open();
		const realError = console.error;
		console.error = () => {};

		try {
			await calendar.refresh();
		} finally {
			console.error = realError;
		}

		expect(timesInvoked('listar_cuentas')).toBe(1);
		expect(calendar.eventos.value.map((e) => e.uid)).toEqual(['del-almacen']);
	});

	test('el botón de actualizar de la ventana le pide la vuelta al sincronizador', async () => {
		setAnswer('listar_cuentas', ACCOUNTS);
		setAnswer('store_events', FROM_STORE);
		mounted = mount(CalendarView, { attachTo: document.body });
		await flush();
		invocations.length = 0;

		const refresh = mounted
			.findAllComponents(ActionButton)
			.find((b) => b.props('icon') === 'view-refresh');
		expect(refresh).toBeDefined();
		await refresh?.trigger('click');
		await flush();

		expect(timesInvoked(REQUEST_SYNC)).toBe(1);
		expect(timesInvoked('listar_cuentas')).toBe(1);
	});
});

describe('el aviso del almacén', () => {
	test('un cambio guardado en el almacén relee el mes', async () => {
		setAnswer('listar_cuentas', ACCOUNTS);
		setAnswer('store_events', FROM_STORE);
		const calendar = open();
		await calendar.cargar();
		await flush();
		setAnswer('store_events', { ...FROM_STORE, eventos: [event({ uid: 'nuevo' })] });

		await emit(CHANGED_EVENT, { areas: ['calendar'] });
		await flush();

		expect(timesInvoked('listar_cuentas')).toBe(2);
		expect(calendar.eventos.value.map((e) => e.uid)).toEqual(['nuevo']);
	});

	test('al cerrar la ventana deja de escuchar al almacén', async () => {
		setAnswer('listar_cuentas', ACCOUNTS);
		setAnswer('store_events', FROM_STORE);
		open();
		await flush();

		scope?.stop();
		scope = null;
		await emit(CHANGED_EVENT, { areas: ['calendar'] });
		await flush();

		expect(timesInvoked('listar_cuentas')).toBe(0);
	});

	test('cerrada antes de engancharse, tampoco queda escuchando', async () => {
		setAnswer('listar_cuentas', ACCOUNTS);
		setAnswer('store_events', FROM_STORE);
		open();
		// Sin esperar: `listen` todavía no contestó cuando se cierra.
		scope?.stop();
		scope = null;
		await flush();

		await emit(CHANGED_EVENT, { areas: ['calendar'] });
		await flush();

		expect(timesInvoked('listar_cuentas')).toBe(0);
	});
});
