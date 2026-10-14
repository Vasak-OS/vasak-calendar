/**
 * La interfaz de editar, el badge de sincronización y la vista de resolver un
 * conflicto.
 *
 * No se comprueba cómo dibuja cada pieza de `vue-libvasak` —eso se prueba en la
 * librería— sino que el calendario las use bien: que editar se encienda con el
 * ETag y se apague sin él o en conflicto, que el badge diga el estado, y que la
 * comparación traiga las dos versiones y mande la elección.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { ActionButton, AlertMessage, Badge } from '@vasakgroup/vue-libvasak';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import ConflictDialog from '@/components/calendar/ConflictDialog.vue';
import EventDialog from '@/components/calendar/EventDialog.vue';
import SyncBadge from '@/components/calendar/SyncBadge.vue';
import type { ConflictComparison } from '@/composables/use-calendario';
import type { CalendarEvent } from '@/tools/mes';
import { olvidarTodo } from './dobles';

let vista: VueWrapper | null = null;

afterEach(() => {
	vista?.unmount();
	vista = null;
	olvidarTodo();
});

function event(extra: Partial<CalendarEvent> = {}): CalendarEvent {
	return {
		uid: 'google/42',
		title: 'Reunión',
		start: '2026-09-15T14:00:00+00:00',
		end: '2026-09-15T15:00:00+00:00',
		all_day: false,
		recurring: false,
		shown_once: false,
		zone: '',
		calendar: 'google/1',
		color: null,
		etag: '"etag-1"',
		sync_state: 'synced',
		...extra,
	};
}

describe('SyncBadge', () => {
	test('un evento pendiente lleva el badge con el tono de aviso', () => {
		vista = mount(SyncBadge, { props: { event: event({ sync_state: 'pending' }) } });
		const badge = vista.findComponent(Badge);
		expect(badge.exists()).toBe(true);
		expect(badge.props('tone')).toBe('warning');
		expect(vista.text()).toContain('sincronizacion.pendiente');
	});

	test('un evento en conflicto lleva el tono de error', () => {
		vista = mount(SyncBadge, { props: { event: event({ sync_state: 'conflict' }) } });
		expect(vista.findComponent(Badge).props('tone')).toBe('error');
	});

	test('un evento al día no dibuja nada', () => {
		vista = mount(SyncBadge, { props: { event: event({ sync_state: 'synced' }) } });
		expect(vista.findComponent(Badge).exists()).toBe(false);
		expect(vista.find('[data-testid="sync-badge"]').exists()).toBe(false);
	});

	test('compacto es sólo el punto, sin texto', () => {
		vista = mount(SyncBadge, { props: { event: event({ sync_state: 'pending' }), compact: true } });
		expect(vista.findComponent(Badge).props('label')).toBeUndefined();
	});
});

/** El botón de un ActionButton por su etiqueta (clave de i18n, sin catálogo). */
function actionByLabel(wrapper: VueWrapper, label: string) {
	return wrapper.findAllComponents(ActionButton).find((b) => b.props('label') === label);
}

