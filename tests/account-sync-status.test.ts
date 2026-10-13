/**
 * Cómo va la sincronización de cada cuenta, en el panel de cuentas
 * (Vasak-OS/vasak-calendar#63).
 *
 * El estado sale de `sync_status` (el `GetStatus` del almacén) y se relee con el
 * aviso `calendar-sync-status`; «Actualizar» guarda a qué cuentas no se les
 * pudo pedir una vuelta. `invoke` y `listen` son los dobles de
 * `tests/dobles.ts`: el bus y el almacén se prueban en Rust
 * (`src-tauri/src/store.rs`).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ActionButton, StatusDot } from '@vasakgroup/vue-libvasak';
import { mount, type VueWrapper } from '@vue/test-utils';
import { type EffectScope, effectScope } from 'vue';
import AccountsPanel from '@/components/calendar/AccountsPanel.vue';
import { useCalendario } from '@/composables/use-calendario';
import type { AccountSyncStatus, SyncRequestFailure } from '@/tools/sync-status';
import CalendarView from '@/views/CalendarView.vue';
import { emit, invocations, olvidarTodo, setAnswer, setFailure, timesInvoked } from './dobles';

const STATUS_EVENT = 'calendar-sync-status';

const ACCOUNTS = [
	{ id: 'google', nombre: 'ana@gmail.com', necesita_reconectarse: false },
	{ id: 'nube', nombre: 'ana@nube', necesita_reconectarse: false },
];

const STATUSES: AccountSyncStatus[] = [
	{ account_id: 'google', state: 'syncing', detail: '', last_synced_at: null },
	{ account_id: 'nube', state: 'failed', detail: 'clave rechazada', last_synced_at: null },
];

const EMPTY_STORE = { calendarios: [], eventos: [], fallos: [], available: false };

let scope: EffectScope | null = null;
let mounted: VueWrapper | null = null;

// Otros archivos montan la ventana sin soltar sus oyentes ni olvidar lo que
// pidieron: se arranca de cero para contar sólo lo de cada prueba.
beforeEach(() => {
	olvidarTodo();
});

afterEach(() => {
	scope?.stop();
	scope = null;
	mounted?.unmount();
	mounted = null;
	document.body.innerHTML = '';
	olvidarTodo();
});

function open() {
	scope = effectScope();
	const calendar = scope.run(() => useCalendario());
	if (!calendar) throw new Error('el alcance no devolvió el calendario');
	return calendar;
}

async function flush(rounds = 10) {
	for (let i = 0; i < rounds; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Corre `fn` sin ensuciar la salida con los `console.error` esperados. */
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
	const real = console.error;
	console.error = () => {};
	try {
		return await fn();
	} finally {
		console.error = real;
	}
}

describe('el estado de la sincronización', () => {
	test('al abrir se lee el estado de cada cuenta del almacén', async () => {
		setAnswer('sync_status', STATUSES);
		const calendar = open();
		await flush();

		expect(timesInvoked('sync_status')).toBe(1);
		expect(calendar.syncStatuses.value).toEqual(STATUSES);
	});

	test('una respuesta que no es una lista es ningún estado', async () => {
		setAnswer('sync_status', { error: 'no' });
		const calendar = open();
		await flush();

		expect(calendar.syncStatuses.value).toEqual([]);
	});

	test('si no se puede leer el estado, se queda el que había', async () => {
		setAnswer('sync_status', STATUSES);
		const calendar = open();
		await flush();
		setFailure('sync_status', 'GetStatus: el servicio no existe');

		await quietly(async () => {
			await emit(STATUS_EVENT);
			await flush();
		});

		expect(timesInvoked('sync_status')).toBe(2);
		expect(calendar.syncStatuses.value).toEqual(STATUSES);
	});

	test('el aviso de estado relee el estado, no el mes', async () => {
		setAnswer('sync_status', STATUSES);
		const calendar = open();
		await flush();
		const synced: AccountSyncStatus[] = [
			{ account_id: 'google', state: 'synced', detail: '', last_synced_at: null },
		];
		setAnswer('sync_status', synced);

		await emit(STATUS_EVENT);
		await flush();

		expect(calendar.syncStatuses.value).toEqual(synced);
		expect(timesInvoked('listar_cuentas')).toBe(0);
	});

	test('al cerrar la ventana deja de escuchar el estado', async () => {
		open();
		await flush();
		scope?.stop();
		scope = null;

		await emit(STATUS_EVENT);
		await flush();

		expect(timesInvoked('sync_status')).toBe(1);
	});

	test('cerrada antes de engancharse, tampoco queda escuchando el estado', async () => {
		open();
		scope?.stop();
		scope = null;
		await flush();

		await emit(STATUS_EVENT);
		await flush();

		// Sólo la lectura del arranque.
		expect(timesInvoked('sync_status')).toBe(1);
	});
});

