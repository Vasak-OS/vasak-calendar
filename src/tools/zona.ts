/**
 * Pasar de un instante a un reloj de pared y al revés, en la zona que sea.
 *
 * ── Por qué no alcanza con `Date` ───────────────────────────────────────────
 *
 * Un `Date` de JavaScript es un instante, y todos sus métodos de lectura
 * —`getDate()`, `getMonth()`, `getDay()`— contestan **en la zona del sistema**.
 * Eso está bien mientras la agenda se muestre en la zona del sistema; en cuanto
 * la persona elige otra —porque viaja, o porque trabaja con gente de afuera— no
 * hay forma de preguntarle a `Date` qué día es «ahí».
 *
 * Así que la cuadrícula deja de razonar con instantes y pasa a razonar con
 * **fechas civiles**: año, mes, día, hora y minuto tal como los muestra un reloj
 * colgado en esa zona. Este módulo es el puente entre las dos cosas.
 *
 * ── Va aparte y con pruebas ─────────────────────────────────────────────────
 *
 * Por el mismo motivo que `mes.ts`: una conversión de zona mal hecha no rompe
 * nada a la vista. Corre un evento una hora, o un día, y se ve perfectamente
 * bien. La persona se entera cuando llega tarde.
 */

/** Un reloj de pared: lo que se lee en un reloj colgado en alguna zona. */
export interface Civil {
	anio: number;
	/** De 1 a 12, como lo dice la gente y no como lo cuenta `Date`. */
	mes: number;
	dia: number;
	hora: number;
	minuto: number;
}

/** La zona horaria en la que está el sistema. */
export function zonaDeLaSesion(): string {
	try {
		return new Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
	} catch {
		// Un motor sin zonas no es un motivo para no abrir el calendario.
		return 'UTC';
	}
}

/** Si el motor sabe de esa zona. */
export function esZonaConocida(zona: string): boolean {
	if (!zona) {
		return false;
	}
	try {
		new Intl.DateTimeFormat('en-US', { timeZone: zona });
		return true;
	} catch {
		return false;
	}
}

/**
 * Todas las zonas que conoce el motor, para poder elegir una.
 *
 * `supportedValuesOf` es relativamente nuevo. Si no está, se devuelve lo mínimo
 * que deja funcionar la pantalla —la del sistema y UTC— en vez de romperla: no
 * poder elegir otra zona es una función menos, no una aplicación que no abre.
 */
export function zonasConocidas(): string[] {
	try {
		const todas = Intl.supportedValuesOf?.('timeZone');
		if (todas && todas.length > 0) {
			return todas;
		}
	} catch {
		// Cae al respaldo de abajo.
	}
	return [...new Set([zonaDeLaSesion(), 'UTC'])].sort();
}

/**
 * Formateadores ya armados, por zona.
 *
 * `Intl.DateTimeFormat` es caro de construir y esto se llama una vez por evento
 * y por celda: sin la caché, pintar un mes con cien eventos construye cientos de
 * formateadores idénticos y la cuadrícula se siente pesada al cambiar de mes.
 */
const formateadores = new Map<string, Intl.DateTimeFormat>();

function formateador(zona: string): Intl.DateTimeFormat {
	const guardado = formateadores.get(zona);
	if (guardado) {
		return guardado;
	}
	const nuevo = new Intl.DateTimeFormat('en-US', {
		timeZone: zona,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		// `h23` y no `hour12: false`: con lo segundo hay motores que devuelven la
		// medianoche como «24», y un 24 en la hora corre el día entero.
		hourCycle: 'h23',
		era: 'short',
	});
	formateadores.set(zona, nuevo);
	return nuevo;
}

/** El reloj de pared de un instante, en una zona. */
export function civilDe(instante: Date, zona: string): Civil {
	const partes = formateador(zona).formatToParts(instante);
	const valor = (tipo: Intl.DateTimeFormatPartTypes) =>
		Number(partes.find((p) => p.type === tipo)?.value ?? '0');

	// Antes de Cristo el año vuelve a contar hacia arriba, así que sin mirar la
	// era un evento del año 1 a.C. se confunde con uno del 1 d.C. No pasa con un
	// calendario de verdad; pasa con lo que manda un servidor cualquiera.
	const antesDeCristo = partes.some((p) => p.type === 'era' && p.value.startsWith('B'));
	const anio = valor('year');

	return {
		anio: antesDeCristo ? 1 - anio : anio,
		mes: valor('month'),
		dia: valor('day'),
		hora: valor('hour'),
		minuto: valor('minute'),
	};
}

/**
 * Cuánto corre una zona respecto de UTC en ese instante, en minutos.
 *
 * Positivo al este de Greenwich. Cambia a lo largo del año en las zonas con
 * horario de verano, y por eso se pregunta **por instante** y no por zona.
 */
