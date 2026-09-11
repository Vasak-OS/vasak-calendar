/**
 * La aritmética de la cuadrícula del mes.
 *
 * Va aparte de los componentes y sin nada de Vue adentro porque es lo único de
 * un calendario que se equivoca **en silencio**: una celda corrida un día se ve
 * perfectamente bien, y la persona se entera cuando llega tarde a algo. Acá se
 * puede probar sin montar nada.
 *
 * ── Todo esto pasa en «la zona de la agenda» ────────────────────────────────
 *
 * Un evento llega en UTC desde el programa. Qué día del mes ocupa no depende de
 * dónde está el servidor: depende del reloj contra el que lo mire la persona. Y
 * ese reloj no es necesariamente el del sistema — quien viaja puede querer
 * seguir viendo su agenda con la hora de su casa.
 *
 * Así que cada función de acá recibe la zona y trabaja con **fechas civiles**
 * —lo que marca un reloj colgado en esa zona—, no con los métodos de `Date`, que
 * siempre contestan en la zona del sistema. El puente está en `zona.ts`.
 */

import {
	type Civil,
	civilDe,
	claveCivil,
	columnaCivil,
	medianocheDe,
	mismoDiaCivil,
	primeroDeMesCivil,
	sumarDiasCivil,
} from '@/tools/zona';

/** Cuántos días trae una semana. Nombrado para que la aritmética se lea. */
const DIAS_POR_SEMANA = 7;

/**
 * Cuántas semanas puede llegar a ocupar un mes.
 *
 * Seis: un mes de 31 días que arranca en domingo las necesita. Es el tope, no la
 * cantidad — ver [`semanasDe`].
 */
const MAX_SEMANAS = 6;

/**
 * Cuántas filas ocupa de verdad ese mes.
 *
 * **Las que hagan falta y no siempre seis.** Con seis fijas, septiembre de 2026
 * dibujaba una séptima fila entera del mes siguiente, que no es relleno de los
 * bordes: es una semana completa que no tiene nada que ver con lo que se está
 * mirando.
 *
 * Que la cantidad cambie de mes a mes no mueve nada de lugar: la cuadrícula
 * ocupa el alto que le da su contenedor y lo reparte entre las filas que haya,
 * así que lo que cambia es el alto de cada celda y no el del mes.
 */
function semanasDe(primero: Civil, dias: number): number {
	const ocupadas = Math.ceil((columnaCivil(primero) + dias) / DIAS_POR_SEMANA);
	return Math.min(ocupadas, MAX_SEMANAS);
}

/** Cuántos días tiene el mes de esa fecha. */
function diasDelMes(civil: Civil): number {
	return sumarDiasCivil(primeroDeMesCivil(civil, 1), -1).dia;
}

/** Un día de la cuadrícula. */
export interface Dia {
	/** La medianoche de ese día **en la zona de la agenda**, como instante. */
	fecha: Date;
	/**
	 * `AAAA-MM-DD` en esa zona.
	 *
	 * Va calculada acá y no en quien la use: sacarla de la fecha necesita la
	 * zona, y así los componentes no tienen que conocerla para identificar un
	 * día.
	 */
	clave: string;
	/** Si cae en el mes que se está mirando, o es relleno del anterior/siguiente. */
	delMes: boolean;
	esHoy: boolean;
}

/** Un evento tal como llega del programa. */
export interface Evento {
	uid: string;
	titulo: string;
	/** ISO 8601, en UTC. */
	inicio: string;
	fin: string;
	/** Los nombres vienen del programa tal cual: Tauri no los convierte. */
	todo_el_dia: boolean;
	se_repite: boolean;
	/**
	 * La zona en la que lo escribieron, tal como venía en el archivo.
	 *
	 * Vacía si el evento venía en UTC, si era de día completo o si no decía
	 * ninguna. Sirve para avisar cuando un evento está escrito en una zona
	 * distinta de aquella en la que se está mirando la agenda.
	 */
	zona: string;
	calendario: string;
	color: string | null;
}

/** Las 42 celdas del mes que contiene `referencia`, en la zona de la agenda. */
export function cuadricula(referencia: Date, zona: string, hoy: Date = new Date()): Dia[] {
	const mirando = civilDe(referencia, zona);
	const primero: Civil = { ...mirando, dia: 1, hora: 0, minuto: 0 };
	const arranque = sumarDiasCivil(primero, -columnaCivil(primero));
	const civilDeHoy = civilDe(hoy, zona);
	const semanas = semanasDe(primero, diasDelMes(mirando));

	return Array.from({ length: semanas * DIAS_POR_SEMANA }, (_, i) => {
		const civil = sumarDiasCivil(arranque, i);
		return {
			fecha: medianocheDe(civil, zona),
			clave: claveCivil(civil),
			delMes: civil.mes === mirando.mes && civil.anio === mirando.anio,
			esHoy: mismoDiaCivil(civil, civilDeHoy),
		};
	});
}

/** El primero del mes que contiene ese instante, en esa zona. */
export function primeroDelMes(instante: Date, zona: string): Date {
	const civil = civilDe(instante, zona);
	return medianocheDe({ ...civil, dia: 1 }, zona);
}

