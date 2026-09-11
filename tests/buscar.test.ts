import { describe, expect, test } from 'bun:test';
import { buscarOpciones, type Opcion } from '../src/tools/buscar';

/** Los mapas de teclado del instalador: el caso que originó este módulo. */
const TECLADOS: Opcion[] = [
	'be-latin1',
	'br-latin1-abnt2',
	'br-latin1-us',
	'cz-lat2',
	'de-latin1',
	'de-latin1-nodeadkeys',
	'es',
	'fr-latin1',
	'it',
	'la-latin1',
	'us',
	'us-acentos',
].map((t) => ({ valor: t, etiqueta: t }));

const ZONAS: Opcion[] = [
	{ valor: 'America/Argentina/Buenos_Aires', etiqueta: 'Buenos Aires', detalle: 'America' },
	{ valor: 'America/Argentina/Cordoba', etiqueta: 'Cordoba', detalle: 'America' },
	{ valor: 'America/Bogota', etiqueta: 'Bogota', detalle: 'America' },
	{ valor: 'Europe/Madrid', etiqueta: 'Madrid', detalle: 'Europe' },
	{ valor: 'Europe/Paris', etiqueta: 'Paris', detalle: 'Europe' },
];

describe('buscarOpciones', () => {
	test('el teclado latinoamericano aparece primero al escribir «la»', () => {
		// Éste es el caso que lo motivó, visto usando la aplicación. Con un filtro
		// que sólo pregunta «¿contiene?» y devuelve en orden alfabético,
		// `la-latin1` quedaba detrás de nueve entradas que contienen «latin», y
		// con la lista recortada podía no aparecer.
		const resultado = buscarOpciones(TECLADOS, 'la');
		expect(resultado[0].valor).toBe('la-latin1');
	});

	test('lo exacto le gana a lo que apenas empieza igual', () => {
		// `us` exacto tiene que ir antes que `us-acentos`.
		const resultado = buscarOpciones(TECLADOS, 'us');
		expect(resultado[0].valor).toBe('us');
		expect(resultado[1].valor).toBe('us-acentos');
	});

	test('un prefijo le gana a una coincidencia en el medio', () => {
		const resultado = buscarOpciones(TECLADOS, 'br');
		expect(resultado[0].valor).toBe('br-latin1-abnt2');
		expect(resultado[1].valor).toBe('br-latin1-us');
	});

	test('se puede buscar por un tramo del medio del identificador', () => {
		// Nadie escribe «america/» para llegar a Argentina.
		const resultado = buscarOpciones(ZONAS, 'argentina');
		expect(resultado).toHaveLength(2);
		expect(resultado[0].valor).toBe('America/Argentina/Buenos_Aires');
	});

	test('el nombre visible sirve para buscar', () => {
		const resultado = buscarOpciones(ZONAS, 'bue');
		expect(resultado[0].etiqueta).toBe('Buenos Aires');
	});

	test('una coincidencia en el detalle no le gana a una en el nombre', () => {
		// «Bogota» empieza con «bo»; el detalle «America» no contiene «bo». Se
		// comprueba al revés: buscar la región devuelve todo lo de esa región,
		// pero sin desplazar una coincidencia de nombre.
		const resultado = buscarOpciones(ZONAS, 'europe');
		expect(resultado).toHaveLength(2);
		expect(resultado.map((o) => o.etiqueta).sort()).toEqual(['Madrid', 'Paris']);
	});

	test('sin texto devuelve la lista intacta y en el mismo orden', () => {
		// Reordenar con el campo vacío movería las entradas bajo el cursor de
		// alguien que estaba mirando la lista.
		expect(buscarOpciones(TECLADOS, '')).toEqual(TECLADOS);
		expect(buscarOpciones(TECLADOS, '   ')).toEqual(TECLADOS);
	});

	test('no distingue mayúsculas', () => {
		expect(buscarOpciones(ZONAS, 'MADRID')[0].etiqueta).toBe('Madrid');
		expect(buscarOpciones(TECLADOS, 'LA')[0].valor).toBe('la-latin1');
	});

	test('lo que no coincide no aparece', () => {
		expect(buscarOpciones(TECLADOS, 'zzz')).toHaveLength(0);
	});

	test('el orden es estable entre dos búsquedas iguales', () => {
		// Sin el desempate explícito por posición, dos opciones del mismo nivel
		// dependen de la estabilidad del `sort` del motor para no bailar.
		const a = buscarOpciones(TECLADOS, 'latin').map((o) => o.valor);
		const b = buscarOpciones(TECLADOS, 'latin').map((o) => o.valor);
		expect(a).toEqual(b);
	});

	test('no pierde ninguna coincidencia al ordenar', () => {
		// El orden cambia; el conjunto no. Un filtro que además descarta es un
		// filtro que esconde la opción correcta.
		const conFiltro = TECLADOS.filter((t) => t.valor.includes('latin')).map((o) => o.valor);
		const conBusqueda = buscarOpciones(TECLADOS, 'latin').map((o) => o.valor);
		expect(conBusqueda.sort()).toEqual(conFiltro.sort());
	});
});
