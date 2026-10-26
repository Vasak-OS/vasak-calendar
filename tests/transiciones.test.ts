/**
 * Las transiciones de la ventana (vue-libvasak 2.21.0, Once UI §5.5).
 *
 * Tres cambios se animan en `CalendarView`:
 *
 * - el **período** (mes, semana, día) con las flechas y «Hoy»: desliza hacia el
 *   lado de la flecha (`SlideTransition`, `slideFrom`) sobre un elemento con
 *   `:key` el título;
 * - la **vista** (día, semana, mes, año, agenda): sale una y entra la otra
 *   (`RevealTransition`);
 * - **Calendario ↔ Tareas**: lo mismo, con una sola caja por parte.
 *
 * Lo que se comprueba es lo que se nota: de qué lado entra cada período, que
 * «Hoy» siga llevando la lista al día de hoy aunque la lista nueva todavía no
 * exista cuando termina de cargar (el riesgo de remontar la vista), y que cada
 * transición tenga un único hijo por rama —Vue avisa si no—.
 *
 * Lo que no se prueba acá: que el deslizamiento de 16 px no asome fuera de la
 * ventana. happy-dom no maqueta ni anima; eso se mira en la ventana real.
 */

import { afterEach, describe, expect, setSystemTime, spyOn, test } from 'bun:test';
import { RevealTransition, SegmentedControl, SlideTransition } from '@vasakgroup/vue-libvasak';
import { mount, type VueWrapper } from '@vue/test-utils';
import ColumnsView from '@/components/calendar/ColumnsView.vue';
import MonthAgenda from '@/components/calendar/MonthAgenda.vue';
import MonthGrid from '@/components/calendar/MonthGrid.vue';
import MonthNavigation from '@/components/calendar/MonthNavigation.vue';
import TasksView from '@/components/calendar/TasksView.vue';
import ViewSwitcher from '@/components/calendar/ViewSwitcher.vue';
import YearView from '@/components/calendar/YearView.vue';
import { cuadricula, type Dia } from '@/tools/mes';
import { zonaDeLaSesion } from '@/tools/zona';
import CalendarView from '@/views/CalendarView.vue';
import { olvidarTodo, setAnswer } from './dobles';
import { calendarEvent as event } from './fixtures/events';

let mounted: VueWrapper | null = null;
const realOffsetTop = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetTop');
const realScrollTo = HTMLElement.prototype.scrollTo;

afterEach(() => {
	mounted?.unmount();
	mounted = null;
	document.body.innerHTML = '';
	olvidarTodo();
	if (realOffsetTop) Object.defineProperty(HTMLElement.prototype, 'offsetTop', realOffsetTop);
	HTMLElement.prototype.scrollTo = realScrollTo;
	setSystemTime();
	try {
		localStorage.clear();
	} catch {
		// Sin almacenamiento no hay nada que limpiar.
	}
});

/** «Hoy» fijo en mitad de mes: el mes de al lado nunca tiene a hoy en su cuadrícula. */
const MID_MONTH = new Date('2026-10-15T12:00:00Z');

