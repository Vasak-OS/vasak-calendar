/**
 * Las vistas del calendario: día, N días, semana, mes, año y agenda.
 *
 * Lo que se comprueba:
 *
 * - que el selector cambia de vista y aparece la pieza de cada una;
 * - que cada vista muestra **las ocurrencias que caen en su rango** y no las de
 *   afuera —un evento del martes está en la columna del martes y en ninguna
 *   otra, el día con algo del año lleva su punto—;
 * - que el composable le pide al almacén el rango de la vista (un día, una
 *   semana, un año) y no siempre el del mes;
 * - que la vista elegida se recuerda entre aperturas.
 *
 * La hora en la zona de la agenda se prueba en `views.test.ts` y en
 * `month-agenda.test.ts` sobre las funciones puras; acá se mira el montaje.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { SegmentedControl } from '@vasakgroup/vue-libvasak';
import { mount, type VueWrapper } from '@vue/test-utils';
import { type EffectScope, effectScope, nextTick } from 'vue';
import AgendaView from '@/components/calendar/AgendaView.vue';
import ColumnsView from '@/components/calendar/ColumnsView.vue';
import DayEvents from '@/components/calendar/DayEvents.vue';
import MonthGrid from '@/components/calendar/MonthGrid.vue';
import ViewSwitcher from '@/components/calendar/ViewSwitcher.vue';
import YearView from '@/components/calendar/YearView.vue';
import { useCalendario } from '@/composables/use-calendario';
import { type CalendarEvent, eventsByDay } from '@/tools/mes';
import { CALENDAR_VIEWS, viewDays } from '@/tools/views';
import CalendarView from '@/views/CalendarView.vue';
import { invocations, olvidarTodo, setAnswer } from './dobles';

let mounted: VueWrapper | null = null;
let scope: EffectScope | null = null;

afterEach(() => {
	mounted?.unmount();
	mounted = null;
	scope?.stop();
	scope = null;
	document.body.innerHTML = '';
	olvidarTodo();
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
		start: '2026-10-15T14:00:00Z',
		end: '2026-10-15T15:00:00Z',
		all_day: false,
		recurring: false,
		shown_once: false,
		zone: '',
		calendar: 'https://nube.ejemplo.com/personal/',
		color: '#e66100',
		...extra,
	};
}

/** `eventsOf` de un rango de días dado, como lo arma el composable. */
function eventsOfFor(days: ReturnType<typeof viewDays>, events: CalendarEvent[]) {
	const byDay = eventsByDay(events, days, 'UTC');
	return (clave: string) => byDay.get(clave) ?? [];
}

const ANCHOR = new Date('2026-10-15T00:00:00Z');
const FAR = new Date('2000-01-01T00:00:00Z');

async function flush(rounds = 6) {
	for (let i = 0; i < rounds; i++) await nextTick();
}

describe('la columna de un día (día, N días, semana)', () => {
	test('una sección por día, con su fecha', () => {
		const days = viewDays('week', ANCHOR, 'UTC', FAR);
		mounted = mount(ColumnsView, {
			props: { days, zone: 'UTC', eventsOf: eventsOfFor(days, []) },
		});

		const sections = mounted.findAll('[data-day]');
		expect(sections).toHaveLength(7);
		expect(sections[0].attributes('data-day')).toBe('2026-10-12');
		expect(sections.at(-1)?.attributes('data-day')).toBe('2026-10-18');
	});

	test('el evento está en la columna de su día y en ninguna otra', () => {
		const days = viewDays('week', ANCHOR, 'UTC', FAR);
		const events = [event({ title: 'Dentista', start: '2026-10-15T14:00:00Z', end: '2026-10-15T15:00:00Z' })];
		mounted = mount(ColumnsView, {
			props: { days, zone: 'UTC', eventsOf: eventsOfFor(days, events) },
		});

		const thursday = mounted.get('[data-day="2026-10-15"]');
		expect(thursday.text()).toContain('Dentista');
		// El resto de los días no lo tienen: su `DayEvents` dice «sin eventos».
		for (const key of ['2026-10-12', '2026-10-16', '2026-10-18']) {
			expect(mounted.get(`[data-day="${key}"]`).text()).not.toContain('Dentista');
			expect(mounted.get(`[data-day="${key}"]`).text()).toContain('calendario.sinEventos');
		}
	});

	test('un evento de varios días está en cada columna que ocupa', () => {
		const days = viewDays('week', ANCHOR, 'UTC', FAR);
		const events = [
			event({ title: 'Congreso', start: '2026-10-13T09:00:00Z', end: '2026-10-15T17:00:00Z' }),
		];
		mounted = mount(ColumnsView, {
			props: { days, zone: 'UTC', eventsOf: eventsOfFor(days, events) },
		});

		for (const key of ['2026-10-13', '2026-10-14', '2026-10-15']) {
			expect(mounted.get(`[data-day="${key}"]`).text()).toContain('Congreso');
		}
		expect(mounted.get('[data-day="2026-10-16"]').text()).not.toContain('Congreso');
	});
});