/** El primero de otro mes, para moverse de a uno. */
export function sumarMeses(instante: Date, meses: number, zona: string): Date {
	return medianocheDe(primeroDeMesCivil(civilDe(instante, zona), meses), zona);
}

/**
 * El rango que hay que pedirle al servidor para llenar esa cuadrícula.
 *
 * **La cuadrícula entera y no el mes**: las celdas de relleno son días reales
 * que la persona ve, y pedir sólo del 1 al 30 las deja siempre vacías. Se ve
 * como si nunca hubiera nada los últimos días de agosto.
 */
export function rangoDe(dias: Dia[], zona: string): { desde: string; hasta: string } {
	const primero = dias[0].fecha;
	const ultimo = dias[dias.length - 1].fecha;
	// El final del último día, no su comienzo: un evento del sábado a las tres de
	// la tarde queda fuera de un rango que termina el sábado a las cero horas.
	const cierre = sumarDiasCivil(civilDe(ultimo, zona), 1);

	return {
		desde: primero.toISOString(),
		hasta: medianocheDe(cierre, zona).toISOString(),
	};
}

/**
 * Reparte los eventos por día, dentro de la cuadrícula que se está mirando.
 *
 * Un evento de varios días aparece en **cada** día que ocupa: una conferencia de
 * martes a jueves que sólo se viera el martes haría creer que el miércoles está
 * libre.
 *
 * `dias` no es sólo para saber qué mostrar: **acota el recorrido**. Un evento que
 * el servidor manda con fechas absurdas —un `DTEND` en el año 9999, que en un
 * calendario ajeno es cuestión de tiempo— daría millones de vueltas y la ventana
 * quedaría congelada varios segundos sin que nada lo explique. Acá se busca en
 * qué celda cae cada punta y se recorre el pedazo de la cuadrícula que hay entre
 * las dos, así que ningún evento da más de 42 vueltas.
 */
export function porDia(eventos: Evento[], dias: Dia[], zona: string): Map<string, Evento[]> {
	const mapa = new Map<string, Evento[]>();
	if (dias.length === 0) {
		return mapa;
	}
	const celda = new Map(dias.map((dia, i) => [dia.clave, i]));
	const primeraClave = dias[0].clave;
	const ultimaClave = dias[dias.length - 1].clave;

	for (const evento of eventos) {
		const inicio = new Date(evento.inicio);
		if (Number.isNaN(inicio.getTime())) {
			continue;
		}
		const fin = new Date(evento.fin);

		// **Un evento de día completo no tiene zona, y por eso se lee en UTC.**
		//
		// El programa lo manda como la medianoche UTC de ese día, que es la forma
		// de decir «el 15» sin decir a qué hora. Leerlo en la zona de la agenda lo
		// corre: en Buenos Aires esa medianoche son las nueve de la noche del 14,
		// y el evento aparecía **un día antes**. El feriado del 15 caía el 14 para
		// medio mundo, en silencio, que es exactamente el error que este archivo
		// existe para no cometer.
		const suya = evento.todo_el_dia ? 'UTC' : zona;

		// El último día que ocupa.
		//
		// Un evento de día completo termina en la medianoche del día **siguiente**
		// —así lo define el formato—, y contarla como un día más lo pintaría un
		// día de sobra. Con hora, en cambio, la medianoche exacta sí es el corte
		// y tampoco suma un día.
		let cierre = inicio;
		if (!Number.isNaN(fin.getTime()) && fin > inicio) {
			const civilFin = civilDe(fin, suya);
			const enLaMedianoche = civilFin.hora === 0 && civilFin.minuto === 0;
			const candidato = enLaMedianoche ? new Date(fin.getTime() - 60000) : fin;
			cierre = candidato >= inicio ? candidato : inicio;
		}

		// Recortado a lo que se ve. Lo de afuera no tiene celda donde ir.
		//
		// Las claves son `AAAA-MM-DD` con el año rellenado a cuatro dígitos, así
		// que compararlas como texto es compararlas como fechas.
		const desdeClave = claveCivil(civilDe(inicio, suya));
		const hastaClave = claveCivil(civilDe(cierre, suya));
		if (hastaClave < primeraClave || desdeClave > ultimaClave) {
			continue;
		}
		const desde = celda.get(desdeClave) ?? 0;
		const hasta = celda.get(hastaClave) ?? dias.length - 1;

		for (let i = desde; i <= hasta; i++) {
			const clave = dias[i].clave;
			const delDia = mapa.get(clave);
			if (delDia) {
				delDia.push(evento);
			} else {
				mapa.set(clave, [evento]);
			}
		}
	}

	// Los del día en orden: primero los de día completo, que son el marco del
	// día, y después el resto por hora. Sin ordenar salen como los mandó el
	// servidor, que no sigue ningún criterio útil.
	for (const delDia of mapa.values()) {
		delDia.sort((a, b) => {
			if (a.todo_el_dia !== b.todo_el_dia) {
				return a.todo_el_dia ? -1 : 1;
			}
			return a.inicio.localeCompare(b.inicio);
		});
	}

	return mapa;
}