/** Que terminen la carga, las promesas que encadena y las transiciones. */
async function flush(rounds = 10) {
	for (let i = 0; i < rounds; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** La ventana con una cuenta y un evento en el primero y el último día del mes de hoy. */
async function open() {
	setSystemTime(MID_MONTH);
	const days = cuadricula(new Date(), zonaDeLaSesion()).filter((day) => day.delMes);
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
	await flush();
	return mounted;
}

/** Los controles del mes, en la tira de arriba de la vista. */
function strip(wrapper: VueWrapper) {
	return wrapper.get('[data-pane="month"]');
}

const nav = (wrapper: VueWrapper) => strip(wrapper).findComponent(MonthNavigation);
// Las flechas cambian de etiqueta según la vista (mes, o «anterior»/«siguiente»):
// son siempre el primer y el último botón.
const previous = (wrapper: VueWrapper) => nav(wrapper).findAll('button').at(0)?.trigger('click');
const next = (wrapper: VueWrapper) => nav(wrapper).findAll('button').at(-1)?.trigger('click');
const today = (wrapper: VueWrapper) =>
	strip(wrapper)
		.findAll('button')
		.find((b) => b.text() === 'calendario.hoy')
		?.trigger('click');

const slideFrom = (wrapper: VueWrapper) => wrapper.findComponent(SlideTransition).props('direction');

/** El elemento del período —el que lleva la clave—: el padre de la cuadrícula. */
const periodElement = (wrapper: VueWrapper) => wrapper.findComponent(MonthGrid).element.parentElement;

/** Cambia de vista como lo hace el selector. */
async function changeView(wrapper: VueWrapper, view: string) {
	wrapper.findComponent(ViewSwitcher).vm.$emit('change', view);
	await flush(1);
}

/** Cambia de parte —calendario o tareas— como lo hace el selector de arriba. */
function changeMode(wrapper: VueWrapper, mode: 'calendar' | 'tasks') {
	const selector = wrapper
		.findAllComponents(SegmentedControl)
		.find((c) => (c.props() as { options: { value: string }[] }).options.some((o) => o.value === 'tasks'));
	selector?.vm.$emit('change', mode);
}

describe('de qué lado entra el período', () => {
	test('avanzar entra por la derecha y retroceder por la izquierda', async () => {
		const wrapper = await open();
		await previous(wrapper);
		expect(slideFrom(wrapper)).toBe('left');
		await flush();
		await next(wrapper);
		expect(slideFrom(wrapper)).toBe('right');
	});

	test('el lado ya está puesto en el turno en que cambia el título', async () => {
		const wrapper = await open();
		const before = nav(wrapper).get('h1').text();
		await previous(wrapper);
		// Sin esperar a nada: la transición que está saliendo lee el lado ahora, y
		// un lado puesto después la haría salir para el lado equivocado.
		expect(nav(wrapper).get('h1').text()).not.toBe(before);
		expect(slideFrom(wrapper)).toBe('left');
	});

	test('«Hoy» entra por el lado hacia donde queda hoy', async () => {
		const wrapper = await open();
		await next(wrapper);
		await flush();
		await today(wrapper);
		// Estábamos en el mes que viene: hoy queda atrás.
		expect(slideFrom(wrapper)).toBe('left');
		await flush();

		await previous(wrapper);
		await flush();
		await today(wrapper);
		// Y ahora estábamos en el mes pasado: hoy queda adelante.
		expect(slideFrom(wrapper)).toBe('right');
	});
});

describe('la clave del período', () => {
	test('al cambiar de mes se monta un período nuevo y el viejo se va', async () => {
		const wrapper = await open();
		const old = periodElement(wrapper);
		expect(old?.isConnected).toBe(true);
		await next(wrapper);
		await flush();
		const now = periodElement(wrapper);
		expect(now).not.toBe(old);
		expect(now?.isConnected).toBe(true);
		expect(old?.isConnected).toBe(false);
	});

	test('actualizar sin cambiar de período no remonta nada', async () => {
		const wrapper = await open();
		const period = periodElement(wrapper);
		const grid = wrapper.findComponent(MonthGrid).element;
		await wrapper.get('[title="calendario.actualizar"]').trigger('click');
		await flush();
		expect(periodElement(wrapper)).toBe(period);
		expect(wrapper.findComponent(MonthGrid).element).toBe(grid);
	});
});

/** El doble de `offsetTop`: cada día dice estar a «número del día × 100» px. */
function fakeLayout() {
	Object.defineProperty(HTMLElement.prototype, 'offsetTop', {
		configurable: true,
		get(this: HTMLElement) {
			return this.dataset.day ? Number(this.dataset.day.slice(8)) * 100 : 0;
		},
	});
	const calls: ScrollToOptions[] = [];
	HTMLElement.prototype.scrollTo = ((options: ScrollToOptions) =>
		void calls.push(options)) as typeof HTMLElement.prototype.scrollTo;
	return calls;
}

// Hoy es el 15 de octubre: la lista, llevada a hoy, queda en `top: 1500`.
const TODAY_TOP = { top: 1500 };

describe('«Hoy» lleva la lista al día de hoy en el período que entra', () => {
	test('desde otro mes, en la agenda del mes', async () => {
		const calls = fakeLayout();
		const wrapper = await open();
		await next(wrapper);
		await flush();
		calls.length = 0;
		await today(wrapper);
		await flush();
		expect(calls).toEqual([TODAY_TOP]);
		// Y la lista donde eso pasó es la del período nuevo, no una que ya se fue.
		expect(wrapper.findComponent(MonthAgenda).element.isConnected).toBe(true);
	});

	test('desde otro mes, en la vista de agenda', async () => {
		const calls = fakeLayout();
		const wrapper = await open();
		await changeView(wrapper, 'agenda');
		await flush();
		await next(wrapper);
		await flush();
		calls.length = 0;
		await today(wrapper);
		await flush();
		expect(calls).toEqual([TODAY_TOP]);
	});

	test('sin cambiar de período, la lista se lleva a hoy en el momento', async () => {
		const calls = fakeLayout();
		const wrapper = await open();
		calls.length = 0;
		await today(wrapper);
		await flush();
		expect(calls).toEqual([TODAY_TOP]);
	});

	// Un período que se monta por otra razón que «Hoy» —acá, un cambio de vista—
	// no tiene que llevar la lista a hoy: la bandera de «Hoy» se baja al usarla.
	test('la bandera no queda armada: una vista nueva no salta a hoy', async () => {
		const calls = fakeLayout();
		const wrapper = await open();
		// «Hoy» sin cambiar de período (consume su turno en el momento)…
		await today(wrapper);
		await flush();
		calls.length = 0;
		await changeView(wrapper, 'agenda');
		await flush();
		expect(calls).toEqual([]);
	});

	test('tampoco queda armada tras «Hoy» desde otro mes', async () => {
		const calls = fakeLayout();
		const wrapper = await open();
		await next(wrapper);
		await flush();
		await today(wrapper);
		await flush();
		calls.length = 0;
		await changeView(wrapper, 'agenda');
		await flush();
		expect(calls).toEqual([]);
	});
});

describe('el cambio de vista', () => {
	test('cada vista muestra su rama y sólo esa, sin avisos de Vue', async () => {
		const warn = spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const wrapper = await open();
			expect(wrapper.findComponent(MonthGrid).exists()).toBe(true);

			await changeView(wrapper, 'week');
			await flush();
			expect(wrapper.findComponent(ColumnsView).exists()).toBe(true);
			expect(wrapper.findComponent(MonthGrid).exists()).toBe(false);

			await changeView(wrapper, 'year');
			await flush();
			expect(wrapper.findComponent(YearView).exists()).toBe(true);
			expect(wrapper.findComponent(ColumnsView).exists()).toBe(false);

			await changeView(wrapper, 'agenda');
			await flush();
			expect(wrapper.findComponent(MonthAgenda).exists()).toBe(true);
			expect(wrapper.findComponent(YearView).exists()).toBe(false);
			expect(wrapper.findComponent(MonthGrid).exists()).toBe(false);

			await changeView(wrapper, 'month');
			await flush();
			expect(wrapper.findComponent(MonthGrid).exists()).toBe(true);

			const avisos = warn.mock.calls.map((call) => String(call[0])).filter((m) => m.includes('Vue warn'));
			expect(avisos).toEqual([]);
		} finally {
			warn.mockRestore();
		}
	});

	test('hay una transición por parte y por vista y una por período, todas out-in', async () => {
		const wrapper = await open();
		// Calendario ↔ Tareas (afuera) y el cambio de vista (adentro), cada una con
		// la del período adentro: sale lo viejo y recién después entra lo nuevo.
		const reveals = wrapper.findAllComponents(RevealTransition);
		expect(reveals).toHaveLength(2);
		expect(reveals.map((r) => r.props('mode'))).toEqual(['out-in', 'out-in']);
		expect(reveals[1].findComponent(SlideTransition).exists()).toBe(true);
		expect(wrapper.findComponent(SlideTransition).props('mode')).toBe('out-in');
	});
});

describe('de Calendario a Tareas', () => {
	test('cada parte muestra su rama y sólo esa, sin avisos de Vue', async () => {
		const warn = spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const wrapper = await open();
			expect(wrapper.findComponent(TasksView).exists()).toBe(false);

			changeMode(wrapper, 'tasks');
			await flush();
			expect(wrapper.findComponent(TasksView).exists()).toBe(true);
			expect(wrapper.findComponent(MonthGrid).exists()).toBe(false);

			changeMode(wrapper, 'calendar');
			await flush();
			expect(wrapper.findComponent(TasksView).exists()).toBe(false);
			expect(wrapper.findComponent(MonthGrid).exists()).toBe(true);

			const avisos = warn.mock.calls.map((call) => String(call[0])).filter((m) => m.includes('Vue warn'));
			expect(avisos).toEqual([]);
		} finally {
			warn.mockRestore();
		}
	});

	test('al volver, el calendario sigue en el mes y la vista en que estaba', async () => {
		const wrapper = await open();
		await next(wrapper);
		await flush();
		const title = nav(wrapper).get('h1').text();
		changeMode(wrapper, 'tasks');
		await flush();
		changeMode(wrapper, 'calendar');
		await flush();
		expect(nav(wrapper).get('h1').text()).toBe(title);
	});
});
