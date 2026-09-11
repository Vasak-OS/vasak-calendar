import { describe, expect, test } from 'bun:test';
import {
	civilDe,
	claveCivil,
	columnaCivil,
	desplazamientoDe,
	esZonaConocida,
	instanteDe,
	medianocheDe,
	mismoDiaCivil,
	primeroDeMesCivil,
	sumarDiasCivil,
	zonaDeLaSesion,
	zonasConocidas,
} from '../src/tools/zona';

const BUENOS_AIRES = 'America/Argentina/Buenos_Aires';
const MADRID = 'Europe/Madrid';
const TOKIO = 'Asia/Tokyo';

describe('civilDe', () => {
	test('el mismo instante es otro reloj en cada zona', () => {
		// Y por eso la cuadrícula no puede usar los métodos de `Date`: contestan
		// siempre en la zona del sistema.
		const instante = new Date('2026-09-15T02:00:00Z');

		expect(civilDe(instante, 'UTC')).toEqual({ anio: 2026, mes: 9, dia: 15, hora: 2, minuto: 0 });
		// En Buenos Aires todavía es el 14.
		expect(civilDe(instante, BUENOS_AIRES)).toEqual({
			anio: 2026,
			mes: 9,
			dia: 14,
			hora: 23,
			minuto: 0,
		});
		// Y en Tokio ya es de mañana.
		expect(civilDe(instante, TOKIO)).toEqual({
			anio: 2026,
			mes: 9,
			dia: 15,
			hora: 11,
			minuto: 0,
		});
	});

	test('la medianoche es la hora cero y no la veinticuatro', () => {
		// Con `hour12: false` hay motores que devuelven «24», y un 24 en la hora
		// corre el día entero al hacer la cuenta inversa.
		expect(civilDe(new Date('2026-09-15T00:00:00Z'), 'UTC').hora).toBe(0);
	});
});

describe('desplazamientoDe', () => {
	test('cambia con el horario de verano', () => {
		// Madrid corre +1 en invierno y +2 en verano. Por eso se pregunta por
		// instante y no por zona.
		expect(desplazamientoDe(new Date('2026-01-15T12:00:00Z'), MADRID)).toBe(60);
		expect(desplazamientoDe(new Date('2026-07-15T12:00:00Z'), MADRID)).toBe(120);
	});

	test('al oeste de Greenwich es negativo', () => {
		expect(desplazamientoDe(new Date('2026-07-15T12:00:00Z'), BUENOS_AIRES)).toBe(-180);
	});
});

describe('instanteDe', () => {
	test('deshace lo que hizo civilDe', () => {
		for (const zona of ['UTC', BUENOS_AIRES, MADRID, TOKIO]) {
			for (const iso of ['2026-01-15T08:30:00Z', '2026-07-15T23:45:00Z', '2026-12-31T00:00:00Z']) {
				const instante = new Date(iso);
				expect(instanteDe(civilDe(instante, zona), zona).getTime()).toBe(instante.getTime());
			}
		}
	});

	test('las nueve de la mañana son otro instante en cada zona', () => {
		const nueve = { anio: 2026, mes: 7, dia: 15, hora: 9, minuto: 0 };

		expect(instanteDe(nueve, 'UTC').toISOString()).toBe('2026-07-15T09:00:00.000Z');
		// Madrid en julio corre +2.
		expect(instanteDe(nueve, MADRID).toISOString()).toBe('2026-07-15T07:00:00.000Z');
		// Buenos Aires, -3.
		expect(instanteDe(nueve, BUENOS_AIRES).toISOString()).toBe('2026-07-15T12:00:00.000Z');
	});

	test('la segunda pasada corrige el cambio de horario de verano', () => {
		// Con una sola pasada, un reloj de pared cercano al cambio se mide con el
		// desplazamiento del otro lado y cae una hora corrido. El 29 de marzo de
		// 2026 Madrid adelanta.
		expect(instanteDe({ anio: 2026, mes: 3, dia: 29, hora: 12, minuto: 0 }, MADRID).toISOString()).toBe(
			'2026-03-29T10:00:00.000Z'
		);
		expect(instanteDe({ anio: 2026, mes: 3, dia: 28, hora: 12, minuto: 0 }, MADRID).toISOString()).toBe(
			'2026-03-28T11:00:00.000Z'
		);
	});
});

describe('medianocheDe', () => {
	test('es la medianoche de esa zona, no la de UTC', () => {
		const civil = { anio: 2026, mes: 9, dia: 15, hora: 17, minuto: 30 };
		// En Buenos Aires la medianoche del 15 son las tres de la mañana UTC.
		expect(medianocheDe(civil, BUENOS_AIRES).toISOString()).toBe('2026-09-15T03:00:00.000Z');
	});
});

