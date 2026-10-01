/**
 * Las piezas del calendario que pasaron a la librería (vue-libvasak#74).
 *
 * Lo que se comprueba no es cómo se dibuja cada componente —eso se prueba en
 * la librería— sino que el calendario los use y les pase lo suyo: que el panel
 * de cuentas sea el `Panel`, que los títulos sean `SectionHeading`, que el
 * color de cada calendario siga llegando —es dato del servidor y no puede
 * perderse en la mudanza—, que «hoy» lleve el velo de lo elegido y que las
 * marcas de la cuadrícula sean iconos del tema y no caracteres.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import {
	ActionButton,
	AlertMessage,
	EmptyState,
	Panel,
	SectionHeading,
	StatusDot,
	ThemeIcon,
} from '@vasakgroup/vue-libvasak';
import { mount, type VueWrapper } from '@vue/test-utils';
import AccountsPanel from '@/components/calendar/AccountsPanel.vue';
import MonthGrid from '@/components/calendar/MonthGrid.vue';
import TimeZonePicker from '@/components/calendar/TimeZonePicker.vue';
import { type CalendarEvent, cuadricula } from '@/tools/mes';
import CalendarView from '@/views/CalendarView.vue';
import { olvidarTodo } from './dobles';

let mounted: VueWrapper | null = null;

afterEach(() => {
	mounted?.unmount();
	mounted = null;
	olvidarTodo();
});

function accountsPanel(props: Record<string, unknown> = {}) {
	mounted = mount(AccountsPanel, {
		props: {
			accounts: [
				{ id: 'a1', nombre: 'ana@nube.ejemplo.com', necesita_reconectarse: false },
				{ id: 'a2', nombre: 'trabajo', necesita_reconectarse: true },
			],
			calendars: [
				{ url: 'https://nube.ejemplo.com/personal/', nombre: 'Personal', color: '#3584e4' },
				{ url: 'https://nube.ejemplo.com/feriados/', nombre: 'Feriados', color: null },
			],
			notices: [],
			zone: 'UTC',
			chosenZone: '',
			systemZone: 'UTC',
			foreignZone: false,
			...props,
		},
	});
	return mounted;
}

function event(extra: Partial<CalendarEvent> = {}): CalendarEvent {
	return {
		uid: 'uno',
		title: 'Reunión',
		start: '2026-09-15T14:00:00+00:00',
		end: '2026-09-15T15:00:00+00:00',
		all_day: false,
		recurring: false,
		shown_once: false,
		zone: '',
		calendar: 'https://nube.ejemplo.com/personal/',
		color: '#e66100',
		...extra,
	};
}

function monthGrid(events: CalendarEvent[]) {
	const days = cuadricula(new Date('2026-09-15T12:00:00Z'), 'UTC');
	mounted = mount(MonthGrid, {
		props: { days, zone: 'UTC', eventsOf: (key: string) => (key === '2026-09-15' ? events : []) },
	});
	return mounted;
}

describe('el panel de cuentas', () => {
	test('es el `Panel` de la librería, como `aside`', () => {
		const panel = accountsPanel().findComponent(Panel);

		expect(panel.exists()).toBe(true);
		expect(panel.element.tagName).toBe('ASIDE');
	});

	test('y ya no lleva el fondo ni el canto escritos a mano', () => {
		// `bg-ui-surface/45` y `border-ui-border` eran la copia de acá; la
		// superficie y el canto los pone el `Panel` (`/70`, `ui-line`).
		const classes = accountsPanel().find('aside').classes();

		expect(classes).not.toContain('bg-ui-surface/45');
		expect(classes).toContain('bg-ui-surface/70');
	});

	test('cede ancho en una ventana angosta en vez de tapar el mes', () => {
		// Con `w-56 shrink-0` solo, por debajo de unos 450 px de ventana la
		// cuadrícula no tenía lugar y desaparecía entera.
		expect(accountsPanel().find('aside').classes()).toContain('max-w-[40%]');
	});

	test('los títulos son `SectionHeading`, como `h2`', () => {
		const titles = accountsPanel().findAllComponents(SectionHeading);

		expect(titles.map((h) => h.props('title'))).toEqual([
			'cuentas.titulo',
			'cuentas.calendarios',
			'calendario.zonaEtiqueta',
		]);
		expect(titles.every((h) => h.props('as') === 'h2')).toBe(true);
	});

	test('el color de cada calendario llega al punto, y sin color va el acento', () => {
		// Es dato del servidor: perderlo en la mudanza dejaría todos los
		// calendarios del mismo color sin que nada falle.
		const dots = accountsPanel()
			.findAllComponents(StatusDot)
			.filter((dot) => dot.props('size') === 'md');

		expect(dots).toHaveLength(2);
		expect(dots[0]?.attributes('style')).toContain('--dot-color: #3584e4');
		expect(dots[1]?.attributes('style')).toBeUndefined();
		expect(dots[1]?.classes()).toContain('bg-primary');
	});

	test('una cuenta por reconectar lo dice con el punto de aviso y texto legible', () => {
		const note = accountsPanel().find('[data-testid="needs-reconnect"]');

		expect(note.text()).toBe('cuentas.necesitaReconectarse');
		expect(note.findComponent(StatusDot).props('tone')).toBe('warning');
		// El amarillo como color de texto no llega a 4,5:1 sobre el panel.
		expect(note.classes()).not.toContain('text-status-warning');
	});

	test('lo que no se pudo leer va en el aviso del sistema', () => {
		const alert = accountsPanel({ notices: ['Personal: tiempo agotado'] }).findComponent(AlertMessage);

		expect(alert.exists()).toBe(true);
		expect(alert.props('tone')).toBe('warning');
		expect(alert.text()).toContain('Personal: tiempo agotado');
	});

	test('sin cuentas, el vacío de la librería dice qué hacer', () => {
		const empty = accountsPanel({ accounts: [], calendars: [] }).findComponent(EmptyState);

		expect(empty.props('title')).toBe('cuentas.sinCuentasTitulo');
		expect(empty.props('note')).toBe('cuentas.sinCuentasDescripcion');
		expect(empty.props('size')).toBe('sm');
	});

	test('elegir una zona sigue avisando hacia afuera', async () => {
		const panel = accountsPanel();
		panel.findComponent(TimeZonePicker).vm.$emit('choose', 'Europe/Madrid');

		expect(panel.emitted('chooseZone')?.[0]).toEqual(['Europe/Madrid']);
	});
});

describe('la cuadrícula del mes', () => {
	test('es un `Panel`, con la cuadrícula de verdad adentro', () => {
		const grid = monthGrid([]);

		expect(grid.findComponent(Panel).exists()).toBe(true);
		// La fila de los nombres de los días y una por semana: septiembre de 2026
		// ocupa cinco.
		expect(grid.find('[role="grid"]').findAll('[role="row"]')).toHaveLength(6);
		expect(grid.find('[role="grid"]').find('[role="rowgroup"]').exists()).toBe(true);
	});

	test('hoy lleva el velo de lo elegido y no el relleno del primario', () => {
		// Decisión 4 de vasak-desktop#144: lo que dice «éste» es el velo de
		// acento en todo el sistema.
		mounted = mount(MonthGrid, { props: { days: cuadricula(new Date(), 'UTC'), zone: 'UTC', eventsOf: () => [] } });
		const today = mounted.find('[aria-current="date"]');

		expect(today.exists()).toBe(true);
		expect(today.classes()).toContain('bg-ui-selected-accent');
		expect(today.classes()).not.toContain('bg-primary');
	});

	test('el color del calendario va por `style`, del dato del evento', () => {
		const stripe = monthGrid([event()]).find('[data-testid="event-color"]');

		expect(stripe.attributes('style')).toContain('background-color: #e66100');
	});

	test('y sin color, el acento del esquema', () => {
		const stripe = monthGrid([event({ color: null })]).find('[data-testid="event-color"]');

		expect(stripe.attributes('style')).toContain('var(--color-primary)');
	});

	test('las marcas son iconos del tema y no caracteres', () => {
		const grid = monthGrid([event({ recurring: true, zone: 'Europe/Madrid' })]);
		const names = grid.findAllComponents(ThemeIcon).map((i) => i.props('name'));

		expect(names).toContain('media-playlist-repeat');
		expect(names).toContain('preferences-system-time');
		expect(grid.text()).not.toContain('↻');
		expect(grid.text()).not.toContain('🌐');
	});
});

describe('la barra', () => {
	test('los cuatro botones son `ActionButton`', () => {
		mounted = mount(CalendarView);
		const buttons = mounted.findAllComponents(ActionButton);

		expect(buttons.map((b) => b.props('icon') || b.props('label'))).toEqual(
			expect.arrayContaining(['view-refresh', 'go-previous', 'go-next', 'calendario.hoy'])
		);
	});

	test('«Hoy» es el secundario chico y las flechas no tienen relleno', () => {
		mounted = mount(CalendarView);
		const buttons = mounted.findAllComponents(ActionButton);
		const today = buttons.find((b) => b.props('label') === 'calendario.hoy');

		expect(today?.props('variant')).toBe('secondary');
		expect(today?.props('size')).toBe('sm');
		for (const name of ['go-previous', 'go-next', 'view-refresh']) {
			expect(buttons.find((b) => b.props('icon') === name)?.props('variant')).toBe('ghost');
		}
	});
});
