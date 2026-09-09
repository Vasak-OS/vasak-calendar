import { describe, expect, test } from 'bun:test';
import {
	claveDe,
	columna,
	cuadricula,
	type Evento,
	medianoche,
	mismoDia,
	porDia,
	rangoDe,
	sumarDias,
	sumarMeses,
} from '../src/tools/mes';

/** Un evento con lo mínimo, para no repetir el resto en cada caso. */
function evento(inicio: string, fin: string, extra: Partial<Evento> = {}): Evento {
	return {
		uid: inicio,
		titulo: 'Algo',
		inicio,
		fin,
		todo_el_dia: false,
		se_repite: false,
		calendario: 'https://nube.ejemplo.com/dav/calendars/ana/personal/',
		color: null,
		...extra,
	};
}

describe('columna', () => {
	test('la semana empieza el lunes', () => {
		// Sin la rotación, `getDay()` cuenta desde el domingo y el mes entero
		// sale corrido una columna.
		expect(columna(new Date(2026, 8, 14))).toBe(0); // lunes
		expect(columna(new Date(2026, 8, 20))).toBe(6); // domingo
	});
});

describe('cuadricula', () => {
	test('siempre mide seis semanas', () => {
		// Fijo y no variable: con un número de filas que cambia, la cuadrícula
		// cambia de alto al pasar de mes y todo lo que hay debajo salta.
		for (const mes of [0, 1, 4, 7, 11]) {
			expect(cuadricula(new Date(2026, mes, 1))).toHaveLength(42);
		}
		// Y febrero de un año bisiesto que arranca lunes, que es el mes más corto
		// posible en filas.
		expect(cuadricula(new Date(2024, 1, 1))).toHaveLength(42);
	});

	test('arranca el lunes anterior al primero del mes', () => {
		// Septiembre de 2026 arranca martes, así que la primera celda es el 31
		// de agosto.
		const dias = cuadricula(new Date(2026, 8, 15));
		expect(dias[0].fecha.getDate()).toBe(31);
		expect(dias[0].fecha.getMonth()).toBe(7);
		expect(dias[0].delMes).toBe(false);
		expect(dias[1].fecha.getDate()).toBe(1);
		expect(dias[1].delMes).toBe(true);
	});

	test('marca hoy sin mirar el reloj', () => {
		// `hoy` entra por argumento: si leyera el reloj, este test pasaría o
		// fallaría según el día en que corriera.
		const dias = cuadricula(new Date(2026, 8, 1), new Date(2026, 8, 15));
		const marcados = dias.filter((d) => d.esHoy);
		expect(marcados).toHaveLength(1);
		expect(marcados[0].fecha.getDate()).toBe(15);
	});

	test('un mes que no contiene hoy no marca nada', () => {
		expect(cuadricula(new Date(2026, 0, 1), new Date(2026, 8, 15)).some((d) => d.esHoy)).toBe(
			false
		);
	});
});

describe('sumarMeses', () => {
	test('el 31 de enero más un mes es febrero y no marzo', () => {
		// `setMonth` sobre un 31 desborda al mes siguiente porque febrero no
		// tiene 31 días, y avanzar de mes terminaba salteando febrero entero.
		const siguiente = sumarMeses(new Date(2026, 0, 31), 1);
		expect(siguiente.getMonth()).toBe(1);
		expect(siguiente.getFullYear()).toBe(2026);
	});

	test('cruza el año en las dos direcciones', () => {
		expect(sumarMeses(new Date(2026, 11, 5), 1).getFullYear()).toBe(2027);
		expect(sumarMeses(new Date(2026, 0, 5), -1).getFullYear()).toBe(2025);
	});
});

describe('rangoDe', () => {
	test('cubre la cuadrícula entera y no sólo el mes', () => {
		// Las celdas de relleno son días reales que la persona ve: pedir sólo del
		// 1 al 30 las deja siempre vacías.
		const dias = cuadricula(new Date(2026, 8, 15));
		const { desde, hasta } = rangoDe(dias);

		expect(new Date(desde).getTime()).toBe(dias[0].fecha.getTime());
		// El final del último día, no su comienzo: si no, un evento del sábado a
		// las tres de la tarde queda afuera.
		const finDelUltimo = sumarDias(dias[41].fecha, 1);
		expect(new Date(hasta).getTime()).toBe(finDelUltimo.getTime());
	});
});

