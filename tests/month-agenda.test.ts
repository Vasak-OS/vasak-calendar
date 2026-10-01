/**
 * El mes como agenda, con la ventana angosta.
 *
 * Por debajo de 36 rem de fila la cuadrícula queda con siete columnas de unos
 * 30 px y los eventos se ven como una hora cortada; ahí el mes pasa a ser una
 * lista de los días que tienen algo, como en un teléfono. Lo que se comprueba:
 *
 * - qué días entran (los del mes con eventos, y hoy aunque esté libre) y en qué
 *   orden, con los eventos de cada día en el orden de la cuadrícula;
 * - qué hora se dice de un evento de varios días en cada día que ocupa, y de
 *   uno de día completo;
 * - que la lista usa las piezas de la librería y el color del calendario llega
 *   como dato;
 * - que la vista cambia por el ancho de la fila —una consulta de contenedor que
 *   tiene que existir de verdad en la hoja de Tailwind—, y que el mes, la zona
 *   y la columna elegida se conservan al ensanchar, porque las dos vistas están
 *   montadas siempre;
 * - que «Hoy» lleva la lista al día de hoy.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { compile } from '@tailwindcss/node';
import {
	EmptyState,
	ListGroup,
	ListRow,
	SectionHeading,
	StatusDot,
} from '@vasakgroup/vue-libvasak';
import { mount, type VueWrapper } from '@vue/test-utils';
import AccountsPanel from '@/components/calendar/AccountsPanel.vue';
import MonthAgenda from '@/components/calendar/MonthAgenda.vue';
import MonthGrid from '@/components/calendar/MonthGrid.vue';
import MonthNavigation from '@/components/calendar/MonthNavigation.vue';
import {
	agendaSections,
	eventSpanOn,
	isAgendaEmpty,
	todaySectionKey,
} from '@/tools/agenda';
import { type CalendarEvent, cuadricula, type Dia, eventsByDay } from '@/tools/mes';
import { NARROW_ONLY, PANE_SHOWN, WIDE_ONLY } from '@/tools/narrow-layout';
import { zonaDeLaSesion } from '@/tools/zona';
import CalendarView from '@/views/CalendarView.vue';
import { olvidarTodo, setAnswer } from './dobles';

let mounted: VueWrapper | null = null;
const realOffsetTop = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetTop');

afterEach(() => {
	mounted?.unmount();
	mounted = null;
	document.body.innerHTML = '';
	olvidarTodo();
	if (realOffsetTop) Object.defineProperty(HTMLElement.prototype, 'offsetTop', realOffsetTop);
	try {
		localStorage.clear();
	} catch {
		// Sin almacenamiento no hay nada que limpiar.
	}
});

function event(extra: Partial<CalendarEvent> = {}): CalendarEvent {
	return {
		uid: 'uno',
		title: 'Reunión',
		start: '2026-09-15T14:00:00Z',
		end: '2026-09-15T15:00:00Z',
		all_day: false,
		recurring: false,
		shown_once: false,
		zone: '',
		calendar: 'https://nube.ejemplo.com/personal/',
		color: '#e66100',
		...extra,
	};
}

/** Septiembre de 2026 en UTC, con «hoy» el 20. */
const SEPTEMBER = cuadricula(
	new Date('2026-09-15T12:00:00Z'),
	'UTC',
	new Date('2026-09-20T12:00:00Z')
);

function sectionsOf(events: CalendarEvent[], days: Dia[] = SEPTEMBER) {
	const byDay = eventsByDay(events, days, 'UTC');
	return agendaSections(days, (key) => byDay.get(key) ?? []);
}

const keys = (sections: ReturnType<typeof sectionsOf>) => sections.map((s) => s.day.clave);

