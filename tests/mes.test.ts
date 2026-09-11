import { describe, expect, test } from 'bun:test';
import {
	cuadricula,
	type Evento,
	porDia,
	primeroDelMes,
	rangoDe,
	sumarMeses,
} from '../src/tools/mes';
import { civilDe } from '../src/tools/zona';

const BUENOS_AIRES = 'America/Argentina/Buenos_Aires';
const TOKIO = 'Asia/Tokyo';

/**
 * Cada caso fija su zona en vez de usar la del sistema.
 *
 * Así el resultado no depende de en qué zona corra el test, que es la forma más
 * fácil de tener una prueba que pasa en la máquina de quien la escribió y falla
 * en el servidor de integración.
 */
const ZONA = 'UTC';

/** Un evento con lo mínimo, para no repetir el resto en cada caso. */
function evento(inicio: string, fin: string, extra: Partial<Evento> = {}): Evento {
	return {
		uid: inicio,
		titulo: 'Algo',
		inicio,
		fin,
		todo_el_dia: false,
		se_repite: false,
		zona: '',
		calendario: 'https://nube.ejemplo.com/dav/calendars/ana/personal/',
		color: null,
		...extra,
	};
}

/** El instante del mediodía de un día, para apuntar a un mes sin ambigüedad. */
function mediodia(iso: string): Date {
	return new Date(`${iso}T12:00:00Z`);
}

describe('cuadricula', () => {
	test('siempre mide seis semanas', () => {
		// Fijo y no variable: con un número de filas que cambia, la cuadrícula
		// cambia de alto al pasar de mes y todo lo que hay debajo salta.
		for (const mes of ['2026-01-01', '2026-02-01', '2026-05-01', '2026-08-01', '2026-12-01']) {
			expect(cuadricula(mediodia(mes), ZONA)).toHaveLength(42);
		}
		// Y febrero de un bisiesto que arranca jueves, que es de los más cortos
		// en filas.
		expect(cuadricula(mediodia('2024-02-01'), ZONA)).toHaveLength(42);
	});

	test('arranca el lunes anterior al primero del mes', () => {
		// Septiembre de 2026 arranca martes, así que la primera celda es el 31 de
		// agosto.
		const dias = cuadricula(mediodia('2026-09-15'), ZONA);
		expect(dias[0].clave).toBe('2026-08-31');
		expect(dias[0].delMes).toBe(false);
		expect(dias[1].clave).toBe('2026-09-01');
		expect(dias[1].delMes).toBe(true);
	});

	test('marca hoy sin mirar el reloj', () => {
		// `hoy` entra por argumento: si leyera el reloj, este test pasaría o
		// fallaría según el día en que corriera.
		const dias = cuadricula(mediodia('2026-09-01'), ZONA, mediodia('2026-09-15'));
		const marcados = dias.filter((d) => d.esHoy);
		expect(marcados).toHaveLength(1);
		expect(marcados[0].clave).toBe('2026-09-15');
	});

	test('un mes que no contiene hoy no marca nada', () => {
		const dias = cuadricula(mediodia('2026-01-01'), ZONA, mediodia('2026-09-15'));
		expect(dias.some((d) => d.esHoy)).toBe(false);
	});

	test('el mes que se dibuja es el de la zona de la agenda', () => {
		// Este instante es el 1 de octubre en Tokio y todavía el 30 de septiembre
		// en Buenos Aires. Mirar la agenda en una zona u otra tiene que mostrar
		// meses distintos, que es justo lo que se pide poder hacer.
		const instante = new Date('2026-09-30T16:00:00Z');
		expect(cuadricula(instante, TOKIO).some((d) => d.clave === '2026-10-01' && d.delMes)).toBe(true);
		expect(
			cuadricula(instante, BUENOS_AIRES).some((d) => d.clave === '2026-09-30' && d.delMes)
		).toBe(true);
	});

	test('cada celda apunta a la medianoche de su zona', () => {
		// La fecha es el instante con el que después se formatea el número del
		// día: si fuera la medianoche de otra zona, el número saldría corrido.
		const dias = cuadricula(mediodia('2026-09-15'), BUENOS_AIRES);
		const primero = dias.find((d) => d.clave === '2026-09-01');
		expect(primero?.fecha.toISOString()).toBe('2026-09-01T03:00:00.000Z');
		expect(civilDe(primero!.fecha, BUENOS_AIRES)).toMatchObject({ dia: 1, hora: 0, minuto: 0 });
	});

	test('la cuadrícula no repite ni saltea días al cambiar el horario de verano', () => {
		// Contando horas en vez de días, la celda siguiente al cambio cae a las
		// 23 del mismo día o a la 1 del subsiguiente: un día repetido o uno que
		// falta, y todo lo demás corrido.
		for (const mes of ['2026-03-01', '2026-10-01']) {
			const claves = cuadricula(mediodia(mes), 'Europe/Madrid').map((d) => d.clave);
			expect(new Set(claves).size).toBe(42);
		}
	});
});

