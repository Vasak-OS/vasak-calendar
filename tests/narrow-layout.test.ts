/**
 * Una columna por vez con la ventana angosta, como una aplicación de teléfono.
 *
 * Por debajo de 36 rem de fila el mes ocupa todo y las cuentas pasan a ser una
 * vista propia; desde ahí para arriba, las dos columnas una al lado de la otra
 * como siempre. Lo que se comprueba:
 *
 * - que se llega al panel de cuentas y se vuelve al mes, con el foco en el
 *   botón de la columna nueva (la vieja se oculta y un foco ahí se pierde);
 * - que lo elegido en el panel —la zona horaria— y los calendarios siguen ahí
 *   después de ir y volver: el panel no se desmonta, sólo se oculta;
 * - que las clases que lo deciden existen de verdad en la hoja que arma
 *   Tailwind: una clase que no emite regla no da ningún error, y entonces las
 *   dos columnas quedan apretadas como antes sin que nada falle;
 * - que la columna que se ve pisa el ancho del costado (`w-56`, `max-w-[40%]`)
 *   y la otra no deja hueco: eso es lo que hace que nada se corte a 240 y 360.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { compile } from '@tailwindcss/node';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import AccountsPanel from '@/components/calendar/AccountsPanel.vue';
import WindowAppLayout from '@/layouts/WindowAppLayout.vue';
import {
	NARROW_ONLY,
	PANE_HIDDEN,
	PANE_SHOWN,
	type Pane,
	paneClass,
} from '@/tools/narrow-layout';
import CalendarView from '@/views/CalendarView.vue';
import { olvidarTodo } from './dobles';

let view: VueWrapper | null = null;

afterEach(() => {
	view?.unmount();
	view = null;
	document.body.innerHTML = '';
	olvidarTodo();
	try {
		localStorage.clear();
	} catch {
		// Sin almacenamiento no hay nada que limpiar.
	}
});

async function settle(rounds = 6) {
	for (let i = 0; i < rounds; i++) await nextTick();
}

function open() {
	// Pegado al documento: el foco sólo se mueve entre elementos que están en él.
	view = mount(CalendarView, { attachTo: document.body });
	return view;
}

/** La raíz de cada columna: el panel de cuentas es un componente, el mes un envoltorio. */
function pane(wrapper: VueWrapper, name: Pane) {
	return name === 'accounts' ? wrapper.findComponent(AccountsPanel) : wrapper.get('[data-pane="month"]');
}

/** El botón de ir o volver de cada columna, que vive adentro de ella. */
function navButton(wrapper: VueWrapper, name: Pane) {
	const holder = pane(wrapper, name).get(`[data-nav="${name}"]`);
	return holder.get('button');
}

describe('las clases de cada columna', () => {
	test('la que se mira ocupa la fila y la otra se oculta', () => {
		expect(paneClass('month', 'month')).toBe(PANE_SHOWN);
		expect(paneClass('accounts', 'month')).toBe(PANE_HIDDEN);
		expect(paneClass('accounts', 'accounts')).toBe(PANE_SHOWN);
		expect(paneClass('month', 'accounts')).toBe(PANE_HIDDEN);
	});

	test('todas dependen del ancho de la fila y ninguna de la pantalla', () => {
		// WebKitGTK no avisa de `resize` ni de `matchMedia`: un `sm:` o un
		// `md:` acá no cambiaría nunca con la ventana.
		for (const classes of [PANE_SHOWN, PANE_HIDDEN, NARROW_ONLY]) {
			for (const name of classes.split(' ')) {
				expect(name).toMatch(/^@(max|min)-\[36rem\]\/row:/);
			}
		}
	});
});

describe('la hoja de Tailwind', () => {
	async function css(candidates: string[]) {
		const compiler = await compile('@import "tailwindcss/utilities";', {
			base: process.cwd(),
			onDependency: () => {},
		});
		return compiler.build(candidates);
	}

	test('la fila es el contenedor `row`', async () => {
		const sheet = await css(['@container/row']);
		expect(sheet).toContain('container-type: inline-size');
		expect(sheet).toContain('container-name: row');
	});

	test('las columnas cambian por debajo de 36 rem y los botones existen sólo ahí', async () => {
		const sheet = await css([...`${PANE_SHOWN} ${PANE_HIDDEN} ${NARROW_ONLY}`.split(' ')]);
		const narrow = sheet.split('@container row (width < 36rem)')[1]?.split('@container')[0] ?? '';
		const wide = sheet.split('@container row (width >= 36rem)')[1] ?? '';

		// Angosta: la que se ve se estira entera y la otra no ocupa nada.
		expect(narrow).toContain('width: 100%');
		expect(narrow).toContain('max-width: none');
		expect(narrow).toContain('flex: 1');
		expect(narrow).toContain('display: none');
		// Ancha: los botones de ir y volver desaparecen, y la pantalla queda
		// como siempre. Los dos rangos se tocan sin pisarse, así que a ningún
		// ancho se ven las dos cosas ni ninguna.
		expect(wide).toContain('display: none');
	});
});

