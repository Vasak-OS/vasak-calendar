/**
 * La aritmética de la cuadrícula del mes.
 *
 * Va aparte de los componentes y sin nada de Vue adentro porque es lo único de
 * un calendario que se equivoca **en silencio**: una celda corrida un día se ve
 * perfectamente bien, y la persona se entera cuando llega tarde a algo. Acá se
 * puede probar sin montar nada.
 *
 * Todo lo de este archivo trabaja en la **hora local** de quien mira. Un evento
 * llega en UTC desde el servidor; qué día del mes ocupa depende de dónde está la
 * persona, y no de dónde está el servidor.
 */

/** Cuántos días trae una semana. Nombrado para que la aritmética se lea. */
const DIAS_POR_SEMANA = 7;

/**
 * Cuántas semanas tiene la cuadrícula.
 *
 * Seis y no «las que hagan falta»: un mes de 31 días que arranca en domingo
 * ocupa seis filas, y uno de febrero que arranca lunes ocupa cuatro. Con un
 * número variable la cuadrícula cambia de alto al pasar de mes y todo lo que hay
 * debajo salta. Seis siempre entra y siempre mide igual.
 */
const SEMANAS = 6;

/** Un día de la cuadrícula. */
export interface Dia {
	/** La medianoche local de ese día. */
	fecha: Date;
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
	calendario: string;
	color: string | null;
}

/**
 * La medianoche local de un día.
 *
 * `new Date(a, m, d)` y no `new Date('2026-09-15')`: la segunda forma la
 * interpreta el motor como **UTC**, así que en cualquier zona al oeste de
 * Greenwich devuelve las nueve de la noche del día anterior. Es la manera más
 * común de correr un calendario un día entero.
 */
export function medianoche(fecha: Date): Date {
	return new Date(fecha.getFullYear(), fecha.getMonth(), fecha.getDate());
}

/**
 * En qué columna va un día, con la semana empezando el lunes.
 *
 * `getDay()` cuenta desde el domingo. En español —y en la norma ISO— la semana
 * empieza el lunes, así que sin esta rotación el mes entero sale corrido una
 * columna.
 */
export function columna(fecha: Date): number {
	return (fecha.getDay() + 6) % DIAS_POR_SEMANA;
}

/** Suma días respetando los cambios de mes, de año y de horario de verano. */
export function sumarDias(fecha: Date, dias: number): Date {
	const salida = new Date(fecha);
	salida.setDate(salida.getDate() + dias);
	return salida;
}

/** El mismo día de otro mes, sin desbordar. */
export function sumarMeses(fecha: Date, meses: number): Date {
	// El día 1 y no el que sea: `setMonth` sobre un 31 de enero más un mes da 3
	// de marzo, porque febrero no tiene 31. Como esto se usa para moverse entre
	// meses, lo que importa es el mes y no el día.
	return new Date(fecha.getFullYear(), fecha.getMonth() + meses, 1);
}

/** Si dos momentos caen el mismo día local. */
export function mismoDia(a: Date, b: Date): boolean {
	return (
		a.getFullYear() === b.getFullYear() &&
		a.getMonth() === b.getMonth() &&
		a.getDate() === b.getDate()
	);
}

/**
 * Las 42 celdas del mes que contiene `referencia`.
 *
 * `hoy` se pasa como argumento en vez de leer el reloj acá: así se puede probar
 * qué celda queda marcada sin depender de cuándo corra el test.
 */
export function cuadricula(referencia: Date, hoy: Date = new Date()): Dia[] {
	const primero = new Date(referencia.getFullYear(), referencia.getMonth(), 1);
	const arranque = sumarDias(primero, -columna(primero));

	return Array.from({ length: SEMANAS * DIAS_POR_SEMANA }, (_, i) => {
		const fecha = sumarDias(arranque, i);
		return {
			fecha,
			delMes: fecha.getMonth() === referencia.getMonth(),
			esHoy: mismoDia(fecha, hoy),
		};
	});
}

/**
 * El rango que hay que pedirle al servidor para llenar esa cuadrícula.
 *
 * **La cuadrícula entera y no el mes**: las celdas de relleno son días reales
 * que la persona ve, y pedir sólo del 1 al 30 las deja siempre vacías. Se ve
 * como si nunca hubiera nada los últimos días de agosto.
 */
export function rangoDe(dias: Dia[]): { desde: string; hasta: string } {
	const primero = dias[0].fecha;
	const ultimo = dias[dias.length - 1].fecha;
	return {
		desde: primero.toISOString(),
		// El final del último día, no su comienzo: un evento del sábado a las
		// tres de la tarde queda fuera de un rango que termina el sábado a las
		// cero horas.
		hasta: sumarDias(medianoche(ultimo), 1).toISOString(),
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
 * calendario ajeno es cuestión de tiempo— daría millones de vueltas, cada una con
 * su `Date` y su cadena, y la ventana quedaría congelada varios segundos sin que
 * nada explique por qué. Recortado a la cuadrícula, ningún evento da más de 42.
 *
 * La clave del mapa es la fecha local en `AAAA-MM-DD`, y no el `Date`, porque
 * dos `Date` del mismo día no son la misma clave.
 */
export function porDia(eventos: Evento[], dias: Dia[]): Map<string, Evento[]> {
	const mapa = new Map<string, Evento[]>();
	if (dias.length === 0) {
		return mapa;
	}
	const primero = medianoche(dias[0].fecha);
	const postrero = medianoche(dias[dias.length - 1].fecha);

	for (const evento of eventos) {
		const inicio = new Date(evento.inicio);
		const fin = new Date(evento.fin);
		if (Number.isNaN(inicio.getTime())) {
			continue;
		}

		// El último día que ocupa.
		//
		// Un evento de día completo termina en la medianoche del día **siguiente**
		// —así lo define el formato—, y contarla como un día más lo pintaría un
		// día de sobra. Con hora, en cambio, la medianoche exacta sí es el corte
		// y tampoco suma un día.
		let ultimo = medianoche(inicio);
		if (!Number.isNaN(fin.getTime()) && fin > inicio) {
			const cierre = fin.getTime() === medianoche(fin).getTime() ? sumarDias(fin, -1) : fin;
			if (cierre >= inicio) {
				ultimo = medianoche(cierre);
			}
		}

		// Recortado a lo que se ve. Lo de afuera no tiene celda donde ir.
		const desde = medianoche(inicio) < primero ? primero : medianoche(inicio);
		if (ultimo > postrero) {
			ultimo = postrero;
		}

		for (let dia = desde; dia <= ultimo; dia = sumarDias(dia, 1)) {
			const clave = claveDe(dia);
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

/** La clave de un día en el mapa: su fecha **local** en `AAAA-MM-DD`. */
export function claveDe(fecha: Date): string {
	const mes = String(fecha.getMonth() + 1).padStart(2, '0');
	const dia = String(fecha.getDate()).padStart(2, '0');
	return `${fecha.getFullYear()}-${mes}-${dia}`;
}