describe('primeroDelMes y sumarMeses', () => {
	test('el primero del mes es el de la zona de la agenda', () => {
		expect(primeroDelMes(mediodia('2026-09-15'), 'UTC').toISOString()).toBe(
			'2026-09-01T00:00:00.000Z'
		);
		expect(primeroDelMes(mediodia('2026-09-15'), BUENOS_AIRES).toISOString()).toBe(
			'2026-09-01T03:00:00.000Z'
		);
	});

	test('el 31 de enero más un mes es febrero y no marzo', () => {
		// Avanzar de mes sobre un día 31 desborda al siguiente porque febrero no
		// tiene 31 días, y se salteaba febrero entero.
		const siguiente = sumarMeses(mediodia('2026-01-31'), 1, ZONA);
		expect(civilDe(siguiente, ZONA)).toMatchObject({ anio: 2026, mes: 2, dia: 1 });
	});

	test('cruza el año en las dos direcciones', () => {
		expect(civilDe(sumarMeses(mediodia('2026-12-05'), 1, ZONA), ZONA).anio).toBe(2027);
		expect(civilDe(sumarMeses(mediodia('2026-01-05'), -1, ZONA), ZONA).anio).toBe(2025);
	});
});

describe('rangoDe', () => {
	test('cubre la cuadrícula entera y no sólo el mes', () => {
		// Las celdas de relleno son días reales que la persona ve: pedir sólo del
		// 1 al 30 las deja siempre vacías.
		const dias = cuadricula(mediodia('2026-09-15'), ZONA);
		const { desde, hasta } = rangoDe(dias, ZONA);

		expect(desde).toBe(dias[0].fecha.toISOString());
		// El final del último día, no su comienzo: si no, un evento del sábado a
		// las tres de la tarde queda afuera.
		expect(hasta).toBe('2026-10-12T00:00:00.000Z');
		expect(dias[41].clave).toBe('2026-10-11');
	});

	test('el rango se corre con la zona', () => {
		// Pedir el rango de otra zona trae los eventos de otros días, y las
		// primeras y últimas celdas quedan vacías sin motivo.
		const dias = cuadricula(mediodia('2026-09-15'), TOKIO);
		const { desde } = rangoDe(dias, TOKIO);
		expect(desde).toBe('2026-08-30T15:00:00.000Z');
	});
});

