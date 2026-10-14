/**
 * El composable de tareas: leer, crear, completar, borrar y resolver conflictos.
 *
 * Lo que se comprueba es el puente con el programa —qué comando se llama, con qué
 * argumentos— y lo optimista: completar cambia la casilla antes de que conteste el
 * servidor, borrar saca la fila ya. La lógica de armar el parche vive en
 * `tools/task-form.ts` y se prueba aparte; acá se mira la orquesta.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { effectScope } from 'vue';
import { type Task, useTasks } from '@/composables/use-tasks';
import { invocations, olvidarTodo, setAnswer, setFailure } from './dobles';

/** Una tarea mínima para la vista. */
function tarea(extra: Partial<Task> = {}): Task {
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
		sync_state: 'pending',
		...extra,
	};
}

/** Corre `useTasks` en un ámbito propio, que se cierra al terminar. */
function enUnAmbito<T>(uso: (t: ReturnType<typeof useTasks>) => Promise<T>): Promise<T> {
	const scope = effectScope();
	const cal = scope.run(() => useTasks());
	if (!cal) {
		throw new Error('no se pudo crear el composable');
	}
	return uso(cal).finally(() => scope.stop());
}

/** Lo último que se le pidió a un comando. */
function ultimaLlamada(comando: string): unknown {
	return invocations.filter((i) => i.command === comando).at(-1)?.args;
}

beforeEach(() => olvidarTodo());
afterEach(() => olvidarTodo());

describe('leer', () => {
	test('pide store_tasks con include_completed y guarda lo que vino', async () => {
		setAnswer('store_tasks', {
			calendars: [{ url: 'google/1', nombre: 'Tareas', color: null }],
			tasks: [tarea()],
			notices: [],
			available: true,
		});
		await enUnAmbito(async (t) => {
			await t.cargar();
			expect(t.tasks.value).toHaveLength(1);
			expect(t.calendars.value).toHaveLength(1);
			expect(t.available.value).toBe(true);
			expect(ultimaLlamada('store_tasks')).toEqual({ includeCompleted: false });
		});
	});

	test('ver completadas relee pidiendo también las terminadas', async () => {
		setAnswer('store_tasks', { calendars: [], tasks: [], notices: [], available: true });
		await enUnAmbito(async (t) => {
			await t.setIncludeCompleted(true);
			expect(ultimaLlamada('store_tasks')).toEqual({ includeCompleted: true });
		});
	});

	test('un «no» de la persona enciende «sin permiso» y no deja tareas', async () => {
		setFailure('store_tasks', 'store-permission-denied');
		await enUnAmbito(async (t) => {
			await t.cargar();
			expect(t.sinPermiso.value).toBe(true);
			expect(t.tasks.value).toEqual([]);
		});
	});
});

describe('crear y editar', () => {
	test('writeTask llama a put_task con el parche serializado y relee', async () => {
		setAnswer('store_tasks', { calendars: [], tasks: [], notices: [], available: true });
		await enUnAmbito(async (t) => {
			const fallo = await t.writeTask('google', '1', { summary: 'Hola' }, '');
			expect(fallo).toBeNull();
			expect(ultimaLlamada('put_task')).toEqual({
				accountId: 'google',
				calendarId: '1',
				payload: JSON.stringify({ summary: 'Hola' }),
				ifMatch: '',
			});
			expect(invocations.some((i) => i.command === 'store_tasks')).toBe(true);
		});
	});

	test('un fallo del programa vuelve como texto para el formulario', async () => {
		setFailure('put_task', 'la fecha no sirve');
		await enUnAmbito(async (t) => {
			expect(await t.writeTask('google', '1', {}, '')).toBe('la fecha no sirve');
		});
	});
});