describe('EventDialog al editar', () => {
	function openEdit(extra: Partial<CalendarEvent> = {}) {
		vista = mount(EventDialog, {
			props: {
				open: true,
				mode: 'edit',
				calendars: [{ url: 'google/1', nombre: 'Personal', color: null }],
				zone: 'UTC',
				event: event(extra),
			},
			attachTo: document.body,
		});
		return vista;
	}

	test('con ETag y sin conflicto, «Guardar» está habilitado', () => {
		openEdit({ sync_state: 'pending', etag: '"etag-1"' });
		expect(actionByLabel(vista!, 'editor.guardar')?.props('disabled')).toBe(false);
	});

	test('sin ETag, «Guardar» está apagado y se dice que está pendiente', () => {
		openEdit({ etag: '', sync_state: 'pending' });
		expect(actionByLabel(vista!, 'editor.guardar')?.props('disabled')).toBe(true);
		expect(document.body.innerHTML).toContain('editor.pendiente');
	});

	test('en conflicto, aparece el aviso y «Guardar» queda apagado', () => {
		openEdit({ sync_state: 'conflict' });
		expect(vista!.findComponent(AlertMessage).exists()).toBe(true);
		expect(actionByLabel(vista!, 'editor.guardar')?.props('disabled')).toBe(true);
	});

	test('el botón del aviso pide resolver el conflicto', async () => {
		openEdit({ sync_state: 'conflict' });
		await actionByLabel(vista!, 'conflicto.resolver')?.trigger('click');
		expect(vista!.emitted('resolve-conflict')?.[0]?.[0]).toMatchObject({ uid: 'google/42' });
	});

	test('guardar emite el parche con id y el ETag como ifMatch', async () => {
		openEdit({ sync_state: 'pending', etag: '"etag-1"' });
		await actionByLabel(vista!, 'editor.guardar')?.trigger('click');
		const submitted = vista!.emitted('submit')?.[0]?.[0] as {
			accountId: string;
			calendarId: string;
			payload: Record<string, unknown>;
			ifMatch: string;
		};
		expect(submitted.accountId).toBe('google');
		expect(submitted.calendarId).toBe('1');
		expect(submitted.ifMatch).toBe('"etag-1"');
		expect(submitted.payload.id).toBe(42);
		expect(submitted.payload.summary).toBe('Reunión');
	});
});

describe('ConflictDialog', () => {
	function comparison(extra: Partial<ConflictComparison> = {}): ConflictComparison {
		return {
			id: '42',
			op: 'put',
			local: 'BEGIN:VEVENT\r\nSUMMARY:La mía\r\nEND:VEVENT',
			server: 'BEGIN:VEVENT\r\nSUMMARY:La del servidor\r\nEND:VEVENT',
			server_etag: '"srv"',
			server_unavailable: false,
			...extra,
		};
	}

	async function openWith(comp: ConflictComparison | null) {
		vista = mount(ConflictDialog, {
			props: {
				open: true,
				event: event(),
				load: async () => comp,
			},
			attachTo: document.body,
		});
		await flushPromises();
		await nextTick();
		return vista;
	}

	test('muestra las dos versiones parseadas y las dos acciones', async () => {
		await openWith(comparison());
		expect(document.body.innerHTML).toContain('La mía');
		expect(document.body.innerHTML).toContain('La del servidor');
		expect(actionByLabel(vista!, 'conflicto.mantenerLaMia')?.exists()).toBe(true);
		expect(actionByLabel(vista!, 'conflicto.tomarLaDelServidor')?.props('disabled')).toBe(false);
	});

	test('mantener la mía y tomar la del servidor emiten su elección', async () => {
		await openWith(comparison());
		await actionByLabel(vista!, 'conflicto.mantenerLaMia')?.trigger('click');
		await actionByLabel(vista!, 'conflicto.tomarLaDelServidor')?.trigger('click');
		expect(vista!.emitted('resolve')).toEqual([['keep_local'], ['take_server']]);
	});

	test('sin copia del servidor, se dice y «tomar la del servidor» queda apagado', async () => {
		await openWith(comparison({ server: null, server_etag: null, server_unavailable: true }));
		expect(document.body.innerHTML).toContain('conflicto.servidorNoDisponible');
		expect(actionByLabel(vista!, 'conflicto.tomarLaDelServidor')?.props('disabled')).toBe(true);
	});

	test('un borrado local no muestra versión local', async () => {
		await openWith(comparison({ op: 'delete', local: null }));
		expect(document.body.innerHTML).toContain('conflicto.borradoLocal');
	});

	test('un id que ya no está en conflicto lo dice, sin acciones', async () => {
		await openWith(null);
		expect(document.body.innerHTML).toContain('conflicto.yaResuelto');
		expect(actionByLabel(vista!, 'conflicto.mantenerLaMia')).toBeUndefined();
	});

	test('un fallo al traer la comparación se avisa', async () => {
		vista = mount(ConflictDialog, {
			props: {
				open: true,
				event: event(),
				load: async () => {
					throw new Error('sin conexión');
				},
			},
			attachTo: document.body,
		});
		await flushPromises();
		await nextTick();
		expect(document.body.innerHTML).toContain('conflicto.noSePudoCargar');
	});
});
