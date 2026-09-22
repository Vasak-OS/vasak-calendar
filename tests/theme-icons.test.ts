/**
 * Los iconos del calendario siguen al tema, y la recarga va por el planificador.
 *
 * El calendario no resuelve ningún icono: los pide por nombre a `ThemeIcon`. Lo
 * que se comprueba acá es que la recarga llegue por el planificador de la
 * librería y no en el acto.
 *
 * Importa porque hasta este cambio no era así, y nada lo decía: el manifiesto
 * pedía `^1.1.0`, que admite la 1.4.0, pero `bun.lock` había quedado en la
 * 1.1.0 y se empaquetaba ésa. Un rango que ya se satisface no mueve el candado,
 * y el CI decía «al día» porque sólo miraba el rango.
 */

import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
import { olvidarLosIconosDelTema } from '@vasakgroup/vue-libvasak';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import CalendarioView from '@/views/CalendarioView.vue';
import { emit, olvidarTodo, setThemeIcon } from './dobles';

/**
 * Deja que terminen las promesas encadenadas del pedido del icono.
 *
 * Sólo microtareas: con el reloj detenido, un `setTimeout(0)` no vuelve nunca.
 */
async function settle(rounds = 8) {
	for (let i = 0; i < rounds; i++) {
		await nextTick();
		await Promise.resolve();
	}
}

/**
 * Adelanta el reloj hasta pasada la espera del planificador, y asienta.
 *
 * Con temporizadores falsos y no con una espera de verdad. Las dos cosas que
 * hay que comprobar acá se pelean: que la recarga **todavía no** pasó justo
 * después del evento, y que **sí** pasa un poco más tarde. Con el reloj real la
 * primera falla de a ratos —si la máquina se demora, los 100 ms se cumplen
 * antes de la aserción— y con sólo un `nextTick` la segunda se vuelve vacía:
 * sin planificador la recarga tampoco llega a verse, así que la prueba pasaría
 * con la librería vieja.
 *
 * Se avanza en pasos porque el planificador `await`ea entre tandas y las
 * microtareas tienen que poder correr en el medio.
 */
async function advancePastReload() {
	for (let i = 0; i < 8; i++) {
		jest.advanceTimersByTime(40);
		await settle(2);
	}
}

let mounted: VueWrapper | null = null;

function openCalendar() {
	mounted = mount(CalendarioView);
	return mounted;
}

function iconSources(vista: VueWrapper): string[] {
	return vista.findAll('img').map((una) => una.attributes('src') ?? '');
}

beforeEach(() => {
	jest.useFakeTimers();
	olvidarTodo();
	// La memoria de la librería vive en su módulo y sobrevive entre archivos de
	// prueba: sin vaciarla, esto ve el icono que dejó otra.
	olvidarLosIconosDelTema();
});

afterEach(() => {
	mounted?.unmount();
	mounted = null;
	olvidarLosIconosDelTema();
	jest.useRealTimers();
});

describe('el calendario dibuja sus iconos con el tema', () => {
	test('el de la aplicación sale del tema, por nombre', async () => {
		setThemeIcon('calendar', 'data:image/svg+xml,calendario-claro');

		const vista = openCalendar();
		await settle();

		expect(iconSources(vista)).toContain('data:image/svg+xml,calendario-claro');
	});

	test('la recarga se agenda, no pasa en el acto', async () => {
		// Es lo que separa la 1.1.0 —la que se venía empaquetando— de la 1.4.0:
		// sin planificador el dibujo nuevo ya estaría acá.
		setThemeIcon('calendar', 'data:image/svg+xml,calendario-claro');

		const vista = openCalendar();
		await settle();

		setThemeIcon('calendar', 'data:image/svg+xml,calendario-oscuro');
		await emit('vicons:theme-changed');
		await settle();

		expect(iconSources(vista)).not.toContain('data:image/svg+xml,calendario-oscuro');

		await advancePastReload();
		expect(iconSources(vista)).toContain('data:image/svg+xml,calendario-oscuro');
	});
});