describe('porDia', () => {
	/** Septiembre de 2026, que es la cuadrícula de casi todos los casos de acá. */
	const MES = cuadricula(new Date(2026, 8, 1));

	test('un evento de un día cae en su día local', () => {
		const mapa = porDia([evento('2026-09-15T14:00:00+00:00', '2026-09-15T15:00:00+00:00')], MES);
		const dia = medianoche(new Date('2026-09-15T14:00:00Z'));
		expect(mapa.get(claveDe(dia))).toHaveLength(1);
	});

	test('un evento de varios días aparece en todos', () => {
		// Una conferencia de martes a jueves que sólo se viera el martes haría
		// creer que el miércoles está libre.
		const mapa = porDia([evento('2026-09-15T09:00:00+00:00', '2026-09-17T18:00:00+00:00')], MES);
		for (const dia of [15, 16, 17]) {
			expect(mapa.get(claveDe(new Date(2026, 8, dia)))).toHaveLength(1);
		}
		expect(mapa.has(claveDe(new Date(2026, 8, 18)))).toBe(false);
	});

	test('uno de día completo no se derrama al día siguiente', () => {
		// El formato hace terminar un día completo en la medianoche del día
		// **siguiente**. Contarla como un día más lo pintaría un día de sobra.
		const mapa = porDia(
			[evento('2026-09-15T00:00:00+00:00', '2026-09-16T00:00:00+00:00', { todo_el_dia: true })],
			MES
		);
		const inicio = medianoche(new Date('2026-09-15T00:00:00Z'));
		expect(mapa.get(claveDe(inicio))).toHaveLength(1);
		expect(mapa.has(claveDe(sumarDias(inicio, 1)))).toBe(false);
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
			MES
		);

		const clave = claveDe(medianoche(new Date('2026-09-15T09:00:00Z')));
		expect(mapa.get(clave)?.map((e) => e.uid)).toEqual(['completo', 'mañana', 'tarde']);
	});

	test('un evento sin fin usable ocupa sólo su día', () => {
		// El programa manda `fin` igual a `inicio` cuando el evento no traía
		// `DTEND`. No puede terminar dando un bucle ni cero días.
		const mapa = porDia([evento('2026-09-15T14:00:00+00:00', '2026-09-15T14:00:00+00:00')], MES);
		expect(mapa.size).toBe(1);
	});

	test('un fin anterior al inicio no da un bucle infinito', () => {
		// Un servidor puede mandar cualquier cosa, y un `for` que avanza hasta un
		// tope que quedó atrás no termina nunca: la ventana se congela.
		const mapa = porDia([evento('2026-09-15T14:00:00+00:00', '2026-09-01T00:00:00+00:00')], MES);
		expect(mapa.size).toBe(1);
	});

	test('un evento con fechas absurdas no cuelga la ventana', () => {
		// Un `DTEND` en el año 9999 daría millones de vueltas, cada una con su
		// `Date` y su cadena: la ventana se congela varios segundos y nada explica
		// por qué. Recortado a la cuadrícula, no puede dar más de 42.
		const empezo = Date.now();
		const mapa = porDia([evento('2026-09-15T00:00:00+00:00', '9999-12-31T00:00:00+00:00')], MES);

		expect(mapa.size).toBeLessThanOrEqual(MES.length);
		expect(Date.now() - empezo).toBeLessThan(1000);
		// Y lo que sí se ve, se ve: desde el 15 hasta el final de la cuadrícula.
		expect(mapa.get(claveDe(new Date(2026, 8, 15)))).toHaveLength(1);
	});

	test('un evento que empieza antes de la cuadrícula se ve desde el borde', () => {
		// Una conferencia de agosto que sigue en septiembre ocupa los primeros
		// días del mes que se está mirando, y ésos hay que pintarlos.
		const mapa = porDia([evento('2020-01-01T00:00:00+00:00', '2026-09-03T00:00:00+00:00')], MES);
		expect(mapa.get(claveDe(MES[0].fecha))).toHaveLength(1);
		expect(mapa.get(claveDe(new Date(2026, 8, 2)))).toHaveLength(1);
		expect(mapa.has(claveDe(new Date(2026, 8, 4)))).toBe(false);
	});

	test('un evento que cae fuera de la cuadrícula no aparece', () => {
		const mapa = porDia([evento('2027-05-01T00:00:00+00:00', '2027-05-02T00:00:00+00:00')], MES);
		expect(mapa.size).toBe(0);
	});

	test('sin cuadrícula no hay dónde poner nada', () => {
		expect(porDia([evento('2026-09-15T14:00:00+00:00', '2026-09-15T15:00:00+00:00')], []).size).toBe(
			0
		);
	});

	test('una fecha que no se entiende se saltea sin perder las demás', () => {
		const mapa = porDia(
			[
				evento('no es una fecha', 'tampoco'),
				evento('2026-09-15T14:00:00+00:00', '2026-09-15T15:00:00+00:00', { uid: 'sano' }),
			],
			MES
		);
		expect(mapa.size).toBe(1);
		expect([...mapa.values()][0][0].uid).toBe('sano');
	});
});

describe('claveDe', () => {
	test('rellena con ceros para que la clave sea única', () => {
		// Sin el relleno, el 1 de febrero y el 12 de enero dan «2026-1-2» y
		// «2026-1-2»: dos días distintos en la misma celda.
		expect(claveDe(new Date(2026, 1, 1))).toBe('2026-02-01');
		expect(claveDe(new Date(2026, 0, 12))).toBe('2026-01-12');
	});
});

describe('mismoDia', () => {
	test('distingue el mismo día de meses o años distintos', () => {
		expect(mismoDia(new Date(2026, 8, 15, 1), new Date(2026, 8, 15, 23))).toBe(true);
		expect(mismoDia(new Date(2026, 8, 15), new Date(2026, 9, 15))).toBe(false);
		expect(mismoDia(new Date(2026, 8, 15), new Date(2025, 8, 15))).toBe(false);
	});
});