describe('sumarDiasCivil', () => {
	test('cruza meses y años', () => {
		expect(sumarDiasCivil({ anio: 2026, mes: 1, dia: 31, hora: 0, minuto: 0 }, 1)).toMatchObject({
			anio: 2026,
			mes: 2,
			dia: 1,
		});
		expect(sumarDiasCivil({ anio: 2026, mes: 12, dia: 31, hora: 0, minuto: 0 }, 1)).toMatchObject({
			anio: 2027,
			mes: 1,
			dia: 1,
		});
		expect(sumarDiasCivil({ anio: 2026, mes: 1, dia: 1, hora: 0, minuto: 0 }, -1)).toMatchObject({
			anio: 2025,
			mes: 12,
			dia: 31,
		});
	});

	test('el 29 de febrero existe sólo en los bisiestos', () => {
		expect(sumarDiasCivil({ anio: 2024, mes: 2, dia: 28, hora: 0, minuto: 0 }, 1).dia).toBe(29);
		expect(sumarDiasCivil({ anio: 2026, mes: 2, dia: 28, hora: 0, minuto: 0 }, 1)).toMatchObject({
			mes: 3,
			dia: 1,
		});
	});

	test('no toca la hora', () => {
		// Sumarle veinticuatro horas a un instante cruza un cambio de horario de
		// verano y cae a las 23 o a la 1. Contando días eso no puede pasar.
		expect(sumarDiasCivil({ anio: 2026, mes: 3, dia: 28, hora: 14, minuto: 30 }, 1)).toEqual({
			anio: 2026,
			mes: 3,
			dia: 29,
			hora: 14,
			minuto: 30,
		});
	});
});

describe('primeroDeMesCivil', () => {
	test('el 31 de enero más un mes es febrero y no marzo', () => {
		// Avanzar de mes sobre un día 31 desborda al siguiente, porque febrero no
		// tiene 31: se salteaba febrero entero.
		expect(primeroDeMesCivil({ anio: 2026, mes: 1, dia: 31, hora: 0, minuto: 0 }, 1)).toMatchObject({
			anio: 2026,
			mes: 2,
			dia: 1,
		});
	});

	test('cruza el año en las dos direcciones', () => {
		expect(primeroDeMesCivil({ anio: 2026, mes: 12, dia: 5, hora: 0, minuto: 0 }, 1).anio).toBe(2027);
		expect(primeroDeMesCivil({ anio: 2026, mes: 1, dia: 5, hora: 0, minuto: 0 }, -1).anio).toBe(2025);
	});
});

describe('columnaCivil', () => {
	test('la semana empieza el lunes', () => {
		// Sin la rotación, el domingo queda en la primera columna y el mes entero
		// sale corrido.
		expect(columnaCivil({ anio: 2026, mes: 9, dia: 14, hora: 0, minuto: 0 })).toBe(0);
		expect(columnaCivil({ anio: 2026, mes: 9, dia: 20, hora: 0, minuto: 0 })).toBe(6);
	});
});

describe('claveCivil', () => {
	test('rellena con ceros para que la clave sea única', () => {
		// Sin el relleno, el 1 de febrero y el 12 de enero dan la misma cadena y
		// dos días distintos caen en la misma celda.
		expect(claveCivil({ anio: 2026, mes: 2, dia: 1, hora: 0, minuto: 0 })).toBe('2026-02-01');
		expect(claveCivil({ anio: 2026, mes: 1, dia: 12, hora: 0, minuto: 0 })).toBe('2026-01-12');
	});

	test('el año también, para poder comparar claves como texto', () => {
		// La cuadrícula decide qué eventos entran comparando claves: sin rellenar
		// el año, «999-01-01» sale después de «2026-01-01».
		expect(claveCivil({ anio: 999, mes: 1, dia: 1, hora: 0, minuto: 0 })).toBe('0999-01-01');
		expect('0999-01-01' < '2026-01-01').toBe(true);
	});
});

describe('mismoDiaCivil', () => {
	test('distingue el mismo número de día de meses o años distintos', () => {
		const quince = { anio: 2026, mes: 9, dia: 15, hora: 1, minuto: 0 };
		expect(mismoDiaCivil(quince, { ...quince, hora: 23 })).toBe(true);
		expect(mismoDiaCivil(quince, { ...quince, mes: 10 })).toBe(false);
		expect(mismoDiaCivil(quince, { ...quince, anio: 2025 })).toBe(false);
	});
});

describe('las zonas del sistema', () => {
	test('la de la sesión es una que el motor conoce', () => {
		expect(esZonaConocida(zonaDeLaSesion())).toBe(true);
	});

	test('una zona inventada no se acepta', () => {
		// Las zonas de IANA se renombran: una guardada que ya no existe tiene que
		// descartarse, no dejar la agenda sin dibujar.
		expect(esZonaConocida('Mar/Del_Plata')).toBe(false);
		expect(esZonaConocida('')).toBe(false);
	});

	test('siempre hay al menos una para elegir', () => {
		const zonas = zonasConocidas();
		expect(zonas.length).toBeGreaterThan(0);
		expect(zonas.every((z) => esZonaConocida(z))).toBe(true);
	});
});
