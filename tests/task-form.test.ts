/**
 * El armado del parche de una tarea, sin montar nada.
 *
 * Es lo que decide qué se sube al servidor —una fecha mal armada, un estado o una
 * prioridad fuera de lo que entiende `TaskPatch` no se ven hasta que la tarea cae
 * mal—, así que se prueba aparte del componente, como `event-form.ts`.
 */

import { describe, expect, test } from 'bun:test';
import {
	buildCreateTask,
	buildEditTask,
	buildToggleDone,
	priorityFromNumber,
	statusFromString,
	type TaskFormState,
} from '@/tools/task-form';

/** Un estado de formulario con lo mínimo, que cada prueba ajusta. */
function form(extra: Partial<TaskFormState> = {}): TaskFormState {
	return {
		summary: 'Comprar pan',
		calendar: 'google/1',
		description: '',
		hasDue: false,
		allDay: false,
		due: '',
		status: 'NEEDS-ACTION',
		priority: 'none',
		...extra,
	};
}

describe('crear una tarea', () => {
	test('arma el parche con el título y sin id, y parte la cuenta y la lista', () => {
		const result = buildCreateTask(form(), 'UTC');
		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		expect(result.accountId).toBe('google');
		expect(result.calendarId).toBe('1');
		expect(result.patch.id).toBeUndefined();
		expect(result.patch.summary).toBe('Comprar pan');
		expect(result.patch.status).toBe('NEEDS-ACTION');
		// Sin prioridad se saca (null); sin vencimiento también.
		expect(result.patch.priority).toBeNull();
		expect(result.patch.due).toBeNull();
	});

	test('sin título, dice qué falta', () => {
		const result = buildCreateTask(form({ summary: '   ' }), 'UTC');
		expect(result).toEqual({ ok: false, error: 'tareas.faltaTitulo' });
	});

	test('sin lista con forma global, dice qué falta', () => {
		const result = buildCreateTask(form({ calendar: 'sin-barra' }), 'UTC');
		expect(result).toEqual({ ok: false, error: 'tareas.faltaCalendario' });
	});

	test('con vencimiento de día entero, arma un DATE sin zona', () => {
		const result = buildCreateTask(
			form({ hasDue: true, allDay: true, due: '2026-09-20' }),
			'America/Argentina/Buenos_Aires'
		);
		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		expect(result.patch.due).toEqual({ value: '20260920', params: ['VALUE=DATE'] });
	});

	test('con vencimiento con hora, arma un DATE-TIME con la zona', () => {
		const result = buildCreateTask(
			form({ hasDue: true, allDay: false, due: '2026-09-20T15:30' }),
			'Europe/Madrid'
		);
		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		expect(result.patch.due).toEqual({ value: '20260920T153000', params: ['TZID=Europe/Madrid'] });
	});

	test('un vencimiento a medio escribir no pasa', () => {
		const result = buildCreateTask(form({ hasDue: true, allDay: true, due: '2026-09' }), 'UTC');
		expect(result).toEqual({ ok: false, error: 'tareas.fechaInvalida' });
	});

	test('la prioridad elegida se traduce a su número', () => {
		for (const [priority, value] of [
			['high', 1],
			['medium', 5],
			['low', 9],
		] as const) {
			const result = buildCreateTask(form({ priority }), 'UTC');
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.patch.priority).toBe(value);
			}
		}
	});

	test('una descripción en blanco no se manda; una con texto sí', () => {
		expect((buildCreateTask(form({ description: '  ' }), 'UTC') as { patch: Record<string, unknown> }).patch.description).toBeUndefined();
		const conTexto = buildCreateTask(form({ description: 'con leche' }), 'UTC');
		expect(conTexto.ok).toBe(true);
		if (conTexto.ok) {
			expect(conTexto.patch.description).toBe('con leche');
		}
	});
});

describe('editar una tarea', () => {
	test('lleva el id local y arma cuenta y lista desde el calendario', () => {
		const result = buildEditTask(form({ summary: 'Otro' }), 'UTC', 'google/42');
		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		expect(result.accountId).toBe('google');
		expect(result.calendarId).toBe('1');
		expect(result.patch.id).toBe(42);
		expect(result.patch.summary).toBe('Otro');
	});

	test('un id de tarea sin forma global no se puede editar', () => {
		const result = buildEditTask(form(), 'UTC', 'sin-barra');
		expect(result).toEqual({ ok: false, error: 'tareas.noSePuede' });
	});

	test('un id local que no es un entero positivo no se puede editar', () => {
		expect(buildEditTask(form(), 'UTC', 'google/0')).toEqual({ ok: false, error: 'tareas.noSePuede' });
		expect(buildEditTask(form(), 'UTC', 'google/abc')).toEqual({ ok: false, error: 'tareas.noSePuede' });
	});
});

describe('completar desde la casilla', () => {
	const task = { task_id: 'google/42', calendar_id: 'google/1', etag: '"etag-1"' };

	test('marcar hecha fija el estado completado y el 100 por ciento', () => {
		const result = buildToggleDone(task, true);
		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		expect(result.accountId).toBe('google');
		expect(result.calendarId).toBe('1');
		expect(result.ifMatch).toBe('"etag-1"');
		expect(result.patch).toEqual({ id: 42, status: 'COMPLETED', percent_complete: 100 });
	});

	test('desmarcar vuelve a pendiente y a 0', () => {
		const result = buildToggleDone(task, false);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.patch).toEqual({ id: 42, status: 'NEEDS-ACTION', percent_complete: 0 });
		}
	});

	test('sin ETag no se puede completar: está pendiente de sincronizar', () => {
		const result = buildToggleDone({ ...task, etag: '' }, true);
		expect(result).toEqual({ ok: false, error: 'tareas.pendiente' });
	});

	test('una tarea sin id global no se puede completar', () => {
		const result = buildToggleDone({ task_id: 'sin-barra', calendar_id: 'google/1', etag: '"e"' }, true);
		expect(result).toEqual({ ok: false, error: 'tareas.noSePuede' });
	});
});

describe('traducir lo guardado al formulario', () => {
	test('el estado en minúsculas se vuelve el del formulario; lo desconocido, pendiente', () => {
		expect(statusFromString('completed')).toBe('COMPLETED');
		expect(statusFromString('IN-PROCESS')).toBe('IN-PROCESS');
		expect(statusFromString('')).toBe('NEEDS-ACTION');
		expect(statusFromString(null)).toBe('NEEDS-ACTION');
		expect(statusFromString('loquesea')).toBe('NEEDS-ACTION');
	});

	test('el número de prioridad cae en su tramo; 0 o nada es sin prioridad', () => {
		expect(priorityFromNumber(1)).toBe('high');
		expect(priorityFromNumber(4)).toBe('high');
		expect(priorityFromNumber(5)).toBe('medium');
		expect(priorityFromNumber(7)).toBe('medium');
		expect(priorityFromNumber(8)).toBe('low');
		expect(priorityFromNumber(9)).toBe('low');
		expect(priorityFromNumber(0)).toBe('none');
		expect(priorityFromNumber(null)).toBe('none');
		expect(priorityFromNumber(undefined)).toBe('none');
	});
});
