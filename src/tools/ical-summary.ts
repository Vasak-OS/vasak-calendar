/**
 * Leer un evento de iCalendar crudo para **mostrarlo**, no para escribirlo.
 *
 * La vista de un conflicto compara dos versiones de un evento —la mía y la del
 * servidor— y las dos llegan como iCal crudo (`GetConflict`, ver `store.rs`). No
 * se interpreta todo el formato: alcanza con el título, las fechas y la
 * ubicación para que la persona reconozca qué está eligiendo. Lo que no se
 * entiende no rompe nada: queda el crudo, que la vista muestra tal cual como
 * respaldo.
 *
 * Va aparte y con pruebas porque desarmar el crudo tiene trampas —líneas
 * partidas, texto con escapes, parámetros antes del valor— que no se ven hasta
 * que un título con una coma aparece cortado.
 */

/** Un evento crudo, con lo justo para reconocerlo en la vista de un conflicto. */
export interface IcalCard {
	/** `SUMMARY`, ya sin escapes. Vacío si no venía. */
	summary: string;
	/** `LOCATION`, ya sin escapes. Vacío si no venía. */
	location: string;
	/** `DESCRIPTION`, ya sin escapes. Vacío si no venía. */
	description: string;
	/** `DTSTART` en una forma legible (`AAAA-MM-DD`, con hora y zona si tiene). */
	start: string;
	/** `DTEND` en la misma forma. Vacío si no venía. */
	end: string;
}

/**
 * Junta las líneas partidas de un iCalendar.
 *
 * El formato corta las líneas largas y sigue en la siguiente con un espacio o
 * una tabulación adelante. Sin volver a juntarlas, un título largo aparece
 * cortado y una fecha partida no se interpreta — y los títulos largos son
 * justamente los que más se cortan. Es la misma regla que `unir_lineas` en
 * `caldav.rs`, del lado de la lectura.
 */
export function unfold(raw: string): string[] {
	const lines: string[] = [];
	for (const rawLine of raw.split('\n')) {
		const line = rawLine.replace(/\r$/, '');
		if ((line.startsWith(' ') || line.startsWith('\t')) && lines.length > 0) {
			lines[lines.length - 1] += line.slice(1);
			continue;
		}
		lines.push(line);
	}
	return lines;
}

/** Una propiedad de iCalendar: su nombre en mayúsculas, sus parámetros, su valor. */
interface IcalProperty {
	name: string;
	params: string[];
	value: string;
}

/**
 * Parte una línea `NOMBRE;PARAM=VAL:valor` en sus tres partes.
 *
 * El valor arranca en el **primer** dos puntos: un valor puede tener los suyos
 * —una URL, por ejemplo—, pero el nombre y los parámetros no. Devuelve `null`
 * si no hay dos puntos: no es una propiedad con valor.
 */
function parseLine(line: string): IcalProperty | null {
	const colon = line.indexOf(':');
	if (colon < 0) {
		return null;
	}
	const head = line.slice(0, colon);
	const value = line.slice(colon + 1);
	const parts = head.split(';');
	const name = parts[0].toUpperCase();
	if (!name) {
		return null;
	}
	return { name, params: parts.slice(1), value };
}

/**
 * Deshace los escapes del texto de iCalendar: `\\n` es un salto, y `\\,` `\\;`
 * `\\\\` son la coma, el punto y coma y la barra literales. El orden importa:
 * la barra va última para no deshacer lo que las otras acaban de poner.
 */
function unescapeText(value: string): string {
	return value
		.replace(/\\n/gi, '\n')
		.replace(/\\,/g, ',')
		.replace(/\\;/g, ';')
		.replace(/\\\\/g, '\\');
}

/**
 * La zona declarada en los parámetros de una fecha (`TZID=...`), o vacío.
 */
function tzidOf(params: string[]): string {
	for (const param of params) {
		const match = /^TZID=(.+)$/i.exec(param);
		if (match) {
			return match[1];
		}
	}
	return '';
}

/**
 * Una fecha de iCalendar en una forma legible, sin resolver zonas.
 *
 * `AAAAMMDD` (todo el día) → `AAAA-MM-DD`; `AAAAMMDDTHHMMSSZ` → `AAAA-MM-DD
 * HH:MM UTC`; con `TZID`, la zona entre paréntesis. Lo que no tiene esa forma
 * vuelve tal cual: antes que inventar una fecha, se muestra el crudo.
 */
export function formatIcalDate(value: string, params: string[]): string {
	const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value);
	if (!match) {
		return value;
	}
	const [, y, mo, d, h, mi, , z] = match;
	const day = `${y}-${mo}-${d}`;
	if (h === undefined) {
		return day;
	}
	const time = `${h}:${mi}`;
	if (z) {
		return `${day} ${time} UTC`;
	}
	const zone = tzidOf(params);
	return zone ? `${day} ${time} (${zone})` : `${day} ${time}`;
}

/**
 * Lee de un iCal crudo lo justo para reconocer el evento. Toma el **primer**
 * valor de cada propiedad: un `VEVENT` sano no las repite, y ante uno raro es
 * mejor mostrar uno que ninguno.
 */
export function parseIcalCard(raw: string): IcalCard {
	const card: IcalCard = { summary: '', location: '', description: '', start: '', end: '' };
	const seen = new Set<string>();
	for (const line of unfold(raw)) {
		const property = parseLine(line);
		if (!property || seen.has(property.name)) {
			continue;
		}
		switch (property.name) {
			case 'SUMMARY':
				card.summary = unescapeText(property.value);
				seen.add(property.name);
				break;
			case 'LOCATION':
				card.location = unescapeText(property.value);
				seen.add(property.name);
				break;
			case 'DESCRIPTION':
				card.description = unescapeText(property.value);
				seen.add(property.name);
				break;
			case 'DTSTART':
				card.start = formatIcalDate(property.value, property.params);
				seen.add(property.name);
				break;
			case 'DTEND':
				card.end = formatIcalDate(property.value, property.params);
				seen.add(property.name);
				break;
		}
	}
	return card;
}