export function desplazamientoDe(instante: Date, zona: string): number {
	const civil = civilDe(instante, zona);
	// Los segundos y los milisegundos no participan: ninguna zona tiene un
	// desplazamiento con fracción de minuto desde hace un siglo, y arrastrarlos
	// sólo mete ruido en la resta.
	const alRas = Math.floor(instante.getTime() / 60000) * 60000;
	return (enUtc(civil) - alRas) / 60000;
}

/**
 * El instante en el que un reloj de pared marca eso, en esa zona.
 *
 * ── Por qué son dos pasadas ─────────────────────────────────────────────────
 *
 * Para saber qué instante es «las 9 en Madrid» hace falta el desplazamiento de
 * Madrid, y para saber el desplazamiento hace falta el instante. Se rompe el
 * círculo suponiendo que el reloj de pared es UTC, midiendo el desplazamiento
 * ahí, y corrigiendo. La segunda pasada existe porque la primera puede caer del
 * otro lado de un cambio de horario de verano.
 *
 * Dentro de la hora del cambio esto puede errar por una hora: es la misma
 * ambigüedad que tiene el formato —hay una hora local que no existe y otra que
 * ocurre dos veces— y está resuelta del mismo modo que del lado del programa.
 */
export function instanteDe(civil: Civil, zona: string): Date {
	const supuesto = enUtc(civil);
	const primera = supuesto - desplazamientoDe(new Date(supuesto), zona) * 60000;
	const segunda = supuesto - desplazamientoDe(new Date(primera), zona) * 60000;
	return new Date(segunda);
}

/** La medianoche de un día civil, como instante. */
export function medianocheDe(civil: Civil, zona: string): Date {
	return instanteDe({ ...civil, hora: 0, minuto: 0 }, zona);
}

/** `AAAA-MM-DD` de una fecha civil. Es la clave con la que se agrupa por día. */
export function claveCivil(civil: Civil): string {
	const mes = String(civil.mes).padStart(2, '0');
	const dia = String(civil.dia).padStart(2, '0');
	return `${String(civil.anio).padStart(4, '0')}-${mes}-${dia}`;
}

/**
 * Suma días a una fecha civil, sin tocar la hora.
 *
 * **Civil y no de instantes**: sumarle 24 horas a un instante cruza un cambio de
 * horario de verano y cae a las 23 o a la 1 del día siguiente, y la cuadrícula
 * termina con un día repetido o uno faltante. Contando días en el calendario eso
 * no puede pasar.
 */
export function sumarDiasCivil(civil: Civil, dias: number): Civil {
	// Se apoya en la aritmética de `Date` en UTC, que es puro calendario: sin
	// zona no hay horario de verano que la corra.
	const fecha = new Date(enUtc({ ...civil, hora: 12, minuto: 0 }));
	fecha.setUTCDate(fecha.getUTCDate() + dias);
	return {
		anio: fecha.getUTCFullYear(),
		mes: fecha.getUTCMonth() + 1,
		dia: fecha.getUTCDate(),
		hora: civil.hora,
		minuto: civil.minuto,
	};
}

/** El primero de otro mes, contando desde una fecha civil. */
export function primeroDeMesCivil(civil: Civil, meses: number): Civil {
	const fecha = new Date(enUtc({ anio: civil.anio, mes: civil.mes, dia: 1, hora: 12, minuto: 0 }));
	fecha.setUTCMonth(fecha.getUTCMonth() + meses);
	return {
		anio: fecha.getUTCFullYear(),
		mes: fecha.getUTCMonth() + 1,
		dia: 1,
		hora: 0,
		minuto: 0,
	};
}

/**
 * Qué día de la semana cae una fecha civil, con el lunes en 0.
 *
 * `getDay()` cuenta desde el domingo. En español —y en la norma ISO— la semana
 * empieza el lunes, así que sin la rotación el mes entero sale corrido una
 * columna.
 */
export function columnaCivil(civil: Civil): number {
	return (new Date(enUtc(civil)).getUTCDay() + 6) % 7;
}

/** Si dos fechas civiles son el mismo día. */
export function mismoDiaCivil(a: Civil, b: Civil): boolean {
	return a.anio === b.anio && a.mes === b.mes && a.dia === b.dia;
}

/**
 * Una fecha civil leída como si fuera UTC.
 *
 * `Date.UTC` con un año de dos dígitos lo manda a los 1900, así que el año se
 * pone aparte. Con un calendario de verdad no pasa; con lo que manda un servidor
 * cualquiera, sí.
 */
function enUtc(civil: Civil): number {
	const fecha = new Date(0);
	fecha.setUTCFullYear(civil.anio, civil.mes - 1, civil.dia);
	fecha.setUTCHours(civil.hora, civil.minuto, 0, 0);
	return fecha.getTime();
}
