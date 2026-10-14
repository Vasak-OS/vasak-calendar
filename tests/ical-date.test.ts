import { describe, expect, test } from 'bun:test';
import {
	allDayToIcal,
	dateTimeToIcal,
	isoToDatePicker,
	isoToDateTimePicker,
	pickerToIcal,
} from '../src/tools/ical-date';

const BUENOS_AIRES = 'America/Argentina/Buenos_Aires';
const MADRID = 'Europe/Madrid';

describe('todo el día', () => {
	test('va como DATE, sin zona ni hora', () => {
		expect(allDayToIcal('2026-09-15')).toEqual({
			value: '20260915',
			params: ['VALUE=DATE'],
		});
	});

	test('un día entero es el mismo en cualquier zona: nunca lleva TZID', () => {
		// Es el error que esto existe para no cometer: con hora o con zona, un
		// feriado del 15 cae el 14 para medio mundo.
		const madrid = allDayToIcal('2026-01-01');
		expect(madrid?.params).toEqual(['VALUE=DATE']);
		expect(madrid?.value).toBe('20260101');
	});

	test('una fecha a medio escribir o vacía se rechaza', () => {
		for (const basura of ['', '2026-09', '2026/09/15', 'mañana', '2026-9-5']) {
			expect(allDayToIcal(basura)).toBeNull();
		}
	});
});

describe('con hora', () => {
	test('en una zona con nombre va el reloj de pared crudo con TZID', () => {
		// No se convierte a ningún instante: lo que la persona escribió es lo que
		// se escribe, con su zona pegada.
		expect(dateTimeToIcal('2026-09-15T14:30', MADRID)).toEqual({
			value: '20260915T143000',
			params: ['TZID=Europe/Madrid'],
		});
	});

	test('en UTC va la marca Z y ningún parámetro', () => {
		expect(dateTimeToIcal('2026-09-15T14:30', 'UTC')).toEqual({
			value: '20260915T143000Z',
			params: [],
		});
	});

	test('los segundos, si vienen, se respetan', () => {
		expect(dateTimeToIcal('2026-09-15T14:30:45', MADRID)?.value).toBe('20260915T143045');
	});

	test('un valor que no tiene la forma esperada se rechaza', () => {
		for (const basura of ['', '2026-09-15', '2026-09-15 14:30', 'mañana']) {
			expect(dateTimeToIcal(basura, MADRID)).toBeNull();
		}
	});
});

describe('pickerToIcal elige la forma según todo-el-día', () => {
	test('todo el día usa DATE', () => {
		expect(pickerToIcal('2026-09-15', MADRID, true)).toEqual({
			value: '20260915',
			params: ['VALUE=DATE'],
		});
	});

	test('con hora usa DATE-TIME', () => {
		expect(pickerToIcal('2026-09-15T09:00', MADRID, false)).toEqual({
			value: '20260915T090000',
			params: ['TZID=Europe/Madrid'],
		});
	});
});

describe('ida y vuelta del selector con hora', () => {
	// Lo que sale de un campo, pasado a iCalendar y leído de nuevo, vuelve igual:
	// con TZID el valor es el reloj de pared crudo, así que la vuelta es directa.
	test('el reloj de pared sobrevive el viaje', () => {
		const wall = '2026-09-15T14:30';
		const ical = dateTimeToIcal(wall, MADRID);
		expect(ical).not.toBeNull();
		// Reconstruir el `AAAA-MM-DDTHH:MM` desde el valor crudo.
		const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})/.exec(ical?.value ?? '');
		expect(m).not.toBeNull();
		const devuelto = `${m?.[1]}-${m?.[2]}-${m?.[3]}T${m?.[4]}:${m?.[5]}`;
		expect(devuelto).toBe(wall);
	});
});

describe('abrir el selector desde un instante', () => {
	test('con hora, lee el reloj de pared de la zona de la agenda', () => {
		// 17:30 UTC son las 14:30 en Buenos Aires (−03:00).
		expect(isoToDateTimePicker('2026-09-15T17:30:00Z', BUENOS_AIRES)).toBe('2026-09-15T14:30');
		// Y las 19:30 en Madrid en septiembre (verano, +02:00).
		expect(isoToDateTimePicker('2026-09-15T17:30:00Z', MADRID)).toBe('2026-09-15T19:30');
	});

	test('todo el día se lee en UTC, no en la zona: no se corre de día', () => {
		// El almacén guarda el día entero como la medianoche UTC. En Buenos Aires
		// esa medianoche es el día anterior; leerlo en UTC lo deja en su día.
		expect(isoToDatePicker('2026-09-15T00:00:00Z', true, BUENOS_AIRES)).toBe('2026-09-15');
	});

	test('una hora cercana a la medianoche no cambia de día al leerse en su zona', () => {
		// 02:00 UTC del 15 son las 23:00 del 14 en Buenos Aires.
		expect(isoToDateTimePicker('2026-09-15T02:00:00Z', BUENOS_AIRES)).toBe('2026-09-14T23:00');
	});
});

describe('ida y vuelta de un evento con hora por su zona', () => {
	test('abrir y volver a guardar no corre el evento', () => {
		// Un evento que la agenda muestra en Madrid: se abre el selector con su
		// reloj de pared y, al guardarlo con TZID=Madrid, el valor es ese mismo
		// reloj. El instante sólo lo vuelve a fijar el servidor con la zona.
		const iso = '2026-09-15T17:30:00Z';
		const wall = isoToDateTimePicker(iso, MADRID);
		const ical = dateTimeToIcal(wall, MADRID);
		expect(ical).toEqual({ value: '20260915T193000', params: ['TZID=Europe/Madrid'] });
	});
});