describe('lo que «Actualizar» no pudo pedir', () => {
	test('se guarda qué cuentas rechazaron el pedido y por qué', async () => {
		setAnswer('listar_cuentas', ACCOUNTS);
		setAnswer('store_events', EMPTY_STORE);
		const failures: SyncRequestFailure[] = [{ account_id: 'nube', reason: 'denied' }];
		setAnswer('request_sync', failures);
		const calendar = open();
		await calendar.cargar();

		await calendar.refresh();

		expect(calendar.refreshFailures.value).toEqual(failures);
	});

	test('un «Actualizar» que sale bien borra los rechazos del anterior', async () => {
		setAnswer('listar_cuentas', ACCOUNTS);
		setAnswer('store_events', EMPTY_STORE);
		setAnswer('request_sync', [{ account_id: 'nube', reason: 'failed' }]);
		const calendar = open();
		await calendar.cargar();
		await calendar.refresh();
		setAnswer('request_sync', []);

		await calendar.refresh();

		expect(calendar.refreshFailures.value).toEqual([]);
	});

	test('si el programa no contesta, todas las cuentas pedidas quedan sin servicio', async () => {
		setAnswer('listar_cuentas', [
			...ACCOUNTS,
			{ id: 'vencida', nombre: 'vieja', necesita_reconectarse: true },
		]);
		setAnswer('store_events', EMPTY_STORE);
		setFailure('request_sync', 'el programa no contesta');
		const calendar = open();
		await calendar.cargar();

		await quietly(() => calendar.refresh());

		// La que hay que reconectar ni se pidió: su aviso es el de reconectar.
		expect(calendar.refreshFailures.value).toEqual([
			{ account_id: 'google', reason: 'unavailable' },
			{ account_id: 'nube', reason: 'unavailable' },
		]);
	});

	test('no se le pide una vuelta a la cuenta que hay que reconectar', async () => {
		setAnswer('listar_cuentas', [
			ACCOUNTS[0],
			{ id: 'vencida', nombre: 'vieja', necesita_reconectarse: true },
		]);
		setAnswer('store_events', EMPTY_STORE);
		const calendar = open();
		await calendar.cargar();

		await calendar.refresh();

		const pedido = invocations.find((i) => i.command === 'request_sync');
		expect(pedido?.args).toEqual({ accountIds: ['google'] });
	});

	test('«Actualizar» también relee el estado', async () => {
		setAnswer('listar_cuentas', ACCOUNTS);
		setAnswer('store_events', EMPTY_STORE);
		const calendar = open();
		await flush();
		setAnswer('sync_status', STATUSES);

		await calendar.refresh();

		expect(calendar.syncStatuses.value).toEqual(STATUSES);
	});

	test('el aviso de estado olvida «se acaba de pedir» y deja los demás rechazos', async () => {
		setAnswer('listar_cuentas', ACCOUNTS);
		setAnswer('store_events', EMPTY_STORE);
		setAnswer('request_sync', [
			{ account_id: 'google', reason: 'too_soon' },
			{ account_id: 'nube', reason: 'denied' },
		]);
		const calendar = open();
		await calendar.cargar();
		await calendar.refresh();
		await flush();

		await emit(STATUS_EVENT);
		await flush();

		expect(calendar.refreshFailures.value).toEqual([{ account_id: 'nube', reason: 'denied' }]);
	});
});