describe('los días de la agenda', () => {
	test('los del mes que tienen algo, en orden, y hoy aunque esté libre', () => {
		const sections = sectionsOf([
			event({ uid: 'b', start: '2026-09-25T09:00:00Z', end: '2026-09-25T10:00:00Z' }),
			event({ uid: 'a', start: '2026-09-03T09:00:00Z', end: '2026-09-03T10:00:00Z' }),
		]);
		expect(keys(sections)).toEqual(['2026-09-03', '2026-09-20', '2026-09-25']);
		expect(sections[1].events).toEqual([]);
	});

	test('el relleno de la cuadrícula no entra: el 31 de agosto no es de septiembre', () => {
		// La primera fila de septiembre de 2026 arranca el lunes 31 de agosto.
		expect(SEPTEMBER[0].clave).toBe('2026-08-31');
		const sections = sectionsOf([
			event({ start: '2026-08-31T09:00:00Z', end: '2026-08-31T10:00:00Z' }),
		]);
		expect(keys(sections)).toEqual(['2026-09-20']);
	});

	test('dentro del día, el de día completo primero y después por hora', () => {
		const sections = sectionsOf([
			event({ uid: 'tarde', start: '2026-09-10T18:00:00Z', end: '2026-09-10T19:00:00Z' }),
			event({ uid: 'mañana', start: '2026-09-10T08:00:00Z', end: '2026-09-10T09:00:00Z' }),
			event({
				uid: 'feriado',
				all_day: true,
				start: '2026-09-10T00:00:00Z',
				end: '2026-09-11T00:00:00Z',
			}),
		]);
		expect(sections[0].events.map((e) => e.uid)).toEqual(['feriado', 'mañana', 'tarde']);
	});

	test('un evento de varios días está en cada día que ocupa', () => {
		const sections = sectionsOf([
			event({ uid: 'congreso', start: '2026-09-08T09:00:00Z', end: '2026-09-10T17:00:00Z' }),
		]);
		expect(keys(sections)).toEqual(['2026-09-08', '2026-09-09', '2026-09-10', '2026-09-20']);
	});

	test('uno de día completo de varios días, sin un día de más al final', () => {
		// Termina en la medianoche del 13, que es como el formato dice «hasta el 12».
		const sections = sectionsOf([
			event({
				uid: 'vacaciones',
				all_day: true,
				start: '2026-09-11T00:00:00Z',
				end: '2026-09-13T00:00:00Z',
			}),
		]);
		expect(keys(sections)).toEqual(['2026-09-11', '2026-09-12', '2026-09-20']);
	});

	test('un mes sin eventos es un mes vacío, aunque tenga hoy', () => {
		expect(isAgendaEmpty(sectionsOf([]))).toBe(true);
		expect(isAgendaEmpty(sectionsOf([event()]))).toBe(false);
	});

	test('«Hoy» va a hoy, o al primer día que viene, o al último', () => {
		const sections = sectionsOf([event()]);
		expect(todaySectionKey(sections, '2026-09-20')).toBe('2026-09-20');
		expect(todaySectionKey(sections, '2026-09-16')).toBe('2026-09-20');
		expect(todaySectionKey(sections, '2026-09-30')).toBe('2026-09-20');
		expect(todaySectionKey([], '2026-09-30')).toBe('');
	});
});

describe('la hora de cada evento en cada día', () => {
	test('uno que empieza y termina ese día dice las dos horas', () => {
		expect(eventSpanOn(event(), '2026-09-15', 'UTC').kind).toBe('range');
	});

	test('uno de varios días: desde, el medio entero, hasta', () => {
		const congress = event({ start: '2026-09-08T09:00:00Z', end: '2026-09-10T17:00:00Z' });
		const first = eventSpanOn(congress, '2026-09-08', 'UTC');
		const middle = eventSpanOn(congress, '2026-09-09', 'UTC');
		const last = eventSpanOn(congress, '2026-09-10', 'UTC');
		expect(first).toEqual({ kind: 'from', start: new Date('2026-09-08T09:00:00Z') });
		expect(middle).toEqual({ kind: 'all-day' });
		expect(last).toEqual({ kind: 'until', end: new Date('2026-09-10T17:00:00Z') });
	});

	test('una guardia que termina a medianoche no dice «hasta las 0:00» al otro día', () => {
		const shift = event({ start: '2026-09-15T22:00:00Z', end: '2026-09-16T00:00:00Z' });
		expect(eventSpanOn(shift, '2026-09-15', 'UTC').kind).toBe('range');
	});

	test('la hora es la de la zona de la agenda, y el día también', () => {
		// De las 2 a las 4 UTC del 16 son de las 23 del 15 a la 1 del 16 en
		// Buenos Aires: en UTC no cruza la medianoche, en la agenda sí.
		const late = event({ start: '2026-09-16T02:00:00Z', end: '2026-09-16T04:00:00Z' });
		expect(eventSpanOn(late, '2026-09-16', 'UTC').kind).toBe('range');
		expect(eventSpanOn(late, '2026-09-15', 'America/Argentina/Buenos_Aires').kind).toBe('from');
		expect(eventSpanOn(late, '2026-09-16', 'America/Argentina/Buenos_Aires').kind).toBe('until');
	});

	test('uno sin duración dice su hora sola', () => {
		const reminder = event({ start: '2026-09-15T09:00:00Z', end: '2026-09-15T09:00:00Z' });
		expect(eventSpanOn(reminder, '2026-09-15', 'UTC')).toEqual({
			kind: 'at',
			start: new Date('2026-09-15T09:00:00Z'),
		});
	});

	test('uno de día completo es de día completo', () => {
		const holiday = event({ all_day: true, start: '2026-09-15T00:00:00Z', end: '2026-09-16T00:00:00Z' });
		expect(eventSpanOn(holiday, '2026-09-15', 'UTC')).toEqual({ kind: 'all-day' });
	});
});