describe('la ventana angosta', () => {
	test('la fila de la ventana es el contenedor del que dependen las columnas', () => {
		const layout = mount(WindowAppLayout, { slots: { default: '<p data-x />' } });
		const row = layout.get('[data-x]').element.parentElement;
		expect(row?.classList.contains('@container/row')).toBe(true);
		layout.unmount();
	});

	test('arranca por el mes, con las cuentas un paso atrás', () => {
		const wrapper = open();
		expect(pane(wrapper, 'month').classes()).toEqual(expect.arrayContaining(PANE_SHOWN.split(' ')));
		expect(pane(wrapper, 'accounts').classes()).toEqual(expect.arrayContaining(PANE_HIDDEN.split(' ')));
	});

	test('el botón de cada columna sólo existe con la ventana angosta', () => {
		const wrapper = open();
		for (const name of ['month', 'accounts'] as const) {
			const holder = navButton(wrapper, name).element.parentElement as HTMLElement;
			expect(holder.className).toContain(NARROW_ONLY);
		}
	});

	test('los botones son iconos del tema con su nombre dicho', () => {
		const wrapper = open();
		expect(navButton(wrapper, 'month').text()).toContain('nav.accounts');
		expect(navButton(wrapper, 'accounts').text()).toContain('nav.month');
	});

	test('se llega al panel de cuentas y se vuelve al mes', async () => {
		const wrapper = open();

		await navButton(wrapper, 'month').trigger('click');
		await settle();
		expect(pane(wrapper, 'accounts').classes()).toEqual(expect.arrayContaining(PANE_SHOWN.split(' ')));
		expect(pane(wrapper, 'month').classes()).toEqual(expect.arrayContaining(PANE_HIDDEN.split(' ')));
		// El foco va al botón de la columna nueva: el que se apretó acaba de
		// quedar oculto.
		expect(document.activeElement).toBe(navButton(wrapper, 'accounts').element);

		await navButton(wrapper, 'accounts').trigger('click');
		await settle();
		expect(pane(wrapper, 'month').classes()).toEqual(expect.arrayContaining(PANE_SHOWN.split(' ')));
		expect(pane(wrapper, 'accounts').classes()).toEqual(expect.arrayContaining(PANE_HIDDEN.split(' ')));
		expect(document.activeElement).toBe(navButton(wrapper, 'month').element);
	});

	test('lo elegido en el panel se conserva al ir y volver', async () => {
		const wrapper = open();
		const panel = wrapper.findComponent(AccountsPanel);

		panel.vm.$emit('chooseZone', 'Europe/Madrid');
		await settle();
		expect(panel.props('chosenZone')).toBe('Europe/Madrid');

		await navButton(wrapper, 'month').trigger('click');
		await settle();
		await navButton(wrapper, 'accounts').trigger('click');
		await settle();

		// El mismo panel, no uno nuevo: ocultar no desmonta, así que nada de
		// lo que tenía adentro se pierde.
		const after = wrapper.findComponent(AccountsPanel);
		expect(after.vm).toBe(panel.vm);
		expect(after.props('chosenZone')).toBe('Europe/Madrid');
		expect(after.props('zone')).toBe('Europe/Madrid');
	});

	test('el panel en vista propia pisa el ancho del costado', () => {
		// `w-56 max-w-[40%]` es el ancho de la columna al costado; en la vista
		// propia lo tienen que pisar `w-full` y `max-w-none`, o el panel se queda
		// en el 40 % de una fila de 230 px y lo de adentro se corta.
		const wrapper = open();
		const classes = pane(wrapper, 'accounts').classes();
		expect(classes).toContain('w-56');
		expect(classes).toContain('max-w-[40%]');
		expect(PANE_SHOWN).toContain('row:w-full');
		expect(PANE_SHOWN).toContain('row:max-w-none');
	});
});