describe('completar', () => {
	test('marca la casilla ya y llama a put_task con el ETag', async () => {
		setAnswer('store_tasks', {
			calendars: [],
			tasks: [tarea()],
			notices: [],
			available: true,
		});
		await enUnAmbito(async (t) => {
			await t.cargar();
			const fallo = await t.toggleDone(tarea(), true);
			expect(fallo).toBeNull();
			expect(ultimaLlamada('put_task')).toEqual({
				accountId: 'google',
				calendarId: '1',
				payload: JSON.stringify({ id: 42, status: 'COMPLETED', percent_complete: 100 }),
				ifMatch: '"etag-1"',
			});
		});
	});

	test('sin ETag no intenta nada y dice que está pendiente', async () => {
		await enUnAmbito(async (t) => {
			const fallo = await t.toggleDone(tarea({ etag: '' }), true);
			expect(fallo).toBe('tareas.pendiente');
			expect(invocations.some((i) => i.command === 'put_task')).toBe(false);
		});
	});

	test('si completar falla, la casilla vuelve a su estado', async () => {
		setAnswer('store_tasks', {
			calendars: [],
			tasks: [tarea({ done: false })],
			notices: [],
			available: true,
		});
		setFailure('put_task', 'sin conexión');
		await enUnAmbito(async (t) => {
			await t.cargar();
			const fallo = await t.toggleDone(tarea(), true);
			expect(fallo).toBe('sin conexión');
			expect(t.tasks.value[0].done).toBe(false);
		});
	});
});

describe('borrar', () => {
	test('saca la tarea de la vista ya y llama a delete_task', async () => {
		setAnswer('store_tasks', {
			calendars: [],
			tasks: [tarea({ task_id: 'google/42' }), tarea({ task_id: 'google/7' })],
			notices: [],
			available: true,
		});
		await enUnAmbito(async (t) => {
			await t.cargar();
			expect(t.tasks.value).toHaveLength(2);
			const fallo = await t.deleteTask(tarea({ task_id: 'google/42' }));
			expect(fallo).toBeNull();
			expect(t.tasks.value.map((x) => x.task_id)).toEqual(['google/7']);
			expect(ultimaLlamada('delete_task')).toEqual({
				accountId: 'google',
				taskId: '42',
				ifMatch: '"etag-1"',
			});
		});
	});

	test('una tarea sin id global no se puede borrar', async () => {
		await enUnAmbito(async (t) => {
			const fallo = await t.deleteTask(tarea({ task_id: 'sin-barra' }));
			expect(fallo).toBe('tareas.noSePuede');
			expect(invocations.some((i) => i.command === 'delete_task')).toBe(false);
		});
	});

	test('si el borrado falla, la tarea vuelve a la vista', async () => {
		setAnswer('store_tasks', {
			calendars: [],
			tasks: [tarea({ task_id: 'google/42' })],
			notices: [],
			available: true,
		});
		setFailure('delete_task', 'sin conexión');
		await enUnAmbito(async (t) => {
			await t.cargar();
			const fallo = await t.deleteTask(tarea({ task_id: 'google/42' }));
			expect(fallo).toBe('sin conexión');
			expect(t.tasks.value.map((x) => x.task_id)).toEqual(['google/42']);
		});
	});
});

describe('conflictos, por el mismo comando que los eventos', () => {
	test('getConflict parte el id global y pide la comparación', async () => {
		const comparison = {
			id: '42',
			op: 'put',
			local: 'LOCAL',
			server: 'SERVER',
			server_etag: '"srv"',
			server_unavailable: false,
		};
		setAnswer('get_conflict', comparison);
		await enUnAmbito(async (t) => {
			expect(await t.getConflict('google/42')).toEqual(comparison);
			expect(ultimaLlamada('get_conflict')).toEqual({ accountId: 'google', id: '42' });
		});
	});

	test('resolveConflict manda la elección y relee', async () => {
		setAnswer('store_tasks', { calendars: [], tasks: [], notices: [], available: true });
		await enUnAmbito(async (t) => {
			const fallo = await t.resolveConflict('google/42', 'take_server');
			expect(fallo).toBeNull();
			expect(ultimaLlamada('resolve_conflict')).toEqual({
				accountId: 'google',
				id: '42',
				choice: 'take_server',
			});
			expect(invocations.some((i) => i.command === 'store_tasks')).toBe(true);
		});
	});

	test('resolveConflict de un id sin forma global no intenta nada', async () => {
		await enUnAmbito(async (t) => {
			expect(await t.resolveConflict('sin-barra', 'keep_local')).toBe('tareas.noSePuede');
			expect(invocations.some((i) => i.command === 'resolve_conflict')).toBe(false);
		});
	});
});