describe('porDia', () => {
	/** Septiembre de 2026, que es la cuadrícula de casi todos los casos de acá. */
	const MES = cuadricula(mediodia('2026-09-01'), ZONA);

	test('un evento de un día cae en su día', () => {
		const mapa = porDia(
			[evento('2026-09-15T14:00:00+00:00', '2026-09-15T15:00:00+00:00')],
			MES,
			ZONA
		);
		expect(mapa.get('2026-09-15')).toHaveLength(1);
	});

	test('un evento de varios días aparece en todos', () => {
		// Una conferencia de martes a jueves que sólo se viera el martes haría
		// creer que el miércoles está libre.
		const mapa = porDia(
			[evento('2026-09-15T09:00:00+00:00', '2026-09-17T18:00:00+00:00')],
			MES,
			ZONA
		);
		for (const dia of ['2026-09-15', '2026-09-16', '2026-09-17']) {
			expect(mapa.get(dia)).toHaveLength(1);
		}
		expect(mapa.has('2026-09-18')).toBe(false);
	});

	test('uno de día completo no se derrama al día siguiente', () => {
		// El formato hace terminar un día completo en la medianoche del día
		// **siguiente**. Contarla como un día más lo pintaría un día de sobra.
		const mapa = porDia(
			[evento('2026-09-15T00:00:00+00:00', '2026-09-16T00:00:00+00:00', { todo_el_dia: true })],
			MES,
			ZONA
		);
		expect(mapa.get('2026-09-15')).toHaveLength(1);
		expect(mapa.has('2026-09-16')).toBe(false);
	});

	test('uno de día completo cae el mismo día en cualquier zona', () => {
		// **El bug que tenía.** Un día completo llega como la medianoche UTC de
		// ese día, que es la forma de decir «el 15» sin decir a qué hora. Leída en
		// la zona de la agenda, en Buenos Aires son las nueve de la noche del 14:
		// el feriado del 15 se dibujaba el 14, en silencio.
		const completo = evento('2026-09-15T00:00:00+00:00', '2026-09-16T00:00:00+00:00', {
			todo_el_dia: true,
		});

		for (const zona of [ZONA, BUENOS_AIRES, TOKIO]) {
			const mapa = porDia([completo], cuadricula(mediodia('2026-09-01'), zona), zona);
			expect(mapa.get('2026-09-15'), zona).toHaveLength(1);
			expect(mapa.has('2026-09-14'), zona).toBe(false);
			expect(mapa.has('2026-09-16'), zona).toBe(false);
		}
	});

	test('uno con hora sí cambia de día según la zona', () => {
		// Lo contrario del caso anterior, y es lo correcto: una reunión de las 23
		// UTC del 15 es del 16 en Tokio, y quien mire la agenda en Tokio la tiene
		// el 16.
		const nocturno = evento('2026-09-15T23:00:00+00:00', '2026-09-16T00:00:00+00:00');

		expect(porDia([nocturno], MES, ZONA).has('2026-09-15')).toBe(true);
		const enTokio = cuadricula(mediodia('2026-09-01'), TOKIO);
		expect(porDia([nocturno], enTokio, TOKIO).has('2026-09-16')).toBe(true);
	});

	test('primero los de día completo y después por hora', () => {
		// Sin ordenar salen como los mandó el servidor, que no sigue ningún
		// criterio útil.
		const mapa = porDia(
			[
				evento('2026-09-15T18:00:00+00:00', '2026-09-15T19:00:00+00:00', { uid: 'tarde' }),
				evento('2026-09-15T09:00:00+00:00', '2026-09-15T10:00:00+00:00', { uid: 'mañana' }),
				evento('2026-09-15T00:00:00+00:00', '2026-09-16T00:00:00+00:00', {
					uid: 'completo',
					todo_el_dia: true,
				}),
			],
			MES,
			ZONA
		);

		expect(mapa.get('2026-09-15')?.map((e) => e.uid)).toEqual(['completo', 'mañana', 'tarde']);
	});

	test('un evento sin fin usable ocupa sólo su día', () => {
		// El programa manda `fin` igual a `inicio` cuando el evento no traía
		// `DTEND`. No puede terminar dando un bucle ni cero días.
		const mapa = porDia(
			[evento('2026-09-15T14:00:00+00:00', '2026-09-15T14:00:00+00:00')],
			MES,
			ZONA
		);
		expect(mapa.size).toBe(1);
	});

	test('un fin anterior al inicio no da un bucle infinito', () => {
		// Un servidor puede mandar cualquier cosa, y un recorrido que avanza hacia
		// un tope que quedó atrás no termina nunca: la ventana se congela.
		const mapa = porDia(
			[evento('2026-09-15T14:00:00+00:00', '2026-09-01T00:00:00+00:00')],
			MES,
			ZONA
		);
		expect(mapa.size).toBe(1);
	});

	test('un evento con fechas absurdas no cuelga la ventana', () => {
		// Un `DTEND` en el año 9999 daría millones de vueltas: la ventana se
		// congela varios segundos y nada explica por qué. Recortado a la
		// cuadrícula, no puede dar más de 42.
		const empezo = Date.now();
		const mapa = porDia(
			[evento('2026-09-15T00:00:00+00:00', '9999-12-31T00:00:00+00:00')],
			MES,
			ZONA
		);

		expect(mapa.size).toBeLessThanOrEqual(MES.length);
		expect(Date.now() - empezo).toBeLessThan(1000);
		// Y lo que sí se ve, se ve: desde el 15 hasta el final de la cuadrícula.
		expect(mapa.get('2026-09-15')).toHaveLength(1);
		expect(mapa.get(MES[41].clave)).toHaveLength(1);
	});

	test('un evento que empieza antes de la cuadrícula se ve desde el borde', () => {
		// Una conferencia de agosto que sigue en septiembre ocupa los primeros
		// días del mes que se está mirando, y ésos hay que pintarlos.
		const mapa = porDia(
			[evento('2020-01-01T00:00:00+00:00', '2026-09-03T00:00:00+00:00')],
			MES,
			ZONA
		);
		expect(mapa.get(MES[0].clave)).toHaveLength(1);
		expect(mapa.get('2026-09-02')).toHaveLength(1);
		expect(mapa.has('2026-09-04')).toBe(false);
	});

	test('un evento que cae fuera de la cuadrícula no aparece', () => {
		const mapa = porDia(
			[evento('2027-05-01T00:00:00+00:00', '2027-05-02T00:00:00+00:00')],
			MES,
			ZONA
		);
		expect(mapa.size).toBe(0);
	});

	test('sin cuadrícula no hay dónde poner nada', () => {
		const mapa = porDia([evento('2026-09-15T14:00:00+00:00', '2026-09-15T15:00:00+00:00')], [], ZONA);
		expect(mapa.size).toBe(0);
	});

	test('una fecha que no se entiende se saltea sin perder las demás', () => {
		const mapa = porDia(
			[
				evento('no es una fecha', 'tampoco'),
				evento('2026-09-15T14:00:00+00:00', '2026-09-15T15:00:00+00:00', { uid: 'sano' }),
			],
			MES,
			ZONA
		);
		expect(mapa.size).toBe(1);
		expect([...mapa.values()][0][0].uid).toBe('sano');
	});
});
