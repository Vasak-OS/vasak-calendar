/**
 * El texto del vencimiento de una tarea y si ya pasó.
 *
 * Como en `mes.ts`, una fecha leída en la zona equivocada cae un día de lugar y
 * no se nota: el de todo-el-día se lee en UTC, el de con hora en la zona de la
 * agenda. Acá se prueba sin montar nada.
 */

import { describe, expect, test } from 'bun:test';
import { formatDue, isOverdue } from '@/tools/task-display';

describe('el texto del vencimiento', () => {
	test('un día entero sale sólo con la fecha, leído en UTC', () => {
		// La medianoche UTC del 20; en Buenos Aires son las 21 del 19. Leído en
		// UTC tiene que seguir siendo el 20, no correrse al 19.
		const texto = formatDue('2026-09-20T00:00:00Z', true, 'America/Argentina/Buenos_Aires', 'es-ES');
		expect(texto).toContain('20');
		expect(texto).toContain('2026');
		// Sin hora: no lleva dos puntos de reloj.
		expect(texto).not.toMatch(/\d\d:\d\d/);
	});

	test('con hora, lleva la hora en la zona de la agenda', () => {
		const texto = formatDue('2026-09-20T12:00:00Z', false, 'UTC', 'es-ES');
		expect(texto).toMatch(/\d\d:\d\d/);
	});

	test('sin vencimiento, o una fecha que no se entiende, es vacío', () => {
		expect(formatDue(null, true, 'UTC', 'es-ES')).toBe('');
		expect(formatDue(undefined, false, 'UTC', 'es-ES')).toBe('');
		expect(formatDue('mañana', false, 'UTC', 'es-ES')).toBe('');
	});
});

describe('si el vencimiento ya pasó', () => {
	const ahora = new Date('2026-09-20T12:00:00Z');

	test('una tarea con hora ya pasada está vencida', () => {
		expect(isOverdue('2026-09-20T10:00:00Z', false, false, ahora)).toBe(true);
		expect(isOverdue('2026-09-20T14:00:00Z', false, false, ahora)).toBe(false);
	});

	test('una terminada nunca está vencida: ya se hizo', () => {
		expect(isOverdue('2026-09-19T10:00:00Z', false, true, ahora)).toBe(false);
	});

	test('una de día entero vence al terminar el día, no al empezar', () => {
		// El día de hoy (su medianoche UTC) no está vencido todavía.
		expect(isOverdue('2026-09-20T00:00:00Z', true, false, ahora)).toBe(false);
		// El de ayer sí.
		expect(isOverdue('2026-09-18T00:00:00Z', true, false, ahora)).toBe(true);
	});

	test('sin vencimiento, nunca está vencida', () => {
		expect(isOverdue(null, false, false, ahora)).toBe(false);
	});
});
