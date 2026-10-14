/**
 * Pasar lo que elige el formulario de un evento a una fecha de iCalendar, y al
 * revés.
 *
 * ── Por qué va aparte y con pruebas ──────────────────────────────────────────
 *
 * Es el borde donde una fecha deja de ser «lo que marcó la persona» y pasa a ser
 * lo que se sube al servidor con su credencial. Equivocarse acá no rompe nada a
 * la vista —el evento se guarda, aparece en la cuadrícula— pero cae un día o una
 * hora de lugar, o peor: una fecha de todo-el-día que sale con hora termina a las
 * nueve de la noche del día anterior en Buenos Aires, que es el mismo error que
 * `mes.ts` existe para no cometer, ahora del lado de la escritura.
 *
 * ── Las dos formas de una fecha de iCalendar ─────────────────────────────────
 *
 *  - **Con hora** (`DATE-TIME`): `AAAAMMDDTHHMMSS` con `TZID=<zona>`, o
 *    `AAAAMMDDTHHMMSSZ` sin parámetro cuando la zona es UTC. El valor es el
 *    **reloj de pared** en esa zona: no se convierte a ningún instante acá —el
 *    servidor resuelve la zona con el mismo lector que la lectura—, así que lo
 *    que la persona escribió es lo que se escribe, con su zona pegada.
 *  - **Todo el día** (`DATE`): `AAAAMMDD` con `VALUE=DATE` y **sin** zona. Un
 *    día entero no tiene hora ni huso: ponérselos lo correría al mirarlo desde
 *    otra zona.
 *
 * El parche que se arma con esto es `{ value, params }`, tal como lo espera
 * `PutEvent` del almacén (ver `store.rs`).
 */

import { type Civil, civilDe } from '@/tools/zona';

/** Una fecha lista para el parche de `PutEvent`: el valor y sus parámetros. */
export interface IcalDate {
	value: string;
	params: string[];
}

/** Dos dígitos, con el cero adelante. */
function pad2(n: number): string {
	return String(n).padStart(2, '0');
}

/** Cuatro dígitos de año, con ceros adelante. */
function pad4(n: number): string {
	return String(n).padStart(4, '0');
}

/**
 * La fecha de todo-el-día de un `<input type="date">` (`AAAA-MM-DD`) como
 * `DATE` de iCalendar.
 *
 * Sin zona ni hora a propósito: un día entero es el mismo día en cualquier huso,
 * y pegarle una zona lo correría. Un valor que no tiene la forma de una fecha
 * —vacío, a medio escribir— devuelve `null`: no se inventa una fecha, se rechaza
 * y la ventana no deja guardar.
 */
export function allDayToIcal(day: string): IcalDate | null {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
	if (!match) {
		return null;
	}
	return {
		value: `${match[1]}${match[2]}${match[3]}`,
		params: ['VALUE=DATE'],
	};
}

/**
 * La fecha-hora de un `<input type="datetime-local">` (`AAAA-MM-DDTHH:MM`),
 * interpretada como el reloj de pared de `zone`, como `DATE-TIME` de iCalendar.
 *
 * Los segundos van en cero: el campo no los pide. Con la zona en UTC se escribe
 * la marca `Z` y ningún parámetro, que es la forma canónica; con cualquier otra,
 * el valor crudo y el `TZID`. No se convierte a ningún instante: el valor es la
 * hora que la persona ve, y la zona viaja con él.
 *
 * Un valor que no tiene la forma esperada devuelve `null`.
 */
export function dateTimeToIcal(wall: string, zone: string): IcalDate | null {
	const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(wall);
	if (!match) {
		return null;
	}
	const [, y, mo, d, h, mi, s] = match;
	const stamp = `${y}${mo}${d}T${h}${mi}${s ?? '00'}`;
	if (zone === 'UTC') {
		return { value: `${stamp}Z`, params: [] };
	}
	return { value: stamp, params: [`TZID=${zone}`] };
}

/**
 * Arma la fecha del parche a partir de lo que tiene el formulario: el valor del
 * campo y si es de todo el día.
 *
 * Es el único punto por el que pasa el formulario: así no decide en dos lados si
 * mandar `DATE` o `DATE-TIME`.
 */
export function pickerToIcal(value: string, zone: string, allDay: boolean): IcalDate | null {
	return allDay ? allDayToIcal(value) : dateTimeToIcal(value, zone);
}

/**
 * El valor con el que abrir un `<input type="date">` a partir de un instante,
 * leído en la zona de la agenda: `AAAA-MM-DD`.
 *
 * Para todo-el-día se lee en UTC, no en la zona: el almacén guarda un día
 * completo como la medianoche UTC de ese día, y leerlo en otra zona lo correría
 * —en Buenos Aires esa medianoche es el día anterior—, igual que en `mes.ts`.
 */
export function isoToDatePicker(iso: string, allDay: boolean, zone: string): string {
	const civil = civilDe(new Date(iso), allDay ? 'UTC' : zone);
	return civilToDate(civil);
}

/**
 * El valor con el que abrir un `<input type="datetime-local">` a partir de un
 * instante, leído como el reloj de pared de la zona de la agenda:
 * `AAAA-MM-DDTHH:MM`.
 */
export function isoToDateTimePicker(iso: string, zone: string): string {
	const civil = civilDe(new Date(iso), zone);
	return `${civilToDate(civil)}T${pad2(civil.hora)}:${pad2(civil.minuto)}`;
}

/** `AAAA-MM-DD` de una fecha civil, para un `<input type="date">`. */
function civilToDate(civil: Civil): string {
	return `${pad4(civil.anio)}-${pad2(civil.mes)}-${pad2(civil.dia)}`;
}