describe('la lista', () => {
	function agenda(events: CalendarEvent[], days: Dia[] = SEPTEMBER) {
		const byDay = eventsByDay(events, days, 'UTC');
		mounted = mount(MonthAgenda, {
			props: { days, zone: 'UTC', eventsOf: (key: string) => byDay.get(key) ?? [] },
		});
		return mounted;
	}

	test('un título pegajoso por día y una fila por evento, con la hora y el título enteros', () => {
		const wrapper = agenda([
			event({ title: 'Revisión trimestral con el equipo de infraestructura' }),
			event({ uid: 'dos', all_day: true, start: '2026-09-15T00:00:00Z', end: '2026-09-16T00:00:00Z', title: 'Feriado' }),
		]);
		const headings = wrapper.findAllComponents(SectionHeading);
		expect(headings).toHaveLength(2);
		expect(headings.every((h) => h.props('sticky'))).toBe(true);

		const rows = wrapper.findAllComponents(ListRow);
		// El 15 con dos eventos y hoy, libre, con su fila de «nada».
		expect(rows.map((r) => r.props('title'))).toEqual([
			'Feriado',
			'Revisión trimestral con el equipo de infraestructura',
			'agenda.nothing',
		]);
		expect(rows[0].props('description')).toBe('calendario.todoElDia');
		// Sin catálogo `t()` devuelve la clave, y el marcador se reemplaza a mano:
		// lo que importa es que llegan las dos horas.
		expect(rows[1].props('description')).toBe('agenda.range');
		expect(wrapper.findAllComponents(ListGroup)).toHaveLength(2);
	});

	test('hoy se marca como la fecha actual', () => {
		const wrapper = agenda([event()]);
		const today = wrapper.get('[data-day="2026-09-20"]');
		expect(today.attributes('aria-current')).toBe('date');
		expect(wrapper.get('[data-day="2026-09-15"]').attributes('aria-current')).toBeUndefined();
	});

	test('el color del calendario llega al punto como dato, y sin color va el acento', () => {
		const wrapper = agenda([event(), event({ uid: 'sin', color: null })]);
		const dots = wrapper.findAllComponents(StatusDot);
		expect(dots.map((d) => d.props('color'))).toEqual(['#e66100', undefined]);
		expect(dots.every((d) => d.props('tone') === 'accent')).toBe(true);
	});

	test('las marcas de repetición y de otra zona se ven también en la lista', () => {
		const wrapper = agenda([event({ recurring: true, zone: 'Europe/Madrid' })]);
		expect(wrapper.find('[data-testid="recurrence-mark"]').exists()).toBe(true);
		expect(wrapper.find('[data-testid="foreign-zone-mark"]').exists()).toBe(true);
	});

	test('un mes sin eventos muestra el vacío', () => {
		const wrapper = agenda([]);
		expect(wrapper.findComponent(EmptyState).props('title')).toBe('agenda.empty');
		expect(wrapper.findAllComponents(ListRow)).toHaveLength(0);
	});
});

describe('el cambio de vista por ancho', () => {
	async function css(candidates: string[]) {
		const compiler = await compile('@import "tailwindcss/utilities";', {
			base: process.cwd(),
			onDependency: () => {},
		});
		return compiler.build(candidates);
	}

	test('la cuadrícula sólo con la ventana ancha y la agenda sólo con la angosta', () => {
		mounted = mount(CalendarView, { attachTo: document.body });
		expect(mounted.findComponent(MonthGrid).classes()).toContain(WIDE_ONLY);
		expect(mounted.findComponent(MonthAgenda).classes()).toContain(NARROW_ONLY);
	});

	test('las dos clases existen en la hoja y se reparten los anchos sin pisarse', async () => {
		const sheet = await css([WIDE_ONLY, NARROW_ONLY]);
		const narrow = sheet.split('@container row (width < 36rem)')[1]?.split('@container')[0] ?? '';
		const wide = sheet.split('@container row (width >= 36rem)')[1] ?? '';
		expect(narrow).toContain('display: none');
		expect(wide).toContain('display: none');
		// El mismo umbral que las columnas: a 590 px de fila, la ventana de 600
		// se ve exactamente como antes.
		expect(WIDE_ONLY).toBe('@max-[36rem]/row:hidden');
		expect(PANE_SHOWN).toContain('@max-[36rem]/row:');
	});
});

