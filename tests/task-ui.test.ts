/**
 * La interfaz de las tareas: el badge reusado, el formulario y la lista.
 *
 * No se comprueba cómo dibuja cada pieza de `vue-libvasak` —eso se prueba en la
 * librería— sino que las tareas las usen bien: que el badge diga el estado de una
 * tarea (el mismo componente que los eventos), que editar se encienda con el ETag
 * y se apague sin él o en conflicto, y que la lista muestre las tareas, complete
 * desde la casilla y ofrezca crear.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import {
	ActionButton,
	AlertMessage,
	Badge,
	Checkbox,
	ListRow,
	TextInput,
} from '@vasakgroup/vue-libvasak';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import SyncBadge from '@/components/calendar/SyncBadge.vue';
import TaskDialog from '@/components/calendar/TaskDialog.vue';
import TasksView from '@/components/calendar/TasksView.vue';
import type { Task } from '@/composables/use-tasks';
import { invocations, olvidarTodo, setAnswer } from './dobles';

let vista: VueWrapper | null = null;

afterEach(() => {
	vista?.unmount();
	vista = null;
	for (const suelto of document.body.querySelectorAll('[role="listbox"]')) suelto.remove();
	olvidarTodo();
});

function task(extra: Partial<Task> = {}): Task {
	return {
		task_id: 'google/42',
		calendar_id: 'google/1',
		title: 'Comprar pan',
		due: null,
		all_day: false,
		status: 'needs-action',
		priority: null,
		completed: null,
		done: false,
		color: null,
		etag: '"etag-1"',
		sync_state: 'synced',
		...extra,
	};
}

/** El botón de un ActionButton por su etiqueta (clave de i18n, sin catálogo). */
function actionByLabel(wrapper: VueWrapper, label: string) {
	return wrapper.findAllComponents(ActionButton).find((b) => b.props('label') === label);
}

describe('SyncBadge con una tarea', () => {
	test('una tarea pendiente lleva el badge de aviso: el mismo componente que el evento', () => {
		vista = mount(SyncBadge, { props: { event: task({ sync_state: 'pending' }) } });
		expect(vista.findComponent(Badge).props('tone')).toBe('warning');
	});

	test('una tarea en conflicto lleva el tono de error', () => {
		vista = mount(SyncBadge, { props: { event: task({ sync_state: 'conflict' }) } });
		expect(vista.findComponent(Badge).props('tone')).toBe('error');
	});

	test('una tarea al día no dibuja nada', () => {
		vista = mount(SyncBadge, { props: { event: task({ sync_state: 'synced' }) } });
		expect(vista.findComponent(Badge).exists()).toBe(false);
	});
});

describe('TaskDialog al editar', () => {
	function openEdit(extra: Partial<Task> = {}) {
		vista = mount(TaskDialog, {
			props: {
				open: true,
				mode: 'edit',
				calendars: [{ url: 'google/1', nombre: 'Tareas', color: null }],
				zone: 'UTC',
				task: task(extra),
			},
			attachTo: document.body,
		});
		return vista;
	}

	test('con ETag y sin conflicto, «Guardar» está habilitado', () => {
		openEdit({ etag: '"etag-1"', sync_state: 'pending' });
		expect(actionByLabel(vista!, 'tareas.guardar')?.props('disabled')).toBe(false);
	});

	test('sin ETag, «Guardar» está apagado y se dice que está pendiente', () => {
		openEdit({ etag: '', sync_state: 'pending' });
		expect(actionByLabel(vista!, 'tareas.guardar')?.props('disabled')).toBe(true);
		expect(document.body.innerHTML).toContain('tareas.pendiente');
	});

	test('en conflicto, aparece el aviso y «Guardar» queda apagado', () => {
		openEdit({ sync_state: 'conflict' });
		expect(vista!.findComponent(AlertMessage).exists()).toBe(true);
		expect(actionByLabel(vista!, 'tareas.guardar')?.props('disabled')).toBe(true);
	});

	test('el botón del aviso pide resolver el conflicto', async () => {
		openEdit({ sync_state: 'conflict' });
		await actionByLabel(vista!, 'conflicto.resolver')?.trigger('click');
		expect(vista!.emitted('resolve-conflict')?.[0]?.[0]).toMatchObject({ task_id: 'google/42' });
	});

	test('guardar emite el parche con id y el ETag como ifMatch', async () => {
		openEdit({ etag: '"etag-1"', sync_state: 'pending' });
		await actionByLabel(vista!, 'tareas.guardar')?.trigger('click');
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
		expect(submitted.payload.summary).toBe('Comprar pan');
	});
});