describe('la línea en el panel de cuentas', () => {
	function panel(props: Record<string, unknown>) {
		mounted = mount(AccountsPanel, {
			props: {
				accounts: ACCOUNTS,
				calendars: [],
				notices: [],
				zone: 'America/Argentina/Buenos_Aires',
				chosenZone: '',
				systemZone: 'America/Argentina/Buenos_Aires',
				foreignZone: false,
				...props,
			},
		});
		return mounted;
	}

	test('cada cuenta con estado tiene su línea, anunciada como estado', () => {
		const wrapper = panel({ syncStatuses: STATUSES });

		const lines = wrapper.findAll('[data-testid="sync-status"]');
		expect(lines).toHaveLength(2);
		for (const line of lines) expect(line.attributes('role')).toBe('status');
		expect(lines[0].text()).toContain('sync.syncing');
		expect(lines[1].text()).toContain('sync.failed');
	});

	test('el punto lleva el tono y late mientras sincroniza', () => {
		const wrapper = panel({ syncStatuses: STATUSES });

		const dots = wrapper
			.findAll('[data-testid="sync-status"]')
			.map((line) => line.findComponent(StatusDot));
		expect(dots.map((d) => d.props('tone'))).toEqual(['accent', 'error']);
		expect(dots.map((d) => Boolean(d.props('pulse')))).toEqual([true, false]);
	});

	test('lo que «Actualizar» no pudo pedir se dice debajo de esa cuenta', () => {
		const wrapper = panel({
			syncStatuses: STATUSES,
			refreshFailures: [{ account_id: 'google', reason: 'denied' }],
		});

		const lines = wrapper.findAll('[data-testid="sync-status"]');
		expect(lines[0].text()).toContain('sync.request.denied');
		expect(lines[0].findComponent(StatusDot).props('tone')).toBe('warning');
		expect(lines[1].text()).toContain('sync.failed');
	});

	test('una cuenta sin estado ni rechazo no tiene línea', () => {
		const wrapper = panel({ syncStatuses: [STATUSES[0]] });

		expect(wrapper.findAll('[data-testid="sync-status"]')).toHaveLength(1);
	});

	test('en una cuenta para reconectar gana el aviso de reconectar', () => {
		const wrapper = panel({
			accounts: [{ id: 'google', nombre: 'ana@gmail.com', necesita_reconectarse: true }],
			syncStatuses: STATUSES,
		});

		expect(wrapper.find('[data-testid="needs-reconnect"]').exists()).toBe(true);
		expect(wrapper.find('[data-testid="sync-status"]').exists()).toBe(false);
	});
});

describe('la ventana', () => {
	test('muestra el estado del almacén debajo de cada cuenta', async () => {
		setAnswer('listar_cuentas', ACCOUNTS);
		setAnswer('store_events', EMPTY_STORE);
		setAnswer('sync_status', STATUSES);
		mounted = mount(CalendarView, { attachTo: document.body });
		await flush();

		const lines = mounted.findAll('[data-testid="sync-status"]');
		expect(lines.map((l) => l.text())).toEqual(['sync.syncing', 'sync.failed']);
	});

	test('el botón de actualizar dice qué cuenta rechazó el pedido', async () => {
		setAnswer('listar_cuentas', ACCOUNTS);
		setAnswer('store_events', EMPTY_STORE);
		mounted = mount(CalendarView, { attachTo: document.body });
		await flush();
		expect(mounted.find('[data-testid="sync-status"]').exists()).toBe(false);
		setAnswer('request_sync', [{ account_id: 'nube', reason: 'too_soon' }]);

		const refresh = mounted
			.findAllComponents(ActionButton)
			.find((b) => b.props('icon') === 'view-refresh');
		await refresh?.trigger('click');
		await flush();

		const lines = mounted.findAll('[data-testid="sync-status"]');
		expect(lines.map((l) => l.text())).toEqual(['sync.request.too_soon']);
	});
});