/** Que terminen la carga y las promesas que encadena. */
async function flush(rounds = 10) {
	for (let i = 0; i < rounds; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * La vista con una cuenta y un evento por día en los días que se pidan del mes
 * de hoy, a las 10 de la zona de la sesión.
 */
function viewWithEvents() {
	const zone = zonaDeLaSesion();
	const days = cuadricula(new Date(), zone).filter((day) => day.delMes);
	const ten = (day: Dia) => new Date(day.fecha.getTime() + 10 * 3600_000);
	const events = [days[0], days[days.length - 1]].map((day, i) =>
		event({
			uid: `e${i}`,
			title: `Evento ${i}`,
			start: ten(day).toISOString(),
			end: new Date(ten(day).getTime() + 3600_000).toISOString(),
		})
	);
	setAnswer('listar_cuentas', [{ id: 'a1', nombre: 'ana', necesita_reconectarse: false }]);
	setAnswer('account_events', { calendarios: [], eventos: events, fallos: [] });
	mounted = mount(CalendarView, { attachTo: document.body });
	return mounted;
}

describe('«Hoy» y la selección', () => {
	test('«Hoy» lleva el mes a hoy y la lista al día de hoy', async () => {
		// happy-dom no maqueta: cada día dice estar a «número del día × 100» px
		// del principio de la lista, para saber adónde se la llevó.
		Object.defineProperty(HTMLElement.prototype, 'offsetTop', {
			configurable: true,
			get(this: HTMLElement) {
				return this.dataset.day ? Number(this.dataset.day.slice(8)) * 100 : 0;
			},
		});
		const wrapper = viewWithEvents();
		await flush();
		const list = wrapper.get('[data-testid="month-agenda"]').element as HTMLElement;
		const calls: ScrollToOptions[] = [];
		list.scrollTo = ((options: ScrollToOptions) => void calls.push(options)) as typeof list.scrollTo;

		const strip = wrapper.get('[data-pane="month"]');
		const nav = strip.findComponent(MonthNavigation);
		const thisMonth = nav.get('h1').text();
		await nav.get('[aria-label="calendario.mesSiguiente"]').trigger('click');
		await flush();
		expect(nav.get('h1').text()).not.toBe(thisMonth);

		const today = wrapper.findComponent(MonthAgenda).props('days').find((d: Dia) => d.esHoy);
		expect(today).toBeUndefined();

		const todayButton = strip.findAll('button').find((b) => b.text() === 'calendario.hoy');
		await todayButton?.trigger('click');
		await flush();

		expect(nav.get('h1').text()).toBe(thisMonth);
		const todayDay = wrapper.findComponent(MonthAgenda).props('days').find((d: Dia) => d.esHoy) as Dia;
		const section = wrapper.get(`[data-day="${todayDay.clave}"]`);
		expect(section.attributes('aria-current')).toBe('date');
		expect(calls.at(-1)).toEqual({ top: Number(todayDay.clave.slice(8)) * 100 });
	});

	test('al ensanchar se ve el mismo mes, la misma zona y la misma columna', async () => {
		const wrapper = viewWithEvents();
		await flush();
		const agenda = wrapper.findComponent(MonthAgenda);
		const grid = wrapper.findComponent(MonthGrid);

		// En la ventana angosta: otro mes, otra zona y el panel de cuentas.
		const strip = wrapper.get('[data-pane="month"]');
		await strip.findComponent(MonthNavigation).get('[aria-label="calendario.mesSiguiente"]').trigger('click');
		wrapper.findComponent(AccountsPanel).vm.$emit('chooseZone', 'Europe/Madrid');
		await strip.get('[data-nav="month"] button').trigger('click');
		await flush();

		// Ensanchar no monta nada nuevo: es CSS. La cuadrícula que aparece es la
		// misma instancia, y mira lo mismo que la agenda que se oculta.
		expect(wrapper.findComponent(MonthGrid).element).toBe(grid.element);
		expect(wrapper.findComponent(MonthAgenda).element).toBe(agenda.element);
		expect(grid.props('days')).toEqual(agenda.props('days'));
		expect(grid.props('zone')).toBe('Europe/Madrid');
		expect(agenda.props('zone')).toBe('Europe/Madrid');
		expect(wrapper.findComponent(AccountsPanel).classes()).toEqual(
			expect.arrayContaining(PANE_SHOWN.split(' '))
		);
	});

	test('con eventos, la agenda del mes de hoy los lista en orden', async () => {
		const wrapper = viewWithEvents();
		await flush();
		const titles = wrapper
			.findComponent(MonthAgenda)
			.findAllComponents(ListRow)
			.map((row) => row.props('title'))
			.filter((title) => title !== 'agenda.nothing');
		expect(titles).toEqual(['Evento 0', 'Evento 1']);
	});
});