describe('TaskDialog al crear', () => {
	test('con un título, guardar emite el parche sin id ni ifMatch', async () => {
		vista = mount(TaskDialog, {
			props: {
				open: true,
				mode: 'create',
				calendars: [{ url: 'google/1', nombre: 'Tareas', color: null }],
				zone: 'UTC',
			},
			attachTo: document.body,
		});
		// El formulario de crear abre en blanco: se pone un título y recién ahí
		// guardar emite. El primer TextInput es el del título.
		vista.findAllComponents(TextInput)[0].vm.$emit('update:modelValue', 'Comprar pan');
		await nextTick();
		await actionByLabel(vista, 'tareas.guardar')?.trigger('click');
		const submitted = vista.emitted('submit')?.[0]?.[0] as {
			payload: Record<string, unknown>;
			ifMatch: string;
		};
		expect(submitted.ifMatch).toBe('');
		expect(submitted.payload.id).toBeUndefined();
		expect(submitted.payload.summary).toBe('Comprar pan');
	});

	test('sin título, no emite y muestra qué falta', async () => {
		vista = mount(TaskDialog, {
			props: {
				open: true,
				mode: 'create',
				calendars: [{ url: 'google/1', nombre: 'Tareas', color: null }],
				zone: 'UTC',
			},
			attachTo: document.body,
		});
		// Se abre con el título en blanco: guardar no emite y avisa.
		await actionByLabel(vista, 'tareas.guardar')?.trigger('click');
		expect(vista.emitted('submit')).toBeUndefined();
		expect(document.body.innerHTML).toContain('tareas.faltaTitulo');
	});
});

describe('TasksView', () => {
	async function openWith(tasks: Task[], extra: Record<string, unknown> = {}) {
		setAnswer('store_tasks', {
			calendars: [{ url: 'google/1', nombre: 'Tareas', color: null }],
			tasks,
			notices: [],
			available: true,
			...extra,
		});
		vista = mount(TasksView, {
			props: { zone: 'UTC', reask: async () => null },
			attachTo: document.body,
		});
		await flushPromises();
		await nextTick();
		return vista;
	}

	test('muestra una fila por tarea, con su título', async () => {
		await openWith([task({ title: 'Comprar pan' }), task({ task_id: 'google/7', title: 'Llamar' })]);
		const filas = vista!.findAllComponents(ListRow);
		expect(filas).toHaveLength(2);
		expect(vista!.text()).toContain('Comprar pan');
		expect(vista!.text()).toContain('Llamar');
	});

	test('la casilla completa la tarea sin abrir el formulario', async () => {
		await openWith([task()]);
		const checkbox = vista!.findComponent(Checkbox);
		checkbox.vm.$emit('update:modelValue', true);
		await flushPromises();
		// Llamó a put_task (completar), no se abrió el diálogo de editar.
		expect(invocations.some((i) => i.command === 'put_task')).toBe(true);
	});

	test('sin listas de tareas, lo dice', async () => {
		await openWith([], { available: false, calendars: [] });
		expect(vista!.text()).toContain('tareas.sinListasTitulo');
	});

	test('con listas pero sin tareas, ofrece crear', async () => {
		await openWith([]);
		expect(vista!.text()).toContain('tareas.vacioTitulo');
		expect(actionByLabel(vista!, 'tareas.crear')?.exists()).toBe(true);
	});

	test('un «no» del almacén muestra el estado de «sin permiso»', async () => {
		setAnswer('store_tasks', undefined);
		// Un fallo con la marca del «no».
		const { setFailure } = await import('./dobles');
		setFailure('store_tasks', 'store-permission-denied');
		vista = mount(TasksView, {
			props: { zone: 'UTC', reask: async () => null },
			attachTo: document.body,
		});
		await flushPromises();
		await nextTick();
		expect(vista.text()).toContain('permiso.titulo');
	});
});