describe('la vista de año', () => {
	test('son doce meses', () => {
		const days = viewDays('year', ANCHOR, 'UTC', FAR);
		mounted = mount(YearView, {
			props: { year: 2026, zone: 'UTC', today: FAR, eventsOf: eventsOfFor(days, []) },
		});

		expect(mounted.findAll('[data-month]')).toHaveLength(12);
	});

	test('un día con eventos lleva su punto, y uno sin eventos no', () => {
		const days = viewDays('year', ANCHOR, 'UTC', FAR);
		const events = [event({ start: '2026-10-15T14:00:00Z', end: '2026-10-15T15:00:00Z' })];
		mounted = mount(YearView, {
			props: { year: 2026, zone: 'UTC', today: FAR, eventsOf: eventsOfFor(days, events) },
		});

		// El punto está, y una sola vez: sólo el día que tiene algo.
		expect(mounted.findAll('[data-testid="year-event-dot"]')).toHaveLength(1);
	});

	test('tocar un día lo abre; tocar el nombre del mes abre el mes', async () => {
		const days = viewDays('year', ANCHOR, 'UTC', FAR);
		mounted = mount(YearView, {
			props: { year: 2026, zone: 'UTC', today: FAR, eventsOf: eventsOfFor(days, []) },
		});

		await mounted.get('[data-month="3"] button[type="button"]').trigger('click');
		expect(mounted.emitted('selectMonth')).toBeTruthy();

		// Un día cualquiera de marzo: la segunda celda clicable del mes.
		const marchDays = mounted.get('[data-month="3"]').findAll('button[type="button"]');
		await marchDays[2].trigger('click');
		expect(mounted.emitted('selectDay')).toBeTruthy();
	});
});

describe('la agenda como vista', () => {
	test('lista los días del rango que tienen algo, con sus eventos', () => {
		const days = viewDays('agenda', ANCHOR, 'UTC', FAR);
		const events = [
			event({ uid: 'a', title: 'Médico', start: '2026-10-05T09:00:00Z', end: '2026-10-05T10:00:00Z' }),
			event({ uid: 'b', title: 'Cena', start: '2026-10-20T20:00:00Z', end: '2026-10-20T22:00:00Z' }),
		];
		mounted = mount(AgendaView, {
			props: { days, zone: 'UTC', eventsOf: eventsOfFor(days, events) },
		});

		const sections = mounted.findAll('[data-day]');
		expect(sections.map((s) => s.attributes('data-day'))).toEqual(['2026-10-05', '2026-10-20']);
		expect(mounted.text()).toContain('Médico');
		expect(mounted.text()).toContain('Cena');
		expect(mounted.findComponent(DayEvents).exists()).toBe(true);
	});

	test('un rango sin nada muestra el vacío', () => {
		const days = viewDays('agenda', ANCHOR, 'UTC', FAR);
		mounted = mount(AgendaView, {
			props: { days, zone: 'UTC', eventsOf: eventsOfFor(days, []) },
		});

		expect(mounted.find('[data-day]').exists()).toBe(false);
		expect(mounted.text()).toContain('agenda.empty');
	});
});

describe('el selector cambia de vista', () => {
	function open() {
		setAnswer('listar_cuentas', []);
		setAnswer('store_events', { calendarios: [], eventos: [], fallos: [], available: true });
		mounted = mount(CalendarView, { attachTo: document.body });
		return mounted;
	}

	test('el selector es el segmentado de la librería, con las seis vistas', () => {
		const control = open().findComponent(ViewSwitcher).findComponent(SegmentedControl);
		expect(control.exists()).toBe(true);
		const options = (control.props() as Record<string, unknown>).options as unknown[];
		expect(options.length).toBe(CALENDAR_VIEWS.length);
	});

	test('arranca en el mes', async () => {
		const wrapper = open();
		await flush();
		expect(wrapper.findComponent(MonthGrid).exists()).toBe(true);
	});

	test('elegir otra vista monta su pieza', async () => {
		const wrapper = open();
		await flush();

		for (const [view, component] of [
			['week', ColumnsView],
			['year', YearView],
			['agenda', AgendaView],
			['day', ColumnsView],
		] as const) {
			wrapper.findComponent(ViewSwitcher).vm.$emit('change', view);
			await flush();
			expect(wrapper.findComponent(component).exists()).toBe(true);
		}
		// Ya no está el mes.
		expect(wrapper.findComponent(MonthGrid).exists()).toBe(false);
	});
});

describe('el composable le pide a cada vista su rango', () => {
	function calendar() {
		scope = effectScope();
		const api = scope.run(() => useCalendario())!;
		return api;
	}

	test('cada vista mira la cantidad de días que le toca', async () => {
		setAnswer('listar_cuentas', []);
		setAnswer('store_events', { calendarios: [], eventos: [], fallos: [], available: true });
		const api = calendar();
		await flush();

		await api.setView('day');
		expect(api.dias.value).toHaveLength(1);

		await api.setView('days');
		expect(api.dias.value).toHaveLength(3);

		await api.setView('week');
		expect(api.dias.value).toHaveLength(7);

		await api.setView('year');
		expect(api.dias.value.length).toBeGreaterThanOrEqual(365);
	});

	test('cambiar de vista vuelve a pedirle al almacén', async () => {
		setAnswer('listar_cuentas', []);
		setAnswer('store_events', { calendarios: [], eventos: [], fallos: [], available: true });
		const api = calendar();
		await flush();

		const before = invocations.filter((i) => i.command === 'store_events').length;
		await api.setView('year');
		const after = invocations.filter((i) => i.command === 'store_events').length;
		expect(after).toBeGreaterThan(before);
	});

	test('la vista elegida se recuerda para la próxima vez', async () => {
		setAnswer('listar_cuentas', []);
		setAnswer('store_events', { calendarios: [], eventos: [], fallos: [], available: true });
		const first = calendar();
		await flush();
		await first.setView('week');
		scope?.stop();
		scope = null;

		const again = calendar();
		expect(again.view.value).toBe('week');
	});
});
