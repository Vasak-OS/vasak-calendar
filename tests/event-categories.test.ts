/**
 * Color propio del evento y filtro por categoría (vasak-calendar#6, puntos 2 y 3).
 *
 * Lo que se comprueba:
 *
 * - qué color lleva la marca del costado: el del evento si trae uno que sirva y
 *   si no el de su calendario (un color en blanco no es un color);
 * - qué categorías se ofrecen: sin repetir, ordenadas y sólo las de lo que se ve;
 * - qué eventos quedan al apagar categorías: uno sin categorías no se apaga
 *   nunca y uno con varias se apaga recién cuando están apagadas todas;
 * - que lo apagado se recuerda por su propia clave, sin pisar la de calendarios;
 * - que, con el composable, el filtro de categorías se combina con el de
 *   calendarios: las categorías de un calendario oculto no aparecen, la casilla
 *   de una categoría apagada sigue para reactivarla, y `eventos` y `calendarios`
 *   quedan enteros.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { type EffectScope, effectScope, nextTick } from 'vue';
import { useCalendario } from '@/composables/use-calendario';
import {
	HIDDEN_CALENDARS_KEY,
	loadHiddenCalendars,
	saveHiddenCalendars,
} from '@/tools/calendar-filter';
import {
	categoriesIn,
	filterByCategories,
	HIDDEN_CATEGORIES_KEY,
	loadHiddenCategories,
	markColor,
	saveHiddenCategories,
	toggleCategory,
} from '@/tools/event-categories';
import { olvidarTodo, setAnswer } from './dobles';
import { calendarEvent as event } from './fixtures/events';

const PERSONAL = 'https://nube.ejemplo.com/personal/';
const TRABAJO = 'https://nube.ejemplo.com/trabajo/';

afterEach(() => {
	olvidarTodo();
	localStorage.clear();
});

describe('el color de la marca del costado', () => {
	test('el color propio del evento pisa al de su calendario', () => {
		expect(markColor(event({ color: '#e66100', event_color: '#33aaff' }))).toBe('#33aaff');
	});

	test('sin color propio, o con uno en blanco, se usa el del calendario', () => {
		expect(markColor(event({ color: '#e66100' }))).toBe('#e66100');
		expect(markColor(event({ color: '#e66100', event_color: null }))).toBe('#e66100');
		expect(markColor(event({ color: '#e66100', event_color: '' }))).toBe('#e66100');
		expect(markColor(event({ color: '#e66100', event_color: '   ' }))).toBe('#e66100');
	});

	test('sin ninguno de los dos no hay color: el que dibuja usa el acento', () => {
		expect(markColor(event({ color: null, event_color: '  ' }))).toBeNull();
		expect(markColor(event({ color: '' }))).toBeNull();
	});
});

describe('qué categorías se ofrecen', () => {
	test('sin repetir y en orden alfabético', () => {
		const events = [
			event({ uid: 'a', categories: ['Trabajo', 'Casa'] }),
			event({ uid: 'b', categories: ['Casa', 'Amigos'] }),
			event({ uid: 'c' }),
		];
		expect(categoriesIn(events)).toEqual(['Amigos', 'Casa', 'Trabajo']);
	});

	test('un nombre en blanco no es una categoría y los espacios de más no la duplican', () => {
		const events = [event({ categories: ['Casa', ' Casa ', '', '  '] })];
		expect(categoriesIn(events)).toEqual(['Casa']);
	});

	test('«Trabajo» y «trabajo» son dos categorías, como en el servidor', () => {
		expect(categoriesIn([event({ categories: ['Trabajo', 'trabajo'] })])).toHaveLength(2);
	});

	test('sin eventos, o sin categorías, no hay lista', () => {
		expect(categoriesIn([])).toEqual([]);
		expect(categoriesIn([event({ categories: [] }), event({})])).toEqual([]);
	});
});

describe('qué eventos quedan al apagar categorías', () => {
	test('un evento sin categorías se ve siempre, haya lo que haya apagado', () => {
		const events = [event({ uid: 'a' }), event({ uid: 'b', categories: [] })];
		expect(filterByCategories(events, new Set(['Trabajo', 'Casa'])).map((e) => e.uid)).toEqual([
			'a',
			'b',
		]);
	});

	test('uno con una sola categoría apagada desaparece y los demás siguen', () => {
		const events = [
			event({ uid: 'a', categories: ['Trabajo'] }),
			event({ uid: 'b', categories: ['Casa'] }),
		];
		expect(filterByCategories(events, new Set(['Trabajo'])).map((e) => e.uid)).toEqual(['b']);
	});

	test('uno con varias categorías se oculta sólo cuando están apagadas todas', () => {
		const events = [event({ uid: 'a', categories: ['Trabajo', 'Casa'] })];
		expect(filterByCategories(events, new Set(['Trabajo']))).toHaveLength(1);
		expect(filterByCategories(events, new Set(['Casa']))).toHaveLength(1);
		expect(filterByCategories(events, new Set(['Trabajo', 'Casa']))).toHaveLength(0);
	});

	test('sin nada apagado se ven todos y no se modifica la lista de partida', () => {
		const events = [event({ uid: 'a', categories: ['Trabajo'] })];
		expect(filterByCategories(events, new Set())).toHaveLength(1);
		filterByCategories(events, new Set(['Trabajo']));
		expect(events).toHaveLength(1);
	});
});

describe('apagar y prender una categoría', () => {
	test('apagar dos veces seguidas la deja a la vista y no toca la de partida', () => {
		const partida = new Set<string>();
		const apagada = toggleCategory(partida, 'Casa');
		expect(apagada.has('Casa')).toBe(true);
		expect(partida.size).toBe(0);
		expect(toggleCategory(apagada, 'Casa').size).toBe(0);
	});

	test('apagar una no toca a las otras', () => {
		const siguiente = toggleCategory(new Set(['Casa']), 'Trabajo');
		expect([...siguiente].sort()).toEqual(['Casa', 'Trabajo']);
	});
});

describe('qué se recuerda', () => {
	test('lo apagado se guarda y se lee igual en la próxima apertura', () => {
		saveHiddenCategories(new Set(['Casa', 'Trabajo']));
		expect([...loadHiddenCategories()].sort()).toEqual(['Casa', 'Trabajo']);
	});

	test('las categorías y los calendarios se guardan cada uno en su clave', () => {
		saveHiddenCategories(new Set(['Casa']));
		saveHiddenCalendars(new Set([PERSONAL]));

		expect(HIDDEN_CATEGORIES_KEY).not.toBe(HIDDEN_CALENDARS_KEY);
		expect(JSON.parse(localStorage.getItem(HIDDEN_CATEGORIES_KEY) ?? '[]')).toEqual(['Casa']);
		expect(JSON.parse(localStorage.getItem(HIDDEN_CALENDARS_KEY) ?? '[]')).toEqual([PERSONAL]);
		expect([...loadHiddenCategories()]).toEqual(['Casa']);
		expect([...loadHiddenCalendars()]).toEqual([PERSONAL]);
	});

	test('sin nada guardado, o con un valor sucio, no se apaga nada', () => {
		expect(loadHiddenCategories().size).toBe(0);
		for (const sucio of ['{no es json', '"texto"', '{"a":1}', 'null']) {
			localStorage.setItem(HIDDEN_CATEGORIES_KEY, sucio);
			expect(loadHiddenCategories().size).toBe(0);
		}
	});

	test('si el almacenamiento no se puede leer, no se apaga nada y guardar no rompe', () => {
		const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
		Object.defineProperty(globalThis, 'localStorage', {
			configurable: true,
			get() {
				throw new Error('bloqueado');
			},
		});
		try {
			expect(loadHiddenCategories().size).toBe(0);
			expect(() => saveHiddenCategories(new Set(['Casa']))).not.toThrow();
		} finally {
			if (original) Object.defineProperty(globalThis, 'localStorage', original);
		}
	});
});

describe('con el composable, combinado con el filtro de calendarios', () => {
	let scope: EffectScope | null = null;
	afterEach(() => {
		scope?.stop();
		scope = null;
	});

	const CALENDARS = [
		{ url: PERSONAL, nombre: 'Personal', color: '#e66100' },
		{ url: TRABAJO, nombre: 'Trabajo', color: '#e66100' },
	];

	async function open() {
		const start = new Date().toISOString();
		const at = { start, end: start };
		setAnswer('listar_cuentas', []);
		setAnswer('store_events', {
			calendarios: CALENDARS,
			eventos: [
				event({ uid: 'a', calendar: PERSONAL, categories: ['Casa'], ...at }),
				event({ uid: 'b', calendar: TRABAJO, categories: ['Oficina'], ...at }),
				event({ uid: 'c', calendar: PERSONAL, categories: ['Casa', 'Oficina'], ...at }),
				event({ uid: 'd', calendar: PERSONAL, ...at }),
				event({ uid: 'e', calendar: TRABAJO, categories: ['Clientes'], ...at }),
			],
			fallos: [],
			available: true,
		});
		scope = effectScope();
		const api = scope.run(() => useCalendario())!;
		await api.cargar();
		return api;
	}

	function drawn(api: Awaited<ReturnType<typeof open>>): string[] {
		return api.dias.value.flatMap((d) => api.eventsOf(d.clave).map((e) => e.uid)).sort();
	}

	test('una categoría que sólo tiene un calendario oculto no aparece como casilla', async () => {
		const api = await open();
		expect(api.categories.value).toEqual(['Casa', 'Clientes', 'Oficina']);

		api.toggleCalendarVisibility(TRABAJO);
		await nextTick();
		// «Clientes» era sólo de Trabajo y se va; «Oficina» sigue por el evento `c`, de Personal.
		expect(api.categories.value).toEqual(['Casa', 'Oficina']);

		api.toggleCalendarVisibility(TRABAJO);
		await nextTick();
		expect(api.categories.value).toEqual(['Casa', 'Clientes', 'Oficina']);
	});

	test('apagar una categoría oculta sus eventos pero la casilla sigue para reactivarla', async () => {
		const api = await open();
		expect(drawn(api)).toEqual(['a', 'b', 'c', 'd', 'e']);

		api.toggleCategoryVisibility('Casa');
		await nextTick();

		// `a` sólo era «Casa»; `c` también es «Oficina» y sigue; `d` no tiene categorías.
		expect(drawn(api)).toEqual(['b', 'c', 'd', 'e']);
		expect(api.categories.value).toEqual(['Casa', 'Clientes', 'Oficina']);
		expect(api.hiddenCategories.value.has('Casa')).toBe(true);

		api.toggleCategoryVisibility('Casa');
		await nextTick();
		expect(drawn(api)).toEqual(['a', 'b', 'c', 'd', 'e']);
	});

	test('apagar la única categoría de unos eventos los saca pero su casilla no desaparece', async () => {
		const api = await open();

		// «Clientes» sólo está en `e`: al apagarla no queda ningún evento visible con
		// ella, y la casilla tiene que seguir para poder prenderla otra vez.
		api.toggleCategoryVisibility('Clientes');
		await nextTick();

		expect(drawn(api)).toEqual(['a', 'b', 'c', 'd']);
		expect(api.categories.value).toEqual(['Casa', 'Clientes', 'Oficina']);
	});

	test('apagar categorías no toca ni `eventos` ni `calendarios`', async () => {
		const api = await open();
		api.toggleCategoryVisibility('Casa');
		api.toggleCategoryVisibility('Oficina');
		await nextTick();

		expect(drawn(api)).toEqual(['d', 'e']);
		expect(api.eventos.value).toHaveLength(5);
		expect(api.calendarios.value.map((c) => c.url)).toEqual([PERSONAL, TRABAJO]);
	});

	test('los dos filtros se acumulan: calendario oculto y categoría apagada', async () => {
		const api = await open();
		api.toggleCalendarVisibility(TRABAJO);
		api.toggleCategoryVisibility('Casa');
		await nextTick();

		// Sin Trabajo (`b` fuera) y sin lo que sólo era «Casa» (`a` fuera).
		expect(drawn(api)).toEqual(['c', 'd']);
	});

	test('lo apagado se guarda y vale en la próxima apertura, sin pisar lo de los calendarios', async () => {
		const first = await open();
		first.toggleCategoryVisibility('Casa');
		first.toggleCalendarVisibility(TRABAJO);
		expect(JSON.parse(localStorage.getItem(HIDDEN_CATEGORIES_KEY) ?? '[]')).toEqual(['Casa']);
		expect(JSON.parse(localStorage.getItem(HIDDEN_CALENDARS_KEY) ?? '[]')).toEqual([TRABAJO]);
		scope?.stop();

		const again = await open();
		expect(again.hiddenCategories.value.has('Casa')).toBe(true);
		expect(again.hiddenCalendars.value.has(TRABAJO)).toBe(true);
		expect(drawn(again)).toEqual(['c', 'd']);
	});
});
