/**
 * El estado de «sin permiso» y el botón de volver a pedirlo (ola 2 del almacén).
 *
 * Cuando el almacén le niega a la ventana el permiso de leer el calendario, no
 * se va al servidor —eso pediría la credencial de la cuenta, que es más que lo
 * que la persona acaba de negar—: se muestra un estado que lo dice, con un botón
 * que le pide a `vasak-permissions` que vuelva a preguntar. Lo que se comprueba:
 *
 * - que el «no» del almacén enciende el estado y **no** lee cuenta por cuenta;
 * - que un fallo cualquiera del almacén —no un «no»— sí lee cuenta por cuenta y
 *   no enciende el estado;
 * - que volver a pedir el permiso relee cuando se reabrió el diálogo, y deja el
 *   aviso traducido cuando no se pudo ni reabrir;
 * - que el botón de la ventana invoca el comando de volver a pedir.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { ActionButton, EmptyState } from '@vasakgroup/vue-libvasak';
import { mount, type VueWrapper } from '@vue/test-utils';
import { type EffectScope, effectScope } from 'vue';
import { useCalendario } from '@/composables/use-calendario';
import type { CalendarEvent } from '@/tools/mes';
import { STORE_PERMISSION_DENIED } from '@/tools/store-permission';
import CalendarView from '@/views/CalendarView.vue';
import { invocations, olvidarTodo, setAnswer, setFailure, timesInvoked } from './dobles';

const REASK = 'request_calendar_access_again';

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

const ACCOUNTS = [{ id: 'google', nombre: 'ana@gmail.com', necesita_reconectarse: false }];

const FROM_ACCOUNT = {
	calendarios: [{ url: 'https://nube/dav/ana/', nombre: 'Casa', color: null }],
	eventos: [event({ uid: 'de-la-cuenta', calendar: 'https://nube/dav/ana/' })],
	fallos: [],
};

describe('el «no» del almacén enciende el estado de «sin permiso»', () => {
	test('con el «no» no se lee cuenta por cuenta y el calendario queda vacío', async () => {
		setAnswer('listar_cuentas', ACCOUNTS);
		setFailure('store_events', STORE_PERMISSION_DENIED);
		setAnswer('account_events', FROM_ACCOUNT);
		const calendar = open();

		await calendar.cargar();

		expect(calendar.sinPermiso.value).toBe(true);
		// Ir al servidor pediría `account.calendar`, más que lo que se negó.
		expect(timesInvoked('account_events')).toBe(0);
		expect(calendar.eventos.value).toEqual([]);
		expect(calendar.calendarios.value).toEqual([]);
	});

	test('un fallo cualquiera del almacén no es un «no»: lee cuenta por cuenta', async () => {
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

		expect(calendar.sinPermiso.value).toBe(false);
		expect(timesInvoked('account_events')).toBe(1);
		expect(calendar.eventos.value.map((e) => e.uid)).toEqual(['de-la-cuenta']);
	});
});

describe('volver a pedir el permiso', () => {
	test('cuando se reabre el diálogo, relee; si siguen negándolo, sigue sin permiso', async () => {
		setAnswer('listar_cuentas', ACCOUNTS);
		setFailure('store_events', STORE_PERMISSION_DENIED);
		setAnswer(REASK, { outcome: 'reopened' });
		const calendar = open();
		await calendar.cargar();
		expect(timesInvoked('listar_cuentas')).toBe(1);

		const aviso = await calendar.pedirPermisoDeNuevo();

		// `reopened` no deja aviso: relee, y es esa lectura la que reabre el diálogo.
		expect(aviso).toBeNull();
		expect(timesInvoked(REASK)).toBe(1);
		// Releyó: la persona volvió a decir que no, así que sigue sin permiso.
		expect(timesInvoked('listar_cuentas')).toBe(2);
		expect(calendar.sinPermiso.value).toBe(true);
	});

	test('un re-pedido demasiado seguido deja el aviso del techo y no relee', async () => {
		setAnswer('listar_cuentas', ACCOUNTS);
		setFailure('store_events', STORE_PERMISSION_DENIED);
		setAnswer(REASK, { outcome: 'too_soon' });
		const calendar = open();
		await calendar.cargar();

		const aviso = await calendar.pedirPermisoDeNuevo();

		expect(aviso).toBe('permiso.limite');
		// No se reabrió nada, así que no se relee: una sola carga.
		expect(timesInvoked('listar_cuentas')).toBe(1);
	});

	test('si no se pudo ni pedir, el aviso es el genérico', async () => {
		setAnswer('listar_cuentas', ACCOUNTS);
		setFailure('store_events', STORE_PERMISSION_DENIED);
		setFailure(REASK, 'el servicio de permisos no está');
		const calendar = open();
		await calendar.cargar();
		const realError = console.error;
		console.error = () => {};

		let aviso: string | null;
		try {
			aviso = await calendar.pedirPermisoDeNuevo();
		} finally {
			console.error = realError;
		}

		expect(aviso).toBe('permiso.error');
	});
});

describe('la vista', () => {
	test('con «sin permiso» muestra el estado y su botón, que invoca el comando', async () => {
		setAnswer('listar_cuentas', ACCOUNTS);
		setFailure('store_events', STORE_PERMISSION_DENIED);
		setAnswer(REASK, { outcome: 'too_soon' });
		mounted = mount(CalendarView, { attachTo: document.body });
		await flush();

		expect(mounted.findComponent(EmptyState).exists()).toBe(true);
		const reask = mounted
			.findAllComponents(ActionButton)
			.find((b) => b.props('variant') === 'primary');
		expect(reask).toBeDefined();

		invocations.length = 0;
		await reask?.trigger('click');
		await flush();

		expect(timesInvoked(REASK)).toBe(1);
	});
});
