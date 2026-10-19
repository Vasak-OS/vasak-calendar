/**
 * Elegir qué calendarios se ven (vasak-calendar#6, punto 1).
 *
 * Lo que se comprueba:
 *
 * - que un calendario oculto no aporta sus eventos y los demás siguen;
 * - que el filtro es por **URL** del calendario: dos calendarios del mismo
 *   color (o del mismo nombre) se distinguen y ocultar uno no apaga al otro;
 * - que ocultar y mostrar se deshacen, sin tocar el conjunto de partida;
 * - que sin almacenamiento, o con un valor sucio, no se oculta nada;
 * - que, con el composable, ocultar un calendario sólo quita lo que se dibuja:
 *   `calendarios` y `eventos` quedan enteros (se puede seguir creando en él) y
 *   lo oculto se recuerda en la próxima apertura.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { type EffectScope, effectScope, nextTick } from 'vue';
import { useCalendario } from '@/composables/use-calendario';
import {
	filterByCalendars,
	HIDDEN_CALENDARS_KEY,
	loadHiddenCalendars,
	saveHiddenCalendars,
	toggleCalendar,
} from '@/tools/calendar-filter';
import { olvidarTodo, setAnswer } from './dobles';
import { calendarEvent as event } from './fixtures/events';

const PERSONAL = 'https://nube.ejemplo.com/personal/';
const TRABAJO = 'https://nube.ejemplo.com/trabajo/';

afterEach(() => {
	olvidarTodo();
	localStorage.clear();
});

describe('qué eventos se dibujan', () => {
	test('un calendario oculto no aporta sus eventos y los demás siguen', () => {
		const events = [
			event({ uid: 'a', calendar: PERSONAL }),
			event({ uid: 'b', calendar: TRABAJO }),
		];
		const visible = filterByCalendars(events, new Set([TRABAJO]));
		expect(visible.map((e) => e.uid)).toEqual(['a']);
	});

	test('sin nada oculto se ven todos', () => {
		const events = [event({ uid: 'a', calendar: PERSONAL }), event({ uid: 'b', calendar: TRABAJO })];
		expect(filterByCalendars(events, new Set())).toHaveLength(2);
	});

	test('dos calendarios del mismo color se distinguen: se filtra por URL, no por color', () => {
		const events = [
			event({ uid: 'a', calendar: PERSONAL, color: '#e66100' }),
			event({ uid: 'b', calendar: TRABAJO, color: '#e66100' }),
		];
		const visible = filterByCalendars(events, new Set([PERSONAL]));
		expect(visible.map((e) => e.uid)).toEqual(['b']);
	});

	test('un evento sin calendario se muestra aunque haya cosas ocultas', () => {
		const events = [event({ uid: 'a', calendar: '' }), event({ uid: 'b', calendar: TRABAJO })];
		expect(filterByCalendars(events, new Set([TRABAJO])).map((e) => e.uid)).toEqual(['a']);
	});

	test('filtrar no modifica la lista de partida', () => {
		const events = [event({ uid: 'a', calendar: TRABAJO })];
		filterByCalendars(events, new Set([TRABAJO]));
		expect(events).toHaveLength(1);
	});
});

describe('ocultar y mostrar', () => {
	test('ocultar dos veces seguidas y mostrar deja el calendario a la vista', () => {
		const oculto = toggleCalendar(new Set(), PERSONAL);
		expect(oculto.has(PERSONAL)).toBe(true);
		const visto = toggleCalendar(oculto, PERSONAL);
		expect(visto.has(PERSONAL)).toBe(false);
		expect(visto.size).toBe(0);
	});

	test('ocultar uno no toca a los otros y no cambia el conjunto de partida', () => {
		const partida = new Set([PERSONAL]);
		const siguiente = toggleCalendar(partida, TRABAJO);
		expect([...siguiente].sort()).toEqual([PERSONAL, TRABAJO].sort());
		expect([...partida]).toEqual([PERSONAL]);
	});
});

describe('qué se recuerda', () => {
	test('lo oculto se guarda y se lee igual en la próxima apertura', () => {
		saveHiddenCalendars(new Set([PERSONAL, TRABAJO]));
		expect([...loadHiddenCalendars()].sort()).toEqual([PERSONAL, TRABAJO].sort());
	});

	test('sin nada guardado no se oculta nada', () => {
		expect(loadHiddenCalendars().size).toBe(0);
	});

	test('un valor que no se entiende no oculta nada', () => {
		for (const sucio of ['{no es json', '"texto"', '{"a":1}', 'null']) {
			localStorage.setItem(HIDDEN_CALENDARS_KEY, sucio);
			expect(loadHiddenCalendars().size).toBe(0);
		}
	});

	test('de una lista con basura se quedan sólo las URL', () => {
		localStorage.setItem(HIDDEN_CALENDARS_KEY, JSON.stringify([PERSONAL, 3, null, { a: 1 }]));
		expect([...loadHiddenCalendars()]).toEqual([PERSONAL]);
	});

	test('si el almacenamiento no se puede leer, no se oculta nada', () => {
		const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
		Object.defineProperty(globalThis, 'localStorage', {
			configurable: true,
			get() {
				throw new Error('bloqueado');
			},
		});
		try {
			expect(loadHiddenCalendars().size).toBe(0);
			// Y guardar tampoco rompe lo que se está viendo.
			expect(() => saveHiddenCalendars(new Set([PERSONAL]))).not.toThrow();
		} finally {
			if (original) Object.defineProperty(globalThis, 'localStorage', original);
		}
	});
});

describe('con el composable', () => {
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
		setAnswer('listar_cuentas', []);
		setAnswer('store_events', {
			calendarios: CALENDARS,
			eventos: [
				event({ uid: 'a', title: 'Personal', calendar: PERSONAL, start, end: start }),
				event({ uid: 'b', title: 'Trabajo', calendar: TRABAJO, start, end: start }),
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

	test('ocultar un calendario lo saca de lo que se dibuja pero no de la lista', async () => {
		const api = await open();
		expect(drawn(api)).toEqual(['a', 'b']);

		api.toggleCalendarVisibility(TRABAJO);
		await nextTick();

		expect(drawn(api)).toEqual(['a']);
		// Sigue entero: se puede seguir creando eventos en el calendario oculto.
		expect(api.calendarios.value.map((c) => c.url)).toEqual([PERSONAL, TRABAJO]);
		expect(api.eventos.value).toHaveLength(2);

		api.toggleCalendarVisibility(TRABAJO);
		await nextTick();
		expect(drawn(api)).toEqual(['a', 'b']);
	});

	test('lo oculto se guarda y vale en la próxima apertura, sin volver a pedirlo', async () => {
		const first = await open();
		first.toggleCalendarVisibility(PERSONAL);
		expect(JSON.parse(localStorage.getItem(HIDDEN_CALENDARS_KEY) ?? '[]')).toEqual([PERSONAL]);
		scope?.stop();

		const again = await open();
		expect(again.hiddenCalendars.value.has(PERSONAL)).toBe(true);
		expect(drawn(again)).toEqual(['b']);
	});
});
