/**
 * Leer un evento de iCalendar crudo para mostrarlo en la comparación de un
 * conflicto. Las trampas que se prueban —líneas partidas, texto con escapes,
 * parámetros antes del valor— no se ven hasta que un título con una coma aparece
 * cortado.
 */

import { describe, expect, test } from 'bun:test';
import { formatIcalDate, parseIcalCard, unfold } from '../src/tools/ical-summary';

describe('unfold', () => {
	test('junta las líneas que siguen con un espacio o una tabulación', () => {
		// Una continuación empieza con espacio o tab; un tab dentro del valor (sin
		// salto antes) es parte del valor, no un doblez.
		const raw = 'SUMMARY:Una reunión\r\n  muy larga\n DESCRIPTION sigue';
		expect(unfold(raw)).toEqual(['SUMMARY:Una reunión muy largaDESCRIPTION sigue']);
	});

	test('una continuación sin línea previa se deja tal cual, sin explotar', () => {
		expect(unfold(' huérfana')).toEqual([' huérfana']);
	});
});

describe('formatIcalDate', () => {
	test('todo el día es sólo la fecha', () => {
		expect(formatIcalDate('20260915', ['VALUE=DATE'])).toBe('2026-09-15');
	});

	test('UTC lleva la marca', () => {
		expect(formatIcalDate('20260915T140000Z', [])).toBe('2026-09-15 14:00 UTC');
	});

	test('con TZID, la zona entre paréntesis', () => {
		expect(formatIcalDate('20260915T140000', ['TZID=Europe/Madrid'])).toBe(
			'2026-09-15 14:00 (Europe/Madrid)'
		);
	});

	test('con hora y sin zona ni Z, sólo la hora', () => {
		expect(formatIcalDate('20260915T140000', [])).toBe('2026-09-15 14:00');
	});

	test('lo que no es una fecha vuelve tal cual', () => {
		expect(formatIcalDate('mañana', [])).toBe('mañana');
	});
});

describe('parseIcalCard', () => {
	const RAW = [
		'BEGIN:VEVENT',
		'UID:abc',
		'SUMMARY:Reunión\\, con escape',
		'DTSTART;TZID=Europe/Madrid:20260915T140000',
		'DTEND;TZID=Europe/Madrid:20260915T150000',
		'LOCATION:Sala 2',
		'DESCRIPTION:Primera línea\\nSegunda',
		'END:VEVENT',
	].join('\r\n');

	test('saca el título sin escapes, las fechas legibles y la ubicación', () => {
		const card = parseIcalCard(RAW);
		expect(card.summary).toBe('Reunión, con escape');
		expect(card.start).toBe('2026-09-15 14:00 (Europe/Madrid)');
		expect(card.end).toBe('2026-09-15 15:00 (Europe/Madrid)');
		expect(card.location).toBe('Sala 2');
		expect(card.description).toBe('Primera línea\nSegunda');
	});

	test('toma el primer valor de cada propiedad y no se confunde con los dos puntos del valor', () => {
		const raw = 'SUMMARY:Reunión: la buena\nSUMMARY:la repetida';
		expect(parseIcalCard(raw).summary).toBe('Reunión: la buena');
	});

	test('un crudo sin nada reconocible deja todo vacío', () => {
		const card = parseIcalCard('BEGIN:VEVENT\r\nEND:VEVENT');
		expect(card).toEqual({ summary: '', location: '', description: '', start: '', end: '' });
	});

	test('una línea sin dos puntos no es una propiedad', () => {
		expect(parseIcalCard('esto no es nada').summary).toBe('');
	});
});
