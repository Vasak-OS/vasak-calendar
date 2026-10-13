/**
 * Un evento de prueba, con valores por omisión que se pisan por campo.
 *
 * Vive acá y no dentro de cada archivo de prueba porque varios lo arman igual
 * —la agenda, las vistas— y tres copias del mismo molde terminan separándose.
 * No es un `.test.ts`, así que el corredor no lo toma como una suite.
 */

import type { CalendarEvent } from '@/tools/mes';

export function calendarEvent(extra: Partial<CalendarEvent> = {}): CalendarEvent {
	return {
		uid: 'uno',
		title: 'Reunión',
		start: '2026-09-15T14:00:00Z',
		end: '2026-09-15T15:00:00Z',
		all_day: false,
		recurring: false,
		shown_once: false,
		zone: '',
		calendar: 'https://nube.ejemplo.com/personal/',
		color: '#e66100',
		...extra,
	};
}
